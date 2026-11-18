import { expect, test } from '@playwright/test';
import { moveTabRow, projectTabRows, shortAddress, tabRowText, type TabForList } from '../../src/lib/tabList.js';
import { tabMoveIndex } from '../../src/lib/order.js';
import type { TabInfo } from '../../src/lib/types.js';

const W = 1;
const t = (id: number, groupId: number, index: number, extra: Partial<TabForList> = {}): TabForList => ({
  id,
  groupId,
  index,
  active: false,
  title: `Tab ${id}`,
  url: `https://example.com/${id}`,
  windowId: W,
  ...extra,
});

test('a project lists its own tabs, in tab bar order, with the names given to them', () => {
  const tabs = [t(3, 10, 4), t(1, 10, 2, { active: true }), t(2, 20, 3), t(4, 10, 0, { windowId: 2 }), t(5, 10, 3)];
  const rows = projectTabRows(tabs, W, 10, new Map([[5, 'Work account']]));
  expect(rows).toEqual([
    { id: 1, name: '', title: 'Tab 1', url: 'https://example.com/1', active: true },
    { id: 5, name: 'Work account', title: 'Tab 5', url: 'https://example.com/5', active: false },
    { id: 3, name: '', title: 'Tab 3', url: 'https://example.com/3', active: false },
  ]);
});

test('a row says the given name, else the page title, else a short address', () => {
  const row = { id: 1, name: '', title: '', url: 'https://mail.example.com/inbox?x=1', active: false };
  expect(tabRowText({ ...row, name: 'Work', title: 'Inbox' })).toBe('Work');
  expect(tabRowText({ ...row, title: 'Inbox' })).toBe('Inbox');
  expect(tabRowText(row)).toBe('mail.example.com/inbox');
  expect(tabRowText({ ...row, url: '' })).toBe('New tab');
  expect(shortAddress('https://example.com/')).toBe('example.com');
  expect(shortAddress('brave://settings/')).toBe('brave://settings/');
});

test('the list shows a moved row at once, before the tab bar follows', () => {
  const rows = [1, 2, 3, 4].map((id) => ({ id, name: '', title: `${id}`, url: '', active: false }));
  expect(moveTabRow(rows, 4, 1).map((r) => r.id)).toEqual([4, 1, 2, 3]);
  expect(moveTabRow(rows, 1, null).map((r) => r.id)).toEqual([2, 3, 4, 1]);
  expect(moveTabRow(rows, 2, 4).map((r) => r.id)).toEqual([1, 3, 2, 4]);
  expect(moveTabRow(rows, 9, 1).map((r) => r.id)).toEqual([1, 2, 3, 4]);
});

test.describe('moving a tab inside its project', () => {
  // A loose tab, then group 10 (tabs 11 to 14), then group 20.
  const bar: TabInfo[] = [
    [1, -1],
    [11, 10],
    [12, 10],
    [13, 10],
    [14, 10],
    [21, 20],
  ].map(([id, groupId], index) => ({
    id: id ?? 0,
    groupId: groupId ?? -1,
    index,
    active: false,
    pinned: false,
    url: '',
    windowId: W,
  }));

  /** What chrome.tabs.move does: the tab ends at `index`. */
  const apply = (tabId: number, index: number): number[] => {
    const ids = bar.map((x) => x.id).filter((id) => id !== tabId);
    ids.splice(index, 0, tabId);
    return ids;
  };

  test('before another tab of its project, or last in it; it never leaves the group', () => {
    const cases: Array<[number, number | null, number[]]> = [
      [14, 11, [1, 14, 11, 12, 13, 21]],
      [11, 14, [1, 12, 13, 11, 14, 21]],
      [11, null, [1, 12, 13, 14, 11, 21]],
      [13, 12, [1, 11, 13, 12, 14, 21]],
    ];
    for (const [tabId, before, expected] of cases) {
      const index = tabMoveIndex(bar, tabId, before);
      expect(index, `${tabId} before ${before}`).not.toBeNull();
      expect(apply(tabId, index ?? -1)).toEqual(expected);
      expect(index ?? 0).toBeGreaterThanOrEqual(1); // inside the group: from index 1 ...
      expect(index ?? 99).toBeLessThanOrEqual(4); // ... to index 4
    }
  });

  test('nothing moves when the tab is already there, or the move would leave its project', () => {
    expect(tabMoveIndex(bar, 11, 12)).toBeNull(); // already right before 12
    expect(tabMoveIndex(bar, 14, null)).toBeNull(); // already last
    expect(tabMoveIndex(bar, 11, 11)).toBeNull();
    expect(tabMoveIndex(bar, 11, 21)).toBeNull(); // 21 is in another project
    expect(tabMoveIndex(bar, 1, null)).toBeNull(); // a tab in no project
    expect(tabMoveIndex(bar, 99, null)).toBeNull();
  });
});
