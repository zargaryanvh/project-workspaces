import { expect, test } from '@playwright/test';
import { groupsToFold, isEmptyPlan, planSwitch } from '../../src/lib/plan.js';
import type { GroupInfo, TabInfo } from '../../src/lib/types.js';

const W = 1;
const g = (id: number, title: string, collapsed = false, windowId = W): GroupInfo => ({
  id,
  title,
  color: 'blue',
  collapsed,
  windowId,
});
const t = (id: number, groupId: number, index: number, extra: Partial<TabInfo> = {}): TabInfo => ({
  id,
  groupId,
  index,
  active: false,
  pinned: false,
  url: `https://example.com/tab-${id}`,
  windowId: W,
  ...extra,
});

// Window 1: Admin (open, has the active tab), Web (folded), Staging (open), one loose tab.
// Window 2 has its own open group that must never be touched.
const groups: GroupInfo[] = [g(10, 'Admin'), g(20, 'Web', true), g(30, '🟠 App staging'), g(40, 'Other', false, 2)];
const tabs: TabInfo[] = [
  t(1, 10, 0, { active: true }),
  t(2, 10, 1),
  t(3, 20, 2),
  t(4, 20, 3),
  t(5, 30, 4),
  t(6, -1, 5),
  t(7, 40, 0, { windowId: 2, active: true }),
];

test('switching opens the project, activates its first tab and folds every other open group of that window', () => {
  expect(planSwitch({ windowId: W, groupId: 20, groups, tabs })).toEqual({
    activateTabId: 3,
    expandGroupId: 20,
    collapseGroupIds: [10, 30],
  });
});

test('goes back to the tab last used in the project', () => {
  const plan = planSwitch({ windowId: W, groupId: 20, groups, tabs, lastActive: { tabId: 4, url: tabs[3]!.url } });
  expect(plan?.activateTabId).toBe(4);
});

test('after a Brave restart the old tab id is gone, so the tab is found by its address', () => {
  const plan = planSwitch({ windowId: W, groupId: 20, groups, tabs, lastActive: { tabId: 999, url: tabs[3]!.url } });
  expect(plan?.activateTabId).toBe(4);
});

test('a remembered tab that is not in the project is ignored', () => {
  const plan = planSwitch({ windowId: W, groupId: 20, groups, tabs, lastActive: { tabId: 1, url: tabs[0]!.url } });
  expect(plan?.activateTabId).toBe(3);
});

test('the first tab is the leftmost one, whatever order Brave lists them in', () => {
  const shuffled = [t(9, 20, 7), t(8, 20, 6), ...tabs.filter((x) => x.groupId !== 20)];
  expect(planSwitch({ windowId: W, groupId: 20, groups, tabs: shuffled })?.activateTabId).toBe(8);
});

test('keeps the active tab when it is already in the project', () => {
  expect(planSwitch({ windowId: W, groupId: 10, groups, tabs })).toEqual({
    activateTabId: null,
    expandGroupId: null,
    collapseGroupIds: [30],
  });
});

test('nothing to do when the project is already the only open one', () => {
  const settled = [g(10, 'Admin'), g(20, 'Web', true), g(30, 'Staging', true)];
  const plan = planSwitch({ windowId: W, groupId: 10, groups: settled, tabs });
  expect(plan && isEmptyPlan(plan)).toBe(true);
});

test('foldOthers false opens the project and leaves the other groups alone', () => {
  const plan = planSwitch({ windowId: W, groupId: 20, groups, tabs, foldOthers: false });
  expect(plan).toEqual({ activateTabId: 3, expandGroupId: 20, collapseGroupIds: [] });
});

test('no plan for an unknown group, a group of another window, or a group without tabs', () => {
  expect(planSwitch({ windowId: W, groupId: 99, groups, tabs })).toBeNull();
  expect(planSwitch({ windowId: W, groupId: 40, groups, tabs })).toBeNull();
  expect(planSwitch({ windowId: W, groupId: 20, groups, tabs: tabs.filter((x) => x.groupId !== 20) })).toBeNull();
});

test('a plan only names one tab to activate: it never closes, discards or reloads tabs', () => {
  const plan = planSwitch({ windowId: W, groupId: 20, groups, tabs });
  expect(Object.keys(plan ?? {}).sort()).toEqual(['activateTabId', 'collapseGroupIds', 'expandGroupId']);
});

test('groupsToFold skips folded groups, the kept group and other windows', () => {
  expect(groupsToFold(groups, W, 30)).toEqual([10]);
  expect(groupsToFold(groups, 2, 40)).toEqual([]);
});
