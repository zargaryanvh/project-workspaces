import { expect, test } from '@playwright/test';
import {
  centerIn,
  clampWindowWidth,
  dockLayout,
  followBrowser,
  followList,
  frameInset,
  nearestWindow,
  PROJECT_WINDOW_DEFAULT_WIDTH,
  sameRect,
  toOuter,
  toVisible,
  type Pair,
} from '../../src/lib/dock.js';

const area = { left: 0, top: 0, width: 1920, height: 1040 };

test('on the left: the list at the screen edge, Brave in the rest', () => {
  expect(dockLayout(area, 'left', 300)).toEqual({
    list: { left: 0, top: 0, width: 300, height: 1040 },
    browser: { left: 300, top: 0, width: 1620, height: 1040 },
  });
});

test('on the right: Brave first, the list at the right edge', () => {
  expect(dockLayout(area, 'right', 280)).toEqual({
    list: { left: 1640, top: 0, width: 280, height: 1040 },
    browser: { left: 0, top: 0, width: 1640, height: 1040 },
  });
});

test('a second screen or a taskbar at the top moves both windows with the work area', () => {
  const second = { left: 1920, top: 40, width: 1600, height: 860 };
  expect(dockLayout(second, 'left', 300)).toEqual({
    list: { left: 1920, top: 40, width: 300, height: 860 },
    browser: { left: 2220, top: 40, width: 1300, height: 860 },
  });
});

test('the width stays usable: not below the minimum, not above the maximum or half the screen', () => {
  expect(clampWindowWidth(100)).toBe(180);
  expect(clampWindowWidth(900)).toBe(600);
  expect(clampWindowWidth(500, 800)).toBe(400);
  expect(clampWindowWidth(Number.NaN)).toBe(PROJECT_WINDOW_DEFAULT_WIDTH);
  expect(clampWindowWidth(301.6)).toBe(302);
  expect(dockLayout({ left: 0, top: 0, width: 700, height: 500 }, 'left', 600).list.width).toBe(350);
});

test('the invisible border: measured from inside the window, zoom taken into account', () => {
  expect(frameInset(616, 600)).toBe(7); // Windows 11: an 8 px frame each side, 1 px of it shows
  expect(frameInset(600, 586)).toBe(6);
  expect(frameInset(600, 600)).toBe(0); // macOS, Linux: no border
  expect(frameInset(616, 900, 0.666)).toBe(7); // the page zoomed out to 67 %
  expect(frameInset(600, 700)).toBe(0); // never negative
  expect(frameInset(600, 300)).toBe(16); // never absurd
  expect(frameInset(Number.NaN, 586)).toBe(0);
});

test('a window is placed by its outer box: the border is added left, right and below, never above', () => {
  const visible = { left: 300, top: 183, width: 1620, height: 1032 };
  const outer = toOuter(visible, 7);
  expect(outer).toEqual({ left: 293, top: 183, width: 1634, height: 1039 });
  expect(toVisible(outer, 7)).toEqual(visible);
});

test('the measured gap: two windows edge to edge by their outer boxes show 14 px, placed by toOuter they touch', () => {
  // As measured on Windows 11: list outer box -1920..-1320, Brave's -1320..0, each with a 7 px border.
  const listVisible = toVisible({ left: -1920, top: 183, width: 600, height: 1032 }, 7);
  const braveVisible = toVisible({ left: -1320, top: 183, width: 1320, height: 1032 }, 7);
  expect(braveVisible.left - (listVisible.left + listVisible.width)).toBe(14);
  const { list, browser } = dockLayout({ left: -1920, top: 183, width: 1920, height: 1032 }, 'left', 300);
  const listShows = toVisible(toOuter(list, 7), 7);
  const braveShows = toVisible(toOuter(browser, 7), 7);
  expect(braveShows.left).toBe(listShows.left + listShows.width);
  expect(listShows.left, 'the list starts at the screen edge, not 7 px in').toBe(-1920);
  expect(listShows.top + listShows.height, 'and reaches the taskbar').toBe(183 + 1032);
});

test('sameRect and centerIn', () => {
  expect(sameRect({ left: 0, top: 0, width: 10, height: 10 }, { left: 1, top: 0, width: 10, height: 11 })).toBe(true);
  expect(sameRect({ left: 0, top: 0, width: 10, height: 10 }, { left: 3, top: 0, width: 10, height: 10 })).toBe(false);
  expect(centerIn({ left: 100, top: 100, width: 200, height: 200 }, area)).toBe(true);
  expect(centerIn({ left: 1800, top: 100, width: 400, height: 200 }, area)).toBe(false);
});

// ---------------------------------------------------------------- Brave leads

const docked: Pair = {
  list: { left: 0, top: 0, width: 300, height: 1040 },
  browser: { left: 300, top: 0, width: 1620, height: 1040 },
};

test('Brave moved: the list goes along at its left, same height, same width', () => {
  const moved = { left: 700, top: 100, width: 1000, height: 800 };
  expect(followBrowser(area, 'left', 300, moved, docked)).toEqual({
    list: { left: 400, top: 100, width: 300, height: 800 },
    browser: moved,
  });
});

test('Brave moved to the screen edge: the list stays on screen and pushes Brave over', () => {
  const moved = { left: 100, top: 0, width: 1200, height: 1040 };
  expect(followBrowser(area, 'left', 300, moved, docked)).toEqual({
    list: { left: 0, top: 0, width: 300, height: 1040 },
    browser: { left: 300, top: 0, width: 1000, height: 1040 },
  });
});

test("Brave's edge next to the list dragged: the list takes the room, from the screen edge", () => {
  const wider = followBrowser(area, 'left', 300, { left: 420, top: 0, width: 1500, height: 1040 }, docked);
  expect(wider.list).toEqual({ left: 0, top: 0, width: 420, height: 1040 });
  expect(wider.browser).toEqual({ left: 420, top: 0, width: 1500, height: 1040 });
  const narrower = followBrowser(area, 'left', 300, { left: 100, top: 0, width: 1820, height: 1040 }, docked);
  expect(narrower.list.width, 'never narrower than the minimum').toBe(180);
  expect(narrower.browser.left).toBe(180);
  expect(narrower.browser.left + narrower.browser.width, "Brave's far edge stays").toBe(1920);
  const tooWide = followBrowser(area, 'left', 300, { left: 900, top: 0, width: 1020, height: 1040 }, docked);
  expect(tooWide.list.width, 'never wider than the maximum').toBe(600);
  expect(tooWide.browser.left).toBe(600);
});

test('a Brave window that is not maximized: the list opens attached to it, not at the screen edge', () => {
  const small = { left: 600, top: 200, width: 900, height: 600 };
  expect(followBrowser(area, 'left', 300, small, null)).toEqual({
    list: { left: 300, top: 200, width: 300, height: 600 },
    browser: small,
  });
});

test('on the right side: the same, mirrored', () => {
  const dockedRight = dockLayout(area, 'right', 300);
  const moved = { left: 200, top: 50, width: 1000, height: 900 };
  expect(followBrowser(area, 'right', 300, moved, dockedRight)).toEqual({
    list: { left: 1200, top: 50, width: 300, height: 900 },
    browser: moved,
  });
  const dragged = followBrowser(area, 'right', 300, { left: 0, top: 0, width: 1500, height: 1040 }, dockedRight);
  expect(dragged.list).toEqual({ left: 1500, top: 0, width: 420, height: 1040 });
  expect(dragged.browser).toEqual({ left: 0, top: 0, width: 1500, height: 1040 });
});

test('the list stays within the screen height, even when Brave reaches past it', () => {
  const tall = followBrowser(area, 'left', 300, { left: 500, top: -20, width: 1000, height: 1200 }, docked);
  expect(tall.list.top).toBe(0);
  expect(tall.list.height).toBe(1040);
});

test('Brave squeezed by the list never gets narrower than Brave allows', () => {
  const thin = followBrowser(area, 'left', 300, { left: 0, top: 0, width: 400, height: 1040 }, null);
  expect(thin.list.left).toBe(0);
  expect(thin.browser.left).toBe(300);
  expect(thin.browser.width).toBe(500);
});

// ---------------------------------------------------------------- the list leads

test("the list's edge next to Brave dragged: Brave keeps its far edge, the two share the room", () => {
  const next = followList(area, { left: 0, top: 0, width: 250, height: 1040 }, docked);
  expect(next).toEqual({
    list: { left: 0, top: 0, width: 250, height: 1040 },
    browser: { left: 250, top: 0, width: 1670, height: 1040 },
    side: 'left',
  });
});

test('the list moved: Brave goes along with its width, but not past the screen edge', () => {
  const dockedSmall: Pair = { list: { left: 0, top: 0, width: 300, height: 800 }, browser: { left: 300, top: 0, width: 1000, height: 800 } };
  expect(followList(area, { left: 200, top: 100, width: 300, height: 800 }, dockedSmall)).toEqual({
    list: { left: 200, top: 100, width: 300, height: 800 },
    browser: { left: 500, top: 100, width: 1000, height: 800 },
    side: 'left',
  });
  const nearEdge = followList(area, { left: 900, top: 0, width: 300, height: 800 }, dockedSmall);
  expect(nearEdge.browser).toEqual({ left: 1200, top: 0, width: 720, height: 800 });
});

test('the list dragged wider than allowed is held at the maximum', () => {
  const next = followList(area, { left: 0, top: 0, width: 750, height: 1040 }, docked);
  expect(next.list.width).toBe(600);
  expect(next.browser.left).toBe(600);
});

test('a list on the right of Brave: Brave follows on the left', () => {
  const dockedRight = dockLayout(area, 'right', 300);
  const next = followList(area, { left: 1580, top: 0, width: 340, height: 1040 }, dockedRight);
  expect(next.side).toBe('right');
  expect(next.list).toEqual({ left: 1580, top: 0, width: 340, height: 1040 });
  expect(next.browser).toEqual({ left: 0, top: 0, width: 1580, height: 1040 });
});

test('a list moved to another screen takes Brave there, with its width as far as that screen allows', () => {
  const laptop = { left: 1920, top: 0, width: 1707, height: 1019 };
  const next = followList(laptop, { left: 1920, top: 0, width: 300, height: 1019 }, docked);
  expect(next.browser.left).toBe(2220);
  expect(next.browser.left + next.browser.width).toBe(1920 + 1707);
  expect(next.browser.top).toBe(0);
  expect(next.browser.height).toBe(1019);
});

// ---------------------------------------------------------------- after a restart

test('a project window brought back after a restart belongs to the Brave window it touches', () => {
  const list = { left: -1920, top: 183, width: 300, height: 1039 };
  const windows = [
    { id: 1, left: 2552, top: 166, width: 1936, height: 1048 },
    { id: 2, left: -1627, top: 183, width: 1634, height: 1039 },
    { id: 3, left: -8, top: -8, width: 1723, height: 1035 },
  ];
  expect(nearestWindow(list, windows)?.id).toBe(2);
  expect(nearestWindow(list, [])).toBeNull();
});
