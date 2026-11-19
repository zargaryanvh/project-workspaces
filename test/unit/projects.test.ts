import { expect, test } from '@playwright/test';
import {
  addMissingProjects,
  findProject,
  removeProject,
  renameProject,
  setProjectColor,
} from '../../src/lib/projects.js';
import type { GroupColor, StoredProject } from '../../src/lib/types.js';

const p = (title: string, color: GroupColor = 'blue'): StoredProject => ({ title, color });
const titles = (list: StoredProject[]) => list.map((x) => x.title);

test.describe('addMissingProjects', () => {
  test('appends new names in the order seen and keeps the rest', () => {
    const out = addMissingProjects([p('Office')], [p('Blog'), p('office'), p('Mail'), p('  ')]);
    expect(titles(out)).toEqual(['Office', 'Blog', 'Mail']);
  });

  test('returns the same list when nothing is new', () => {
    const list = [p('Office'), p('Blog')];
    expect(addMissingProjects(list, [p('OFFICE'), p(' blog ')])).toBe(list);
  });
});

test('setProjectColor changes a known project only', () => {
  const list = [p('Office', 'blue')];
  expect(setProjectColor(list, 'office', 'red')).toEqual([p('Office', 'red')]);
  expect(setProjectColor(list, 'Other', 'red')).toBe(list);
  expect(setProjectColor(list, 'Office', 'blue')).toBe(list);
});

test.describe('renameProject', () => {
  test('the new name takes the old name’s place', () => {
    const out = renameProject([p('Office'), p('Example'), p('Blog')], 'Example', 'App', 'green', false);
    expect(out).toEqual([p('Office'), p('App', 'green'), p('Blog')]);
  });

  test('a change of case or spacing keeps the place', () => {
    expect(renameProject([p('office'), p('Blog')], 'office', 'Office', 'blue', false)).toEqual([p('Office'), p('Blog')]);
  });

  test('when the new name already has a place, that place wins and the old one goes', () => {
    const out = renameProject([p('Staging'), p('Blog'), p('🟠 App staging', 'orange')], 'Staging', '🟠 App staging', 'orange', false);
    expect(titles(out)).toEqual(['Blog', '🟠 App staging']);
  });

  test('when another window still has a group with the old name, both are kept', () => {
    const out = renameProject([p('Office'), p('Blog')], 'Office', 'Office old', 'grey', true);
    expect(titles(out)).toEqual(['Office', 'Office old', 'Blog']);
  });

  test('naming a group that had no name adds it at the end', () => {
    expect(titles(renameProject([p('Office')], '', 'Docs', 'cyan', false))).toEqual(['Office', 'Docs']);
  });

  test('clearing a name changes nothing', () => {
    const list = [p('Docs')];
    expect(renameProject(list, 'Docs', '  ', 'cyan', false)).toBe(list);
  });
});

test('removeProject and findProject match names whatever the case', () => {
  const list = [p('Office'), p('Blog')];
  expect(titles(removeProject(list, 'OFFICE'))).toEqual(['Blog']);
  expect(removeProject(list, 'Other')).toBe(list);
  expect(findProject(list, ' blog ')?.title).toBe('Blog');
  expect(findProject(list, '')).toBeUndefined();
});
