import { expect, test } from '@playwright/test';
import {
  AUTO_JOIN_MS,
  classifyGroupChange,
  noteGroupChange,
  rulesMayMove,
  trackNewTab,
  type TabTrack,
} from '../../src/lib/tabTracking.js';

const NOW = 1_000_000;

test.describe('trackNewTab', () => {
  test('a tab opened from a link inside a group joined that group on its own', () => {
    const track = trackNewTab({ url: '', groupId: 7, hasOpener: true, now: NOW });
    expect(track).toEqual({ host: '', created: NOW, opener: true, auto: 7 });
  });

  test('a tab made with "New tab in group" (no opener) counts as placed by hand', () => {
    const track = trackNewTab({ url: 'chrome://newtab/', groupId: 7, hasOpener: false, now: NOW });
    expect(track.auto).toBeUndefined();
    expect(rulesMayMove({ groupId: 7, pinned: false }, track)).toBe(false);
  });

  test('a tab Brave restores already has its address', () => {
    expect(trackNewTab({ url: 'https://office.example.com/x', groupId: -1, hasOpener: false, now: NOW }).host).toBe(
      'office.example.com',
    );
  });
});

test.describe('classifyGroupChange', () => {
  const linked: TabTrack = { host: '', created: NOW, opener: true };

  test('a move made by the extension is its own', () => {
    expect(classifyGroupChange({ byExtension: true, track: linked, newGroupId: 3, now: NOW + 10 })).toBe('own');
  });

  test('joining a group right after opening from a link is automatic', () => {
    expect(classifyGroupChange({ byExtension: false, track: linked, newGroupId: 3, now: NOW + 100 })).toBe('auto');
  });

  test('a tab already showing a page is grouped by the owner, however new it is', () => {
    const loaded: TabTrack = { ...linked, host: 'blog.example.com' };
    expect(classifyGroupChange({ byExtension: false, track: loaded, newGroupId: 3, now: NOW + 100 })).toBe('manual');
  });

  test('later moves, moves of tabs without an opener, and taking a tab out are the owner’s', () => {
    expect(classifyGroupChange({ byExtension: false, track: linked, newGroupId: 3, now: NOW + AUTO_JOIN_MS + 1 })).toBe(
      'manual',
    );
    expect(
      classifyGroupChange({ byExtension: false, track: { ...linked, opener: false }, newGroupId: 3, now: NOW + 100 }),
    ).toBe('manual');
    expect(classifyGroupChange({ byExtension: false, track: linked, newGroupId: -1, now: NOW + 100 })).toBe('manual');
    expect(
      classifyGroupChange({ byExtension: false, track: { host: '', created: 0, opener: true }, newGroupId: 3, now: NOW }),
    ).toBe('manual');
    expect(classifyGroupChange({ byExtension: false, track: undefined, newGroupId: 3, now: NOW })).toBe('manual');
  });
});

test.describe('rulesMayMove', () => {
  const free = (extra: Partial<TabTrack> = {}): TabTrack => ({ host: '', created: NOW, opener: false, ...extra });

  test('a tab with no group may move', () => {
    expect(rulesMayMove({ groupId: -1, pinned: false }, free())).toBe(true);
    expect(rulesMayMove({ groupId: -1, pinned: false }, undefined)).toBe(true);
  });

  test('a tab the owner took out of a group stays out', () => {
    expect(rulesMayMove({ groupId: -1, pinned: false }, free({ manual: -1 }))).toBe(false);
  });

  test('a tab that joined its group on its own may move', () => {
    expect(rulesMayMove({ groupId: 5, pinned: false }, free({ auto: 5 }))).toBe(true);
  });

  test('a tab the owner put in a group stays there', () => {
    expect(rulesMayMove({ groupId: 5, pinned: false }, free({ manual: 5 }))).toBe(false);
  });

  test('a grouped tab with no history (restored at start-up) stays where it is', () => {
    expect(rulesMayMove({ groupId: 5, pinned: false }, { host: 'x.com', created: 0, opener: false })).toBe(false);
    expect(rulesMayMove({ groupId: 5, pinned: false }, undefined)).toBe(false);
  });

  test('pinned tabs never move', () => {
    expect(rulesMayMove({ groupId: -1, pinned: true }, free())).toBe(false);
  });

  test('an old automatic group does not count once the tab is in another group', () => {
    expect(rulesMayMove({ groupId: 6, pinned: false }, free({ auto: 5 }))).toBe(false);
  });
});

test('noteGroupChange keeps auto and manual apart and ignores the extension’s own moves', () => {
  const track: TabTrack = { host: '', created: NOW, opener: true, manual: 2 };
  noteGroupChange(track, 'auto', 3);
  expect(track).toEqual({ host: '', created: NOW, opener: true, auto: 3 });
  noteGroupChange(track, 'manual', 4);
  expect(track).toEqual({ host: '', created: NOW, opener: true, manual: 4 });
  noteGroupChange(track, 'own', 9);
  expect(track).toEqual({ host: '', created: NOW, opener: true, manual: 4 });
});
