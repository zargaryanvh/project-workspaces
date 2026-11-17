import { expect, test } from '@playwright/test';
import { hostKey, isNewSite, matchRule, normalizeRuleHost } from '../../src/lib/rules.js';
import type { Rule } from '../../src/lib/types.js';

const rule = (host: string, project: string, enabled = true): Rule => ({ id: `${host}-${project}`, host, project, enabled });
const rules: Rule[] = [
  rule('admin.example.com', 'Admin'),
  rule('app.example.com', 'App'),
  rule('staging.example.com', '🟠 App staging'),
  rule('platform.example.com', 'Platform'),
  rule('staging-platform.example.com', '🟠 Platform staging'),
  rule('example.com', 'Web'),
  rule('staging-web.example.com', '🟠 Web staging'),
];

test.describe('matchRule', () => {
  test('sends each host to its project', () => {
    const cases: Array<[string, string]> = [
      ['https://admin.example.com/issues', 'Admin'],
      ['https://app.example.com/', 'App'],
      ['https://staging.example.com/login', '🟠 App staging'],
      ['https://platform.example.com/cabinets', 'Platform'],
      ['https://staging-platform.example.com/', '🟠 Platform staging'],
      ['https://example.com/pricing', 'Web'],
      ['https://staging-web.example.com/', '🟠 Web staging'],
    ];
    for (const [url, project] of cases) expect(matchRule(url, rules)?.project, url).toBe(project);
  });

  test('example.com matches that host only, never a subdomain or a look-alike', () => {
    for (const url of [
      'https://www.example.com/',
      'https://docs.example.com/',
      'https://admin.example.com.example.org/',
      'https://notexample.com/',
      'https://example.com.au/',
      'https://x.staging.example.com/',
    ]) {
      expect(matchRule(url, rules), url).toBeNull();
    }
  });

  test('ignores case, a trailing dot, the path, the query and the port', () => {
    expect(matchRule('HTTPS://Admin.Example.com./a/b?c=d#e', rules)?.project).toBe('Admin');
    expect(matchRule('http://staging.example.com:5180/x', rules)?.project).toBe('🟠 App staging');
  });

  test('a rule with a port matches only that port', () => {
    const local = [rule('localhost:5180', 'Admin local')];
    expect(matchRule('http://localhost:5180/', local)?.project).toBe('Admin local');
    expect(matchRule('http://localhost:5173/', local)).toBeNull();
    expect(matchRule('http://localhost/', local)).toBeNull();
  });

  test('skips switched-off rules, and the first matching rule wins', () => {
    const list = [rule('a.example.com', 'One', false), rule('a.example.com', 'Two'), rule('a.example.com', 'Three')];
    expect(matchRule('https://a.example.com/', list)?.project).toBe('Two');
  });

  test('pages that are not web pages never match', () => {
    for (const url of ['chrome://newtab/', 'brave://settings', 'about:blank', 'file:///C:/x.html', '', 'not a url']) {
      expect(matchRule(url, rules), url).toBeNull();
    }
    expect(matchRule(undefined, rules)).toBeNull();
  });
});

test.describe('normalizeRuleHost', () => {
  test('accepts a host or a full address and keeps only the host', () => {
    expect(normalizeRuleHost('admin.example.com')).toBe('admin.example.com');
    expect(normalizeRuleHost('  Admin.Example.com. ')).toBe('admin.example.com');
    expect(normalizeRuleHost('https://admin.example.com/issues?x=1')).toBe('admin.example.com');
    expect(normalizeRuleHost('localhost:5180')).toBe('localhost:5180');
    expect(normalizeRuleHost('127.0.0.1:8080')).toBe('127.0.0.1:8080');
  });

  test('refuses spaces, single words, stray stars and non-web addresses', () => {
    for (const input of ['', '   ', 'admin example.com', 'intranet', 'ftp://files.example.com', 'a*.example.com', '*', '*.', '*.localhost']) {
      expect(normalizeRuleHost(input), input).toBeNull();
    }
  });

  test('accepts *. for a domain and all its subdomains', () => {
    expect(normalizeRuleHost('*.Payments.com')).toBe('*.payments.com');
    expect(normalizeRuleHost(' *.payments.com ')).toBe('*.payments.com');
  });
});

test.describe('*. addresses', () => {
  const list = [
    rule('*.payments.com', 'Payments'),
    rule('*.example.com', 'Example other'),
    rule('admin.example.com', 'Admin'),
    rule('*.staging.example.com', 'Staging extras'),
  ];

  test('cover the domain itself and every subdomain', () => {
    for (const url of ['https://payments.com/', 'https://vendors.payments.com/overview', 'https://login.payments.com/', 'https://a.b.payments.com/']) {
      expect(matchRule(url, list)?.project, url).toBe('Payments');
    }
    expect(matchRule('https://notpayments.com/', list)).toBeNull();
    expect(matchRule('https://payments.com.evil.org/', list)).toBeNull();
  });

  test('an exact address wins over a *. one, and the longest *. wins among them', () => {
    expect(matchRule('https://admin.example.com/x', list)?.project).toBe('Admin');
    expect(matchRule('https://docs.example.com/', list)?.project).toBe('Example other');
    expect(matchRule('https://x.staging.example.com/', list)?.project).toBe('Staging extras');
  });
});

test.describe('new site detection', () => {
  test('hostKey keeps the port and is empty for non-web pages', () => {
    expect(hostKey('http://a.example.com:8080/x')).toBe('a.example.com:8080');
    expect(hostKey('https://a.example.com/x')).toBe('a.example.com');
    expect(hostKey('chrome://newtab/')).toBe('');
    expect(hostKey(undefined)).toBe('');
  });

  test('a first load and a change of host count; staying on the host or leaving the web does not', () => {
    expect(isNewSite('', 'a.example.com')).toBe(true);
    expect(isNewSite('a.example.com', 'b.example.com')).toBe(true);
    expect(isNewSite('a.example.com', 'a.example.com')).toBe(false);
    expect(isNewSite('a.example.com', '')).toBe(false);
  });
});

