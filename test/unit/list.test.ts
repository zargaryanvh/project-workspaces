import { expect, test } from '@playwright/test';
import { buildList, commandTarget, moveTarget, stepProject } from '../../src/lib/list.js';
import type { GroupInfo, TabInfo } from '../../src/lib/types.js';

const W = 1;
const g = (id: number, title: string, windowId = W): GroupInfo => ({ id, title, color: 'blue', collapsed: true, windowId });
const t = (id: number, groupId: number, index: number, active = false, windowId = W): TabInfo => ({
  id,
  groupId,
  index,
  active,
  pinned: false,
  url: `https://example.com/${id}`,
  windowId,
});

test('the list is in tab bar order, with counts, the current project and numbers 1 to 9', () => {
  const groups = [g(1, 'Office'), g(2, ''), g(3, 'Mail'), g(4, 'Blog'), g(5, 'Bills'), g(6, 'Elsewhere', 2)];
  const tabs = [
    t(41, 4, 0),
    t(11, 1, 1),
    t(12, 1, 2, true),
    t(51, 5, 3),
    t(21, 2, 4),
    t(31, 3, 5),
    t(61, 6, 0, false, 2),
    t(71, -1, 6),
  ];
  const list = buildList(groups, tabs, W);
  expect(list.map((i) => i.title)).toEqual(['Blog', 'Office', 'Bills', '', 'Mail']);
  expect(list.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
  expect(list.find((i) => i.title === 'Office')).toMatchObject({ tabCount: 2, current: true });
  expect(list.filter((i) => i.current)).toHaveLength(1);
});

test('a group is placed by its first tab', () => {
  const list = buildList([g(1, 'A'), g(2, 'B')], [t(1, 1, 5), t(2, 1, 6), t(3, 2, 2)], W);
  expect(list.map((i) => i.title)).toEqual(['B', 'A']);
});

test('only the first nine projects get a shortcut number', () => {
  const groups = Array.from({ length: 11 }, (_, i) => g(i + 1, `P${i + 1}`));
  const tabs = groups.map((x, i) => t(100 + i, x.id, i));
  expect(buildList(groups, tabs, W).map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null, null]);
});

test('a group with no tab in this window is not listed', () => {
  expect(buildList([g(1, 'Ghost'), g(2, 'Real')], [t(1, 2, 0)], W).map((i) => i.title)).toEqual(['Real']);
});

test('stepProject wraps around, and starts at an end when no project is current', () => {
  const list = buildList([g(1, 'A'), g(2, 'B'), g(3, 'C')], [t(1, 1, 0), t(2, 2, 1), t(3, 3, 2)], W);
  expect(stepProject(list, 3, 1)?.title).toBe('A');
  expect(stepProject(list, 1, -1)?.title).toBe('C');
  expect(stepProject(list, 2, 1)?.title).toBe('C');
  expect(stepProject(list, null, 1)?.title).toBe('A');
  expect(stepProject(list, null, -1)?.title).toBe('C');
  expect(stepProject([], 1, 1)).toBeNull();
});

test('commandTarget handles Project N, next and previous', () => {
  const list = buildList([g(1, 'A'), g(2, 'B'), g(3, 'C')], [t(1, 1, 0), t(2, 2, 1, true), t(3, 3, 2)], W);
  expect(commandTarget('project-1', list, null)?.title).toBe('A');
  expect(commandTarget('project-3', list, null)?.title).toBe('C');
  expect(commandTarget('project-4', list, null)).toBeNull();
  expect(commandTarget('next-project', list, null)?.title).toBe('C');
  expect(commandTarget('previous-project', list, null)?.title).toBe('A');
  expect(commandTarget('something-else', list, null)).toBeNull();
});

test('with the active tab outside every group, next and previous start from the project shown last', () => {
  const list = buildList([g(1, 'A'), g(2, 'B'), g(3, 'C')], [t(1, 1, 0), t(2, 2, 1), t(3, 3, 2), t(4, -1, 3, true)], W);
  expect(list.some((i) => i.current)).toBe(false);
  expect(commandTarget('next-project', list, 2)?.title).toBe('C');
  expect(commandTarget('previous-project', list, 2)?.title).toBe('A');
});

test('moveTarget: up lands before the row above, down before the row two below or last', () => {
  const list = buildList(
    [g(1, 'A'), g(2, 'B'), g(3, 'C'), g(4, 'D')],
    [t(1, 1, 0), t(2, 2, 1), t(3, 3, 2), t(4, 4, 3)],
    W,
  );
  expect(moveTarget(list, 2, -1)).toBe(1); // B up: before A
  expect(moveTarget(list, 1, -1)).toBeUndefined(); // A is first
  expect(moveTarget(list, 2, 1)).toBe(4); // B down: before D
  expect(moveTarget(list, 3, 1)).toBeNull(); // C down: last
  expect(moveTarget(list, 4, 1)).toBeUndefined(); // D is last
  expect(moveTarget(list, 99, 1)).toBeUndefined();
});
