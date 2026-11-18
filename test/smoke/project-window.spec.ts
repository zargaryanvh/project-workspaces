import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findBrave,
  launchBrowser,
  onlyOpen,
  pause,
  startPageServer,
  tabIdByPath,
  until,
  windowState,
  type BrowserKind,
  type PageServer,
} from './harness.js';

/**
 * The narrow project window: chosen in the settings, it opens beside Brave
 * with the project list, docks at the screen edge, keeps a width the owner
 * drags it to, and closes again when the owner goes back to the side panel.
 */

interface WindowBox {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
  state: string;
}

test.describe.serial('The narrow project window', () => {
  let kind: BrowserKind = 'chromium';
  let server: PageServer;
  let userDataDir = '';
  let ctx: BrowserContext;
  let sw: Worker;
  let extensionId = '';
  let driver: Page;
  let windowId = -1;
  const tabIds = new Map<string, number>();

  const id = (name: string): number => {
    const value = tabIds.get(name);
    if (value === undefined) throw new Error(`No tab named ${name}`);
    return value;
  };
  const state = () => windowState(sw, windowId);
  const setSurface = (surface: string) =>
    sw.evaluate((surface) => chrome.storage.local.set({ settings: { follow: true, surface, duplicateCheck: true } }), surface);
  const box = (winId: number) =>
    sw.evaluate(async (winId) => {
      const w = await chrome.windows.get(winId).catch(() => null);
      return w ? { id: w.id ?? -1, left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0, state: w.state ?? '' } : null;
    }, winId) as Promise<WindowBox | null>;
  const projectWindows = () =>
    sw.evaluate(async () => {
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
      return wins.filter((w) => w.tabs?.some((t) => (t.url ?? '').includes('panel.html?view=window'))).map((w) => w.id ?? -1);
    });
  /** The rows of the list in the project window. */
  const windowRows = () =>
    driver.evaluate(() => {
      const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html') && w.location.search.includes('view=window'));
      if (!view) return null;
      return [...view.document.querySelectorAll<HTMLElement>('#list .row')].map((r) => ({
        title: r.querySelector('.name')?.textContent ?? '',
        current: r.classList.contains('current'),
      }));
    });
  const windowClick = (title: string) =>
    driver.evaluate(async (title) => {
      const end = Date.now() + 5000;
      for (;;) {
        const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html') && w.location.search.includes('view=window'));
        const row = view && [...view.document.querySelectorAll<HTMLElement>('#list .row')].find((r) => r.querySelector('.name')?.textContent === title);
        const button = row?.querySelector<HTMLElement>('.main');
        if (button) {
          button.click();
          return;
        }
        if (Date.now() > end) throw new Error(`No project ${title} in the project window`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }, title);

  let listId = -1;
  let screenWidth = 0;

  test.beforeAll(async ({}, testInfo) => {
    kind = testInfo.project.name === 'brave' ? 'brave' : 'chromium';
    testInfo.skip(kind === 'brave' && !findBrave(), 'Brave is not installed on this computer');
    server = await startPageServer();
    userDataDir = mkdtempSync(path.join(os.tmpdir(), `project-window-${kind}-`));
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind, ['--screen-info={1600x900}'], { realScreen: true }));

    for (const [name, host] of [
      ['a1', 'alpha.test'],
      ['a2', 'alpha.test'],
      ['b1', 'beta.test'],
    ] as const) {
      const page = await ctx.newPage();
      await page.goto(server.url(host, `/${name}`));
      tabIds.set(name, await tabIdByPath(sw, `/${name}`));
    }
    windowId = await sw.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => t.windowId), id('a1'));
    const makeGroup = (title: string, ids: number[]) =>
      sw.evaluate(
        async ({ title, ids }) => {
          const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]] });
          await chrome.tabGroups.update(groupId, { title, color: 'blue' });
        },
        { title, ids },
      );
    await makeGroup('Alpha', [id('a1'), id('a2')]);
    await makeGroup('Beta', [id('b1')]);
    driver = await ctx.newPage();
    await driver.goto(`chrome-extension://${extensionId}/options.html`);
    screenWidth = await driver.evaluate(() => screen.availWidth);
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('chosen in the settings, the toolbar button opens it beside Brave, docked at the screen edge', async () => {
    await setSurface('window');
    await until(
      () => sw.evaluate(() => chrome.action.getPopup({})),
      (popup) => popup === '',
      'the toolbar button to open the window (no popup)',
    );
    await driver.evaluate((windowId) => chrome.runtime.sendMessage({ type: 'openProjectWindow', windowId }), windowId);
    const ids = await until(projectWindows, (list) => list.length === 1, 'one project window');
    listId = ids[0] ?? -1;
    // Side by side, together filling the screen's width: the list 300 px wide at one edge, Brave in the rest.
    const both = await until(
      async () => ({ list: await box(listId), brave: await box(windowId) }),
      ({ list, brave }) => list?.width === 300 && brave !== null && list.width + brave.width === screenWidth,
      'the window docked at 300 px with Brave beside it',
    );
    const { list, brave } = both;
    if (!list || !brave) throw new Error('windows missing');
    expect(list.state).toBe('normal');
    const [first, second] = list.left < brave.left ? [list, brave] : [brave, list];
    expect(first.left + first.width, 'no gap and no overlap').toBe(second.left);
  });

  test('it lists the projects of the Brave window, and a click switches there', async () => {
    await until(windowRows, (rows) => JSON.stringify(rows?.map((r) => r.title)) === '["Alpha","Beta"]', 'both projects listed');
    await windowClick('Beta');
    await until(state, (s) => onlyOpen(s, 'Beta'), 'Beta open alone in the Brave window');
    await until(windowRows, (rows) => rows?.find((r) => r.current)?.title === 'Beta', 'the window marks Beta');
    expect(await projectWindows(), 'the window stays open after a switch').toEqual([listId]);
  });

  test('dragging its edge keeps the new width, and Brave takes the rest', async () => {
    await pause(1000);
    await sw.evaluate((listId) => chrome.windows.update(listId, { width: 250 }), listId); // what a drag of the edge does
    await until(
      () => sw.evaluate(() => chrome.storage.local.get('projectWindowWidth').then((v) => v['projectWindowWidth'])),
      (w) => w === 250,
      'the width remembered',
    );
    const brave = await until(() => box(windowId), (b) => b !== null && b.width === screenWidth - 250, 'Brave resized beside it');
    expect(brave?.state).toBe('normal');
  });

  test('choosing the side panel again closes it; a maximized Brave is maximized again', async () => {
    // Close it, maximize Brave, open it again: it remembers that Brave was maximized.
    await sw.evaluate((listId) => chrome.windows.remove(listId), listId);
    await until(projectWindows, (list) => list.length === 0, 'the window closed');
    await sw.evaluate((windowId) => chrome.windows.update(windowId, { state: 'maximized' }), windowId);
    const maximized = (await until(() => box(windowId), (b) => b !== null, 'Brave'))?.state === 'maximized';
    await driver.evaluate((windowId) => chrome.runtime.sendMessage({ type: 'openProjectWindow', windowId }), windowId);
    const [again] = await until(projectWindows, (list) => list.length === 1, 'the window open again');
    await until(() => box(again ?? -1), (b) => b?.width === 250, 'it opens at the remembered width');

    await setSurface('sidePanel');
    await until(projectWindows, (list) => list.length === 0, 'the window closed by going back to the side panel');
    await until(
      () => sw.evaluate(() => chrome.sidePanel.getPanelBehavior().then((b) => b.openPanelOnActionClick)),
      (on) => on === true,
      'the toolbar button opens the side panel again',
    );
    if (maximized) {
      await until(() => box(windowId), (b) => b?.state === 'maximized', 'Brave maximized again');
    } else {
      test.info().annotations.push({ type: 'note', description: 'this browser cannot maximize a window headless' });
    }
  });
});
