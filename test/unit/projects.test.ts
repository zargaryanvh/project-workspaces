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
    const out = addMissingProjects([p('Admin')], [p('Web'), p('admin'), p('Mail'), p('  ')]);
    expect(titles(out)).toEqual(['Admin', 'Web', 'Mail']);
  });

  test('returns the same list when nothing is new', () => {
    const list = [p('Admin'), p('Web')];
    expect(addMissingProjects(list, [p('ADMIN'), p(' web ')])).toBe(list);
  });
});

test('setProjectColor changes a known project only', () => {
  const list = [p('Admin', 'blue')];
  expect(setProjectColor(list, 'admin', 'red')).toEqual([p('Admin', 'red')]);
  expect(setProjectColor(list, 'Other', 'red')).toBe(list);
  expect(setProjectColor(list, 'Admin', 'blue')).toBe(list);
});

test.describe('renameProject', () => {
  test('the new name takes the old name’s place', () => {
    const out = renameProject([p('Admin'), p('Example'), p('Web')], 'Example', 'App', 'green', false);
    expect(out).toEqual([p('Admin'), p('App', 'green'), p('Web')]);
  });

  test('a change of case or spacing keeps the place', () => {
    expect(renameProject([p('admin'), p('Web')], 'admin', 'Admin', 'blue', false)).toEqual([p('Admin'), p('Web')]);
  });

  test('when the new name already has a place, that place wins and the old one goes', () => {
    const out = renameProject([p('Staging'), p('Web'), p('🟠 App staging', 'orange')], 'Staging', '🟠 App staging', 'orange', false);
    expect(titles(out)).toEqual(['Web', '🟠 App staging']);
  });

  test('when another window still has a group with the old name, both are kept', () => {
    const out = renameProject([p('Admin'), p('Web')], 'Admin', 'Admin old', 'grey', true);
    expect(titles(out)).toEqual(['Admin', 'Admin old', 'Web']);
  });

  test('naming a group that had no name adds it at the end', () => {
    expect(titles(renameProject([p('Admin')], '', 'Docs', 'cyan', false))).toEqual(['Admin', 'Docs']);
  });

  test('clearing a name changes nothing', () => {
    const list = [p('Docs')];
    expect(renameProject(list, 'Docs', '  ', 'cyan', false)).toBe(list);
  });
});

test('removeProject and findProject match names whatever the case', () => {
  const list = [p('Admin'), p('Web')];
  expect(titles(removeProject(list, 'ADMIN'))).toEqual(['Web']);
  expect(removeProject(list, 'Other')).toBe(list);
  expect(findProject(list, ' web ')?.title).toBe('Web');
  expect(findProject(list, '')).toBeUndefined();
});
