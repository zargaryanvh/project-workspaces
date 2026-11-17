import { hostKey, matchRule } from './rules.js';
import type { Rule, TabInfo } from './types.js';

/**
 * "This site is already open": when a project address is opened while another
 * tab already shows that site, the new tab shows a warning instead.
 */

export interface AlreadyOpenInput {
  /** The address the tab is about to load. */
  url: string;
  tabId: number;
  windowId: number;
  /** Host the tab shows now ('' for a new tab). Moving inside one site is never warned. */
  currentHost: string;
  /** For a brand-new tab: host of the tab it was opened from. A link inside one site is never warned. */
  openerHost: string | null;
  /** The owner chose "Open anyway" for this address in this tab. */
  allowedUrl?: string | undefined;
  rules: readonly Rule[];
  /** Every tab in Brave's normal windows. */
  tabs: readonly TabInfo[];
}

/** The tabs already open on that site, best match first. Null when no warning is due. */
export function findAlreadyOpen(input: AlreadyOpenInput): TabInfo[] | null {
  const host = hostKey(input.url);
  if (!host) return null;
  if (!matchRule(input.url, input.rules)) return null; // project addresses only
  if (input.allowedUrl !== undefined && sameAddress(input.allowedUrl, input.url)) return null;
  if (input.currentHost === host) return null;
  if (input.openerHost === host) return null;
  const others = input.tabs.filter((t) => t.id !== input.tabId && hostKey(t.url) === host);
  if (others.length === 0) return null;
  const exact = (t: TabInfo) => (sameAddress(t.url, input.url) ? 0 : 1);
  const here = (t: TabInfo) => (t.windowId === input.windowId ? 0 : 1);
  return [...others].sort((a, b) => exact(a) - exact(b) || here(a) - here(b) || a.index - b.index);
}

/** The same page: equal apart from the #part and a slash at the end. */
export function sameAddress(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function normalize(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}
