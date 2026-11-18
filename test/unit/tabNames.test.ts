import { expect, test } from '@playwright/test';
import {
  cleanTabName,
  linkTabNames,
  MAX_TAB_NAMES,
  nameAddress,
  pruneTabNames,
  setTabName,
  tabLabels,
} from '../../src/lib/tabNames.js';
import type { TabName } from '../../src/lib/types.js';

const MAIL0 = 'https://mail.example.com/mail/u/0/';
const MAIL1 = 'https://mail.example.com/mail/u/1/';

const named = (id: string, name: string, home: string, last = home, seen = 1): TabName => ({ id, name, home, last, seen });
const tab = (id: number, url: string) => ({ id, url });
const noId = (): string => {
  throw new Error('no new name expected');
};

test.describe('the address a name sticks to', () => {
  test('no ? and no #, the host in lower case, the path as it is', () => {
    expect(nameAddress('https://Mail.Example.com/mail/u/0/?tab=rm#inbox/123')).toBe(MAIL0);
    expect(nameAddress('http://localhost:5174/Docs/Page')).toBe('http://localhost:5174/Docs/Page');
    expect(nameAddress('file:///C:/notes/todo.txt')).toBe('file:///C:/notes/todo.txt');
  });

  test('pages that are not web pages have none, so they never pick up a name by address', () => {
    for (const url of [
      'chrome://newtab/',
      'brave://settings/appearance',
      'about:blank',
      'chrome-extension://abc/panel.html',
      '',
      'not an address',
      undefined,
    ]) {
      expect(nameAddress(url), String(url)).toBe('');
    }
  });

  test('names are one line with single spaces, at most 80 characters', () => {
    expect(cleanTabName('  Work \n account  ')).toBe('Work account');
    expect(cleanTabName('x'.repeat(100))).toHaveLength(80);
    expect(cleanTabName('   ')).toBe('');
  });
});

test.describe('giving a tab a name', () => {
  test('a new name keeps the address it was given on, and the tab shows it', () => {
    const { names, links } = setTabName({
      names: [],
      links: {},
      tab: tab(7, `${MAIL0}#inbox`),
      name: ' Personal ',
      now: 50,
      newId: () => 'a',
    });
    expect(names).toEqual([named('a', 'Personal', MAIL0, MAIL0, 50)]);
    expect(links).toEqual({ '7': 'a' });
    expect(tabLabels(names, links)).toEqual(new Map([[7, 'Personal']]));
  });

  test('renaming changes the same name; an empty name takes it away for good', () => {
    const start = [named('a', 'Personal', MAIL0)];
    const renamed = setTabName({ names: start, links: { '7': 'a' }, tab: tab(7, MAIL0), name: 'Home', now: 60, newId: noId });
    expect(renamed.names).toEqual([named('a', 'Home', MAIL0, MAIL0, 60)]);
    expect(renamed.links).toEqual({ '7': 'a' });
    expect(start[0]?.name, 'the input is left as it was').toBe('Personal');

    const cleared = setTabName({ ...renamed, tab: tab(7, MAIL0), name: '  ', now: 70, newId: noId });
    expect(cleared).toEqual({ names: [], links: {} });
  });

  test('past the limit, names on no open tab and unused longest go first', () => {
    const names = [
      named('old', 'Old', 'https://a.example/', 'https://a.example/', 1),
      named('kept', 'On a tab', 'https://b.example/', 'https://b.example/', 0),
      named('new', 'New', 'https://c.example/', 'https://c.example/', 9),
    ];
    expect(pruneTabNames(names, { '3': 'kept' }, 2).map((n) => n.id)).toEqual(['kept', 'new']);
    expect(MAX_TAB_NAMES).toBe(300);
  });
});

test.describe('which tab shows which name', () => {
  test('after a restart, tabs get their names back by address (where named, or where they were last)', () => {
    const names = [named('p', 'Personal', MAIL0), named('w', 'Work', MAIL1, 'https://mail.example.com/mail/u/1/settings')];
    const r = linkTabNames(
      [
        tab(11, `${MAIL0}#inbox`),
        tab(12, 'https://mail.example.com/mail/u/1/settings?x=1'),
        tab(13, 'https://other.example/'),
      ],
      names,
      {},
      99,
    );
    expect(r.links).toEqual({ '11': 'p', '12': 'w' });
    expect(r.linksChanged).toBe(true);
  });

  test('a named tab keeps its name while it browses the same site, and its last address follows it', () => {
    const r = linkTabNames(
      [tab(1, 'https://docs.example.com/folders/42')],
      [named('d', 'Team drive', 'https://docs.example.com/home')],
      { '1': 'd' },
      5,
    );
    expect(r.links).toEqual({ '1': 'd' });
    expect(r.names[0]).toMatchObject({
      home: 'https://docs.example.com/home',
      last: 'https://docs.example.com/folders/42',
      seen: 5,
    });
    expect(r.namesChanged).toBe(true);
  });

  test('a tab that leaves the site leaves its name behind, and gets it back on its address', () => {
    const names = [named('p', 'Personal', MAIL0, `${MAIL0}inbox`)];
    const away = linkTabNames([tab(1, 'https://news.example.org/')], names, { '1': 'p' }, 5);
    expect(away.links).toEqual({});
    expect(away.names).toEqual(names);
    const back = linkTabNames([tab(1, `${MAIL0}#inbox`)], away.names, away.links, 6);
    expect(back.links).toEqual({ '1': 'p' });
    expect(back.names[0]?.last, 'found where it was named: that is where it is now').toBe(MAIL0);
  });

  test("switching to the other account in the same tab shows that account's name", () => {
    const names = [named('p', 'Personal', MAIL0), named('w', 'Work', MAIL1)];
    const r = linkTabNames([tab(1, `${MAIL1}#inbox`)], names, { '1': 'p' }, 5);
    expect(r.links).toEqual({ '1': 'w' });
    expect(r.names.find((n) => n.id === 'p')?.last, 'the first name stays where it was').toBe(MAIL0);
  });

  test('one name shows on one tab: a second tab at the same address gets none', () => {
    const r = linkTabNames([tab(1, MAIL0), tab(2, MAIL0)], [named('p', 'Personal', MAIL0)], { '1': 'p' }, 5);
    expect(r.links).toEqual({ '1': 'p' });
  });

  test('when a named tab closes, a tab at that address takes the name, and so does one opened later', () => {
    const names = [named('p', 'Personal', MAIL0)];
    expect(linkTabNames([tab(2, MAIL0)], names, { '1': 'p' }, 5).links).toEqual({ '2': 'p' });
    expect(linkTabNames([tab(3, `${MAIL0}?compose=new`)], names, {}, 6).links).toEqual({ '3': 'p' });
  });

  test('links to closed tabs and to names that are gone are dropped', () => {
    const r = linkTabNames([tab(1, 'https://a.example/')], [], { '1': 'gone', '2': 'x' }, 5);
    expect(r.links).toEqual({});
    expect(r.linksChanged).toBe(true);
  });

  test('a name given on a page with no address takes the first web page the tab opens', () => {
    const r = linkTabNames([tab(1, 'https://plan.example.com/board')], [named('s', 'Scratch', '', '')], { '1': 's' }, 5);
    expect(r.links).toEqual({ '1': 's' });
    expect(r.names[0]).toMatchObject({ home: 'https://plan.example.com/board', last: 'https://plan.example.com/board' });
  });

  test('a tab with no address yet (still loading) keeps its name', () => {
    expect(linkTabNames([tab(1, '')], [named('p', 'Personal', MAIL0)], { '1': 'p' }, 5).links).toEqual({ '1': 'p' });
  });

  test('where a name was given wins over where another name was last', () => {
    const names = [named('a', 'Was here last', MAIL0, MAIL1), named('b', 'Named here', MAIL1)];
    expect(linkTabNames([tab(1, MAIL1)], names, {}, 5).links).toEqual({ '1': 'b' });
  });

  test('nothing changes when no tab moved', () => {
    const names = [named('p', 'Personal', MAIL0)];
    expect(linkTabNames([tab(1, `${MAIL0}#inbox`)], names, { '1': 'p' }, 5)).toEqual({
      names,
      links: { '1': 'p' },
      namesChanged: false,
      linksChanged: false,
    });
  });
});
