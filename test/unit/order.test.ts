import { expect, test } from '@playwright/test';
import { groupMoveIndex } from '../../src/lib/order.js';
import type { TabInfo } from '../../src/lib/types.js';

const W = 1;
const GROUP: Record<string, number> = { u: -1, A: 10, B: 20, C: 30 };

/** Builds a tab bar from letters: "uAABBBCC" = one loose tab, then A, B and C. */
function bar(layout: string): TabInfo[] {
  return [...layout].map((ch, index) => ({
    id: index + 1,
    groupId: GROUP[ch] ?? -1,
    index,
    active: false,
    pinned: false,
    url: '',
    windowId: W,
  }));
}

/** What Brave does with tabGroups.move: the group's first tab ends at `index`, counted without the group. */
function applyMove(layout: string, letter: string, index: number): string {
  const rest = [...layout].filter((ch) => ch !== letter);
  const block = [...layout].filter((ch) => ch === letter);
  const at = index === -1 ? rest.length : index;
  rest.splice(at, 0, ...block);
  return rest.join('');
}

function insideAnotherGroup(layout: string, letter: string, index: number): boolean {
  if (index === -1) return false;
  const rest = [...layout].filter((ch) => ch !== letter);
  const before = rest[index - 1];
  const after = rest[index];
  return before !== undefined && after !== undefined && before !== 'u' && before === after;
}

const cases: Array<[string, string, string | null, string]> = [
  ['uAABBBCC', 'A', 'C', 'uBBBAACC'], // to the right, before C
  ['uAABBBCC', 'C', 'A', 'uCCAABBB'], // to the left, before A
  ['uAABBBCC', 'A', null, 'uBBBCCAA'], // last
  ['AAuBBvCC'.replace('v', 'u'), 'C', 'B', 'AAuCCBBu'],
  ['AABBCC', 'B', 'A', 'BBAACC'],
];

for (const [layout, letter, before, expected] of cases) {
  test(`${layout}: ${letter} before ${before ?? 'the end'} gives ${expected}`, () => {
    const index = groupMoveIndex(bar(layout), W, GROUP[letter] ?? -1, before === null ? null : (GROUP[before] ?? -1));
    expect(index).not.toBeNull();
    const at = index ?? 0;
    expect(insideAnotherGroup(layout, letter, at), 'never inside another group').toBe(false);
    expect(applyMove(layout, letter, at)).toBe(expected);
  });
}

test('no move when the group is already there', () => {
  expect(groupMoveIndex(bar('AABBCC'), W, 10, 20)).toBeNull(); // A already right before B
  expect(groupMoveIndex(bar('AABBCC'), W, 30, null)).toBeNull(); // C already last
  expect(groupMoveIndex(bar('AABBCC'), W, 10, 10)).toBeNull();
  expect(groupMoveIndex(bar('AABBCC'), W, 99, 20)).toBeNull();
  expect(groupMoveIndex(bar('AA'), W, 10, null)).toBeNull(); // the only group
});
