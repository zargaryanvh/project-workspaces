import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findBrave,
  launchBrowser,
  onlyOpen,
  openSidePanel,
  panelClick,
  panelRows,
  panelTabs,
  panelType,
  pause,
  startPageServer,
  tabIdByPath,
  until,
  windowState,
  type BrowserKind,
  type PageServer,
  type WindowState,
} from './harness.js';

/**
 * The tab list under each project in the real side panel: the arrow, going to
 * a tab, names of your own, moving and closing tabs, and what a restart keeps.
 */

test.describe.serial('Tab lists in the side panel', () => {
  let kind: BrowserKind = 'chromium';
  let server: PageServer;
  let userDataDir = '';
  let ctx: BrowserContext;
  let sw: Worker;
  let extensionId = '';
  let driver: Page;
  let windowId = -1;
  const pages = new Map<string, Page>();
  const tabIds = new Map<string, number>();
  const loadIds = new Map<string, string>();
  const paths = new Map<string, string>();

  const id = (name: string): number => {
    const value = tabIds.get(name);
    if (value === undefined) throw new Error(`No tab named ${name}`);
    return value;
  };
  const state = () => windowState(sw, windowId);
  const texts = async (title: string): Promise<string[] | null> =>
    (await panelTabs(driver, title))?.map((r) => r.text) ?? null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const go = (tabId: number, url: string) =>
    sw.evaluate(({ tabId, url }) => chrome.tabs.update(tabId, { url }).then(() => undefined), { tabId, url });
  const tabUrl = (tabId: number) => sw.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => t.url ?? ''), tabId);
  const storedLists = () =>
    sw.evaluate(() => chrome.storage.local.get(['tabNames', 'expanded'])) as Promise<{
      tabNames?: Array<{ name: string; home: string }>;
      expanded?: string[];
    }>;
  const docsOrder = (s: WindowState) => s.groups.find((g) => g.title === 'Docs')?.tabIds ?? [];

  /** Types a name for the tab whose row says `text`, and saves it with the check mark. */
  async function nameTab(text: string, name: string): Promise<void> {
    await panelClick(driver, { kind: 'tab', text, part: 'rename' });
    await panelType(driver, 'tab-name', name);
    await panelClick(driver, { kind: 'selector', selector: '#list .tab-save' });
  }

  /** Drags one tab row onto another in the side panel (the browser's own drag events). */
  async function dragTab(fromText: string, toText: string, side: 'before' | 'after'): Promise<void> {
    await driver.evaluate(
      ({ fromText, toText, side }) => {
        const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
        const rowOf = (text: string) =>
          [...(view?.document.querySelectorAll<HTMLElement>('#list .tab-row') ?? [])].find(
            (r) => r.querySelector('.tab-name')?.textContent === text,
          );
        const from = rowOf(fromText);
        const to = rowOf(toText);
        if (!view || !from || !to) throw new Error('tab rows missing');
        const W = view as unknown as { DragEvent: typeof DragEvent; DataTransfer: typeof DataTransfer };
        const data = new W.DataTransfer();
        const rect = to.getBoundingClientRect();
        const y = side === 'before' ? rect.top + 2 : rect.bottom - 2;
        from.dispatchEvent(new W.DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
        to.dispatchEvent(new W.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: y }));
        to.dispatchEvent(new W.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientY: y }));
        from.dispatchEvent(new W.DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      },
      { fromText, toText, side },
    );
  }

  /** No page in `names` was loaded again: same load id, one request each. */
  async function expectNoReloads(names: string[]): Promise<void> {
    for (const name of names) {
      const page = pages.get(name);
      if (!page) throw new Error(`No page named ${name}`);
      const loadId = await page.evaluate(() => (window as unknown as { __loadId: string }).__loadId);
      expect(loadId, `${name} was not reloaded`).toBe(loadIds.get(name));
      expect(server.hits.get(paths.get(name) ?? ''), `${name} was requested once`).toBe(1);
    }
  }

  test.beforeAll(async ({}, testInfo) => {
    kind = testInfo.project.name === 'brave' ? 'brave' : 'chromium';
    testInfo.skip(kind === 'brave' && !findBrave(), 'Brave is not installed on this computer');

    server = await startPageServer();
    userDataDir = mkdtempSync(path.join(os.tmpdir(), `tab-list-${kind}-`));
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind));

    // Mail: two accounts of one site, as a mail service shows them. Docs: three pages.
    const specs: Array<[string, string, string]> = [
      ['m0', 'mail.test', '/mail/u/0/'],
      ['m1', 'mail.test', '/mail/u/1/'],
      ['d1', 'docs.test', '/d1'],
      ['d2', 'docs.test', '/d2'],
      ['d3', 'docs.test', '/d3'],
    ];
    for (const [name, host, pathname] of specs) {
      const page = await ctx.newPage();
      await page.goto(server.url(host, pathname));
      pages.set(name, page);
      paths.set(name, `${host}${pathname}`);
      tabIds.set(name, await tabIdByPath(sw, pathname));
      loadIds.set(name, await page.evaluate(() => (window as unknown as { __loadId: string }).__loadId));
    }
    windowId = await sw.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => t.windowId), id('m0'));

    const makeGroup = (title: string, color: string, names: string[]) =>
      sw.evaluate(
        async ({ title, color, ids }) => {
          const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]] });
          await chrome.tabGroups.update(groupId, { title, color: color as chrome.tabGroups.Color });
          return groupId;
        },
        { title, color, ids: names.map(id) },
      );
    await makeGroup('Mail', 'red', ['m0', 'm1']);
    await makeGroup('Docs', 'blue', ['d1', 'd2', 'd3']);

    driver = await ctx.newPage();
    await driver.goto(`chrome-extension://${extensionId}/options.html`);
    await openSidePanel(driver);
    await until(
      () => panelRows(driver),
      (rows) => rows?.length === 2,
      'the side panel to list two projects',
    );
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test("the arrow shows a project's tabs under it, without switching to it", async () => {
    await panelClick(driver, { kind: 'project', title: 'Docs' });
    await until(state, (s) => onlyOpen(s, 'Docs'), 'Docs open alone');
    expect(await panelTabs(driver, 'Mail'), 'no list before the arrow').toBeNull();

    await panelClick(driver, { kind: 'twisty', title: 'Mail' });
    await until(
      () => texts('Mail'),
      (t) => same(t, ['mail/u/0/', 'mail/u/1/']),
      'the Mail tabs under Mail',
    );
    expect(onlyOpen(await state(), 'Docs'), 'Docs is still the open project, Mail stays folded').toBe(true);
    await until(storedLists, (v) => same(v.expanded, ['mail']), 'the open list remembered');
  });

  test('choosing a project from the tab bar never opens its list', async () => {
    await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), id('d2'));
    await until(state, (s) => onlyOpen(s, 'Docs') && s.active?.id === id('d2'), 'a Docs tab picked in the tab bar');
    const mail = (await state()).groups.find((g) => g.title === 'Mail')?.id ?? -1;
    await sw.evaluate((groupId) => chrome.tabGroups.update(groupId, { collapsed: false }), mail);
    await until(state, (s) => onlyOpen(s, 'Mail'), 'Mail opened from the tab bar');
    await pause(400);
    expect(await panelTabs(driver, 'Docs'), 'the Docs list stays closed').toBeNull();
    expect(await texts('Mail'), 'the Mail list stays open').toEqual(['mail/u/0/', 'mail/u/1/']);
  });

  test('a click on a tab in the list goes to it: its project opens on it, the others fold, nothing reloads', async () => {
    await panelClick(driver, { kind: 'project', title: 'Docs' });
    await until(state, (s) => onlyOpen(s, 'Docs'), 'Docs open');
    await panelClick(driver, { kind: 'tab', text: 'mail/u/1/', part: 'main' });
    await until(state, (s) => onlyOpen(s, 'Mail') && s.active?.id === id('m1'), 'Mail open on the second account');
    await until(
      () => panelTabs(driver, 'Mail'),
      (rows) => rows?.find((r) => r.current)?.text === 'mail/u/1/',
      'the list marks the tab in view',
    );
    await expectNoReloads(['m0', 'm1', 'd1', 'd2', 'd3']);
  });

  test('a tab gets a name of your own; the tab bar keeps the page title', async () => {
    await nameTab('mail/u/0/', 'Personal');
    await until(() => texts('Mail'), (t) => same(t, ['Personal', 'mail/u/1/']), 'Personal in the list');
    await nameTab('mail/u/1/', 'Work');
    await until(() => texts('Mail'), (t) => same(t, ['Personal', 'Work']), 'Work in the list');

    const titles = await sw.evaluate(
      (ids) => Promise.all(ids.map((tabId) => chrome.tabs.get(tabId).then((t) => t.title))),
      [id('m0'), id('m1')],
    );
    expect(titles).toEqual(['mail/u/0/', 'mail/u/1/']);
    const names = (await storedLists()).tabNames ?? [];
    expect(names.map((n) => `${n.name} ${new URL(n.home).pathname}`)).toEqual(['Personal /mail/u/0/', 'Work /mail/u/1/']);
  });

  test('an empty name shows the page title again', async () => {
    await panelClick(driver, { kind: 'twisty', title: 'Docs' });
    await until(() => texts('Docs'), (t) => same(t, ['d1', 'd2', 'd3']), 'the Docs tabs');
    await nameTab('d1', 'Spec');
    await until(() => texts('Docs'), (t) => t?.[0] === 'Spec', 'Spec in the list');
    await nameTab('Spec', '');
    await until(() => texts('Docs'), (t) => t?.[0] === 'd1', 'the page title again');
    await until(
      storedLists,
      (v) => same(v.tabNames?.map((n) => n.name), ['Personal', 'Work']),
      'the cleared name forgotten',
    );
  });

  test('a name stays while its tab browses the site, stays behind when it leaves, and comes back on its address', async () => {
    await go(id('m0'), `${server.url('mail.test', '/mail/u/0/inbox')}?view=all#message-5`);
    await until(() => tabUrl(id('m0')), (u) => u.includes('/mail/u/0/inbox'), 'the first account in its inbox');
    await pause(600);
    expect((await texts('Mail'))?.[0], 'same site: the name stays').toBe('Personal');

    await go(id('m0'), server.url('elsewhere.test', '/away'));
    await until(() => texts('Mail'), (t) => t?.[0] === 'away', 'another site: the page title shows');

    await go(id('m0'), server.url('mail.test', '/mail/u/0/'));
    await until(() => texts('Mail'), (t) => t?.[0] === 'Personal', 'back on its address: the name is back');
  });

  test("the ✕ closes only that tab; switching accounts in one tab then shows that account's name", async () => {
    const before = await state();
    await panelClick(driver, { kind: 'tab', text: 'Work', part: 'close' });
    const after = await until(state, (s) => s.tabs.length === before.tabs.length - 1, 'one tab fewer');
    expect(after.tabs.some((t) => t.id === id('m1')), 'the Work tab is the one closed').toBe(false);
    await until(() => texts('Mail'), (t) => same(t, ['Personal']), 'one tab left in Mail');

    await go(id('m0'), server.url('mail.test', '/mail/u/1/'));
    await until(() => texts('Mail'), (t) => same(t, ['Work']), 'the second account shows its name');
    await go(id('m0'), server.url('mail.test', '/mail/u/0/'));
    await until(() => texts('Mail'), (t) => same(t, ['Personal']), 'and the first account its own');
  });

  test('dragging a tab in the list moves it in the tab bar, inside its project', async () => {
    await until(() => texts('Docs'), (t) => same(t, ['d1', 'd2', 'd3']), 'Docs in order');
    await dragTab('d3', 'd1', 'before');
    const moved = await until(state, (s) => same(docsOrder(s), [id('d3'), id('d1'), id('d2')]), 'd3 first in the tab bar');
    expect(moved.groupOf(id('d3')), 'still in Docs').toBe('Docs');
    await until(() => texts('Docs'), (t) => same(t, ['d3', 'd1', 'd2']), 'the list in tab bar order');

    await dragTab('d3', 'd2', 'after');
    const back = await until(state, (s) => same(docsOrder(s), [id('d1'), id('d2'), id('d3')]), 'd3 last again');
    expect(back.groupOf(id('d3')), 'still in Docs').toBe('Docs');
    await until(() => texts('Docs'), (t) => same(t, ['d1', 'd2', 'd3']), 'the list follows');
  });

  test('after a restart: open lists stay open and the names come back', async () => {
    await pause(3000); // let the browser write its session to disk
    await ctx.close();
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind, ['--restore-last-session']));
    windowId = await until(
      () => sw.evaluate(async () => (await chrome.tabGroups.query({}))[0]?.windowId ?? -1),
      (w) => w !== -1,
      'the restored window',
    );
    await until(
      state,
      (s) => s.groups.length === 2 && s.tabs.every((t) => t.status !== 'loading'),
      'both groups restored and settled',
      20_000,
    );
    driver = await ctx.newPage();
    await driver.goto(`chrome-extension://${extensionId}/options.html`);
    await openSidePanel(driver);
    await until(() => texts('Mail'), (t) => same(t, ['Personal']), 'the Mail list open, with its name', 20_000);
    await until(() => texts('Docs'), (t) => same(t, ['d1', 'd2', 'd3']), 'the Docs list open', 20_000);
  });
});
