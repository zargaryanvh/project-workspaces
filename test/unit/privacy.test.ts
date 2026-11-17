import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The privacy promise, checked on the source: nothing that can reach the
 * network, no remote code, minimal permissions, and a CSP that blocks
 * connections even if a mistake slipped in. The smoke test also checks the CSP
 * in a real browser.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = join(root, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const textFiles = walk(src).filter((f) => ['.ts', '.html', '.css', '.json'].includes(extname(f)));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8')) as Record<string, unknown>;

test('the source has no way to reach the network and runs no remote or generated code', () => {
  const forbidden: Array<[string, RegExp]> = [
    ['fetch()', /\bfetch\s*\(/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['WebSocket', /\bWebSocket\b/],
    ['sendBeacon', /sendBeacon/],
    ['EventSource', /\bEventSource\b/],
    ['importScripts', /importScripts/],
    ['eval()', /\beval\s*\(/],
    ['new Function', /new\s+Function\s*\(/],
    ['a web address', /https?:\/\/[a-z0-9[]/i],
    ['innerHTML', /\.(inner|outer)HTML\s*=/],
  ];
  const found: string[] = [];
  for (const file of textFiles) {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of forbidden) {
      if (pattern.test(text)) found.push(`${relative(root, file)}: ${label}`);
    }
  }
  expect(found).toEqual([]);
});

test('the manifest asks only for tabs, tabGroups, storage and sidePanel', () => {
  expect([...(manifest.permissions as string[])].sort()).toEqual(['sidePanel', 'storage', 'tabGroups', 'tabs']);
  for (const key of [
    'host_permissions',
    'optional_permissions',
    'optional_host_permissions',
    'content_scripts',
    'externally_connectable',
    'web_accessible_resources',
    'update_url',
  ]) {
    expect(manifest[key], key).toBeUndefined();
  }
});

test('the page policy blocks every connection and every outside script', () => {
  const csp = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
});

test('shortcuts: Project 1 to 9, next, previous, the project row; at most four suggested keys (Alt+1 to Alt+4)', () => {
  const commands = manifest.commands as Record<string, { suggested_key?: { default: string } }>;
  for (let n = 1; n <= 9; n++) expect(commands[`project-${n}`], `project-${n}`).toBeDefined();
  expect(commands['next-project']).toBeDefined();
  expect(commands['previous-project']).toBeDefined();
  expect(commands['open-project-row']).toBeDefined();
  const suggested = Object.entries(commands)
    .filter(([, c]) => c.suggested_key)
    .map(([name, c]) => `${name}=${c.suggested_key?.default}`);
  expect(suggested).toEqual(['project-1=Alt+1', 'project-2=Alt+2', 'project-3=Alt+3', 'project-4=Alt+4']);
});

test('user-visible text has no em dash', () => {
  const offenders = textFiles
    .filter((f) => ['.html', '.ts', '.json'].includes(extname(f)))
    .filter((f) => readFileSync(f, 'utf8').includes('—'))
    .map((f) => relative(root, f));
  expect(offenders).toEqual([]);
});
