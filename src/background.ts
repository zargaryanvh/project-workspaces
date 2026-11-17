/**
 * Project workspaces: background worker.
 *
 * One project = one tab group. Switching to a project activates a tab in its
 * group, opens the group and folds every other group in that window. Tabs are
 * never closed (except a new duplicate tab, when the owner says so),
 * discarded or reloaded, and other windows are left alone.
 *
 * Every change to tabs, groups or the saved data runs here, one at a time
 * (see `exclusive`). The extension's pages only ask.
 *
 * Group ids change after a Brave restart, so nothing is saved by group id:
 * projects are matched to groups by title.
 *
 * Privacy: this worker makes no network requests. The manifest's CSP sets
 * connect-src 'none', so it could not make one even by mistake.
 */

import { readWindow, toGroupInfo, toTabInfos } from './lib/chromeShapes.js';
import { findAlreadyOpen } from './lib/duplicates.js';
import { buildList, commandTarget } from './lib/list.js';
import { isMessage, type Message, type Reply } from './lib/messages.js';
import { groupMoveIndex } from './lib/order.js';
import { groupsToFold, planSwitch, type SwitchPlan } from './lib/plan.js';
import {
  addMissingProjects,
  findProject,
  removeProject,
  renameProject,
  setProjectColor,
  type SeenGroup,
} from './lib/projects.js';
import { openProjectKey, pickOpenAfterRestore, rememberOpen, windowSignature } from './lib/restore.js';
import { hostKey, isNewSite, matchRule } from './lib/rules.js';
import { isGroupColor, sanitizeLocal, sanitizeRules, sanitizeSettings } from './lib/sanitize.js';
import {
  classifyGroupChange,
  noteGroupChange,
  rulesMayMove,
  trackNewTab,
  type TabTrack,
} from './lib/tabTracking.js';
import { cleanTitle, defaultColorFor, isStagingTitle, projectKey } from './lib/titles.js';
import type { GroupColor, LocalState, StoredProject } from './lib/types.js';
import { NO_GROUP } from './lib/types.js';

/** Events this soon after the extension's own change count as its own. */
const OWN_MS = 1500;
/** A group name typed in Brave's editor changes on every key; wait for a pause. */
const RENAME_SETTLE_MS = 1200;
const SAVE_DELAY_MS = 300;
/**
 * A window Brave is filling (Ctrl+Shift+T, start-up) is left alone until no tab
 * or group has been added to it for this long. Pages loading do not count.
 */
const SETTLE_QUIET_MS = 800;
const SETTLE_MAX_MS = 6000;
const REMEMBER_DELAY_MS = 700;
const ROW_POPUP = 'panel.html?view=row';

// ---------------------------------------------------------------- state

interface GroupTrack {
  /** The title the project list last took for this group. */
  stableTitle: string;
  collapsed: boolean;
  windowId: number;
}

/** Kept in chrome.storage.session: survives the worker sleeping, not a Brave restart. */
interface SessionState {
  groups: Record<string, GroupTrack>;
  tabs: Record<string, TabTrack>;
  /** The project last shown in each window (for next/previous from a tab with no group). */
  windows: Record<string, number>;
  /** Tabs where the owner chose "Open anyway": the address they may load without a warning. */
  allowed: Record<string, string>;
}

type LocalKey = 'projects' | 'lastActive' | 'openProjects';

let local: LocalState = sanitizeLocal(undefined);
let session: SessionState = { groups: {}, tabs: {}, windows: {}, allowed: {} };
let ready: Promise<void> | null = null;

function init(): Promise<void> {
  if (!ready) {
    ready = start().catch((err: unknown) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function start(): Promise<void> {
  const [stored, saved] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get('state')]);
  local = sanitizeLocal(stored);
  session = readSession(saved['state']);
  await catchUp();
  await applySurface().catch(report); // the toolbar button is a nicety: never let it stop the rest
}

function readSession(raw: unknown): SessionState {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SessionState>;
  const record = <T>(x: unknown): Record<string, T> =>
    typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, T>) : {};
  return {
    groups: record<GroupTrack>(value.groups),
    tabs: record<TabTrack>(value.tabs),
    windows: record<number>(value.windows),
    allowed: record<string>(value.allowed),
  };
}

/** Learns the groups and tabs that are open now: after install, a Brave start or the worker waking up. */
async function catchUp(): Promise<void> {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);

  const liveGroups = new Set<string>();
  for (const group of groups) {
    const id = String(group.id);
    liveGroups.add(id);
    const title = group.title ?? '';
    const track = session.groups[id];
    if (!track) {
      session.groups[id] = { stableTitle: title, collapsed: group.collapsed, windowId: group.windowId };
    } else {
      track.collapsed = group.collapsed;
      track.windowId = group.windowId;
      if (title !== track.stableTitle) scheduleRename(group.id, title);
    }
  }
  for (const id of Object.keys(session.groups)) if (!liveGroups.has(id)) delete session.groups[id];

  const liveTabs = new Set<string>();
  const firstIndex = new Map<number, number>();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const id = String(tab.id);
    liveTabs.add(id);
    // Tabs open before the extension watched them: Brave restored them or the owner placed them.
    session.tabs[id] ??= { host: hostKey(tab.url || tab.pendingUrl), created: 0, opener: false };
    if (tab.groupId !== NO_GROUP) {
      const seen = firstIndex.get(tab.groupId);
      if (seen === undefined || tab.index < seen) firstIndex.set(tab.groupId, tab.index);
    }
  }
  for (const id of Object.keys(session.tabs)) if (!liveTabs.has(id)) delete session.tabs[id];
  for (const id of Object.keys(session.allowed)) if (!liveTabs.has(id)) delete session.allowed[id];

  // Every named group is a project. New ones are remembered in window, then tab bar, order.
  const named: SeenGroup[] = groups
    .filter((g) => cleanTitle(g.title ?? '') !== '')
    .sort((a, b) => a.windowId - b.windowId || (firstIndex.get(a.id) ?? 0) - (firstIndex.get(b.id) ?? 0))
    .map((g) => ({ title: g.title ?? '', color: colorOf(g) }));
  setProjects(addMissingProjects(local.projects, named));
  saveSession();
}

// ---------------------------------------------------------------- saving

const dirtyLocal = new Set<LocalKey>();
let localTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTimer: ReturnType<typeof setTimeout> | undefined;

function saveLocal(key: LocalKey): void {
  dirtyLocal.add(key);
  localTimer ??= setTimeout(() => void flushLocal().catch(report), SAVE_DELAY_MS);
}

async function flushLocal(): Promise<void> {
  if (localTimer !== undefined) clearTimeout(localTimer);
  localTimer = undefined;
  if (dirtyLocal.size === 0) return;
  const items: Partial<LocalState> = {};
  if (dirtyLocal.has('projects')) items.projects = local.projects;
  if (dirtyLocal.has('lastActive')) items.lastActive = local.lastActive;
  if (dirtyLocal.has('openProjects')) items.openProjects = local.openProjects;
  dirtyLocal.clear();
  await chrome.storage.local.set(items);
}

function saveSession(): void {
  sessionTimer ??= setTimeout(() => {
    sessionTimer = undefined;
    chrome.storage.session.set({ state: session }).catch(report);
  }, 150);
}

function setProjects(next: StoredProject[]): void {
  if (next === local.projects) return;
  local.projects = next;
  saveLocal('projects');
}

// ---------------------------------------------------------------- own changes

const ownTabMoves = new Map<number, number>();
const ownOpens = new Map<number, number>();

function markOwnTabMoves(tabIds: readonly number[]): void {
  const until = Date.now() + OWN_MS;
  for (const id of tabIds) ownTabMoves.set(id, until);
}

function isOwnTabMove(tabId: number): boolean {
  const until = ownTabMoves.get(tabId);
  return until !== undefined && until > Date.now();
}

/** The extension is about to open this group (or make Brave open it). */
function markOwnOpen(groupId: number): void {
  ownOpens.set(groupId, Date.now() + OWN_MS);
}

function takeOwnOpen(groupId: number): boolean {
  const until = ownOpens.get(groupId);
  ownOpens.delete(groupId);
  return until !== undefined && until > Date.now();
}

// ---------------------------------------------------------------- windows Brave is filling or closing

const settling = new Map<number, { timer: ReturnType<typeof setTimeout>; until: number }>();
const closingWindows = new Set<number>();

/**
 * Ctrl+Shift+T, a restart or a new window: Brave adds the tabs and groups one by
 * one and makes the first restored tab active. Reacting to that would open the
 * wrong project, so the window is left alone until it settles.
 */
function watchSettling(windowId: number): void {
  const now = Date.now();
  const entry = settling.get(windowId);
  const until = entry?.until ?? now + SETTLE_MAX_MS;
  if (entry) clearTimeout(entry.timer);
  const timer = setTimeout(
    () => {
      settling.delete(windowId);
      init()
        .then(() => exclusive(() => finishSettling(windowId)))
        .catch(report);
    },
    Math.max(0, Math.min(SETTLE_QUIET_MS, until - now)),
  );
  settling.set(windowId, { timer, until });
}

/** A tab or group was added to a window. True while the window is still settling (and the wait starts again). */
function stillSettling(windowId: number): boolean {
  if (!settling.has(windowId)) return false;
  watchSettling(windowId);
  return true;
}

function isQuiet(windowId: number): boolean {
  return settling.has(windowId) || closingWindows.has(windowId);
}

/** The window settled: bring back the project that was open in it. */
async function finishSettling(windowId: number): Promise<void> {
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win || win.type !== 'normal') return;
  const { groups, tabs } = await readWindow(windowId);
  const reopened = groups.length > 0 || tabs.length > 1;
  if (!reopened) {
    // A plain new window: its first page still follows the rules.
    const only = tabs[0];
    if (only) await applyRules(only.id);
    return;
  }
  if (local.settings.follow) {
    const signature = windowSignature(groups, windowId);
    const pick = pickOpenAfterRestore(groups, tabs, windowId, signature ? local.openProjects[signature] : undefined);
    if (pick !== null) await switchTo(windowId, pick);
  }
  await rememberNow(windowId);
}

// ---------------------------------------------------------------- remembering the open project

const rememberTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleRemember(windowId: number): void {
  if (isQuiet(windowId)) return;
  const old = rememberTimers.get(windowId);
  if (old !== undefined) clearTimeout(old);
  rememberTimers.set(
    windowId,
    setTimeout(() => {
      rememberTimers.delete(windowId);
      init()
        .then(() => exclusive(() => rememberNow(windowId)))
        .catch(report);
    }, REMEMBER_DELAY_MS),
  );
}

/** Notes which project is open in a window, so a reopened window gets it back. */
async function rememberNow(windowId: number): Promise<void> {
  if (isQuiet(windowId)) return;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win || win.type !== 'normal') return;
  const { groups, tabs } = await readWindow(windowId);
  const signature = windowSignature(groups, windowId);
  const key = openProjectKey(groups, tabs, windowId);
  if (!signature || !key) return;
  const next = rememberOpen(local.openProjects, signature, key);
  if (next !== local.openProjects) {
    local.openProjects = next;
    saveLocal('openProjects');
  }
}

// ---------------------------------------------------------------- helpers

let queue: Promise<unknown> = Promise.resolve();

/** Runs tab and group changes one after another, never interleaved. */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(report);
  return run;
}

function report(err: unknown): void {
  console.warn('[Project workspaces]', err);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Brave refuses tab edits while the owner drags a tab. Wait a little and try again. */
async function retry<T>(job: () => Promise<T>, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (err) {
      if (attempt >= tries || !/cannot be edited right now|dragging/i.test(errorText(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

function colorOf(group: chrome.tabGroups.TabGroup): GroupColor {
  return isGroupColor(group.color) ? group.color : 'grey';
}

function nonEmpty(ids: number[]): [number, ...number[]] | null {
  return ids.length > 0 ? (ids as [number, ...number[]]) : null;
}

function tabTrack(tabId: number, fallback: () => TabTrack): TabTrack {
  return (session.tabs[String(tabId)] ??= fallback());
}

/** Wraps an event handler so it runs after the worker has loaded its state. */
function listen<A extends unknown[]>(handler: (...args: A) => void | Promise<void>): (...args: A) => void {
  return (...args: A) => {
    init()
      .then(() => handler(...args))
      .catch(report);
  };
}

// ---------------------------------------------------------------- toolbar button

async function applySurface(): Promise<void> {
  const hasSidePanel = typeof chrome.sidePanel?.setPanelBehavior === 'function';
  if (local.settings.surface === 'sidePanel' && hasSidePanel) {
    await chrome.action.setPopup({ popup: '' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } else {
    if (hasSidePanel) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.action.setPopup({ popup: ROW_POPUP });
  }
}

/** The "Open the project row" key: the row of projects under the toolbar button. */
async function openProjectRow(windowId: number | undefined): Promise<void> {
  const current = await chrome.action.getPopup({});
  const swap = !current.endsWith(ROW_POPUP);
  if (swap) await chrome.action.setPopup({ popup: ROW_POPUP });
  try {
    await chrome.action.openPopup(windowId !== undefined ? { windowId } : {});
  } finally {
    if (swap) setTimeout(() => void applySurface().catch(report), 500);
  }
}

// ---------------------------------------------------------------- switching

/** Shows one project in one window: its group opens, the others fold. */
async function switchTo(windowId: number, groupId: number): Promise<boolean> {
  const { groups, tabs } = await readWindow(windowId);
  const target = groups.find((g) => g.id === groupId);
  if (!target) return false;
  const key = projectKey(target.title);
  const plan = planSwitch({ windowId, groupId, groups, tabs, lastActive: key ? local.lastActive[key] : undefined });
  if (!plan) return false;
  await runPlan(plan);
  session.windows[String(windowId)] = groupId;
  saveSession();
  await rememberNow(windowId);
  return true;
}

async function runPlan(plan: SwitchPlan): Promise<void> {
  const expand = plan.expandGroupId;
  if (expand !== null) {
    markOwnOpen(expand);
    await retry(() => chrome.tabGroups.update(expand, { collapsed: false }));
  }
  const activate = plan.activateTabId;
  if (activate !== null) await retry(() => chrome.tabs.update(activate, { active: true }));
  await foldGroups(plan.collapseGroupIds);
}

async function foldGroups(groupIds: readonly number[]): Promise<void> {
  await Promise.all(groupIds.map((id) => retry(() => chrome.tabGroups.update(id, { collapsed: true }))));
}

/** After the owner moved to a tab of another project: open its group, fold the rest. */
async function keepOnlyOpen(windowId: number, groupId: number): Promise<void> {
  const { groups, tabs } = await readWindow(windowId);
  const active = tabs.find((t) => t.active);
  if (!active || active.groupId !== groupId) return; // moved on again; a later event settles it
  if (groups.find((g) => g.id === groupId)?.collapsed) {
    markOwnOpen(groupId); // the active tab must never sit inside a folded group
    await retry(() => chrome.tabGroups.update(groupId, { collapsed: false }));
  }
  await foldGroups(groupsToFold(groups, windowId, groupId));
  session.windows[String(windowId)] = groupId;
  saveSession();
  await rememberNow(windowId);
}

async function runCommand(command: string, windowId: number): Promise<boolean> {
  const { groups, tabs } = await readWindow(windowId);
  const list = buildList(groups, tabs, windowId);
  const target = commandTarget(command, list, session.windows[String(windowId)] ?? null);
  return target ? switchTo(windowId, target.groupId) : false;
}

/** Moves a group in the tab bar; the list follows the tab bar. */
async function moveGroup(windowId: number, groupId: number, beforeGroupId: number | null): Promise<boolean> {
  const { tabs } = await readWindow(windowId);
  const index = groupMoveIndex(tabs, windowId, groupId, beforeGroupId);
  if (index === null) return false;
  await retry(() => chrome.tabGroups.move(groupId, { index }));
  return true;
}

// ---------------------------------------------------------------- rules

/** A tab went to a new site. If a rule names its project, move it there. */
async function applyRules(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.id === undefined || tab.incognito) return;
  if (isQuiet(tab.windowId)) return;
  const groupId = tab.groupId ?? NO_GROUP;
  if (!rulesMayMove({ groupId, pinned: tab.pinned }, session.tabs[String(tabId)])) return;
  const rule = matchRule(tab.url, local.rules);
  if (!rule) return;
  const title = cleanTitle(rule.project);
  const key = projectKey(title);
  if (!key) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win || win.type !== 'normal') return; // pop-ups and app windows cannot hold groups

  const groups = (await chrome.tabGroups.query({ windowId: tab.windowId })).map(toGroupInfo);
  const target = groups.find((g) => projectKey(g.title) === key);
  if (target && target.id === groupId) return;

  markOwnTabMoves([tabId]);
  let newGroupId: number;
  if (target) {
    if (tab.active) markOwnOpen(target.id);
    newGroupId = await retry(() => chrome.tabs.group({ tabIds: tabId, groupId: target.id }));
  } else {
    newGroupId = await retry(() => chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } }));
    const color = findProject(local.projects, title)?.color ?? defaultColorFor(title);
    session.groups[String(newGroupId)] = { stableTitle: title, collapsed: false, windowId: tab.windowId };
    await retry(() => chrome.tabGroups.update(newGroupId, { title, color }));
    setProjects(addMissingProjects(local.projects, [{ title, color }]));
  }
  const track = tabTrack(tabId, () => ({ host: hostKey(tab.url), created: 0, opener: false }));
  track.auto = newGroupId; // put there by a rule, not by the owner: a later rule may move it again
  delete track.manual;
  saveSession();

  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (!now) return;
  if (now.active) {
    if (local.settings.follow) {
      await switchTo(now.windowId, newGroupId);
    } else {
      markOwnOpen(newGroupId);
      await retry(() => chrome.tabGroups.update(newGroupId, { collapsed: false }));
    }
  } else if (!target && local.settings.follow) {
    // A new group for a tab opened in the background starts folded, like every project not in use.
    await retry(() => chrome.tabGroups.update(newGroupId, { collapsed: true }));
  }
}

/**
 * The addresses changed: open tabs that sit in no group and match an address go
 * to their project now, so a new address also sorts the tabs that are already
 * open. Tabs in a group, pinned tabs and tabs taken out of a group by hand stay.
 */
async function sortLooseTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  for (const tab of tabs) {
    if (tab.id === undefined || tab.pinned || tab.incognito || tab.groupId !== NO_GROUP) continue;
    if (isQuiet(tab.windowId) || !matchRule(tab.url, local.rules)) continue;
    await applyRules(tab.id);
  }
}

// ---------------------------------------------------------------- "already open" warning

const checkedNavigation = new Map<number, string>();

interface NavigationSeen {
  tabId: number;
  windowId: number;
  /** The address the tab is going to. */
  url: string;
  /** The site the tab showed before ('' for a new tab). Taken when the event came, before the page loads. */
  fromHost: string;
  openerTabId: number | undefined;
  incognito: boolean;
}

/**
 * A tab is going to an address (it started loading, or it just loaded a new
 * site): maybe it is a project site that is already open. Everything is taken
 * from the event itself, because a fast page (a local dev server) has loaded
 * before any later look at the tab.
 */
function maybeCheckAlreadyOpen(tab: chrome.tabs.Tab, url: string | undefined, fromHost: string): void {
  if (!local.settings.duplicateCheck || tab.id === undefined || !url || !/^https?:/i.test(url)) return;
  // Only a tab that showed no web page yet: a new tab, a link opened in a new tab, a bookmark,
  // a link from another app. A tab going from one site to another may be in a sign-in redirect.
  if (fromHost !== '') return;
  if (isQuiet(tab.windowId) || checkedNavigation.get(tab.id) === url) return;
  checkedNavigation.set(tab.id, url);
  // Not queued behind other work: the warning should come before the page has settled.
  void checkAlreadyOpen({
    tabId: tab.id,
    windowId: tab.windowId,
    url,
    fromHost,
    openerTabId: tab.openerTabId,
    incognito: tab.incognito,
  }).catch(report);
}

async function checkAlreadyOpen(seen: NavigationSeen): Promise<void> {
  if (seen.incognito) return;
  const win = await chrome.windows.get(seen.windowId).catch(() => null);
  if (!win || win.type !== 'normal') return;
  let openerHost: string | null = null;
  if (seen.fromHost === '' && seen.openerTabId !== undefined) {
    const opener = await chrome.tabs.get(seen.openerTabId).catch(() => null);
    openerHost = opener ? hostKey(opener.url) : null;
  }
  const others = findAlreadyOpen({
    url: seen.url,
    tabId: seen.tabId,
    windowId: seen.windowId,
    currentHost: seen.fromHost,
    openerHost,
    allowedUrl: session.allowed[String(seen.tabId)],
    rules: local.rules,
    tabs: toTabInfos(await chrome.tabs.query({ windowType: 'normal' })),
  });
  if (!others) return;
  // Act only if the tab still shows or loads that address: the owner may have moved on.
  const now = await chrome.tabs.get(seen.tabId).catch(() => null);
  if (!now || (now.pendingUrl !== seen.url && now.url !== seen.url)) return;
  // The tab shows the warning instead of the page, and comes to the front.
  const page = chrome.runtime.getURL(`already-open.html?u=${encodeURIComponent(seen.url)}`);
  await chrome.tabs.update(seen.tabId, { url: page, active: true });
  await chrome.windows.update(seen.windowId, { focused: true }).catch(() => undefined);
}

/** "Close this tab" or a tab picked on the warning page: go there, close the new tab. */
async function goToTab(tabId: number, closeTabId: number | undefined): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId);
  await retry(() => chrome.tabs.update(tabId, { active: true }));
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  if (tab.groupId !== NO_GROUP) {
    if (local.settings.follow) {
      await keepOnlyOpen(tab.windowId, tab.groupId);
    } else {
      const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (group?.collapsed) {
        markOwnOpen(group.id);
        await retry(() => chrome.tabGroups.update(group.id, { collapsed: false }));
      }
    }
  }
  if (closeTabId !== undefined && closeTabId !== tabId) await chrome.tabs.remove(closeTabId).catch(() => undefined);
  return true;
}

async function openAnyway(tabId: number, url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) throw new Error('This is not a web address.');
  session.allowed[String(tabId)] = url;
  saveSession();
  checkedNavigation.delete(tabId);
  await chrome.tabs.update(tabId, { url });
  return true;
}

// ---------------------------------------------------------------- page requests

async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'switch':
      return switchTo(message.windowId, message.groupId);
    case 'command':
      return runCommand(message.command, message.windowId);
    case 'create':
      return createProject(message.windowId, message.title, message.color);
    case 'rename':
      return renameGroup(message.groupId, message.title);
    case 'recolor':
      return recolorGroup(message.groupId, message.color);
    case 'move':
      return moveGroup(message.windowId, message.groupId, message.beforeGroupId);
    case 'delete':
      return deleteProject(message.groupId, message.removeRules);
    case 'goToTab':
      return goToTab(message.tabId, message.closeTabId);
    case 'openAnyway':
      return openAnyway(message.tabId, message.url);
  }
}

/** Makes a project from the selected tabs (or the active tab) and switches to it. */
async function createProject(windowId: number, rawTitle: string, color: GroupColor): Promise<number> {
  const title = cleanTitle(rawTitle);
  if (!title) throw new Error('Please type a name for the project.');
  const finalColor: GroupColor = isStagingTitle(title) ? 'orange' : color;

  const selected = await chrome.tabs.query({ windowId, highlighted: true });
  let ids = selected.filter((t) => !t.pinned && t.id !== undefined).map((t) => t.id as number);
  if (ids.length === 0) {
    const [active] = await chrome.tabs.query({ windowId, active: true });
    if (active?.id !== undefined && !active.pinned) ids = [active.id];
  }
  const tabIds = nonEmpty(ids);
  if (!tabIds) throw new Error('Pinned tabs cannot join a project. Select a tab that is not pinned.');

  // A group with this name already in the window gets the tabs, rather than a second group.
  const existing = (await chrome.tabGroups.query({ windowId })).find(
    (g) => projectKey(g.title ?? '') === projectKey(title),
  );
  markOwnTabMoves(tabIds);
  let groupId: number;
  if (existing) {
    groupId = await retry(() => chrome.tabs.group({ tabIds, groupId: existing.id }));
  } else {
    groupId = await retry(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
    session.groups[String(groupId)] = { stableTitle: title, collapsed: false, windowId };
    await retry(() => chrome.tabGroups.update(groupId, { title, color: finalColor }));
  }
  for (const id of tabIds) {
    const track = tabTrack(id, () => ({ host: '', created: 0, opener: false }));
    track.manual = groupId; // the owner chose these tabs
    delete track.auto;
  }
  setProjects(addMissingProjects(local.projects, [{ title, color: existing ? colorOf(existing) : finalColor }]));
  saveSession();
  await switchTo(windowId, groupId);
  return groupId;
}

async function renameGroup(groupId: number, rawTitle: string): Promise<boolean> {
  const title = cleanTitle(rawTitle);
  if (!title) throw new Error('Please type a name for the project.');
  await retry(() => chrome.tabGroups.update(groupId, isStagingTitle(title) ? { title, color: 'orange' } : { title }));
  cancelRename(groupId); // typed in the list, not letter by letter in Brave: settle it now
  await commitRename(groupId);
  return true;
}

async function recolorGroup(groupId: number, color: GroupColor): Promise<boolean> {
  const group = await retry(() => chrome.tabGroups.update(groupId, { color }));
  const title = group?.title ?? '';
  if (cleanTitle(title)) {
    setProjects(setProjectColor(addMissingProjects(local.projects, [{ title, color }]), title, color));
  }
  return true;
}

/** Deleting a project only takes its tabs out of the group. Every tab stays open. */
async function deleteProject(groupId: number, removeRules: boolean): Promise<boolean> {
  const group = await chrome.tabGroups.get(groupId);
  const title = group.title ?? '';
  const tabs = await chrome.tabs.query({ groupId });
  const ids = nonEmpty(tabs.map((t) => t.id).filter((id): id is number => id !== undefined));
  if (ids) {
    markOwnTabMoves(ids);
    await retry(() => chrome.tabs.ungroup(ids));
    for (const id of ids) {
      const track = tabTrack(id, () => ({ host: '', created: 0, opener: false }));
      track.manual = NO_GROUP; // the owner took them out: rules leave them out
      delete track.auto;
    }
    saveSession();
  }
  const key = projectKey(title);
  if (key) {
    const elsewhere = (await chrome.tabGroups.query({})).some((g) => projectKey(g.title ?? '') === key);
    if (!elsewhere) {
      setProjects(removeProject(local.projects, title));
      delete local.lastActive[key];
      saveLocal('lastActive');
    }
    if (removeRules) {
      const kept = local.rules.filter((r) => projectKey(r.project) !== key);
      if (kept.length !== local.rules.length) {
        local.rules = kept;
        await chrome.storage.local.set({ rules: kept });
      }
    }
  }
  scheduleRemember(group.windowId);
  return true;
}

// ---------------------------------------------------------------- renames typed in Brave

const renameTimers = new Map<number, { title: string; timer: ReturnType<typeof setTimeout> }>();

function scheduleRename(groupId: number, title: string): void {
  const pending = renameTimers.get(groupId);
  if (pending?.title === title) return; // same name still settling: folding or recolouring does not restart the wait
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    renameTimers.delete(groupId);
    init()
      .then(() => exclusive(() => commitRename(groupId)))
      .catch(report);
  }, RENAME_SETTLE_MS);
  renameTimers.set(groupId, { title, timer });
}

function cancelRename(groupId: number): void {
  const pending = renameTimers.get(groupId);
  if (pending) clearTimeout(pending.timer);
  renameTimers.delete(groupId);
}

/** The group's name settled: the project keeps its place under the new name. */
async function commitRename(groupId: number): Promise<void> {
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return;
  const track = (session.groups[String(groupId)] ??= {
    stableTitle: '',
    collapsed: group.collapsed,
    windowId: group.windowId,
  });
  const title = group.title ?? '';
  const oldTitle = track.stableTitle;
  if (title === oldTitle) return;
  const all = await chrome.tabGroups.query({});
  const oldStillOpen = all.some((g) => g.id !== groupId && projectKey(g.title ?? '') === projectKey(oldTitle));
  setProjects(renameProject(local.projects, oldTitle, title, colorOf(group), oldStillOpen));

  const from = projectKey(oldTitle);
  const to = projectKey(title);
  const last = from ? local.lastActive[from] : undefined;
  if (last && to && from !== to) {
    local.lastActive[to] = last;
    if (!oldStillOpen) delete local.lastActive[from];
    saveLocal('lastActive');
  }
  track.stableTitle = title;
  saveSession();
  scheduleRemember(group.windowId);
}

// ---------------------------------------------------------------- tab events

function onTabCreated(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined || session.tabs[String(tab.id)]) return;
  if (stillSettling(tab.windowId)) {
    // Brave is reopening this window: the tab is a restored one, placed by the owner long ago.
    session.tabs[String(tab.id)] = { host: hostKey(tab.url || tab.pendingUrl), created: 0, opener: false };
  } else {
    session.tabs[String(tab.id)] = trackNewTab({
      url: tab.url,
      groupId: tab.groupId ?? NO_GROUP,
      hasOpener: tab.openerTabId !== undefined,
      now: Date.now(),
    });
    maybeCheckAlreadyOpen(tab, tab.pendingUrl || tab.url, '');
  }
  saveSession();
}

function onTabUpdated(tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
  if (change.groupId !== undefined) stillSettling(tab.windowId); // a restore puts tabs in groups
  const quiet = isQuiet(tab.windowId);
  const track = tabTrack(tabId, () => ({ host: '', created: 0, opener: tab.openerTabId !== undefined }));
  if (change.groupId !== undefined) {
    const kind = classifyGroupChange({
      byExtension: isOwnTabMove(tabId),
      track,
      newGroupId: change.groupId,
      now: Date.now(),
    });
    noteGroupChange(track, kind, change.groupId);
    saveSession();
  }
  if (change.status === 'loading' && !quiet) maybeCheckAlreadyOpen(tab, tab.pendingUrl, track.host);
  if (change.url !== undefined) {
    const before = track.host;
    if (!quiet && isNewSite(before, hostKey(change.url))) maybeCheckAlreadyOpen(tab, change.url, before);
    track.host = hostKey(change.url);
    const allowed = session.allowed[String(tabId)];
    if (allowed !== undefined && hostKey(allowed) !== track.host && track.host !== '') delete session.allowed[String(tabId)];
    saveSession();
    for (const entry of Object.values(local.lastActive)) {
      if (entry.tabId === tabId && entry.url !== change.url) {
        entry.url = change.url;
        saveLocal('lastActive');
      }
    }
    if (!quiet && isNewSite(before, track.host)) void exclusive(() => applyRules(tabId));
  }
}

function onTabActivated(info: chrome.tabs.OnActivatedInfo): void {
  if (isQuiet(info.windowId)) return;
  void exclusive(async () => {
    const tab = await chrome.tabs.get(info.tabId).catch(() => null);
    if (!tab || tab.id === undefined || tab.groupId === NO_GROUP) {
      scheduleRemember(info.windowId);
      return;
    }
    const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (!group) return;
    const key = projectKey(group.title ?? '');
    if (key) {
      local.lastActive[key] = { tabId: tab.id, url: tab.url ?? '' };
      saveLocal('lastActive');
    }
    session.windows[String(info.windowId)] = tab.groupId;
    saveSession();
    if (local.settings.follow) await keepOnlyOpen(info.windowId, tab.groupId);
    else scheduleRemember(info.windowId);
  });
}

function onTabRemoved(tabId: number, info: chrome.tabs.OnRemovedInfo): void {
  if (info.isWindowClosing) closingWindows.add(info.windowId);
  delete session.tabs[String(tabId)];
  delete session.allowed[String(tabId)];
  ownTabMoves.delete(tabId);
  checkedNavigation.delete(tabId);
  saveSession();
}

/** Brave swapped a tab for a pre-rendered one: carry what we know across. */
function onTabReplaced(addedTabId: number, removedTabId: number): void {
  const track = session.tabs[String(removedTabId)];
  if (track) session.tabs[String(addedTabId)] = track;
  delete session.tabs[String(removedTabId)];
  for (const entry of Object.values(local.lastActive)) {
    if (entry.tabId === removedTabId) {
      entry.tabId = addedTabId;
      saveLocal('lastActive');
    }
  }
  saveSession();
}

// ---------------------------------------------------------------- group events

function onGroupCreated(group: chrome.tabGroups.TabGroup): void {
  stillSettling(group.windowId);
  const title = group.title ?? '';
  session.groups[String(group.id)] = { stableTitle: title, collapsed: group.collapsed, windowId: group.windowId };
  if (cleanTitle(title)) setProjects(addMissingProjects(local.projects, [{ title, color: colorOf(group) }]));
  saveSession();
  scheduleRemember(group.windowId);
}

function onGroupUpdated(group: chrome.tabGroups.TabGroup): void {
  const settlingNow = stillSettling(group.windowId);
  const track = session.groups[String(group.id)];
  if (!track) {
    onGroupCreated(group);
    return;
  }
  const title = group.title ?? '';
  const wasCollapsed = track.collapsed;
  track.collapsed = group.collapsed;
  track.windowId = group.windowId;
  if (title !== track.stableTitle) scheduleRename(group.id, title);
  else if (cleanTitle(title)) setProjects(setProjectColor(local.projects, title, colorOf(group)));
  saveSession();
  if (wasCollapsed !== group.collapsed) scheduleRemember(group.windowId);

  // The owner opened a folded group from the tab bar: make it the open project.
  const openedByOwner = wasCollapsed && !group.collapsed && !takeOwnOpen(group.id);
  if (openedByOwner && local.settings.follow && !settlingNow && !closingWindows.has(group.windowId)) {
    void exclusive(() => switchTo(group.windowId, group.id));
  }
}

function onGroupRemoved(group: chrome.tabGroups.TabGroup): void {
  delete session.groups[String(group.id)];
  ownOpens.delete(group.id);
  cancelRename(group.id);
  saveSession();
  scheduleRemember(group.windowId);
}

// ---------------------------------------------------------------- window events

function onWindowCreated(win: chrome.windows.Window): void {
  if (win.id !== undefined && win.type === 'normal') watchSettling(win.id);
}

function onWindowRemoved(windowId: number): void {
  closingWindows.delete(windowId);
  const entry = settling.get(windowId);
  if (entry) clearTimeout(entry.timer);
  settling.delete(windowId);
  const timer = rememberTimers.get(windowId);
  if (timer !== undefined) clearTimeout(timer);
  rememberTimers.delete(windowId);
  delete session.windows[String(windowId)];
  saveSession();
}

/** Brave just started: the windows it restores settle before anything reacts. */
async function onStartup(): Promise<void> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const win of windows) if (win.id !== undefined) watchSettling(win.id);
}

// ---------------------------------------------------------------- wiring (top level, as MV3 requires)

chrome.runtime.onInstalled.addListener(listen(() => undefined));
chrome.runtime.onStartup.addListener(listen(onStartup));

chrome.windows.onCreated.addListener(listen(onWindowCreated));
chrome.windows.onRemoved.addListener(listen(onWindowRemoved));

chrome.tabs.onCreated.addListener(listen(onTabCreated));
chrome.tabs.onUpdated.addListener(listen(onTabUpdated));
chrome.tabs.onActivated.addListener(listen(onTabActivated));
chrome.tabs.onRemoved.addListener(listen(onTabRemoved));
chrome.tabs.onReplaced.addListener(listen(onTabReplaced));

chrome.tabGroups.onCreated.addListener(listen(onGroupCreated));
chrome.tabGroups.onUpdated.addListener(listen(onGroupUpdated));
chrome.tabGroups.onRemoved.addListener(listen(onGroupRemoved));

chrome.commands.onCommand.addListener((command: string, tab?: chrome.tabs.Tab) => {
  if (command === 'open-project-row') {
    // Straight away: the popup has to open while the key press still counts.
    void openProjectRow(tab?.windowId).catch(report);
    return;
  }
  init()
    .then(() =>
      exclusive(async () => {
        let windowId = tab?.windowId;
        if (windowId === undefined || windowId < 0) windowId = (await chrome.windows.getLastFocused()).id;
        if (windowId !== undefined) await runCommand(command, windowId);
      }),
    )
    .catch(report);
});

chrome.storage.onChanged.addListener(
  listen((changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (changes['rules']) {
      local.rules = sanitizeRules(changes['rules'].newValue);
      void exclusive(() => sortLooseTabs());
    }
    if (changes['settings']) {
      local.settings = sanitizeSettings(changes['settings'].newValue);
      void applySurface().catch(report);
    }
  }),
);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: Reply) => void) => {
  if (sender.id !== chrome.runtime.id || !isMessage(message)) return false;
  init()
    .then(() => exclusive(() => handleMessage(message)))
    .then(async (result) => {
      await flushLocal();
      sendResponse({ ok: true, result });
    })
    .catch((err: unknown) => sendResponse({ ok: false, error: errorText(err) }));
  return true; // answers later
});
