import type { Rule } from './types.js';

export interface UrlHost {
  /** Lower case, no trailing dot, no port. */
  hostname: string;
  /** hostname plus ":port" when the address names a port. */
  host: string;
}

/** The host of a web address, or null for anything that is not http or https. */
export function urlHost(url: string | undefined): UrlHost | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return null;
  return { hostname, host: parsed.port ? `${hostname}:${parsed.port}` : hostname };
}

/** What the extension remembers to notice that a tab went to another site. '' for non-web pages. */
export function hostKey(url: string | undefined): string {
  return urlHost(url)?.host ?? '';
}

/** A tab that went from prevHost to newHost is on a new site and the rules look at it. */
export function isNewSite(prevHost: string, newHost: string): boolean {
  return newHost !== '' && newHost !== prevHost;
}

/** A rule host that starts with "*." covers that domain and every subdomain. */
export const WILDCARD = '*.';

/**
 * Turns what the user typed into a rule host. Accepts a bare host, a full
 * address copied from the address bar (scheme and path are dropped), or
 * "*.example.com" for example.com and all its subdomains.
 * Null when it is not a usable host.
 */
export function normalizeRuleHost(input: string): string | null {
  let raw = input.trim();
  const wildcard = raw.startsWith(WILDCARD);
  if (wildcard) raw = raw.slice(WILDCARD.length);
  if (!raw || /[\s*]/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = urlHost(withScheme);
  if (!parsed) return null;
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;
  if (wildcard && !parsed.hostname.includes('.')) return null;
  return wildcard ? `${WILDCARD}${parsed.host}` : parsed.host;
}

function ruleMatches(want: string, parsed: UrlHost): 'exact' | 'wildcard' | null {
  if (want.startsWith(WILDCARD)) {
    const base = want.slice(WILDCARD.length);
    const name = base.includes(':') ? parsed.host : parsed.hostname;
    return name === base || name.endsWith(`.${base}`) ? 'wildcard' : null;
  }
  return want === (want.includes(':') ? parsed.host : parsed.hostname) ? 'exact' : null;
}

/**
 * The switched-on rule for an address. An exact host wins over "*." rules;
 * among "*." rules the longest (most specific) one wins; otherwise the first.
 * A rule without a port matches any port; a rule with a port matches only that port.
 * "example.com" never matches "www.example.com": only "*.example.com" would.
 */
export function matchRule(url: string | undefined, rules: readonly Rule[]): Rule | null {
  const parsed = urlHost(url);
  if (!parsed) return null;
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const want = rule.host.toLowerCase();
    if (!want) continue;
    const kind = ruleMatches(want, parsed);
    if (kind === 'exact') return rule;
    if (kind === 'wildcard' && (!best || want.length > best.host.length)) best = rule;
  }
  return best;
}
