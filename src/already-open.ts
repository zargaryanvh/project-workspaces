/**
 * Shown in a new tab instead of a project address that is already open
 * elsewhere. Close this tab goes to the open one; Open anyway loads the
 * address here after all; or pick one of your tabs on that site.
 */

import { sameAddress } from './lib/duplicates.js';
import { send } from './lib/messages.js';
import { hostKey, urlHost } from './lib/rules.js';
import { isGroupColor, sanitizeNameLinks, sanitizeTabNames } from './lib/sanitize.js';
import { tabLabels } from './lib/tabNames.js';
import type { GroupColor } from './lib/types.js';
import { NO_GROUP } from './lib/types.js';
import { h, projectLabel } from './ui.js';

const url = new URLSearchParams(location.search).get('u') ?? '';
const host = hostKey(url);
const hostname = urlHost(url)?.hostname ?? host;

const titleEl = document.getElementById('title') as HTMLHeadingElement;
const addressEl = document.getElementById('address') as HTMLParagraphElement;
const whereEl = document.getElementById('where') as HTMLParagraphElement;
const listTitle = document.getElementById('list-title') as HTMLHeadingElement;
const listEl = document.getElementById('tabs') as HTMLUListElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;
const anywayBtn = document.getElementById('anyway') as HTMLButtonElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;

interface OpenTab {
  id: number;
  title: string;
  url: string;
  windowId: number;
  index: number;
  exact: boolean;
  project: string;
  color: GroupColor;
}

let selfId: number | undefined;
let selfWindow: number | undefined;
let best: OpenTab | undefined;

function shortUrl(full: string): string {
  try {
    const u = new URL(full);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return full;
  }
}

function showError(err: unknown): void {
  errorEl.hidden = false;
  errorEl.textContent = err instanceof Error ? err.message : String(err);
}

async function openTabs(): Promise<OpenTab[]> {
  const [tabs, stored, saved] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.storage.local.get('tabNames'),
    chrome.storage.session.get('tabNameLinks'),
  ]);
  // The names given in the project list tell apart tabs of one site (two accounts, say).
  const names = tabLabels(sanitizeTabNames(stored['tabNames']), sanitizeNameLinks(saved['tabNameLinks']));
  const groupIds = [...new Set(tabs.map((t) => t.groupId).filter((g) => g !== NO_GROUP))];
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  await Promise.all(
    groupIds.map(async (id) => {
      const group = await chrome.tabGroups.get(id).catch(() => null);
      if (group) groups.set(id, group);
    }),
  );
  return tabs
    .filter((t) => t.id !== undefined && t.id !== selfId && hostKey(t.url) === host)
    .map((t) => {
      const group = groups.get(t.groupId);
      return {
        id: t.id as number,
        title: names.get(t.id as number) || t.title || shortUrl(t.url ?? ''),
        url: t.url ?? '',
        windowId: t.windowId,
        index: t.index,
        exact: sameAddress(t.url ?? '', url),
        project: group?.title || (group ? 'Untitled group' : 'No project'),
        color: group && isGroupColor(group.color) ? group.color : 'grey',
      };
    })
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        Number(b.windowId === selfWindow) - Number(a.windowId === selfWindow) ||
        a.index - b.index,
    );
}

function goTo(tab: OpenTab): void {
  void send({ type: 'goToTab', tabId: tab.id, ...(selfId !== undefined ? { closeTabId: selfId } : {}) }).catch(showError);
}

/** What the page shows, as a string: it is redrawn only when that changes. */
let lastKey = '';

async function render(): Promise<void> {
  const tabs = await openTabs();
  const key = JSON.stringify(tabs);
  if (key === lastKey) return; // keep the same buttons, so a click in progress still lands
  lastKey = key;
  best = tabs[0];
  const exact = tabs.some((t) => t.exact);
  titleEl.textContent = exact ? 'This page is already open' : `${hostname} is already open`;
  document.title = `Already open: ${hostname}`;
  addressEl.textContent = `You opened ${shortUrl(url)}`;
  addressEl.title = url;

  if (!best) {
    titleEl.textContent = `${hostname} is not open anymore`;
    whereEl.textContent = 'The other tab was closed. You can open the page here.';
    closeBtn.textContent = 'Open the page';
    closeBtn.onclick = () => openAnyway();
    anywayBtn.hidden = true;
    listTitle.hidden = true;
    listEl.replaceChildren();
    return;
  }
  closeBtn.textContent = 'Close this tab';
  closeBtn.onclick = () => best && goTo(best);
  anywayBtn.hidden = false;
  whereEl.textContent = `Close this tab and go to ${best.exact ? 'the same page' : 'your tab'}: ${best.title}${
    best.project === 'No project' ? '' : ` (in ${best.project})`
  }.`;
  listTitle.hidden = false;
  listTitle.textContent = tabs.length === 1 ? `Your tab on ${hostname}` : `Your ${tabs.length} tabs on ${hostname}`;
  listEl.replaceChildren(
    ...tabs.map((tab) =>
      h(
        'li',
        null,
        h(
          'button',
          { type: 'button', class: 'tab', title: tab.url, onclick: () => goTo(tab) },
          h(
            'span',
            { class: 'project', 'data-color': tab.color },
            projectLabel(tab.project).icon,
            h('span', { class: 'project-name' }, projectLabel(tab.project).name),
          ),
          h('span', { class: 'tab-title' }, tab.title),
          h('span', { class: 'tab-url' }, shortUrl(tab.url)),
          tab.exact ? h('span', { class: 'same' }, 'Same page') : null,
        ),
      ),
    ),
  );
}

function openAnyway(): void {
  if (selfId === undefined) {
    location.replace(url);
    return;
  }
  void send({ type: 'openAnyway', tabId: selfId, url }).catch(showError);
}

async function main(): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('This page needs a web address.');
  const self = await chrome.tabs.getCurrent();
  selfId = self?.id;
  selfWindow = self?.windowId;
  anywayBtn.addEventListener('click', openAnyway);
  await render();
  closeBtn.focus();
  // Another tab changing (a title, an address) must not redraw the list under a click.
  let pointerDown = false;
  let waiting = false;
  const release = () =>
    setTimeout(() => {
      pointerDown = false;
      if (waiting) {
        waiting = false;
        void render().catch(showError);
      }
    }, 0);
  document.addEventListener('pointerdown', () => (pointerDown = true), true);
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  const again = () => {
    if (pointerDown) waiting = true;
    else void render().catch(showError);
  };
  chrome.tabs.onRemoved.addListener(again);
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.url !== undefined || change.title !== undefined || change.groupId !== undefined) again();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && changes['tabNames']) || (area === 'session' && changes['tabNameLinks'])) again();
  });
}

void main().catch(showError);
