import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { frameInset, toVisible } from '../../src/lib/dock.js';

/**
 * The narrow project windows: chosen in the settings, the toolbar button opens
 * a Brave window's own project window, attached to its side. The window the
 * owner moves leads and the other follows; each Brave window has its own; the
 * toolbar button closes it again; choosing the side panel closes them all.
 *
 * Headless windows draw no frame, but report one: the page measures it as it
 * would Windows' invisible border, and so do these tests, which compare what
 * would show of each window. Real borders, focus and minimizing are checked
 * on a real screen (see CONTRIBUTING.md).
 */

interface WindowBox {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
  state: string;
}

const SCREEN = { width: 1600, height: 900 };

test.describe.serial('The narrow project windows', () => {
  let kind: BrowserKind = 'chromium';
  let server: PageServer;
  let userDataDir = '';
  let ctx: BrowserContext;
  let sw: Worker;
  let extensionId = '';
  let driver: Page;
  let windowId = -1;
  let secondId = -1;
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
  const setBox = (winId: number, bounds: Partial<WindowBox>) =>
    sw.evaluate(({ winId, bounds }) => chrome.windows.update(winId, bounds as chrome.windows.UpdateInfo).then(() => true), { winId, bounds });
  const projectWindows = () =>
    sw.evaluate(async () => {
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
      return wins.filter((w) => w.tabs?.some((t) => (t.url ?? '').includes('panel.html?view=window'))).map((w) => w.id ?? -1);
    });
  const toggle = (winId: number) => driver.evaluate((winId) => chrome.runtime.sendMessage({ type: 'toggleProjectWindow', windowId: winId }), winId);
  /** The project names in one project window. */
  const rowsOf = (listId: number) =>
    driver.evaluate((listId) => {
      const [view] = chrome.extension.getViews({ type: 'tab', windowId: listId });
      if (!view) return null;
      return [...view.document.querySelectorAll<HTMLElement>('#list .row')].map((r) => ({
        title: r.querySelector('.name')?.textContent ?? '',
        current: r.classList.contains('current'),
      }));
    }, listId);
  const clickIn = (listId: number, title: string) =>
    driver.evaluate(
      async ({ listId, title }) => {
        const end = Date.now() + 5000;
        for (;;) {
          const [view] = chrome.extension.getViews({ type: 'tab', windowId: listId });
          const row = view && [...view.document.querySelectorAll<HTMLElement>('#list .row')].find((r) => r.querySelector('.name')?.textContent === title);
          const button = row?.querySelector<HTMLElement>('.main');
          if (button) {
            button.click();
            return;
          }
          if (Date.now() > end) throw new Error(`No project ${title} in project window ${listId}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      { listId, title },
    );
  /** The frame the page measures in its own window, as the page does. */
  const insetOf = (listId: number) =>
    driver.evaluate((listId) => {
      const [view] = chrome.extension.getViews({ type: 'tab', windowId: listId });
      return view ? { outer: view.outerWidth, inner: view.innerWidth } : null;
    }, listId);
  /** What shows of a window: its box less the frame. */
  const shows = (b: WindowBox, inset: number): WindowBox => ({ ...b, ...toVisible(b, inset) });
  /** The pair as it shows now, once it is the way `ok` wants. */
  const pairWhen = (listId: number, browserId: number, ok: (list: WindowBox, brave: WindowBox) => boolean, what: string) =>
    until(
      async () => {
        const m = await insetOf(listId);
        const inset = m ? frameInset(m.outer, m.inner) : 0;
        const [list, brave] = [await box(listId), await box(browserId)];
        return { list: list && shows(list, inset), brave: brave && shows(brave, inset), inset };
      },
      ({ list, brave }) => list !== null && brave !== null && ok(list, brave),
      what,
    ) as Promise<{ list: WindowBox; brave: WindowBox; inset: number }>;
  /** Moves a window as the owner would: `shown` is where it should show. */
  const moveShown = async (winId: number, listId: number, shown: Partial<WindowBox>) => {
    const m = await insetOf(listId);
    const inset = m ? frameInset(m.outer, m.inner) : 0;
    const now = await box(winId);
    if (!now) throw new Error('no window');
    const cur = shows(now, inset);
    const want = { left: shown.left ?? cur.left, top: shown.top ?? cur.top, width: shown.width ?? cur.width, height: shown.height ?? cur.height };
    return setBox(winId, { left: want.left - inset, top: want.top, width: want.width + 2 * inset, height: want.height + inset });
  };
  const touching = (list: WindowBox, brave: WindowBox) =>
    list.left + list.width === brave.left && list.top === brave.top && list.height === brave.height;

  let listId = -1;

  test.beforeAll(async ({}, testInfo) => {
    kind = testInfo.project.name === 'brave' ? 'brave' : 'chromium';
    testInfo.skip(kind === 'brave' && !findBrave(), 'Brave is not installed on this computer');
    server = await startPageServer();
    userDataDir = mkdtempSync(path.join(os.tmpdir(), `project-window-${kind}-`));
    // The sidebar on the left, so the list starts on the left in Chromium and Brave alike.
    mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify({ side_panel: { is_right_aligned: false } }));
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind, [`--screen-info={${SCREEN.width}x${SCREEN.height}}`], { realScreen: true }));

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
    // Brave fills the screen, as a normal window (headless windows cannot always be maximized).
    await setBox(windowId, { state: 'normal', left: 0, top: 0, width: SCREEN.width, height: SCREEN.height });
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test("chosen in the settings, the toolbar button opens this Brave window's own project window, attached to its side", async () => {
    await setSurface('window');
    await until(
      () => sw.evaluate(() => chrome.action.getPopup({})),
      (popup) => popup === '',
      'the toolbar button to open the window (no popup)',
    );
    await toggle(windowId);
    const ids = await until(projectWindows, (list) => list.length === 1, 'one project window');
    listId = ids[0] ?? -1;
    // The list at the screen edge, 300 wide; Brave gave up that strip and keeps the rest.
    const { list, brave, inset } = await pairWhen(listId, windowId, (l, b) => l.width === 300 && touching(l, b), 'the list attached at 300 px');
    expect(list.left).toBe(0);
    expect(brave.left + brave.width, "Brave's far edge stays").toBe(SCREEN.width - inset);
    expect(list.state).toBe('normal');
  });

  test('it lists the projects of its own Brave window, and a click switches there', async () => {
    await until(() => rowsOf(listId), (rows) => JSON.stringify(rows?.map((r) => r.title)) === '["Alpha","Beta"]', 'both projects listed');
    await clickIn(listId, 'Beta');
    await until(state, (s) => onlyOpen(s, 'Beta'), 'Beta open alone in the Brave window');
    await until(() => rowsOf(listId), (rows) => rows?.find((r) => r.current)?.title === 'Beta', 'the window marks Beta');
    expect(await projectWindows(), 'the window stays open after a switch').toEqual([listId]);
  });

  test('dragging the edge between them resizes both, and the width is kept', async () => {
    await pause(600);
    await moveShown(listId, listId, { width: 250 }); // what a drag of the list's right edge does
    await until(
      () => sw.evaluate(() => chrome.storage.local.get('projectWindowWidth').then((v) => v['projectWindowWidth'])),
      (w) => w === 250,
      'the width remembered',
    );
    const { brave, inset } = await pairWhen(listId, windowId, (l, b) => l.width === 250 && touching(l, b), 'Brave moved its edge along');
    expect(brave.left + brave.width, "Brave's far edge stays").toBe(SCREEN.width - inset);
  });

  test('Brave moved and resized: the list goes along, at its height', async () => {
    await pause(600);
    await moveShown(windowId, listId, { left: 600, top: 100, width: 800, height: 600 });
    const { list, brave } = await pairWhen(listId, windowId, (l, b) => b.left === 600 && touching(l, b), 'the list beside Brave again');
    expect(list.width).toBe(250);
    expect(list.left).toBe(350);
    expect(brave.width).toBe(800);
  });

  test('the list moved: Brave goes along, keeping its width', async () => {
    await pause(600);
    await moveShown(listId, listId, { left: 100, top: 50 });
    const { brave } = await pairWhen(listId, windowId, (l, b) => l.left === 100 && touching(l, b), 'Brave beside the list again');
    expect(brave.left).toBe(350);
    expect(brave.width).toBe(800);
    expect(brave.top).toBe(50);
  });

  test('Brave maximized: the list takes its strip at the screen edge and Brave the rest', async () => {
    await pause(600);
    await setBox(windowId, { state: 'maximized' });
    const maximized = (await box(windowId))?.state === 'maximized';
    if (!maximized) {
      test.info().annotations.push({ type: 'note', description: 'this browser cannot maximize a window headless' });
      return;
    }
    const { list, brave } = await pairWhen(
      listId,
      windowId,
      (l, b) => b.state === 'normal' && l.left === 0 && touching(l, b),
      'docked again at the screen edge',
    );
    expect(list.width).toBe(250);
    expect(brave.left + brave.width).toBe(SCREEN.width);
  });

  test('each Brave window has its own project window, with its own projects', async () => {
    secondId = await sw.evaluate(async (url) => {
      const w = await chrome.windows.create({ url, left: 700, top: 120, width: 800, height: 600, focused: true });
      if (!w) return -1;
      const [tab] = await chrome.tabs.query({ windowId: w.id });
      const groupId = await chrome.tabs.group({ tabIds: [tab?.id ?? -1], createProperties: { windowId: w.id } });
      await chrome.tabGroups.update(groupId, { title: 'Gamma', color: 'green' });
      return w.id ?? -1;
    }, server.url('gamma.test', '/g1'));
    await toggle(secondId);
    const ids = await until(projectWindows, (list) => list.length === 2, 'two project windows');
    const secondList = ids.find((x) => x !== listId) ?? -1;
    await until(() => rowsOf(secondList), (rows) => JSON.stringify(rows?.map((r) => r.title)) === '["Gamma"]', "the second list shows the second window's project");
    expect((await rowsOf(listId))?.map((r) => r.title)).toEqual(['Alpha', 'Beta']);
    const { list } = await pairWhen(secondList, secondId, (l, b) => touching(l, b), 'the second list attached to the second window');
    expect(list.width, "at the remembered width").toBe(250);

    // Closing a Brave window takes its project window along; the other pair stays.
    await sw.evaluate((winId) => chrome.windows.remove(winId), secondId);
    await until(projectWindows, (list) => JSON.stringify(list) === JSON.stringify([listId]), 'only the first project window left');
  });

  test('a project window Brave brings back after a restart belongs to the Brave window it touches', async () => {
    // Window ids change after a restart: the page has to find its Brave window again. This one opens with no record.
    const thirdId = await sw.evaluate(async (url) => {
      const w = await chrome.windows.create({ url, left: 900, top: 150, width: 600, height: 500 });
      if (!w) return -1;
      const [tab] = await chrome.tabs.query({ windowId: w.id });
      const groupId = await chrome.tabs.group({ tabIds: [tab?.id ?? -1], createProperties: { windowId: w.id } });
      await chrome.tabGroups.update(groupId, { title: 'Delta', color: 'pink' });
      return w.id ?? -1;
    }, server.url('delta.test', '/d1'));
    await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', left: 600, top: 150, width: 300, height: 500 }).then(() => true), `chrome-extension://${extensionId}/panel.html?view=window`);
    const ids = await until(projectWindows, (list) => list.length === 2, 'the brought-back window open');
    const adopted = ids.find((x) => x !== listId) ?? -1;
    await until(() => rowsOf(adopted), (rows) => JSON.stringify(rows?.map((r) => r.title)) === '["Delta"]', 'it lists the projects of the window it touches');
    await sw.evaluate((winId) => chrome.windows.remove(winId), thirdId);
    await until(projectWindows, (list) => list.length === 1, 'and goes with it');
  });

  test('the toolbar button again closes it, and opens it at the remembered width', async () => {
    await toggle(windowId);
    await until(projectWindows, (list) => list.length === 0, 'the project window closed');
    await toggle(windowId);
    const [again] = await until(projectWindows, (list) => list.length === 1, 'open again');
    listId = again ?? -1;
    await pairWhen(listId, windowId, (l, b) => l.width === 250 && touching(l, b), 'it opens at the remembered width, attached');
  });

  test('choosing the side panel again closes every project window', async () => {
    await setBox(windowId, { state: 'maximized' });
    const maximizedBefore = (await box(windowId))?.state === 'maximized';
    await setSurface('sidePanel');
    await until(projectWindows, (list) => list.length === 0, 'the window closed by going back to the side panel');
    await until(
      () => sw.evaluate(() => chrome.sidePanel.getPanelBehavior().then((b) => b.openPanelOnActionClick)),
      (on) => on === true,
      'the toolbar button opens the side panel again',
    );
    if (maximizedBefore) {
      await until(() => box(windowId), (b) => b?.state === 'maximized', 'Brave maximized again');
    } else {
      test.info().annotations.push({ type: 'note', description: 'this browser cannot maximize a window headless' });
    }
  });
});
