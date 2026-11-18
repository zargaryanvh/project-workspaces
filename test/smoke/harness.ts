import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Helpers for the smoke test: a local page server, the browser, and the real side panel. */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The built extension: dist/, or DIST_DIR when the build went somewhere else. */
export const DIST = process.env['DIST_DIR'] ? path.resolve(ROOT, process.env['DIST_DIR']) : path.join(ROOT, 'dist');
/** Test-only helper extension: reopens a closed window the way Ctrl+Shift+T does. */
export const HELPER = path.join(ROOT, 'test', 'helper-ext');

export type BrowserKind = 'chromium' | 'brave';

export function findBrave(): string | null {
  const local = process.env['LOCALAPPDATA'];
  const candidates = [
    process.env['BRAVE_PATH'],
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    local ? path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : undefined,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/brave-browser',
  ];
  return candidates.find((p): p is string => typeof p === 'string' && existsSync(p)) ?? null;
}

// ---------------------------------------------------------------- local pages

export interface PageServer {
  port: number;
  /** Requests per host + path. A page load is one request, so a reload shows up here. */
  hits: Map<string, number>;
  url(host: string, pathname: string, link?: string): string;
  close(): Promise<void>;
}

/**
 * Serves tiny pages on 127.0.0.1. The browser maps admin.example.com and the
 * other test hosts to it, so nothing leaves the computer. Each page keeps a
 * random id from its load: if it is reloaded, the id changes.
 */
export async function startPageServer(): Promise<PageServer> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', 'http://local');
    const key = `${host}${url.pathname}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(404);
      res.end();
      return;
    }
    const name = url.pathname.slice(1) || 'home';
    const link = url.searchParams.get('link') ?? '#';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>${name}</title>` +
        `<h1>${host} ${name}</h1><a id="link" href="${link}" target="_blank">open link</a>` +
        `<script>window.__loadId = Math.random().toString(36).slice(2);</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (host, pathname, link) =>
      `http://${host}:${port}${pathname}${link ? `?link=${encodeURIComponent(link)}` : ''}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------- browser

export async function extensionWorker(ctx: BrowserContext): Promise<Worker> {
  const isOurs = (w: Worker) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
  return (
    ctx.serviceWorkers().find(isOurs) ??
    (await ctx.waitForEvent('serviceworker', { predicate: isOurs, timeout: 30_000 }))
  );
}

/** Starts Chromium or Brave with dist/ loaded and a throwaway profile. Headless: nothing pops up. */
export async function launchBrowser(
  userDataDir: string,
  kind: BrowserKind,
  extraArgs: string[] = [],
  options: { realScreen?: boolean } = {},
): Promise<{ ctx: BrowserContext; sw: Worker; extensionId: string }> {
  const brave = kind === 'brave' ? findBrave() : null;
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    // Window tests need pages to see the browser's own screen (not Playwright's 1280x720 viewport),
    // so the screen a page reports and the one window bounds are checked against agree.
    ...(options.realScreen ? { viewport: null } : {}),
    ...(brave ? { executablePath: brave } : { channel: 'chromium' }),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${DIST},${HELPER}`,
      `--load-extension=${DIST},${HELPER}`,
      '--host-resolver-rules=MAP *.example.com 127.0.0.1, MAP example.com 127.0.0.1, MAP *.test 127.0.0.1',
      ...extraArgs,
    ],
  });
  const sw = await extensionWorker(ctx);
  return { ctx, sw, extensionId: new URL(sw.url()).host };
}

/**
 * Reopens the most recently closed window, as Ctrl+Shift+T does, through the
 * test helper. The API reports "No active tab" in automated runs even though
 * the window comes back, so that error is ignored and the window is found by
 * looking. Returns the reopened window's id.
 */
export async function reopenLastClosed(ctx: BrowserContext, sw: Worker, knownWindows: number[]): Promise<number> {
  const isHelper = (w: Worker) => w.url().endsWith('/helper.js');
  const helper = ctx.serviceWorkers().find(isHelper) ?? (await ctx.waitForEvent('serviceworker', { predicate: isHelper }));
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(helper.url()).host}/helper.html`);
  await page.evaluate(() => chrome.sessions.restore().then(() => 'ok', (err: unknown) => String(err)));
  const windowId = await until(
    () =>
      sw.evaluate(async (known) => {
        const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
        return windows.find((w) => w.id !== undefined && !known.includes(w.id))?.id ?? -1;
      }, knownWindows),
    (id) => id !== -1,
    'the reopened window',
  );
  await page.close();
  return windowId;
}

/** The addresses the smoke tests work with. A real install starts with none. */
export const EXAMPLE_RULES: Array<[string, string]> = [
  ['admin.example.com', 'Admin'],
  ['app.example.com', 'App'],
  ['staging.example.com', '\u{1F7E0} App staging'],
  ['platform.example.com', 'Platform'],
  ['staging-platform.example.com', '\u{1F7E0} Platform staging'],
  ['example.com', 'Web'],
  ['staging-web.example.com', '\u{1F7E0} Web staging'],
];

/** Saves addresses the way the settings page does. */
export async function writeRules(sw: Worker, rules: Array<[string, string]> = EXAMPLE_RULES): Promise<void> {
  await sw.evaluate(
    (list) =>
      chrome.storage.local.set({
        rules: list.map(([host, project], i) => ({ id: `rule-${i}`, host, project, enabled: true })),
      }),
    rules,
  );
}

/** Opens a page of the extension in a new tab. */
export async function openExtensionPage(ctx: BrowserContext, extensionId: string, pathAndQuery: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pathAndQuery}`);
  return page;
}

export async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  timeout = 10_000,
): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}\nLast value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- tabs and groups

export interface TabState {
  id: number;
  groupId: number;
  index: number;
  active: boolean;
  url: string;
  discarded: boolean;
  status: string;
}

export interface GroupState {
  id: number;
  title: string;
  color: string;
  collapsed: boolean;
  tabIds: number[];
}

export interface WindowState {
  tabs: TabState[];
  groups: GroupState[];
  active: TabState | undefined;
  /** Titles of the groups that are open (not folded). */
  open: string[];
  groupOf(tabId: number | undefined): string | null;
}

export async function windowState(sw: Worker, windowId: number): Promise<WindowState> {
  const raw = await sw.evaluate(async (windowId) => {
    const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
    return {
      tabs: tabs.map((t) => ({
        id: t.id ?? -1,
        groupId: t.groupId,
        index: t.index,
        active: t.active,
        url: t.url ?? '',
        discarded: t.discarded,
        status: t.status ?? '',
      })),
      groups: groups.map((g) => ({ id: g.id, title: g.title ?? '', color: String(g.color), collapsed: g.collapsed })),
    };
  }, windowId);
  const groups = raw.groups.map((g) => ({
    ...g,
    tabIds: raw.tabs
      .filter((t) => t.groupId === g.id)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.id),
  }));
  return {
    tabs: raw.tabs,
    groups,
    active: raw.tabs.find((t) => t.active),
    open: groups.filter((g) => !g.collapsed).map((g) => g.title),
    groupOf(tabId) {
      const tab = raw.tabs.find((t) => t.id === tabId);
      return groups.find((g) => g.id === tab?.groupId)?.title ?? null;
    },
  };
}

/** "Only this project is open and the active tab is in it." */
export function onlyOpen(state: WindowState, title: string): boolean {
  return state.open.length === 1 && state.open[0] === title && state.groupOf(state.active?.id) === title;
}

export async function tabIdByPath(sw: Worker, pathname: string): Promise<number> {
  return until(
    () =>
      sw.evaluate(async (pathname) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => {
          try {
            return new URL(t.url || t.pendingUrl || '').pathname === pathname;
          } catch {
            return false;
          }
        });
        return tab?.id ?? -1;
      }, pathname),
    (id) => id !== -1,
    `a tab at ${pathname}`,
  );
}

export async function stored(sw: Worker): Promise<{
  projects: Array<{ title: string; color: string }>;
  lastActive: Record<string, { tabId: number; url: string }>;
  rules: Array<{ host: string; project: string }>;
}> {
  const value = await sw.evaluate(() => chrome.storage.local.get(['projects', 'lastActive', 'rules']));
  return {
    projects: (value['projects'] as Array<{ title: string; color: string }> | undefined) ?? [],
    lastActive: (value['lastActive'] as Record<string, { tabId: number; url: string }> | undefined) ?? {},
    rules: (value['rules'] as Array<{ host: string; project: string }> | undefined) ?? [],
  };
}

// ---------------------------------------------------------------- the real side panel

/**
 * Opens the extension's side panel the way Brave needs it: from a click.
 * The driver is the extension's options page; it gets a test button.
 */
export async function openSidePanel(driver: Page): Promise<void> {
  await driver.bringToFront();
  await driver.evaluate(() => {
    if (document.getElementById('test-open-panel')) return;
    const button = document.createElement('button');
    button.id = 'test-open-panel';
    button.textContent = 'Open side panel (test)';
    button.addEventListener('click', () => {
      void chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id ?? -1 }));
    });
    document.body.prepend(button);
  });
  await driver.click('#test-open-panel');
}

export interface PanelRow {
  title: string;
  count: number;
  current: boolean;
  shortcut: string;
}

/** Reads the rows of the side panel through the driver page (same extension, same process). */
export function panelRows(driver: Page): Promise<PanelRow[] | null> {
  return driver.evaluate(() => {
    const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
    if (!view) return null;
    return [...view.document.querySelectorAll<HTMLElement>('#list .row')].map((row) => ({
      // The name as the owner wrote it: a leading emoji shows in the dot's place.
      title: [row.querySelector('.dot.emoji')?.textContent, row.querySelector('.name')?.textContent].filter(Boolean).join(' '),
      count: Number(row.querySelector('.count')?.textContent ?? '0'),
      current: row.classList.contains('current'),
      shortcut: row.querySelector('.key')?.textContent ?? '',
    }));
  });
}

export function panelText(driver: Page, selector: string): Promise<string> {
  return driver.evaluate((selector) => {
    const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
    return view?.document.querySelector(selector)?.textContent ?? '';
  }, selector);
}

export interface PanelTabRow {
  id: number;
  text: string;
  current: boolean;
  named: boolean;
}

/** The tab list under a project in the side panel, or null while it is closed. */
export function panelTabs(driver: Page, title: string): Promise<PanelTabRow[] | null> {
  return driver.evaluate((title) => {
    const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
    if (!view) return null;
    const doc = view.document;
    const row = [...doc.querySelectorAll<HTMLElement>('#list .row')].find(
      (r) => [r.querySelector('.dot.emoji')?.textContent, r.querySelector('.name')?.textContent].filter(Boolean).join(' ') === title,
    );
    const list = row?.dataset.group ? doc.querySelector(`#list .tabs[data-group="${row.dataset.group}"]`) : null;
    if (!list) return null;
    return [...list.querySelectorAll<HTMLElement>('.tab-row')].map((r) => ({
      id: Number(r.dataset.tab),
      text: r.querySelector('.tab-name')?.textContent ?? '',
      current: r.classList.contains('current'),
      named: r.classList.contains('named'),
    }));
  }, title);
}

type PanelTarget =
  | { kind: 'project'; title: string }
  | { kind: 'more'; title: string }
  | { kind: 'twisty'; title: string }
  | { kind: 'tab'; text: string; part: 'main' | 'rename' | 'close' }
  | { kind: 'button'; text: string; scope: string }
  | { kind: 'swatch'; color: string }
  | { kind: 'selector'; selector: string };

/** Clicks something in the side panel, waiting up to 5 s for it to be drawn. */
export function panelClick(driver: Page, target: PanelTarget): Promise<void> {
  return driver.evaluate(async (target) => {
    const find = (): HTMLElement | null => {
      const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
      if (!view) return null;
      const doc = view.document;
      const row = (title: string) =>
        [...doc.querySelectorAll<HTMLElement>('#list .row')].find(
          (r) => [r.querySelector('.dot.emoji')?.textContent, r.querySelector('.name')?.textContent].filter(Boolean).join(' ') === title,
        );
      switch (target.kind) {
        case 'project':
          return row(target.title)?.querySelector<HTMLElement>('.main') ?? null;
        case 'more':
          return row(target.title)?.querySelector<HTMLElement>('.more') ?? null;
        case 'twisty':
          return row(target.title)?.querySelector<HTMLElement>('.twisty') ?? null;
        case 'tab': {
          const tabRow = [...doc.querySelectorAll<HTMLElement>('#list .tab-row')].find(
            (r) => r.querySelector('.tab-name')?.textContent === target.text,
          );
          return tabRow?.querySelector<HTMLElement>(`.tab-${target.part}`) ?? null;
        }
        case 'button':
          return (
            [...doc.querySelectorAll<HTMLButtonElement>(`${target.scope} button`)].find(
              (b) => b.textContent?.trim() === target.text && !b.disabled,
            ) ?? null
          );
        case 'swatch':
          return doc.querySelector<HTMLElement>(`#list .menu .swatch[data-color="${target.color}"]`);
        case 'selector':
          return doc.querySelector<HTMLElement>(target.selector);
      }
    };
    const end = Date.now() + 5000;
    for (;;) {
      const el = find();
      if (el) {
        el.click();
        return;
      }
      if (Date.now() > end) throw new Error(`Nothing to click in the side panel: ${JSON.stringify(target)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, target);
}

/** Types into a side panel text field (rename or new project). */
export function panelType(driver: Page, focusKey: string, value: string): Promise<void> {
  return driver.evaluate(
    async ({ focusKey, value }) => {
      const end = Date.now() + 5000;
      for (;;) {
        const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
        const input = view?.document.querySelector<HTMLInputElement>(`input[data-focus="${focusKey}"]`);
        if (input && view) {
          input.value = value;
          // The event must come from the panel's own window for its listeners to treat it as theirs.
          const PanelEvent = (view as unknown as { Event: typeof Event }).Event;
          input.dispatchEvent(new PanelEvent('input', { bubbles: true }));
          return;
        }
        if (Date.now() > end) throw new Error(`No ${focusKey} field in the side panel`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    { focusKey, value },
  );
}
