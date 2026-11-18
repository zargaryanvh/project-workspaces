import type { TabName } from './types.js';

/**
 * Names the owner gives tabs, for the project list. A name belongs to a tab:
 * it stays while the tab browses that site, and the tab bar keeps the page
 * title. Tab ids change after a restart, so each name also keeps addresses
 * that find its tab again:
 *
 * - `home`, where the tab got its name: a tab that opens it later gets the
 *   name back (an account's address, say);
 * - `last`, the address the tab showed last: after a restart the tab comes
 *   back there.
 *
 * Which tab shows which name is kept apart, as links from tab ids to names,
 * because tab ids only last while the browser runs.
 */

/** At most this many names are kept. Past it, the names on no open tab and unused longest go first. */
export const MAX_TAB_NAMES = 300;
export const MAX_TAB_NAME_LENGTH = 80;

/** A tab as the name helpers see it. */
export interface TabSeen {
  id: number;
  url: string;
}

/** Tab id (as a string) to the id of the name it shows. */
export type NameLinks = Record<string, string>;

/**
 * The part of an address a name sticks to: no ? and no #, the host in lower
 * case. Only web pages and files have one: '' for a new tab page, settings and
 * the like, so those never pick up a name by address.
 */
export function nameAddress(url: string | undefined): string {
  if (!url) return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return '';
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
}

/** The site part of a name address: scheme and host with port. */
function siteOf(address: string): string {
  try {
    const parsed = new URL(address);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/** One line, single spaces, at most 80 characters. */
export function cleanTabName(raw: string): string {
  return Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, MAX_TAB_NAME_LENGTH).join('').trim();
}

/** The name each tab shows, by tab id. */
export function tabLabels(names: readonly TabName[], links: Readonly<NameLinks>): Map<number, string> {
  const byId = new Map(names.map((n) => [n.id, n.name]));
  const out = new Map<number, string>();
  for (const [tabId, nameId] of Object.entries(links)) {
    const name = byId.get(nameId);
    if (name) out.set(Number(tabId), name);
  }
  return out;
}

export interface LinkResult {
  names: TabName[];
  links: NameLinks;
  namesChanged: boolean;
  linksChanged: boolean;
}

function sameLinks(a: Readonly<NameLinks>, b: Readonly<NameLinks>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Matches names to the open tabs, after tabs opened, closed, went to another
 * page or came back with a restart:
 *
 * 1. A tab keeps its name while it browses the same site; `last` follows it.
 * 2. If the page it goes to has a free name of its own (the other account of
 *    the same site), the tab shows that one instead.
 * 3. A tab that leaves the site leaves its name behind.
 * 4. A tab with no name takes a free name saved for its address: `home` first,
 *    then `last`. That brings names back after a restart and when a page is
 *    opened again.
 *
 * One name shows on one tab at a time. Tabs are taken in the order given.
 */
export function linkTabNames(
  tabs: readonly TabSeen[],
  names: readonly TabName[],
  links: Readonly<NameLinks>,
  now: number,
): LinkResult {
  const live = new Map<string, TabSeen>();
  for (const tab of tabs) live.set(String(tab.id), tab);
  const byId = new Map<string, TabName>();
  for (const n of names) byId.set(n.id, { ...n });
  const next: NameLinks = {};
  const taken = new Set<string>();

  // Links whose tab and name are both still there.
  for (const [tabId, nameId] of Object.entries(links)) {
    if (live.has(tabId) && byId.has(nameId) && !taken.has(nameId)) {
      next[tabId] = nameId;
      taken.add(nameId);
    }
  }

  const freeNameFor = (address: string): TabName | undefined => {
    let byLast: TabName | undefined;
    for (const n of byId.values()) {
      if (taken.has(n.id)) continue;
      if (n.home === address) return n;
      if (!byLast && n.last === address) byLast = n;
    }
    return byLast;
  };

  // Named tabs that went to another page.
  for (const [tabId, nameId] of Object.entries(next)) {
    const tab = live.get(tabId);
    const entry = byId.get(nameId);
    if (!tab || !entry) continue;
    const address = nameAddress(tab.url);
    if (!address || address === entry.last) continue;
    if (!entry.home && !entry.last) {
      // Named where there was no web page yet: the first page it opens is its place.
      entry.home = address;
      entry.last = address;
      entry.seen = now;
      continue;
    }
    const other = freeNameFor(address);
    if (other) {
      next[tabId] = other.id;
      taken.delete(nameId);
      taken.add(other.id);
      other.last = address;
      other.seen = now;
      continue;
    }
    if (siteOf(address) !== siteOf(entry.last || entry.home)) {
      delete next[tabId];
      taken.delete(nameId);
      continue;
    }
    entry.last = address;
    entry.seen = now;
  }

  // Tabs with no name take the one saved for their address.
  for (const tab of tabs) {
    const tabId = String(tab.id);
    if (next[tabId] !== undefined) continue;
    const address = nameAddress(tab.url);
    if (!address) continue;
    const match = freeNameFor(address);
    if (!match) continue;
    next[tabId] = match.id;
    taken.add(match.id);
    match.last = address;
    match.seen = now;
  }

  const outNames = names.map((n) => byId.get(n.id) ?? n);
  const namesChanged = outNames.some((n, i) => {
    const old = names[i];
    return !old || n.home !== old.home || n.last !== old.last || n.seen !== old.seen;
  });
  return {
    names: namesChanged ? outNames : [...names],
    links: next,
    namesChanged,
    linksChanged: !sameLinks(next, links),
  };
}

/**
 * Gives a tab a name, renames it, or with an empty name takes it away (the tab
 * shows its page title again, and the name is forgotten).
 */
export function setTabName(input: {
  names: readonly TabName[];
  links: Readonly<NameLinks>;
  tab: TabSeen;
  name: string;
  now: number;
  newId: () => string;
}): { names: TabName[]; links: NameLinks } {
  const name = cleanTabName(input.name);
  const tabId = String(input.tab.id);
  const links: NameLinks = { ...input.links };
  const linked = links[tabId];
  let names = input.names.map((n) => ({ ...n }));
  const entry = linked !== undefined ? names.find((n) => n.id === linked) : undefined;

  if (!name) {
    if (entry) names = names.filter((n) => n.id !== entry.id);
    delete links[tabId];
    return { names, links };
  }
  if (entry) {
    entry.name = name;
    entry.seen = input.now;
    return { names, links };
  }
  const address = nameAddress(input.tab.url);
  const created: TabName = { id: input.newId(), name, home: address, last: address, seen: input.now };
  names.push(created);
  links[tabId] = created.id;
  return { names: pruneTabNames(names, links), links };
}

/** Keeps the list at `max` names: those on no open tab and unused longest go first. */
export function pruneTabNames(names: TabName[], links: Readonly<NameLinks>, max = MAX_TAB_NAMES): TabName[] {
  if (names.length <= max) return names;
  const onTabs = new Set(Object.values(links));
  const gone = new Set(
    names
      .filter((n) => !onTabs.has(n.id))
      .sort((a, b) => a.seen - b.seen)
      .slice(0, names.length - max)
      .map((n) => n.id),
  );
  return names.filter((n) => !gone.has(n.id));
}
