import { expect, test } from '@playwright/test';
import { findAlreadyOpen, sameAddress, type AlreadyOpenInput } from '../../src/lib/duplicates.js';
import type { Rule, TabInfo } from '../../src/lib/types.js';

const rules: Rule[] = [
  { id: '1', host: 'example.com', project: 'Blog', enabled: true },
  { id: '2', host: 'localhost:5174', project: 'Blog', enabled: true },
  { id: '3', host: '*.bills.com', project: 'Bills', enabled: true },
  { id: '4', host: 'off.example.com', project: 'Off', enabled: false },
];
const tab = (id: number, url: string, windowId = 1, index = id): TabInfo => ({
  id,
  groupId: -1,
  index,
  active: false,
  pinned: false,
  url,
  windowId,
});
const open = [
  tab(1, 'https://example.com/home', 1),
  tab(2, 'https://example.com/shop', 2),
  tab(3, 'https://example.com/', 1),
  tab(4, 'http://localhost:5174/shop/latch', 1),
  tab(5, 'https://vendors.bills.com/overview', 1),
  tab(6, 'https://www.google.com/search?q=x', 1),
  tab(7, 'https://off.example.com/', 1),
];
const input = (over: Partial<AlreadyOpenInput>): AlreadyOpenInput => ({
  url: 'https://example.com/',
  tabId: 99,
  windowId: 1,
  currentHost: '',
  openerHost: null,
  rules,
  tabs: open,
  ...over,
});

test('opening example.com while example.com pages are open warns, same page first, this window next', () => {
  expect(findAlreadyOpen(input({}))?.map((t) => t.id)).toEqual([3, 1, 2]);
});

test('another page of the same site warns too', () => {
  expect(findAlreadyOpen(input({ url: 'https://example.com/pricing' }))?.map((t) => t.id)).toEqual([1, 3, 2]);
});

test('local addresses and *. addresses count as project addresses; the port matters', () => {
  expect(findAlreadyOpen(input({ url: 'http://localhost:5174/' }))?.map((t) => t.id)).toEqual([4]);
  expect(findAlreadyOpen(input({ url: 'http://localhost:5180/' }))).toBeNull();
  expect(findAlreadyOpen(input({ url: 'https://vendors.bills.com/' }))?.map((t) => t.id)).toEqual([5]);
  expect(findAlreadyOpen(input({ url: 'https://login.bills.com/' }))).toBeNull(); // nothing open there
});

test('no warning for sites that are not project addresses, or switched off', () => {
  expect(findAlreadyOpen(input({ url: 'https://www.google.com/' }))).toBeNull();
  expect(findAlreadyOpen(input({ url: 'https://off.example.com/x' }))).toBeNull();
});

test('no warning inside one site: a link from the same site, or moving within it', () => {
  expect(findAlreadyOpen(input({ openerHost: 'example.com' }))).toBeNull();
  expect(findAlreadyOpen(input({ currentHost: 'example.com' }))).toBeNull();
  expect(findAlreadyOpen(input({ openerHost: 'mail.google.com' }))).not.toBeNull(); // from another site: warn
});

test('no warning after "Open anyway" for that address', () => {
  expect(findAlreadyOpen(input({ allowedUrl: 'https://example.com' }))).toBeNull();
  expect(findAlreadyOpen(input({ allowedUrl: 'https://example.com/other' }))).not.toBeNull();
});

test('the tab itself does not count', () => {
  expect(findAlreadyOpen(input({ tabs: [tab(99, 'https://example.com/')] }))).toBeNull();
});

test('sameAddress ignores the #part and a slash at the end', () => {
  expect(sameAddress('https://example.com/', 'https://example.com')).toBe(true);
  expect(sameAddress('https://example.com/shop#top', 'https://example.com/shop')).toBe(true);
  expect(sameAddress('https://example.com/shop', 'https://example.com/home')).toBe(false);
  expect(sameAddress('https://example.com/?a=1', 'https://example.com/?a=2')).toBe(false);
});
