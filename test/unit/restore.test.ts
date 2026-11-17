import { expect, test } from '@playwright/test';
import { openProjectKey, pickOpenAfterRestore, rememberOpen, windowSignature } from '../../src/lib/restore.js';
import type { GroupInfo, TabInfo } from '../../src/lib/types.js';

const W = 7;
const g = (id: number, title: string, collapsed: boolean, windowId = W): GroupInfo => ({
  id,
  title,
  color: 'blue',
  collapsed,
  windowId,
});
const t = (id: number, groupId: number, active = false, windowId = W): TabInfo => ({
  id,
  groupId,
  index: id,
  active,
  pinned: false,
  url: `https://example.com/${id}`,
  windowId,
});

test('a window is known by its project names, whatever the order, case or ids', () => {
  const a = windowSignature([g(1, 'Beta', true), g(2, 'alpha', false), g(3, '', false), g(4, 'Other', false, 9)], W);
  const b = windowSignature([g(50, 'Alpha', true), g(60, ' beta ', true)], W);
  expect(a).toBe('alpha\nbeta');
  expect(b).toBe(a);
  expect(windowSignature([g(1, '', false)], W)).toBe('');
});

test('the open project is the active tab group, else the only open group', () => {
  const groups = [g(1, 'Alpha', true), g(2, 'Beta', false), g(3, 'Gamma', true)];
  expect(openProjectKey(groups, [t(1, 2, true)], W)).toBe('beta');
  expect(openProjectKey(groups, [t(1, -1, true)], W)).toBe('beta'); // active tab outside groups
  expect(openProjectKey([g(1, 'A', false), g(2, 'B', false)], [t(1, -1, true)], W)).toBeNull(); // two open, no answer
});

test('after Ctrl+Shift+T: the remembered project wins over what Brave made active', () => {
  // Brave made the first tab active (in Alpha) although Beta was open before.
  const groups = [g(10, 'Alpha', true), g(20, 'Beta', false), g(30, 'Gamma', true)];
  const tabs = [t(1, 10, true), t(2, 20), t(3, 30)];
  expect(pickOpenAfterRestore(groups, tabs, W, 'beta')).toBe(20);
});

test('with nothing remembered: the only open group, else the active tab group, else nothing', () => {
  const tabs = [t(1, 10, true), t(2, 20)];
  expect(pickOpenAfterRestore([g(10, 'Alpha', true), g(20, 'Beta', false)], tabs, W, undefined)).toBe(20);
  expect(pickOpenAfterRestore([g(10, 'Alpha', false), g(20, 'Beta', false)], tabs, W, undefined)).toBe(10);
  expect(pickOpenAfterRestore([g(10, 'Alpha', true), g(20, 'Beta', true)], [t(1, -1, true)], W, 'gone')).toBeNull();
});

test('rememberOpen keeps the newest windows, last, and returns the same object when nothing changed', () => {
  let map: Record<string, string> = {};
  map = rememberOpen(map, 'a', 'x');
  map = rememberOpen(map, 'b', 'y');
  const same = rememberOpen(map, 'b', 'y');
  expect(same).toBe(map);
  map = rememberOpen(map, 'a', 'z'); // updated: moves to the end
  expect(Object.entries(map)).toEqual([
    ['b', 'y'],
    ['a', 'z'],
  ]);
  let big: Record<string, string> = {};
  for (let i = 0; i < 40; i++) big = rememberOpen(big, `w${i}`, 'p', 30);
  expect(Object.keys(big)).toHaveLength(30);
  expect(Object.keys(big)[0]).toBe('w10');
  expect(rememberOpen(map, '', 'x')).toBe(map);
});
