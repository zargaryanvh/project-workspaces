import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findBrave,
  launchBrowser,
  onlyOpen,
  openExtensionPage,
  pause,
  reopenLastClosed,
  startPageServer,
  tabIdByPath,
  until,
  windowState,
  writeRules,
  type BrowserKind,
  type PageServer,
} from './harness.js';

/**
 * Ctrl+Shift+T brings back the project that was open, and opening a project
 * address that is already open shows the warning in the new tab.
 */

test.describe.serial('Reopened windows and the already-open warning', () => {
  let kind: BrowserKind = 'chromium';
  let server: PageServer;
  let userDataDir = '';
  let ctx: BrowserContext;
  let sw: Worker;
  let extensionId = '';
  let mainWindow = -1;
  let driver: Page;
  let homeTab = -1;

  /** A new tab in the main window (after Ctrl+Shift+T the reopened window has the focus). */
  const createTab = (url: string, active: boolean) =>
    sw.evaluate(
      ({ url, active, windowId }) => chrome.tabs.create({ url, active, windowId }).then((t) => t.id ?? -1),
      { url, active, windowId: mainWindow },
    );
  const tabUrl = (tabId: number) => sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url ?? '', () => 'gone'), tabId);
  const warningPage = () =>
    until(
      async () => ctx.pages().find((p) => p.url().includes('/already-open.html')) ?? null,
      (p) => p !== null,
      'the warning page',
    ) as Promise<Page>;

  test.beforeAll(async ({}, testInfo) => {
    kind = testInfo.project.name === 'brave' ? 'brave' : 'chromium';
    testInfo.skip(kind === 'brave' && !findBrave(), 'Brave is not installed on this computer');
    server = await startPageServer();
    userDataDir = mkdtempSync(path.join(os.tmpdir(), `workspaces-restore-${kind}-`));
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind));
    await writeRules(sw); // a real install starts with no addresses
    mainWindow = await sw.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0]?.id ?? -1);
    driver = await openExtensionPage(ctx, extensionId, 'options.html');
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a window reopened with Ctrl+Shift+T gets back the project that was open, on the same tab', async () => {
    const u = (host: string, name: string) => server.url(host, `/${name}`);
    const second = await sw.evaluate(
      async (urls) => (await chrome.windows.create({ url: urls, focused: false }))?.id ?? -1,
      [u('a.test', 'a1'), u('a.test', 'a2'), u('b.test', 'b1'), u('b.test', 'b2'), u('c.test', 'c1')],
    );
    await pause(1500); // the new window settles first
    const groups = await sw.evaluate(async (windowId) => {
      const tabs = await chrome.tabs.query({ windowId });
      const ids = (part: string) => tabs.filter((t) => (t.url ?? '').includes(part)).map((t) => t.id ?? -1) as [number, ...number[]];
      const make = async (part: string, title: string, color: chrome.tabGroups.Color) => {
        const id = await chrome.tabs.group({ tabIds: ids(part), createProperties: { windowId } });
        await chrome.tabGroups.update(id, { title, color });
        return id;
      };
      return {
        alpha: await make('/a', 'Alpha', 'blue' as chrome.tabGroups.Color),
        beta: await make('/b', 'Beta', 'green' as chrome.tabGroups.Color),
        gamma: await make('/c', 'Gamma', 'red' as chrome.tabGroups.Color),
      };
    }, second);

    // Beta open, on its second tab: the state to get back.
    await driver.evaluate(
      ({ windowId, groupId }) => chrome.runtime.sendMessage({ type: 'switch', windowId, groupId }),
      { windowId: second, groupId: groups.beta },
    );
    const b2 = await tabIdByPath(sw, '/b2');
    await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), b2);
    await until(
      () => windowState(sw, second),
      (s) => onlyOpen(s, 'Beta') && s.active?.id === b2,
      'Beta open on b2',
    );
    await pause(1200);

    await sw.evaluate((windowId) => chrome.windows.remove(windowId), second);
    await pause(800);
    const reopened = await reopenLastClosed(ctx, sw, [mainWindow]);
    const after = await until(
      () => windowState(sw, reopened),
      (s) => s.groups.length === 3 && onlyOpen(s, 'Beta') && (s.active?.url ?? '').endsWith('/b2'),
      'Beta open on b2 again after Ctrl+Shift+T',
      15_000,
    );
    expect(after.groups.map((g) => g.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  test('opening a project address that is already open shows the warning in the new tab; Close goes to the open tab', async () => {
    homeTab = await createTab(server.url('example.com', '/home'), true);
    await until(
      () => windowState(sw, mainWindow),
      (s) => s.groupOf(homeTab) === 'Blog' && onlyOpen(s, 'Blog'),
      'example.com/home in Blog',
    );

    const again = await createTab(server.url('example.com', '/'), true);
    await until(() => tabUrl(again), (url) => url.includes('/already-open.html'), 'the new tab shows the warning');
    const warning = await warningPage();
    await expect(warning.locator('h1')).toHaveText('example.com is already open');
    await expect(warning.locator('.tab')).toHaveCount(1);
    await expect(warning.locator('.tab')).toContainText('/home');
    await expect(warning.getByRole('button', { name: 'Close this tab' })).toBeFocused();

    await warning.getByRole('button', { name: 'Close this tab' }).click();
    await until(
      () => windowState(sw, mainWindow),
      (s) => !s.tabs.some((t) => t.id === again) && s.active?.id === homeTab && onlyOpen(s, 'Blog'),
      'the new tab closed, back on example.com/home',
    );
  });

  test('Open anyway loads the page in that tab, and its rule still applies', async () => {
    const again = await createTab(server.url('example.com', '/again'), true);
    await until(() => tabUrl(again), (url) => url.includes('/already-open.html'), 'the warning');
    const warning = await warningPage();
    await warning.getByRole('button', { name: 'Open anyway' }).click();
    await until(
      () => windowState(sw, mainWindow),
      (s) => (s.tabs.find((t) => t.id === again)?.url ?? '').endsWith('/again') && s.groupOf(again) === 'Blog',
      'example.com/again loaded and in Blog',
    );
    expect(server.hits.get('example.com/again')).toBeGreaterThanOrEqual(1);
  });

  test('a page opened from a link on the same site is not warned', async () => {
    await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), homeTab);
    const home = await until(
      async () => ctx.pages().find((p) => p.url().endsWith('/home')) ?? null,
      (p) => p !== null,
      'the home page',
    );
    if (!home) throw new Error('home page missing');
    await home.evaluate((href) => document.getElementById('link')?.setAttribute('href', href), server.url('example.com', '/from-home'));
    await home.click('#link');
    const linked = await tabIdByPath(sw, '/from-home');
    await until(() => tabUrl(linked), (url) => url.endsWith('/from-home'), 'the linked page loaded, no warning');
  });

  test('with the warning switched off, the page just opens', async () => {
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings as object), duplicateCheck: false } });
    });
    await pause(300);
    const tab = await createTab(server.url('example.com', '/no-warning'), true);
    await until(() => tabUrl(tab), (url) => url.endsWith('/no-warning'), 'the page opened without a warning');
  });
});
