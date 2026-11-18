/**
 * The project list. Three views of the same list:
 * - the side panel (left or right, wherever Brave's sidebar is): a column with
 *   everything, from switching to making and changing projects, and under each
 *   project its tabs, opened with the arrow;
 * - the project row (view=row): a row of project labels under the toolbar
 *   button, to switch quickly;
 * - the narrow project window (view=window): the side panel's list in a window
 *   of its own, attached to the side of its Brave window (see projectWindow.ts).
 * The order is always the tab bar's order. Every change is asked of the
 * background worker.
 */

import { toGroupInfo } from './lib/chromeShapes.js';
import { buildList, moveTarget, type ListItem } from './lib/list.js';
import { send } from './lib/messages.js';
import { startProjectWindow } from './projectWindow.js';
import { sanitizeExpanded, sanitizeNameLinks, sanitizeRules, sanitizeTabNames } from './lib/sanitize.js';
import { moveTabRow, projectTabRows, shortAddress, tabRowText, type TabForList, type TabRow } from './lib/tabList.js';
import { cleanTabName, MAX_TAB_NAME_LENGTH, tabLabels, type NameLinks } from './lib/tabNames.js';
import { cleanTitle, isStagingTitle, projectKey, withStagingMark } from './lib/titles.js';
import { GROUP_COLORS, NO_GROUP, type GroupColor, type GroupInfo, type Rule, type TabInfo, type TabName } from './lib/types.js';
import { attachTip, COLOR_NAMES, h, icon, keepFocus, plural, projectLabel, syncTip } from './ui.js';

const params = new URLSearchParams(location.search);
const rowView = params.get('view') === 'row';
/** The narrow project window: the side panel's list in a window of its own, beside Brave. */
const windowView = params.get('view') === 'window';
document.body.classList.toggle('row-view', rowView);
document.body.classList.toggle('window-view', windowView);

const listEl = document.getElementById('list') as HTMLUListElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;
const createEl = document.getElementById('create') as HTMLElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;

const data = {
  items: [] as ListItem[],
  /** Each project's tabs, by group id, in tab bar order. */
  tabs: new Map<number, TabRow[]>(),
  /** Projects whose tab list is open (project keys), as saved. */
  expanded: new Set<string>(),
  rules: [] as Rule[],
  shortcuts: new Map<string, string>(),
  /** Selected (highlighted) tabs in this window that can join a project. */
  selected: 0,
  loaded: false,
};

const ui = {
  menuFor: null as number | null,
  renaming: null as { groupId: number; value: string } | null,
  deleting: null as { groupId: number; removeRules: boolean } | null,
  creating: null as { value: string; color: GroupColor } | null,
  dragGroupId: null as number | null,
  /** A tab being dragged in its project's tab list. */
  dragTab: null as { tabId: number; groupId: number } | null,
  /** A tab whose name is being typed. */
  tabRenaming: null as { tabId: number; value: string } | null,
  /** Groups with no name have nothing to remember their open list by: kept here while the panel is open. */
  openUntitled: new Set<number>(),
  listWaiting: false,
  error: '',
};

/** Arrow clicks not saved yet: they show at once and win over what storage says until it agrees. */
const pendingExpand = new Map<string, boolean>();

let windowId = -1;

// ---------------------------------------------------------------- data

/**
 * What the panel knows about its window. All tabs and groups are read only
 * when the window's layout changes (a tab or group added, removed or moved).
 * Smaller news (a new title, another active tab, a group recoloured, saved
 * names) is applied to what the panel already holds, without asking the
 * browser again, and storage is read once and then followed through its
 * change events.
 */
type PanelTab = TabInfo & TabForList;

const known = {
  groups: [] as GroupInfo[],
  tabs: [] as PanelTab[],
  pinned: new Set<number>(),
  names: [] as TabName[],
  links: {} as NameLinks,
};
let labels = new Map<number, string>();

/** Rebuilds the project list and the tab lists from what is known. No browser calls. */
function rebuildModel(): void {
  data.items = buildList(known.groups, known.tabs, windowId);
  data.tabs = new Map(data.items.map((item) => [item.groupId, projectTabRows(known.tabs, windowId, item.groupId, labels)]));
  if (ui.menuFor !== null && !data.items.some((i) => i.groupId === ui.menuFor)) closeMenu();
  if (ui.tabRenaming && !known.tabs.some((t) => t.id === ui.tabRenaming?.tabId)) ui.tabRenaming = null;
}

function toPanelTab(t: chrome.tabs.Tab): PanelTab | null {
  if (t.id === undefined) return null;
  return {
    id: t.id,
    groupId: t.groupId ?? NO_GROUP,
    index: t.index,
    active: t.active,
    pinned: t.pinned,
    title: t.title ?? '',
    url: t.url || t.pendingUrl || '',
    windowId: t.windowId,
  };
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshOwed = false;

/** The window's layout changed: read its tabs and groups again, once the burst of events is over. */
function scheduleRefresh(): void {
  if (document.hidden) {
    refreshOwed = true; // nobody sees the panel: read when it shows again
    return;
  }
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 40);
}

async function refresh(): Promise<void> {
  refreshTimer = undefined;
  refreshOwed = false;
  try {
    const [groups, tabs] = await Promise.all([chrome.tabGroups.query({ windowId }), chrome.tabs.query({ windowId })]);
    known.groups = groups.map(toGroupInfo);
    known.tabs = tabs.map(toPanelTab).filter((t): t is PanelTab => t !== null);
    known.pinned = new Set(known.tabs.filter((t) => t.pinned).map((t) => t.id));
    data.selected = tabs.filter((t) => t.highlighted && !t.pinned).length;
    rebuildModel();
    data.loaded = true;
    renderFromOutside();
  } catch (err) {
    showError(err);
  }
}

/** Storage, read once at the start; later changes come with their new values (see onStorageChanged). */
async function loadStored(): Promise<void> {
  const [stored, saved] = await Promise.all([
    chrome.storage.local.get(['rules', 'expanded', 'tabNames']),
    chrome.storage.session.get('tabNameLinks'),
  ]);
  data.rules = sanitizeRules(stored['rules']);
  takeExpanded(stored['expanded']);
  known.names = sanitizeTabNames(stored['tabNames']);
  known.links = sanitizeNameLinks(saved['tabNameLinks']);
  labels = tabLabels(known.names, known.links);
}

function takeExpanded(raw: unknown): void {
  const expanded = new Set(sanitizeExpanded(raw));
  for (const [key, open] of pendingExpand) if (expanded.has(key) === open) pendingExpand.delete(key);
  data.expanded = expanded;
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  let names = false;
  if (area === 'local') {
    if (changes['rules']) data.rules = sanitizeRules(changes['rules'].newValue);
    if (changes['expanded']) takeExpanded(changes['expanded'].newValue);
    if (changes['tabNames']) {
      known.names = sanitizeTabNames(changes['tabNames'].newValue);
      names = true;
    }
    if (!changes['rules'] && !changes['expanded'] && !names) return; // the worker's own bookkeeping
  } else if (area === 'session') {
    if (!changes['tabNameLinks']) return;
    known.links = sanitizeNameLinks(changes['tabNameLinks'].newValue);
    names = true;
  } else {
    return;
  }
  if (names) labels = tabLabels(known.names, known.links);
  // New names, or a list opened in another window: its rows take the latest titles.
  if (names || changes['expanded']) rebuildModel();
  renderSoon();
}

// ---------------------------------------------------------------- browser events, applied to what is known

function onTabUpdated(tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
  if (tab.windowId !== windowId) return;
  if (change.groupId !== undefined || change.pinned !== undefined) {
    scheduleRefresh();
    return;
  }
  if (change.title === undefined && change.url === undefined) return; // icons, loading progress, sound
  const mine = known.tabs.find((t) => t.id === tabId);
  if (!mine) return; // a tab the panel has not read yet: the refresh for its arrival brings it
  mine.title = tab.title ?? '';
  mine.url = tab.url || tab.pendingUrl || '';
  // Titles and addresses show only in an open tab list; a ticking title elsewhere costs nothing.
  const item = data.items.find((i) => i.groupId === mine.groupId);
  if (!item || !isExpanded(item)) return;
  const row = data.tabs.get(mine.groupId)?.find((r) => r.id === tabId);
  if (!row) return;
  row.title = mine.title;
  row.url = mine.url;
  renderSoon(TITLE_RENDER_MS);
}

function onTabCreated(tab: chrome.tabs.Tab): void {
  if (tab.windowId !== windowId) return;
  // A tab in no project changes nothing the list shows (if it joins a group later, that is its own event).
  if ((tab.groupId ?? NO_GROUP) === NO_GROUP) {
    const added = toPanelTab(tab);
    if (added) known.tabs.push(added);
    return;
  }
  scheduleRefresh();
}

function onTabRemoved(tabId: number, info: chrome.tabs.OnRemovedInfo): void {
  if (info.windowId !== windowId || info.isWindowClosing) return;
  const gone = known.tabs.find((t) => t.id === tabId);
  if (!gone) return;
  known.tabs = known.tabs.filter((t) => t.id !== tabId);
  known.pinned.delete(tabId);
  if (gone.groupId === NO_GROUP) return; // the rest keep their order: nothing to redraw
  rebuildModel();
  renderSoon();
}

function onTabActivated(info: chrome.tabs.OnActivatedInfo): void {
  if (info.windowId !== windowId) return;
  if (!known.tabs.some((t) => t.id === info.tabId)) {
    scheduleRefresh();
    return;
  }
  for (const t of known.tabs) t.active = t.id === info.tabId;
  rebuildModel();
  renderSoon();
}

function onTabHighlighted(info: chrome.tabs.OnHighlightedInfo): void {
  if (info.windowId !== windowId) return;
  data.selected = info.tabIds.filter((id) => !known.pinned.has(id)).length;
  renderSoon();
}

function onGroupUpdated(group: chrome.tabGroups.TabGroup): void {
  if (group.windowId !== windowId) return;
  const mine = known.groups.find((g) => g.id === group.id);
  if (!mine) {
    scheduleRefresh();
    return;
  }
  const next = toGroupInfo(group);
  const shown = mine.title !== next.title || mine.color !== next.color;
  Object.assign(mine, next); // folding and opening change nothing the list shows
  if (!shown) return;
  rebuildModel();
  renderSoon();
}

async function refreshShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const next = new Map(
    commands.flatMap((c) => (c.name && c.shortcut ? [[c.name, c.shortcut] as [string, string]] : [])),
  );
  const same = next.size === data.shortcuts.size && [...next].every(([name, key]) => data.shortcuts.get(name) === key);
  if (same) return; // the panel got focus and nothing changed: leave the rows as they are
  data.shortcuts = next;
  renderFromOutside();
}

// ---------------------------------------------------------------- never redraw under a click

/**
 * A click is a press and a release on the same element. If the rows are drawn
 * again in between, the release lands on a new element and the browser drops
 * the click. That happened when a click also gave the panel focus: the focus
 * redrew the list and the first click was lost. So updates that come from
 * outside (tabs, groups, the panel getting focus) wait while a button is down.
 */
let pointerDown = false;
let renderWaiting = false;
let pointerSafety: ReturnType<typeof setTimeout> | undefined;

function releasePointer(): void {
  if (pointerSafety !== undefined) clearTimeout(pointerSafety);
  setTimeout(() => {
    pointerDown = false;
    if (renderWaiting) {
      renderWaiting = false;
      render();
    }
  }, 0);
}

document.addEventListener(
  'pointerdown',
  () => {
    pointerDown = true;
    if (pointerSafety !== undefined) clearTimeout(pointerSafety);
    pointerSafety = setTimeout(releasePointer, 3000); // released outside the panel: do not wait forever
  },
  true,
);
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);
window.addEventListener('blur', releasePointer);

function renderFromOutside(): void {
  if (pointerDown || document.hidden) {
    renderWaiting = true; // drawn when the button is up, or when the panel shows again
    return;
  }
  render();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (refreshOwed) void refresh();
  if (renderWaiting && !pointerDown) {
    renderWaiting = false;
    render();
  }
});

/** A new title redraws its row at most this often: a title that ticks every second is not redrawn on every tick. */
const TITLE_RENDER_MS = 400;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let renderDue = 0;

/** Draws soon, once for a burst of news. An earlier request wins over a later one. */
function renderSoon(delay = 16): void {
  const due = Date.now() + delay;
  if (renderTimer !== undefined) {
    if (renderDue <= due) return;
    clearTimeout(renderTimer);
  }
  renderDue = due;
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    renderFromOutside();
  }, delay);
}

// ---------------------------------------------------------------- actions

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showError(err: unknown): void {
  ui.error = errorText(err);
  render();
}

async function act(job: () => Promise<unknown>): Promise<void> {
  ui.error = '';
  try {
    await job();
  } catch (err) {
    ui.error = errorText(err);
  }
  render();
  scheduleRefresh();
}

function switchTo(item: ListItem): Promise<void> {
  closeMenu(); // picking a project puts away the menu that was open
  return act(async () => {
    await send({ type: 'switch', windowId, groupId: item.groupId });
    if (rowView) window.close(); // the row is a quick switcher: done
    if (windowView) await focusBrave();
  });
}

/** From the project window, the keyboard goes back to the page in Brave after a switch. */
async function focusBrave(): Promise<void> {
  await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
}

function closeMenu(): void {
  ui.menuFor = null;
  ui.renaming = null;
  ui.deleting = null;
}

function toggleMenu(groupId: number): void {
  const open = ui.menuFor !== groupId;
  closeMenu();
  if (open) ui.menuFor = groupId;
  render();
}

/** Moves a project in the list and its group in the tab bar: right before another one, or last (null). */
function moveProject(groupId: number, beforeGroupId: number | null): Promise<void> {
  // Show the new order at once; the tab bar follows and the next refresh confirms it.
  const moving = data.items.find((i) => i.groupId === groupId);
  if (moving) {
    const rest = data.items.filter((i) => i.groupId !== groupId);
    const at = beforeGroupId === null ? rest.length : rest.findIndex((i) => i.groupId === beforeGroupId);
    rest.splice(at < 0 ? rest.length : at, 0, moving);
    data.items = rest.map((item, i) => ({ ...item, number: i < 9 ? i + 1 : null }));
    render();
  }
  return act(() => send({ type: 'move', windowId, groupId, beforeGroupId }));
}

function moveBy(item: ListItem, step: -1 | 1): void {
  const before = moveTarget(data.items, item.groupId, step);
  if (before !== undefined) void moveProject(item.groupId, before);
}

// ---------------------------------------------------------------- tab lists (the arrow)

function isExpanded(item: ListItem): boolean {
  if (!item.key) return ui.openUntitled.has(item.groupId);
  return pendingExpand.get(item.key) ?? data.expanded.has(item.key);
}

/** The arrow: shows or hides a project's tabs. Only this changes it; switching projects never does. */
function toggleTabs(item: ListItem): void {
  const open = !isExpanded(item);
  if (!open && (data.tabs.get(item.groupId) ?? []).some((r) => r.id === ui.tabRenaming?.tabId)) ui.tabRenaming = null;
  if (!item.key) {
    if (open) ui.openUntitled.add(item.groupId);
    else ui.openUntitled.delete(item.groupId);
    if (open) rebuildModel();
    render();
    return;
  }
  const key = item.key;
  pendingExpand.set(key, open);
  if (open) rebuildModel(); // titles that changed while the list was closed
  render();
  void send({ type: 'expand', key, open }).catch((err: unknown) => {
    pendingExpand.delete(key);
    showError(err);
  });
}

/** A tab picked in the list: its project opens on it and the others fold. */
function showTab(row: TabRow): Promise<void> {
  return act(() => send({ type: 'showTab', tabId: row.id }));
}

function startTabRename(row: TabRow): void {
  ui.tabRenaming = { tabId: row.id, value: row.name };
  render();
  document.querySelector<HTMLInputElement>('input[data-focus="tab-name"]')?.select();
}

function saveTabName(tabId: number, value: string): Promise<void> {
  // Show the new name at once; the next refresh confirms it.
  for (const rows of data.tabs.values()) {
    const row = rows.find((r) => r.id === tabId);
    if (row) row.name = cleanTabName(value);
  }
  ui.tabRenaming = null;
  render();
  return act(() => send({ type: 'nameTab', tabId, name: value }));
}

function closeTabRow(groupId: number, row: TabRow): Promise<void> {
  const rows = data.tabs.get(groupId);
  if (rows) data.tabs.set(groupId, rows.filter((r) => r.id !== row.id));
  if (ui.tabRenaming?.tabId === row.id) ui.tabRenaming = null;
  render();
  return act(() => send({ type: 'closeTab', tabId: row.id }));
}

/** Moves a tab in its project's list, right before another tab or last (null); the tab bar follows. */
function moveTabInList(groupId: number, tabId: number, beforeTabId: number | null): Promise<void> {
  const rows = data.tabs.get(groupId);
  if (rows) {
    data.tabs.set(groupId, moveTabRow(rows, tabId, beforeTabId));
    render();
  }
  return act(() => send({ type: 'moveTab', tabId, beforeTabId }));
}

// ---------------------------------------------------------------- drag to reorder (the grip)

function dropSide(e: DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function clearDropMarks(): void {
  for (const el of listEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

function onDragStart(e: DragEvent, item: ListItem): void {
  ui.dragGroupId = item.groupId;
  const row = (e.currentTarget as HTMLElement).closest<HTMLElement>('.row');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.title || 'project');
    if (row) e.dataTransfer.setDragImage(row, 16, 16);
  }
  row?.classList.add('dragging');
}

function onDragOver(e: DragEvent, item: ListItem): void {
  if (ui.dragGroupId === null || ui.dragGroupId === item.groupId) return;
  e.preventDefault();
  clearDropMarks();
  (e.currentTarget as HTMLElement).classList.add(dropSide(e) === 'before' ? 'drop-before' : 'drop-after');
}

function onDrop(e: DragEvent, item: ListItem): void {
  if (ui.dragGroupId === null) return;
  e.preventDefault();
  const side = dropSide(e);
  const movingId = ui.dragGroupId;
  onDragEnd();
  if (movingId === item.groupId) return;
  const others = data.items.filter((x) => x.groupId !== movingId);
  const at = others.findIndex((x) => x.groupId === item.groupId);
  const before = side === 'before' ? item.groupId : (others[at + 1]?.groupId ?? null);
  void moveProject(movingId, before);
}

function onDragEnd(): void {
  ui.dragGroupId = null;
  clearDropMarks();
  for (const el of listEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
  if (ui.listWaiting) render();
}

// ---------------------------------------------------------------- drag a tab inside its project

function onTabDragStart(e: DragEvent, groupId: number, row: TabRow): void {
  e.stopPropagation();
  ui.dragTab = { tabId: row.id, groupId };
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabRowText(row));
  }
  (e.currentTarget as HTMLElement).classList.add('dragging');
}

function onTabDragOver(e: DragEvent, groupId: number, row: TabRow): void {
  const drag = ui.dragTab;
  if (!drag || drag.groupId !== groupId || drag.tabId === row.id) return; // only inside its own project
  e.preventDefault();
  e.stopPropagation();
  clearDropMarks();
  (e.currentTarget as HTMLElement).classList.add(dropSide(e) === 'before' ? 'drop-before' : 'drop-after');
}

function onTabDrop(e: DragEvent, groupId: number, row: TabRow): void {
  const drag = ui.dragTab;
  if (!drag || drag.groupId !== groupId) return;
  e.preventDefault();
  e.stopPropagation();
  const side = dropSide(e);
  onTabDragEnd();
  if (drag.tabId === row.id) return;
  const others = (data.tabs.get(groupId) ?? []).filter((r) => r.id !== drag.tabId);
  const at = others.findIndex((r) => r.id === row.id);
  const before = side === 'before' ? row.id : (others[at + 1]?.id ?? null);
  void moveTabInList(groupId, drag.tabId, before);
}

function onTabDragEnd(): void {
  ui.dragTab = null;
  clearDropMarks();
  for (const el of listEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
  if (ui.listWaiting) render();
}

// ---------------------------------------------------------------- drawing

function render(): void {
  keepFocus(() => {
    if (rowView) renderRow();
    else {
      renderList();
      renderCreate();
    }
  });
  syncTip();
  errorEl.hidden = !ui.error;
  errorEl.textContent = ui.error;
}

function displayName(item: ListItem): string {
  return item.title || 'Untitled group';
}

/** What the project row shows, as a string: it is rebuilt only when that changes. */
let listKey = '';
let createKey = '';

/**
 * Every row drawn last time, by a key made of everything it shows. A row whose
 * key is unchanged is kept as it is (with its hover and focus), so a new title
 * redraws one row, not the list.
 */
let rowCache = new Map<string, HTMLElement>();

function keep<T extends HTMLElement>(next: Map<string, HTMLElement>, key: string, build: () => T): T {
  const el = (rowCache.get(key) as T | undefined) ?? build();
  next.set(key, el);
  return el;
}

/**
 * Puts exactly these children into `parent`, in this order, touching only what
 * differs: rows no longer wanted go first, then new or moved rows are put in
 * place. One changed row is one removal and one insertion; the rows around it
 * stay where they are.
 */
function patchChildren(parent: Element, wanted: readonly Element[]): void {
  const keepers = new Set(wanted);
  for (const child of Array.from(parent.children)) if (!keepers.has(child)) child.remove();
  let cursor = parent.firstElementChild;
  for (const el of wanted) {
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    parent.insertBefore(el, cursor);
  }
}

/** The project row: labels like Brave's group labels, in tab bar order. */
function renderRow(): void {
  emptyEl.hidden = !data.loaded || data.items.length > 0;
  const key = JSON.stringify(['row', data.items]);
  if (key === listKey) return;
  listKey = key;
  listEl.replaceChildren(
    ...data.items.map((item) =>
      h(
        'li',
        { class: 'chip-item' },
        h(
          'button',
          {
            type: 'button',
            class: item.current ? 'chip current' : 'chip',
            'data-color': item.color,
            title: `${displayName(item)}: ${plural(item.tabCount, 'tab', 'tabs')}${item.number ? `. Key ${item.number}` : ''}`,
            'aria-current': item.current ? 'true' : undefined,
            onclick: () => void switchTo(item),
          },
          item.number !== null ? h('span', { class: 'chip-number' }, item.number) : null,
          h('span', { class: 'chip-name' }, displayName(item)),
        ),
      ),
    ),
  );
}

function renderList(): void {
  emptyEl.hidden = !data.loaded || data.items.length > 0;
  if (ui.dragGroupId !== null || ui.dragTab !== null) {
    ui.listWaiting = true; // redrawing now would cancel the drag
    return;
  }
  ui.listWaiting = false;
  const next = new Map<string, HTMLElement>();
  const rows: HTMLElement[] = [];
  data.items.forEach((item) => {
    const shortcut = item.number !== null ? (data.shortcuts.get(`project-${item.number}`) ?? '') : '';
    const open = isExpanded(item);
    const menu = ui.menuFor === item.groupId;
    rows.push(keep(next, JSON.stringify(['row', item, shortcut, open, menu, ui.renaming === null]), () => renderItem(item)));
    if (menu) {
      const rules = item.key ? data.rules.filter((r) => projectKey(r.project) === item.key).length : 0;
      const key = JSON.stringify(['menu', item, ui.renaming, ui.deleting, rules]);
      rows.push(keep(next, key, () => renderMenu(item)));
    }
    if (open) rows.push(renderTabs(item, next));
  });
  rowCache = next;
  patchChildren(listEl, rows);
}

function renderItem(item: ListItem): HTMLLIElement {
  const name = displayName(item);
  const label = projectLabel(name); // "🔵 Admin" shows its circle once, in the dot's place
  const tabs = plural(item.tabCount, 'tab', 'tabs');
  const shortcut = item.number !== null ? data.shortcuts.get(`project-${item.number}`) : undefined;
  const open = isExpanded(item);
  const arrowLabel = open ? `Hide the tabs of ${name}` : `Show the tabs of ${name}`;
  const classes = ['row', item.current && 'current', ui.menuFor === item.groupId && 'menu-open'].filter(Boolean);
  return h(
    'li',
    {
      class: classes.join(' '),
      'data-color': item.color,
      'data-group': String(item.groupId),
      ondragover: (e: DragEvent) => onDragOver(e, item),
      ondrop: (e: DragEvent) => onDrop(e, item),
      onkeydown: (e: KeyboardEvent) => {
        // The keyboard's way to reorder: Alt+Up and Alt+Down on a project.
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        moveBy(item, e.key === 'ArrowUp' ? -1 : 1);
      },
    },
    h('span', {
      class: 'grip',
      title: 'Drag to change the order (the tab bar follows). From the keyboard: Alt+Up, Alt+Down',
      draggable: ui.renaming === null,
      ondragstart: (e: DragEvent) => onDragStart(e, item),
      ondragend: onDragEnd,
    }),
    h(
      'button',
      {
        class: 'twisty',
        type: 'button',
        title: arrowLabel,
        'aria-label': arrowLabel,
        'aria-expanded': String(open),
        onclick: () => toggleTabs(item),
      },
      h('span', { class: 'twisty-icon', 'aria-hidden': 'true' }),
    ),
    h(
      'button',
      {
        class: 'main',
        type: 'button',
        title: item.current ? `${name} (${tabs}) is open` : `Show ${name} (${tabs})`,
        'aria-current': item.current ? 'true' : undefined,
        onclick: () => void switchTo(item),
      },
      label.icon,
      h('span', { class: item.title ? 'name' : 'name untitled' }, label.name),
      shortcut ? h('span', { class: 'key' }, shortcut) : null,
      h('span', { class: 'count', 'aria-label': tabs }, item.tabCount),
    ),
    h(
      'button',
      {
        class: 'more',
        type: 'button',
        title: `Change ${name}`,
        'aria-label': `Change ${name}`,
        'aria-expanded': String(ui.menuFor === item.groupId),
        onclick: () => toggleMenu(item.groupId),
      },
      '⋯',
    ),
  );
}

/** A project's tabs, under its row, in tab bar order. */
function renderTabs(item: ListItem, next: Map<string, HTMLElement>): HTMLElement {
  const name = displayName(item);
  const box = keep(next, JSON.stringify(['tabs', item.groupId, item.color, name]), () =>
    h(
      'li',
      { class: 'tabs', 'data-color': item.color, 'data-group': String(item.groupId) },
      h('ul', { class: 'tab-list', 'aria-label': `Tabs of ${name}` }),
    ),
  );
  const rows: HTMLElement[] = [];
  for (const row of data.tabs.get(item.groupId) ?? []) {
    const editing = ui.tabRenaming?.tabId === row.id ? ui.tabRenaming : null;
    rows.push(
      editing
        ? keep(next, JSON.stringify(['edit', item.groupId, row, editing]), () => renderTabRename(row, editing))
        : keep(next, JSON.stringify(['tab', item.groupId, row, ui.tabRenaming === null]), () => renderTab(item, row)),
    );
  }
  const list = box.firstElementChild;
  if (list) patchChildren(list, rows);
  return box;
}

function renderTab(item: ListItem, row: TabRow): HTMLLIElement {
  const text = tabRowText(row);
  const tip = [row.name, row.title, shortAddress(row.url)].filter(Boolean).join('\n');
  return h(
    'li',
    {
      class: ['tab-row', row.active && 'current', row.name && 'named'].filter(Boolean).join(' '),
      'data-tab': String(row.id),
      draggable: ui.tabRenaming === null,
      ondragstart: (e: DragEvent) => onTabDragStart(e, item.groupId, row),
      ondragover: (e: DragEvent) => onTabDragOver(e, item.groupId, row),
      ondrop: (e: DragEvent) => onTabDrop(e, item.groupId, row),
      ondragend: onTabDragEnd,
    },
    h(
      'button',
      {
        type: 'button',
        class: 'tab-main',
        title: tip,
        'aria-current': row.active ? 'true' : undefined,
        onclick: () => void showTab(row),
      },
      h('span', { class: 'tab-name' }, text),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'tab-act tab-rename',
        title: row.name ? 'Rename this tab' : 'Give this tab a name',
        'aria-label': `Rename ${text}`,
        onclick: () => startTabRename(row),
      },
      '✎',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'tab-act tab-close',
        title: 'Close this tab',
        'aria-label': `Close ${text}`,
        onclick: () => void closeTabRow(item.groupId, row),
      },
      '✕',
    ),
  );
}

const TAB_NAME_HINT = 'Enter saves. Leave it empty to show the page title.';

/** The i inside a field: its hint shows in a tooltip on hover. */
function infoTip(text: string): HTMLSpanElement {
  const icon = h('span', { class: 'info-tip', 'data-tip': text, 'aria-hidden': 'true' }, 'i');
  attachTip(icon, text);
  return icon;
}

function renderTabRename(row: TabRow, state: { tabId: number; value: string }): HTMLLIElement {
  const save = (): void => void saveTabName(row.id, state.value);
  const cancel = (): void => {
    ui.tabRenaming = null;
    render();
  };
  return h(
    'li',
    { class: 'tab-row editing', 'data-tab': String(row.id) },
    h(
      'div',
      { class: 'tab-field' },
      h('input', {
        type: 'text',
        class: 'text tab-input',
        value: state.value,
        maxLength: MAX_TAB_NAME_LENGTH,
        placeholder: row.title || shortAddress(row.url) || 'Tab name',
        'aria-label': 'Tab name',
        'aria-describedby': 'tab-name-hint',
        'data-focus': 'tab-name',
        oninput: (e: Event) => {
          state.value = (e.target as HTMLInputElement).value;
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          }
        },
      }),
      // The hint lives in the field: an i that shows it on hover, never a line of small print under it.
      infoTip(TAB_NAME_HINT),
      h('span', { id: 'tab-name-hint', class: 'sr-only' }, TAB_NAME_HINT),
    ),
    h(
      'button',
      { type: 'button', class: 'tab-act tab-save', title: 'Save the name', 'aria-label': 'Save the name', onclick: save },
      '✓',
    ),
    h('button', { type: 'button', class: 'tab-act tab-cancel', title: 'Cancel', 'aria-label': 'Cancel', onclick: cancel }, '✕'),
  );
}

/**
 * The colours, in one row. When the row is too narrow for all nine, it shows
 * as many as fit (always with the chosen one) and a + for the others, which
 * opens them under it until a colour is picked.
 */
function swatches(selected: GroupColor, onPick: (color: GroupColor) => void, label: string, disabled = false): HTMLDivElement {
  const more: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: 'swatch-more',
      title: 'More colours',
      'aria-label': 'More colours',
      'aria-expanded': 'false',
      hidden: true,
      onclick: () => {
        const open = box.classList.toggle('open');
        more.setAttribute('aria-expanded', String(open));
        more.title = open ? 'Fewer colours' : 'More colours';
        more.setAttribute('aria-label', more.title);
        more.textContent = open ? '\u2212' : '+';
        fitSwatches(box);
      },
    },
    '+',
  );
  const box: HTMLDivElement = h(
    'div',
    { class: 'swatches fit', role: 'group', 'aria-label': label },
    ...GROUP_COLORS.map((color) =>
      h('button', {
        type: 'button',
        class: 'swatch',
        'data-color': color,
        title: disabled ? 'Staging projects are orange' : COLOR_NAMES[color],
        'aria-label': COLOR_NAMES[color],
        'aria-pressed': String(color === selected),
        disabled,
        onclick: () => onPick(color),
      }),
    ),
    more,
  );
  swatchWatcher.observe(box);
  return box;
}

const SWATCH_SIZE = 22;
const SWATCH_GAP = 6;
/** The room the chosen colour's ring needs around a row that hides what does not fit. */
const SWATCH_RING = 3;

/** Shows as many colours as the row has room for: the rest wait behind the +. */
function fitSwatches(box: HTMLElement): void {
  const colors = [...box.querySelectorAll<HTMLButtonElement>('.swatch')];
  const more = box.querySelector<HTMLButtonElement>('.swatch-more');
  if (!more) return;
  const room = box.clientWidth - 2 * SWATCH_RING;
  if (room <= 0) return; // not drawn yet, or hidden: measured when it shows
  if (box.classList.contains('open')) {
    for (const c of colors) c.hidden = false;
    more.hidden = false;
    return;
  }
  const slots = Math.floor((room + SWATCH_GAP) / (SWATCH_SIZE + SWATCH_GAP));
  if (slots >= colors.length) {
    for (const c of colors) c.hidden = false;
    more.hidden = true;
    return;
  }
  const shown = Math.max(1, slots - 1);
  colors.forEach((c, i) => (c.hidden = i >= shown));
  const chosen = colors.findIndex((c) => c.getAttribute('aria-pressed') === 'true');
  if (chosen >= shown) {
    const last = colors[shown - 1];
    const pick = colors[chosen];
    if (last) last.hidden = true;
    if (pick) pick.hidden = false;
  }
  more.hidden = false;
}

/** One watcher for every colour row: a row fits itself again when its width changes, and stops being watched when it goes. */
const swatchWatcher = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const box = entry.target as HTMLElement;
    if (!box.isConnected) swatchWatcher.unobserve(box);
    else fitSwatches(box);
  }
});

function stagingToggle(on: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  return h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: on,
      onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
    }),
    'Staging (adds \u{1F7E0} and uses orange)',
  );
}

/**
 * A project's menu: one row of colours and two icons, rename and delete, which
 * share the colours' row when there is room and take a second row when not.
 * The order is changed by dragging the grip (or Alt+Up, Alt+Down).
 */
function renderMenu(item: ListItem): HTMLLIElement {
  if (ui.renaming?.groupId === item.groupId) return renderRename(item, ui.renaming);
  if (ui.deleting?.groupId === item.groupId) return renderDelete(item, ui.deleting);
  const name = displayName(item);
  const renameLabel = item.title ? 'Rename' : 'Name it';
  return h(
    'li',
    { class: 'menu', 'data-color': item.color },
    swatches(item.color, (color) => void act(() => send({ type: 'recolor', groupId: item.groupId, color })), `Colour of ${name}`),
    h(
      'div',
      { class: 'menu-icons' },
      h(
        'button',
        { type: 'button', class: 'icon-btn', title: renameLabel, 'aria-label': renameLabel, onclick: () => startRename(item) },
        icon('edit'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn danger',
          title: 'Delete the project (its tabs stay open)',
          'aria-label': 'Delete',
          onclick: () => startDelete(item),
        },
        icon('delete'),
      ),
    ),
  );
}

function startRename(item: ListItem): void {
  ui.renaming = { groupId: item.groupId, value: item.title };
  ui.deleting = null;
  render();
  document.querySelector<HTMLInputElement>('input[data-focus="rename"]')?.select();
}

function renderRename(item: ListItem, state: { groupId: number; value: string }): HTMLLIElement {
  const title = cleanTitle(state.value);
  const canSave = title !== '' && title !== item.title;
  const save = (): void => {
    if (!canSave) return;
    void act(async () => {
      await send({ type: 'rename', groupId: item.groupId, title: state.value });
      closeMenu();
    });
  };
  const cancel = (): void => {
    ui.renaming = null;
    render();
  };
  return h(
    'li',
    { class: 'menu form', 'data-color': item.color },
    h('input', {
      type: 'text',
      class: 'text',
      value: state.value,
      maxLength: 80,
      placeholder: 'Project name',
      'aria-label': 'New name',
      'data-focus': 'rename',
      oninput: (e: Event) => {
        state.value = (e.target as HTMLInputElement).value;
        render();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      },
    }),
    stagingToggle(isStagingTitle(state.value), (on) => {
      state.value = withStagingMark(state.value, on);
      render();
    }),
    h(
      'div',
      { class: 'menu-actions' },
      h('button', { type: 'button', onclick: cancel }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', disabled: !canSave, onclick: save }, 'Save'),
    ),
  );
}

function startDelete(item: ListItem): void {
  ui.deleting = { groupId: item.groupId, removeRules: false };
  ui.renaming = null;
  render();
}

function renderDelete(item: ListItem, state: { groupId: number; removeRules: boolean }): HTMLLIElement {
  const name = displayName(item);
  const rules = item.key ? data.rules.filter((r) => projectKey(r.project) === item.key).length : 0;
  const tabsLine = item.tabCount === 1 ? 'Its tab stays open.' : `All ${item.tabCount} tabs stay open.`;
  return h(
    'li',
    { class: 'menu form', 'data-color': item.color },
    h('p', { class: 'confirm' }, `Delete the project “${name}”? ${tabsLine} Only the group goes away.`),
    rules > 0
      ? h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: state.removeRules,
            onchange: (e: Event) => {
              state.removeRules = (e.target as HTMLInputElement).checked;
            },
          }),
          rules === 1
            ? 'Also delete its address. If you keep it, the next matching tab makes this project again.'
            : `Also delete its ${rules} addresses. If you keep them, the next matching tab makes this project again.`,
        )
      : null,
    h(
      'div',
      { class: 'menu-actions' },
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            ui.deleting = null;
            render();
          },
        },
        'Cancel',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'primary danger',
          onclick: () =>
            void act(async () => {
              await send({ type: 'delete', groupId: item.groupId, removeRules: state.removeRules });
              closeMenu();
            }),
        },
        'Delete project',
      ),
    ),
  );
}

function renderCreate(): void {
  const count = Math.max(1, data.selected);
  const state = ui.creating;
  const key = JSON.stringify([state, count]);
  if (key === createKey) return; // unchanged: keep the button under the pointer as it is
  createKey = key;
  if (!state) {
    createEl.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: 'new',
          title: count > 1 ? `New project from the ${count} selected tabs` : 'New project from the current tab',
          onclick: () => {
            ui.creating = { value: '', color: 'blue' };
            render();
            document.querySelector<HTMLInputElement>('input[data-focus="create"]')?.focus();
          },
        },
        h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'),
        h(
          'span',
          { class: 'new-text' },
          'New project',
          h('small', null, count > 1 ? `from the ${count} selected tabs` : 'from the current tab'),
        ),
      ),
    );
    return;
  }

  const staging = isStagingTitle(state.value);
  const color: GroupColor = staging ? 'orange' : state.color;
  const canCreate = cleanTitle(state.value) !== '';
  const create = (): void => {
    if (!canCreate) return;
    void act(async () => {
      await send({ type: 'create', windowId, title: state.value, color });
      ui.creating = null;
    });
  };
  const cancel = (): void => {
    ui.creating = null;
    render();
  };
  createEl.replaceChildren(
    h('h2', null, 'New project'),
    h('input', {
      type: 'text',
      class: 'text',
      value: state.value,
      maxLength: 80,
      placeholder: 'Name, for example Admin',
      'aria-label': 'Project name',
      'data-focus': 'create',
      oninput: (e: Event) => {
        state.value = (e.target as HTMLInputElement).value;
        render();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') create();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      },
    }),
    stagingToggle(staging, (on) => {
      state.value = withStagingMark(state.value, on);
      render();
    }),
    swatches(
      color,
      (picked) => {
        state.color = picked;
        render();
      },
      'Colour',
      staging,
    ),
    h(
      'p',
      { class: 'hint' },
      count > 1
        ? `Uses the ${count} selected tabs.`
        : 'Uses the current tab. To use more, select tabs in the tab bar with Ctrl or Shift.',
    ),
    h(
      'div',
      { class: 'menu-actions' },
      h('button', { type: 'button', onclick: cancel }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', disabled: !canCreate, onclick: create }, 'Create'),
    ),
  );
}

// ---------------------------------------------------------------- start

function wireEvents(): void {
  // A menu stays open only while the owner works in it. A click anywhere else closes it;
  // on another project's ⋯ that is all it does (a second click opens that one).
  document.addEventListener(
    'click',
    (e) => {
      if (ui.menuFor === null) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest('.menu')) return;
      const more = target.closest('.more');
      if (more && target.closest('.row')?.classList.contains('menu-open')) return; // its own ⋯ closes it
      closeMenu();
      render();
      if (more) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  // The window's layout changed (only this window's events count): read it again.
  const mine = (id: number) => id === windowId;
  chrome.tabs.onCreated.addListener(onTabCreated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onMoved.addListener((_id, info) => mine(info.windowId) && scheduleRefresh());
  chrome.tabs.onAttached.addListener((_id, info) => mine(info.newWindowId) && scheduleRefresh());
  chrome.tabs.onDetached.addListener((_id, info) => mine(info.oldWindowId) && scheduleRefresh());
  chrome.tabGroups.onCreated.addListener((group) => mine(group.windowId) && scheduleRefresh());
  chrome.tabGroups.onRemoved.addListener((group) => mine(group.windowId) && scheduleRefresh());
  chrome.tabGroups.onMoved.addListener((group) => mine(group.windowId) && scheduleRefresh());
  // Smaller news is applied to what the panel already knows.
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onHighlighted.addListener(onTabHighlighted);
  chrome.tabGroups.onUpdated.addListener(onGroupUpdated);
  chrome.storage.onChanged.addListener(onStorageChanged);
  window.addEventListener('focus', () => void refreshShortcuts());

  document.getElementById('open-options')?.addEventListener('click', () => void chrome.runtime.openOptionsPage());
  document
    .getElementById('open-shortcuts')
    ?.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  document.addEventListener('keydown', (e) => {
    if (rowView) {
      // The row: 1 to 9 opens that project, Escape closes the row.
      const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      const item = n ? data.items[n - 1] : undefined;
      if (item) void switchTo(item);
      if (e.key === 'Escape') window.close();
      return;
    }
    if (e.key !== 'Escape' || (ui.menuFor === null && !ui.creating && !ui.tabRenaming)) return;
    closeMenu();
    ui.creating = null;
    ui.tabRenaming = null;
    render();
  });
}

async function main(): Promise<void> {
  if (windowView) {
    // The narrow project window belongs to one Brave window, which the worker names; it keeps itself beside it.
    const browser = await startProjectWindow();
    if (browser === null) return; // this window closes instead
    windowId = browser;
  } else {
    const fromQuery = Number(params.get('windowId'));
    windowId = Number.isInteger(fromQuery) && fromQuery > 0 ? fromQuery : ((await chrome.windows.getCurrent()).id ?? -1);
  }
  wireEvents();
  await loadStored();
  await Promise.all([refresh(), refreshShortcuts()]);
}

void main().catch(showError);
