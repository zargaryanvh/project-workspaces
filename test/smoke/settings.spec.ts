import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findBrave,
  launchBrowser,
  onlyOpen,
  openExtensionPage,
  startPageServer,
  stored,
  tabIdByPath,
  until,
  windowState,
  writeRules,
  type BrowserKind,
  type PageServer,
} from './harness.js';

/** The settings page (save bar, errors, dropdown, addresses), the project row and a narrow panel. */

test.describe.serial('Settings page, project row and narrow panel', () => {
  let kind: BrowserKind = 'chromium';
  let server: PageServer;
  let userDataDir = '';
  let ctx: BrowserContext;
  let sw: Worker;
  let extensionId = '';
  let windowId = -1;
  let options: Page;

  const createTab = (url: string, active: boolean) =>
    sw.evaluate(({ url, active }) => chrome.tabs.create({ url, active }).then((t) => t.id ?? -1), { url, active });
  const state = () => windowState(sw, windowId);
  const cardByIndex = (i: number) => options.locator('.card').nth(i);

  test.beforeAll(async ({}, testInfo) => {
    kind = testInfo.project.name === 'brave' ? 'brave' : 'chromium';
    testInfo.skip(kind === 'brave' && !findBrave(), 'Brave is not installed on this computer');
    server = await startPageServer();
    userDataDir = mkdtempSync(path.join(os.tmpdir(), `workspaces-settings-${kind}-`));
    ({ ctx, sw, extensionId } = await launchBrowser(userDataDir, kind));

    for (const [host, name] of [
      ['admin.test', 'a1'],
      ['web.test', 'w1'],
    ] as const) {
      const page = await ctx.newPage();
      await page.goto(server.url(host, `/${name}`));
    }
    const a1 = await tabIdByPath(sw, '/a1');
    const w1 = await tabIdByPath(sw, '/w1');
    windowId = await sw.evaluate((tabId) => chrome.tabs.get(tabId).then((t) => t.windowId), a1);
    await sw.evaluate(
      async ({ a1, w1 }) => {
        const admin = await chrome.tabs.group({ tabIds: a1 });
        await chrome.tabGroups.update(admin, { title: 'Admin', color: 'blue' as chrome.tabGroups.Color });
        const web = await chrome.tabs.group({ tabIds: w1 });
        await chrome.tabGroups.update(web, { title: 'Web', color: 'green' as chrome.tabGroups.Color });
      },
      { a1, w1 },
    );
    await until(() => stored(sw), (s) => s.projects.length >= 2, 'the projects remembered');
    options = await openExtensionPage(ctx, extensionId, 'options.html');
    await options.locator('.empty-cards').waitFor();
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a new install starts with no addresses; saved ones show as one card per project', async () => {
    await expect(options.locator('.empty-cards')).toContainText('No addresses yet');
    await writeRules(sw); // as if saved: the page shows them at once, since nothing was typed here
    await options.locator('.card').nth(6).waitFor();
    const names = await options.locator('.card-head input.text').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(names).toEqual(['Admin', 'App', '🟠 App staging', 'Platform', '🟠 Platform staging', 'Web', '🟠 Web staging']);
    await expect(options.locator('#save')).toBeDisabled();
    await expect(options.locator('#discard')).toBeDisabled();
    await expect(cardByIndex(0).locator('.status')).toHaveText('Group open');
    await expect(cardByIndex(1).locator('.status')).toHaveText('No group yet');
  });

  test('the project dropdown opens under its field, exactly as wide, and scrolls inside', async () => {
    const input = cardByIndex(1).locator('.card-head input.text');
    await input.click();
    const menu = cardByIndex(1).locator('.combo-menu');
    await expect(menu).toBeVisible();
    const field = await input.boundingBox();
    const list = await menu.boundingBox();
    if (!field || !list) throw new Error('no boxes');
    expect(Math.abs(list.y - (field.y + field.height))).toBeLessThanOrEqual(4);
    expect(Math.abs(list.x - field.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(list.width - field.width)).toBeLessThanOrEqual(1);
    expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    await expect(menu.locator('.combo-option', { hasText: 'Admin' })).toContainText('open');
    await input.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('a wrong address: red outline and an icon with the message, no text under it; Save refuses; Discard undoes', async () => {
    const web = cardByIndex(5);
    await web.getByRole('button', { name: '+ Add address' }).click();
    const address = web.locator('.address input.text').last();
    await address.fill('not a host');
    await address.press('Tab');
    await expect(address).toHaveClass(/invalid/);
    const icon = web.locator('.field-error.shown');
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute('data-tip', /Type an address like/);
    await expect(web.locator('.note, .help-inline')).toHaveCount(0);

    await expect(options.locator('#save')).toBeEnabled();
    await options.locator('#save').click();
    await expect(address).toBeFocused();
    expect((await stored(sw)).rules).toHaveLength(7);

    await options.locator('#discard').click();
    await expect(options.locator('#save')).toBeDisabled();
    await expect(cardByIndex(5).locator('.address')).toHaveCount(1);
  });

  test('a local address saved for Web sends localhost tabs to Web', async () => {
    const web = cardByIndex(5);
    await web.getByRole('button', { name: '+ Add address' }).click();
    await web.locator('.address input.text').last().fill(`localhost:${server.port}`);
    await options.locator('#save').click();
    await expect(options.locator('#saved')).toHaveText('✓ Saved');
    await until(
      () => stored(sw),
      (s) => s.rules.some((r) => r.host === `localhost:${server.port}` && r.project === 'Web'),
      'the local address saved',
    );
    const tab = await createTab(`http://localhost:${server.port}/local`, false);
    await until(state, (s) => s.groupOf(tab) === 'Web', 'the localhost tab in Web');
  });

  test('saving a new project with *. sorts the matching tabs that are already open (the Payments case)', async () => {
    const vendors = await createTab(server.url('vendors.payments.test', '/overview'), false);
    await until(state, (s) => s.tabs.find((t) => t.id === vendors)?.status === 'complete', 'the Payments page loaded');
    expect((await state()).groupOf(vendors)).toBeNull();

    await options.locator('#add-project').click();
    const payments = options.locator('.card').last();
    await payments.locator('.card-head input.text').fill('Payments');
    await payments.locator('.address input.text').fill('*.payments.test');
    await options.locator('#save').click();
    await until(state, (s) => s.groupOf(vendors) === 'Payments', 'the open Payments tab moved to Payments');

    const login = await createTab(server.url('login.payments.test', '/'), false);
    await until(state, (s) => s.groupOf(login) === 'Payments', 'login.payments.test in Payments too');
  });

  test('drag a project card to change the order', async () => {
    const names = () => options.locator('.card-head input.text').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    // Tall enough to see every card: Playwright would otherwise scroll in the middle of the drag.
    await options.setViewportSize({ width: 1200, height: 1700 });
    const before = await names();
    // The page's own drag events, as the browser sends them: start on the last card's grip,
    // drop on the top edge of the first card. (The browser's drag gesture itself does not start
    // reliably under automation after earlier steps, so the events are sent directly.)
    await options.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('.card')];
      const grip = cards.at(-1)?.querySelector<HTMLElement>('.grip');
      const target = cards[0];
      if (!grip || !target) throw new Error('cards missing');
      const data = new DataTransfer();
      const top = target.getBoundingClientRect().top + 4;
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: top }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientY: top }));
      grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    });
    const after = await names();
    expect(after[0]).toBe(before[7]);
    await expect(options.locator('#save')).toBeEnabled();
    await options.locator('#discard').click();
    expect(await names()).toEqual(before);
  });

  test('leaving with unsaved changes asks first', async () => {
    await options.locator('#follow').click();
    await expect(options.locator('#save')).toBeEnabled();
    const dialogs: string[] = [];
    options.on('dialog', (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await options.close({ runBeforeUnload: true });
    await until(async () => dialogs.length, (n) => n > 0, 'the leave question');
    expect(dialogs[0]).toBe('beforeunload');
    expect(options.isClosed()).toBe(false);
    await options.locator('#discard').click();
    await expect(options.locator('#save')).toBeDisabled();
  });

  test('the toolbar button can open the project row; the row switches projects', async () => {
    const popup = () => sw.evaluate(() => chrome.action.getPopup({}));
    await options.locator('#surface').selectOption('row');
    await options.locator('#save').click();
    await until(popup, (p) => p.endsWith('/panel.html?view=row'), 'the toolbar button opens the row');

    const row = await openExtensionPage(ctx, extensionId, `panel.html?view=row&windowId=${windowId}`);
    await row.locator('.chip').first().waitFor();
    const chips = await row.locator('.chip-name').allTextContents();
    expect(chips).toEqual(expect.arrayContaining(['Admin', 'Web', 'Payments']));
    await row.locator('.chip', { hasText: 'Admin' }).click();
    await until(state, (s) => onlyOpen(s, 'Admin'), 'Admin open from the row');

    await options.bringToFront();
    await options.locator('#surface').selectOption('sidePanel');
    await options.locator('#save').click();
    await until(popup, (p) => p === '', 'back to the side panel');
  });

  test('one click selects a project, even when that click also gives the panel focus', async () => {
    const groups = await sw.evaluate(
      async (id) => (await chrome.tabGroups.query({ windowId: id })).map((g) => ({ id: g.id, title: g.title ?? '' })),
      windowId,
    );
    const web = groups.find((g) => g.title === 'Web');
    if (!web) throw new Error('Web group missing');
    // The list in a window of its own, so clicking it does not change the browsing window's tabs.
    const [panel] = await Promise.all([
      ctx.waitForEvent('page'),
      sw.evaluate(
        (url) => chrome.windows.create({ url, type: 'popup', width: 380, height: 520 }),
        `chrome-extension://${extensionId}/panel.html?windowId=${windowId}`,
      ),
    ]);
    await panel.locator('#list .row').first().waitFor();
    await panel.evaluate(({ id, groupId }) => chrome.runtime.sendMessage({ type: 'switch', windowId: id, groupId }), {
      id: windowId,
      groupId: web.id,
    });
    await until(state, (s) => onlyOpen(s, 'Web'), 'Web open first');

    // What a person does after clicking in the page: the button goes down on a project, the panel
    // gets the focus, and the button comes up a moment later. That one click must select.
    await until(
      async () => (await panel.locator('#list .row.current').textContent()) ?? '',
      (text) => text.includes('Web'),
      'the panel to show Web as the open project',
    );
    const target = panel.locator('#list .row', { hasText: 'Admin' }).locator('.main');
    const box = await until(() => target.boundingBox(), (b) => b !== null, 'the Admin row on screen');
    if (!box) throw new Error('no Admin row');
    await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await panel.mouse.down();
    await panel.evaluate(() => window.dispatchEvent(new Event('focus')));
    await panel.waitForTimeout(150);
    await panel.mouse.up();
    await until(state, (s) => onlyOpen(s, 'Admin'), 'Admin open after one click', 3000);
    await panel.close();
  });

  test('a narrow side panel fits: names end with "...", extras hide, New project stays at the bottom', async () => {
    const narrow = await ctx.newPage();
    await narrow.setViewportSize({ width: 160, height: 200 });
    await narrow.goto(`chrome-extension://${extensionId}/panel.html?windowId=${windowId}`);
    await narrow.locator('#list .row').first().waitFor();
    const m = await narrow.evaluate(() => {
      const shown = (sel: string) => [...document.querySelectorAll(sel)].some((e) => getComputedStyle(e).display !== 'none');
      const scroll = document.getElementById('scroll') as HTMLElement;
      const foot = (document.querySelector('.foot') as HTMLElement).getBoundingClientRect();
      const name = document.querySelector('.row .name') as HTMLElement;
      return {
        sideways: document.documentElement.scrollWidth - innerWidth,
        keys: shown('.key'),
        counts: shown('.count'),
        footBottom: foot.bottom,
        footTop: foot.top,
        height: innerHeight,
        listScrolls: scroll.scrollHeight > scroll.clientHeight,
        ellipsis: getComputedStyle(name).textOverflow,
      };
    });
    expect(m.sideways).toBeLessThanOrEqual(0);
    expect(m.keys).toBe(false);
    expect(m.counts).toBe(false);
    expect(m.ellipsis).toBe('ellipsis');
    expect(m.listScrolls).toBe(true);
    expect(m.footBottom).toBeLessThanOrEqual(m.height + 1);
    expect(m.footTop).toBeLessThan(m.height);
    await narrow.close();
  });
});
