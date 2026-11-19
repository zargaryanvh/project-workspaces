import { expect, test } from '@playwright/test';
import { cardsFromRules, rulesFromCards, sharedHosts, type ProjectCard } from '../../src/lib/ruleGroups.js';
import type { Rule } from '../../src/lib/types.js';

const rule = (id: string, host: string, project: string, enabled = true): Rule => ({ id, host, project, enabled });

test('rules are grouped into one card per project, in the order projects first appear', () => {
  const cards = cardsFromRules([
    rule('1', 'office.example.com', 'Office'),
    rule('2', 'example.com', 'Blog'),
    rule('3', 'localhost:5180', 'office'),
    rule('4', 'localhost:5174', 'Blog', false),
  ]);
  expect(cards.map((c) => c.project)).toEqual(['Office', 'Blog']);
  expect(cards[0]?.rows.map((r) => r.host)).toEqual(['office.example.com', 'localhost:5180']);
  expect(cards[1]?.rows.map((r) => [r.host, r.enabled])).toEqual([
    ['example.com', true],
    ['localhost:5174', false],
  ]);
});

test('cards flatten back card by card; unusable addresses and unnamed cards are left out', () => {
  const cards: ProjectCard[] = [
    {
      id: 'a',
      project: ' Bills ',
      rows: [
        { id: 'r1', host: 'https://Vendors.Bills.com/overview', enabled: true },
        { id: 'r2', host: '*.bills.com', enabled: true },
        { id: 'r3', host: 'not a host', enabled: true },
        { id: 'r4', host: '', enabled: true },
      ],
    },
    { id: 'b', project: '', rows: [{ id: 'r5', host: 'x.example.com', enabled: true }] },
  ];
  expect(rulesFromCards(cards)).toEqual([
    rule('r1', 'vendors.bills.com', 'Bills'),
    rule('r2', '*.bills.com', 'Bills'),
  ]);
});

test('a round trip keeps the rules as they were', () => {
  const rules = [rule('1', 'office.example.com', 'Office'), rule('2', 'example.com', 'Blog'), rule('3', 'localhost:5174', 'Blog')];
  expect(rulesFromCards(cardsFromRules(rules))).toEqual(rules);
});

test('sharedHosts finds an address used by two projects', () => {
  const cards = cardsFromRules([
    rule('1', 'example.com', 'Blog'),
    rule('2', 'example.com', 'Shop'),
    rule('3', 'office.example.com', 'Office'),
  ]);
  expect([...sharedHosts(cards)]).toEqual([['example.com', ['Blog', 'Shop']]]);
});
