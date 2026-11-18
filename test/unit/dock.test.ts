import { expect, test } from '@playwright/test';
import { clampWindowWidth, dockLayout, PROJECT_WINDOW_DEFAULT_WIDTH } from '../../src/lib/dock.js';

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
