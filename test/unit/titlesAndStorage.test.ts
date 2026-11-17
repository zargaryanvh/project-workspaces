import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS, sanitizeLocal, sanitizeRules } from '../../src/lib/sanitize.js';
import { cleanTitle, defaultColorFor, isStagingTitle, leadingEmoji, projectKey, withStagingMark } from '../../src/lib/titles.js';

test.describe('titles', () => {
  test('keys ignore case and extra spaces', () => {
    expect(projectKey('  🟠  App   Staging ')).toBe('🟠 app staging');
    expect(cleanTitle('  🟠  App   Staging ')).toBe('🟠 App Staging');
  });

  test('the staging mark can be added and removed, once', () => {
    expect(withStagingMark('App staging', true)).toBe('🟠 App staging');
    expect(withStagingMark('🟠 App staging', true)).toBe('🟠 App staging');
    expect(withStagingMark('🟠App staging', false)).toBe('App staging');
    expect(isStagingTitle('🟠 Web staging')).toBe(true);
    expect(isStagingTitle('Web staging')).toBe(false);
  });

  test('a leading emoji becomes the icon, so lists show it once', () => {
    expect(leadingEmoji('🔵 Admin')).toEqual({ icon: '🔵', rest: 'Admin' });
    expect(leadingEmoji('  🟠   App   staging ')).toEqual({ icon: '🟠', rest: 'App staging' });
    expect(leadingEmoji('🟠App staging')).toEqual({ icon: '🟠', rest: 'App staging' });
    expect(leadingEmoji('❤️ Family')).toEqual({ icon: '❤️', rest: 'Family' });
    expect(leadingEmoji('👩‍💻 Code')).toEqual({ icon: '👩‍💻', rest: 'Code' });
    expect(leadingEmoji('👍🏽 Reviews')).toEqual({ icon: '👍🏽', rest: 'Reviews' });
    expect(leadingEmoji('Docs')).toBeNull();
    expect(leadingEmoji('Docs 🔵')).toBeNull(); // only at the start
    expect(leadingEmoji('🔵')).toBeNull(); // the emoji is the whole name: keep it as the name
    expect(leadingEmoji('')).toBeNull();
  });

  test('staging gets orange; other projects get a steady colour that is never orange or grey', () => {
    expect(defaultColorFor('🟠 Anything')).toBe('orange');
    for (const title of ['Admin', 'App', 'Web', 'Platform', 'Backend', 'Mail', 'Payments', 'doc', 'Design', 'Research']) {
      const color = defaultColorFor(title);
      expect(['orange', 'grey']).not.toContain(color);
      expect(defaultColorFor(title.toUpperCase())).toBe(color);
    }
  });
});

test.describe('stored data', () => {
  test('empty or broken storage gives the defaults', () => {
    for (const raw of [undefined, null, 42, 'x', []]) {
      expect(sanitizeLocal(raw)).toEqual({
        projects: [],
        rules: [],
        lastActive: {},
        openProjects: {},
        settings: DEFAULT_SETTINGS,
      });
    }
    expect(DEFAULT_SETTINGS).toEqual({ follow: true, surface: 'sidePanel', duplicateCheck: true });
  });

  test('0.1 settings still load: the old popup choice becomes the project row', () => {
    expect(sanitizeLocal({ settings: { follow: true, surface: 'popup' } }).settings).toEqual({
      follow: true,
      surface: 'row',
      duplicateCheck: true,
    });
    expect(sanitizeLocal({ openProjects: { 'a\nb': 'a', bad: 3, '': 'x' } }).openProjects).toEqual({ 'a\nb': 'a' });
  });

  test('bad entries are dropped, repeated names kept once, unknown colours become grey', () => {
    const state = sanitizeLocal({
      projects: [{ title: 'Admin', color: 'blue' }, { title: 'admin', color: 'red' }, { title: 'X', color: 'gold' }, { nope: 1 }],
      lastActive: { admin: { tabId: 4, url: 'https://a' }, bad: { tabId: 'x' } },
      settings: { follow: false, surface: 'somewhere' },
    });
    expect(state.projects).toEqual([
      { title: 'Admin', color: 'blue' },
      { title: 'X', color: 'grey' },
    ]);
    expect(state.lastActive).toEqual({ admin: { tabId: 4, url: 'https://a' } });
    expect(state.settings).toEqual({ follow: false, surface: 'sidePanel', duplicateCheck: true });
  });

  test('rules are tidied: hosts normalised, unusable rules dropped, ids unique', () => {
    const rules = sanitizeRules([
      { id: 'a', host: 'https://Admin.Example.com/x', project: ' Admin ', enabled: true },
      { id: 'a', host: 'app.example.com', project: 'App' },
      { id: 'b', host: 'a*.example.com', project: 'Wild' },
      { id: 'c', host: 'web.example.com', project: '   ' },
      { id: 'd', host: 'off.example.com', project: 'Off', enabled: false },
    ]);
    expect(rules).toEqual([
      { id: 'a', host: 'admin.example.com', project: 'Admin', enabled: true },
      { id: 'a-x', host: 'app.example.com', project: 'App', enabled: true },
      { id: 'd', host: 'off.example.com', project: 'Off', enabled: false },
    ]);
  });
});
