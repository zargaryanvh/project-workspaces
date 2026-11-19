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
  panelKey,
  panelMenu,
  panelRows,
  panelText,
  panelType,
  pause,
  startPageServer,
  stored,
  tabIdByPath,
  until,
  windowState,
  writeRules,
  type BrowserKind,
  type GroupState,
  type PageServer,
  type WindowState,
} from './harness.js';

/** Group titles in the order the tab bar shows them. */
function tabBarOrder(s: WindowState): string[] {
  const first = (g: GroupState) => Math.min(...g.tabIds.map((id) => s.tabs.find((t) => t.id === id)?.index ?? 0));
  return [...s.groups].sort((a, b) => first(a) - first(b)).map((g) => g.title);
}

/**
 * Loads dist/ into a real browser (Playwright's Chromium, or the installed
 * Brave with a throwaway profile) and uses the real side panel. One browser
 * session runs through the steps in order, then Brave/Chromium is restarted.
 */

test.describe.serial('Project workspaces in a real browser', () => {
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
  const groupIds = new Map<string, number>();
  const hostOf = new Map<string, string>();

  const id = (name: string): number => {
    const value = tabIds.get(name);
    if (value === undefined) throw new Error(`No tab named ${name}`);
    return value;
  };
  const state = () => windowState(sw, windowId);
  const command = (name: string) =>
    driver.evaluate(({ command, windowId }) => chrome.runtime.sendMessage({ type: 'command', command, windowId }), {
      command: name,
      windowId,
    });
  const createTab = (url: string, active: boolean) =>
    sw.evaluate(({ url, active }) => chrome.tabs.create({ url, active }).then((t) => t.id ?? -1), { url, active });

  /** No page in `names` was loaded again: same load id, one request each. */
  async function expectNoReloads(names: string[]): Promise<void> {
    for (const name of names) {
      const page = pages.get(name);
      if (!page) throw new Error(`No page named ${name}`);
      const loadId = await page.evaluate(() => (window as unknown as { __loadId: string }).__loadId);
      expect(loadId, `${name} was not reloaded`).toBe(loadIds.get(name));
      expect(server.hits.get(`${hostOf.get(name)}/${name}`), `${name} was requested once`).toBe(1);
    }
  }

  test.beforeAll(async ({}, testInfo) => {
    kind = testInfo.project.name === 'brave' ? 'brave' : 'chromium';
    testInfo.skip(kind === 'brave' && !findBrave(), 'Brave is not installed on this computer');

    server = await startPageServer();
    userDataDir = mkdtempSync(path.join(os.tmpdir(), `workspaces-${kind}-`));
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind));
    await writeRules(sw); // a real install starts with no addresses

    // Seven tabs on test hosts that no rule matches.
    const specs: Array<[string, string, string?]> = [
      ['office-1', 'office.test'],
      ['office-2', 'office.test'],
      ['blog-1', 'blog.test', server.url('app.example.com', '/from-link')],
      ['blog-2', 'blog.test'],
      ['stg-1', 'stg.test'],
      ['stg-2', 'stg.test'],
      ['loose', 'loose.test'],
    ];
    for (const [name, host, link] of specs) {
      const page = await ctx.newPage();
      await page.goto(server.url(host, `/${name}`, link));
      pages.set(name, page);
      hostOf.set(name, host);
      tabIds.set(name, await tabIdByPath(sw, `/${name}`));
      loadIds.set(name, await page.evaluate(() => (window as unknown as { __loadId: string }).__loadId));
    }
    windowId = await sw.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => t.windowId), id('office-1'));

    // Three projects, made the way the owner makes groups in Brave.
    const makeGroup = (title: string, color: string, names: string[]) =>
      sw.evaluate(
        async ({ title, color, ids }) => {
          const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]] });
          await chrome.tabGroups.update(groupId, { title, color: color as chrome.tabGroups.Color });
          return groupId;
        },
        { title, color, ids: names.map(id) },
      );
    groupIds.set('Office', await makeGroup('Office', 'blue', ['office-1', 'office-2']));
    groupIds.set('Blog', await makeGroup('Blog', 'green', ['blog-1', 'blog-2']));
    groupIds.set('🟠 App staging', await makeGroup('🟠 App staging', 'orange', ['stg-1', 'stg-2']));
    await until(
      () => stored(sw),
      (s) => s.projects.length === 3,
      'the three projects to be remembered',
    );

    driver = await ctx.newPage();
    await driver.goto(`chrome-extension://${extensionId}/options.html`);
    await openSidePanel(driver);
    await until(
      () => panelRows(driver),
      (rows) => rows?.length === 3,
      'the side panel to list three projects',
    );
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('the side panel lists the projects of the window with their tab counts', async () => {
    const rows = await panelRows(driver);
    expect(rows?.map((r) => r.title)).toEqual(['Office', 'Blog', '🟠 App staging']);
    expect(rows?.map((r) => r.count)).toEqual([2, 2, 2]);
    const s = await stored(sw);
    expect(s.rules.map((r) => `${r.host} -> ${r.project}`)).toEqual([
      'office.example.com -> Office',
      'app.example.com -> App',
      'staging.example.com -> 🟠 App staging',
      'studio.example.com -> Studio',
      'staging-studio.example.com -> 🟠 Studio staging',
      'example.com -> Blog',
      'staging-blog.example.com -> 🟠 Blog staging',
    ]);
    // Suggested keys: Brave/Chromium assign them on install when nothing else uses them.
    test.info().annotations.push({ type: 'shortcuts shown', description: JSON.stringify(rows?.map((r) => r.shortcut)) });
  });

  test('clicking a project opens it, folds the others, keeps every tab and reloads nothing', async () => {
    const before = await state();
    expect(before.open.sort()).toEqual(['Office', 'Blog', '🟠 App staging'].sort());

    await panelClick(driver, { kind: 'project', title: 'Blog' });
    const after = await until(state, (s) => onlyOpen(s, 'Blog'), 'Blog open alone');

    expect(after.active?.id).toBe(id('blog-1'));
    expect(after.tabs.map((t) => t.id).sort()).toEqual(before.tabs.map((t) => t.id).sort());
    expect(after.tabs.filter((t) => t.discarded)).toEqual([]);
    expect(after.groups.find((g) => g.title === 'Office')?.tabIds).toEqual([id('office-1'), id('office-2')]);
    await expectNoReloads(['office-1', 'office-2', 'blog-1', 'blog-2', 'stg-1', 'stg-2', 'loose']);
    await until(
      () => panelRows(driver),
      (rows) => rows?.find((r) => r.current)?.title === 'Blog',
      'the panel to mark Blog as the open project',
    );
  });

  test('switching back lands on the tab last used in that project', async () => {
    await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), id('blog-2'));
    await until(state, (s) => s.active?.id === id('blog-2'), 'blog-2 active');

    await panelClick(driver, { kind: 'project', title: 'Office' });
    await until(state, (s) => onlyOpen(s, 'Office') && s.active?.id === id('office-1'), 'Office open on its first tab');

    await panelClick(driver, { kind: 'project', title: 'Blog' });
    await until(state, (s) => onlyOpen(s, 'Blog') && s.active?.id === id('blog-2'), 'Blog open on blog-2 again');
  });

  test('shortcut commands: Project N, next project, previous project', async () => {
    await command('project-1');
    await until(state, (s) => onlyOpen(s, 'Office'), 'Project 1 = Office');
    await command('next-project');
    await until(state, (s) => onlyOpen(s, 'Blog'), 'next = Blog');
    await command('previous-project');
    await until(state, (s) => onlyOpen(s, 'Office'), 'previous = Office');
    await command('project-3');
    await until(state, (s) => onlyOpen(s, '🟠 App staging'), 'Project 3 = staging');
    await expectNoReloads(['office-1', 'office-2', 'blog-1', 'blog-2', 'stg-1', 'stg-2', 'loose']);
  });

  test('opening a folded group from the tab bar makes it the open project', async () => {
    // What a click on a folded group label in the tab bar does.
    await sw.evaluate((groupId) => chrome.tabGroups.update(groupId, { collapsed: false }), groupIds.get('Office') ?? -1);
    await until(state, (s) => onlyOpen(s, 'Office'), 'Office open alone after opening it from the tab bar');
  });

  test('going to a tab of a folded project keeps that tab and folds the rest', async () => {
    await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), id('stg-2'));
    await until(
      state,
      (s) => onlyOpen(s, '🟠 App staging') && s.active?.id === id('stg-2'),
      'staging open on stg-2, the tab chosen',
    );
  });

  test('rules: a new staging tab lands in its project, new projects start folded, exact hosts only', async () => {
    const stagingTab = await createTab(server.url('staging.example.com', '/new-staging'), true);
    await until(
      state,
      (s) => s.groupOf(stagingTab) === '🟠 App staging' && onlyOpen(s, '🟠 App staging') && s.active?.id === stagingTab,
      'the new staging tab in 🟠 App staging',
    );

    const studioTab = await createTab(server.url('staging-studio.example.com', '/studio-staging'), false);
    const s1 = await until(state, (s) => s.groupOf(studioTab) === '🟠 Studio staging', 'a new 🟠 Studio staging project');
    expect(s1.groups.find((g) => g.title === '🟠 Studio staging')?.color).toBe('orange');
    await until(state, (s) => onlyOpen(s, '🟠 App staging'), 'the new project folded, staging still the open one');

    const wwwTab = await createTab(server.url('www.example.com', '/www'), false);
    const blogTab = await createTab(server.url('example.com', '/pricing'), false);
    await until(state, (s) => s.groupOf(blogTab) === 'Blog', 'example.com in Blog');
    await until(state, (s) => s.tabs.find((t) => t.id === wwwTab)?.status === 'complete', 'www page loaded');
    await pause(800);
    const s2 = await state();
    expect(s2.groupOf(wwwTab), 'www.example.com matches no rule').toBeNull();
    expect(s2.groups.find((g) => g.title === 'Blog')?.collapsed, 'Blog stays folded').toBe(true);
    expect(onlyOpen(s2, '🟠 App staging')).toBe(true);
    tabIds.set('www', wwwTab);
  });

  test('a rule never takes a tab out of a group the owner put it in', async () => {
    await sw.evaluate(({ tabId, url }) => chrome.tabs.update(tabId, { url }), {
      tabId: id('blog-2'),
      url: server.url('office.example.com', '/manual'),
    });
    await until(state, (s) => s.tabs.find((t) => t.id === id('blog-2'))?.url.includes('/manual') === true, 'blog-2 moved on');
    await pause(800);
    expect((await state()).groupOf(id('blog-2'))).toBe('Blog');
  });

  test('a tab opened from a link follows its rule, and its project becomes the open one', async () => {
    await panelClick(driver, { kind: 'project', title: 'Blog' });
    await until(state, (s) => onlyOpen(s, 'Blog'), 'Blog open'); // let the switch finish first
    await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), id('blog-1'));
    await until(state, (s) => onlyOpen(s, 'Blog') && s.active?.id === id('blog-1'), 'blog-1 active');

    const webPage = pages.get('blog-1');
    if (!webPage) throw new Error('blog-1 page missing');
    await webPage.click('#link');
    const linked = await tabIdByPath(sw, '/from-link');
    // The tab first joins Blog (it was opened from a Blog tab), then its rule sends it to App.
    await until(
      state,
      (s) => s.groupOf(linked) === 'App' && onlyOpen(s, 'App') && s.active?.id === linked,
      'the linked app.example.com tab in App',
    );
  });

  test('rename, recolour and reorder from the side panel', async () => {
    const order = (await stored(sw)).projects.map((p) => p.title);
    const at = order.indexOf('🟠 Studio staging');
    expect(at).toBeGreaterThan(-1);

    await panelClick(driver, { kind: 'more', title: '🟠 Studio staging' });
    await panelClick(driver, { kind: 'button', text: 'Rename', scope: '#list .menu' });
    await panelType(driver, 'rename', '🟠 Studio test');
    await panelClick(driver, { kind: 'button', text: 'Save', scope: '#list .menu' });
    await until(state, (s) => s.groups.some((g) => g.title === '🟠 Studio test'), 'group renamed in the browser');
    const renamed = await until(
      () => stored(sw),
      (s) => s.projects.some((p) => p.title === '🟠 Studio test'),
      'rename remembered',
    );
    expect(renamed.projects.map((p) => p.title).indexOf('🟠 Studio test'), 'keeps its place').toBe(at);
    expect(renamed.projects.some((p) => p.title === '🟠 Studio staging')).toBe(false);

    await panelClick(driver, { kind: 'more', title: 'Office' });
    await panelClick(driver, { kind: 'swatch', color: 'red' });
    await until(state, (s) => s.groups.find((g) => g.title === 'Office')?.color === 'red', 'Office turned red');
    await until(
      () => stored(sw),
      (s) => s.projects.find((p) => p.title === 'Office')?.color === 'red',
      'red remembered',
    );

    // The menu (still open from the colour change): one row of colours and two icons, no Move up or
    // Move down (the grip and Alt+Up, Alt+Down do that).
    const menu = await until(() => panelMenu(driver), (m) => m?.project === 'Office', "Office's menu open");
    expect(menu?.icons).toEqual(['Rename', 'Delete']);
    expect(menu?.texts.some((t) => /Move/.test(t))).toBe(false);
    // Another project's ⋯ only closes the open menu; a second click opens that one.
    await panelClick(driver, { kind: 'more', title: 'Blog' });
    await until(() => panelMenu(driver), (m) => m === null, 'the menu closed, and no other one opened');
    await panelClick(driver, { kind: 'more', title: 'Blog' });
    await until(() => panelMenu(driver), (m) => m?.project === 'Blog' && m.menus === 1, "Blog's menu open");
    // Picking a project closes the menu too.
    await panelClick(driver, { kind: 'project', title: 'Office' });
    await until(() => panelMenu(driver), (m) => m === null, 'the menu closed by picking a project');
    await until(state, (s) => onlyOpen(s, 'Office'), 'and Office opened');

    // The list and the tab bar keep one order: moving in the list moves the group in the tab bar...
    await panelKey(driver, 'Blog', 'ArrowUp', true);
    const moved = await until(state, (s) => tabBarOrder(s)[0] === 'Blog', 'Blog first in the tab bar');
    await until(
      () => panelRows(driver),
      (rows) => JSON.stringify(rows?.map((r) => r.title)) === JSON.stringify(tabBarOrder(moved)),
      'the panel in the same order as the tab bar',
    );
    await command('project-1');
    await until(state, (s) => onlyOpen(s, 'Blog'), 'Project 1 is now Blog');

    // ...and dragging a group in the tab bar moves it in the list.
    await sw.evaluate((groupId) => chrome.tabGroups.move(groupId, { index: -1 }), groupIds.get('Office') ?? -1);
    const after = await until(state, (s) => tabBarOrder(s).at(-1) === 'Office', 'Office last in the tab bar');
    await until(
      () => panelRows(driver),
      (rows) => JSON.stringify(rows?.map((r) => r.title)) === JSON.stringify(tabBarOrder(after)),
      'the panel following the tab bar',
    );
    const rows = await panelRows(driver);
    expect(rows?.at(-1)?.title).toBe('Office');

    // Dragging a row by its grip in the side panel moves the group in the tab bar too.
    await driver.evaluate(() => {
      const view = chrome.extension.getViews().find((w) => w.location.pathname.endsWith('/panel.html'));
      const rowsEl = [...(view?.document.querySelectorAll<HTMLElement>('#list .row') ?? [])];
      const grip = rowsEl.at(-1)?.querySelector<HTMLElement>('.grip');
      const target = rowsEl[0];
      if (!view || !grip || !target) throw new Error('panel rows missing');
      const W = view as unknown as { DragEvent: typeof DragEvent; DataTransfer: typeof DataTransfer };
      const data = new W.DataTransfer();
      const top = target.getBoundingClientRect().top + 3;
      grip.dispatchEvent(new W.DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new W.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: top }));
      target.dispatchEvent(new W.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientY: top }));
      grip.dispatchEvent(new W.DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    });
    await until(state, (s) => tabBarOrder(s)[0] === 'Office', 'Office dragged to the front of the tab bar');
    await until(() => panelRows(driver), (r) => r?.[0]?.title === 'Office', 'Office first in the panel');
  });

  test('a new project from the selected tabs, and deleting it only ungroups its tabs', async () => {
    const s0 = await state();
    const indexes = [id('www'), id('loose')].map((tabId) => s0.tabs.find((t) => t.id === tabId)?.index ?? -1);
    await sw.evaluate(({ windowId, tabs }) => chrome.tabs.highlight({ windowId, tabs }), { windowId, tabs: indexes });
    await until(
      () => panelText(driver, '#create .new small'),
      (text) => text === 'from the 2 selected tabs',
      'the panel to see two selected tabs',
    );

    await panelClick(driver, { kind: 'selector', selector: '#create .new' });
    await panelType(driver, 'create', 'Docs');
    await panelClick(driver, { kind: 'button', text: 'Create', scope: '#create' });
    const s1 = await until(state, (s) => onlyOpen(s, 'Docs'), 'Docs open alone');
    expect([...(s1.groups.find((g) => g.title === 'Docs')?.tabIds ?? [])].sort()).toEqual([id('www'), id('loose')].sort());

    await panelClick(driver, { kind: 'more', title: 'Docs' });
    await panelClick(driver, { kind: 'button', text: 'Delete', scope: '#list .menu' });
    await panelClick(driver, { kind: 'button', text: 'Delete project', scope: '#list .menu' });
    const s2 = await until(state, (s) => !s.groups.some((g) => g.title === 'Docs'), 'Docs gone');
    expect(s2.tabs.length, 'no tab closed').toBe(s1.tabs.length);
    expect(s2.groupOf(id('www'))).toBeNull();
    expect(s2.groupOf(id('loose'))).toBeNull();
    await until(() => stored(sw), (s) => !s.projects.some((p) => p.title === 'Docs'), 'Docs forgotten');
  });

  test('extension pages and the worker cannot reach the network', async () => {
    const fromPage = await driver.evaluate(
      (url) => fetch(url).then(() => 'reached', (err: unknown) => `blocked: ${String(err)}`),
      server.url('127.0.0.1', '/probe-page'),
    );
    const fromWorker = await sw.evaluate(
      (url) => fetch(url).then(() => 'reached', (err: unknown) => `blocked: ${String(err)}`),
      server.url('127.0.0.1', '/probe-worker'),
    );
    expect(fromPage).toMatch(/^blocked/);
    expect(fromWorker).toMatch(/^blocked/);
    expect(server.hits.get('127.0.0.1/probe-page') ?? 0).toBe(0);
    expect(server.hits.get('127.0.0.1/probe-worker') ?? 0).toBe(0);
  });

  test('along the way no tab was reloaded or discarded', async () => {
    // blog-2 was sent to a new address on purpose in the rule test, so it is left out.
    await expectNoReloads(['office-1', 'office-2', 'blog-1', 'stg-1', 'stg-2', 'loose']);
    expect((await state()).tabs.filter((t) => t.discarded)).toEqual([]);
  });

  test('after a restart: same projects, same order, switching and rules still work', async () => {
    await panelClick(driver, { kind: 'project', title: 'Office' }); // Office open before the restart
    const before = await until(state, (s) => onlyOpen(s, 'Office'), 'Office open before restart');
    const memory = await stored(sw);
    const look = (s: Awaited<ReturnType<typeof state>>) => s.groups.map((g) => `${g.title}|${g.color}|${g.collapsed}`).sort();
    const orderBefore = tabBarOrder(before);
    const lastBlog = memory.lastActive['blog'];
    expect(lastBlog?.url).toContain('/blog-1');

    await pause(3000); // let the browser write its session to disk
    await ctx.close();
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind, ['--restore-last-session']));

    windowId = await until(
      () => sw.evaluate(async () => (await chrome.tabGroups.query({}))[0]?.windowId ?? -1),
      (w) => w !== -1,
      'the restored window',
    );
    const after = await until(
      state,
      (s) => s.groups.length === before.groups.length && s.tabs.every((t) => t.status !== 'loading'),
      'every group restored and settled',
      20_000,
    );
    expect(look(after)).toEqual(look(before));
    test.info().annotations.push({
      type: 'group ids',
      description: `before ${before.groups.map((g) => g.id).join(',')} / after ${after.groups.map((g) => g.id).join(',')}`,
    });
    expect((await stored(sw)).projects.map((p) => p.title)).toEqual(memory.projects.map((p) => p.title));

    driver = await ctx.newPage();
    await driver.goto(`chrome-extension://${extensionId}/options.html`);
    await openSidePanel(driver);
    expect(tabBarOrder(after), 'Brave brings the groups back in the same order').toEqual(orderBefore);
    const expectedOrder = orderBefore;
    await until(
      () => panelRows(driver),
      (rows) => JSON.stringify(rows?.map((r) => r.title)) === JSON.stringify(expectedOrder),
      'the side panel to list the projects in tab bar order',
    );

    // Pages already loaded after the restart must not load again when switching.
    const settled = await state();
    const loaded = settled.tabs
      .filter((t) => t.status === 'complete' && t.url.startsWith('http'))
      .map((t) => {
        const u = new URL(t.url);
        return `${u.hostname}${u.pathname}`;
      });
    const hitsBefore = new Map(loaded.map((key) => [key, server.hits.get(key)]));
    await panelClick(driver, { kind: 'project', title: 'Blog' });
    const s1 = await until(state, (s) => onlyOpen(s, 'Blog'), 'Blog open alone after restart');
    expect(s1.active?.url, 'back on the tab last used in Blog, found by its address').toBe(lastBlog?.url);
    for (const [key, count] of hitsBefore) expect(server.hits.get(key), `${key} not reloaded by switching`).toBe(count);

    const stagingTab = await createTab(server.url('staging-blog.example.com', '/after-restart'), true);
    await until(
      state,
      (s) => s.groupOf(stagingTab) === '🟠 Blog staging' && onlyOpen(s, '🟠 Blog staging'),
      'a staging tab after the restart lands in its project',
    );
  });
});
