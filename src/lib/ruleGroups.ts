import { normalizeRuleHost } from './rules.js';
import { cleanTitle, projectKey } from './titles.js';
import type { Rule } from './types.js';

/**
 * The settings page shows rules grouped by project: one card per project with
 * its addresses. Storage keeps a flat list; these convert between the two.
 */

export interface AddressRow {
  id: string;
  /** As typed. Saved only once it is a usable host. */
  host: string;
  enabled: boolean;
}

export interface ProjectCard {
  id: string;
  /** As typed. */
  project: string;
  rows: AddressRow[];
}

/** Groups the flat rule list into cards, in the order each project first appears. */
export function cardsFromRules(rules: readonly Rule[]): ProjectCard[] {
  const cards: ProjectCard[] = [];
  const byKey = new Map<string, ProjectCard>();
  for (const rule of rules) {
    const key = projectKey(rule.project);
    let card = byKey.get(key);
    if (!card) {
      card = { id: `card-${rule.id}`, project: rule.project, rows: [] };
      byKey.set(key, card);
      cards.push(card);
    }
    card.rows.push({ id: rule.id, host: rule.host, enabled: rule.enabled });
  }
  return cards;
}

/** Flattens cards back into rules, card by card. Rows without a usable host and cards without a name are left out. */
export function rulesFromCards(cards: readonly ProjectCard[]): Rule[] {
  const out: Rule[] = [];
  for (const card of cards) {
    const project = cleanTitle(card.project);
    if (!project) continue;
    for (const row of card.rows) {
      const host = normalizeRuleHost(row.host);
      if (host) out.push({ id: row.id, host, project, enabled: row.enabled });
    }
  }
  return out;
}

/** Hosts used by more than one project. Only the first one counts, so the page warns about the others. */
export function sharedHosts(cards: readonly ProjectCard[]): Map<string, string[]> {
  const projectsByHost = new Map<string, string[]>();
  for (const card of cards) {
    const project = cleanTitle(card.project);
    if (!project) continue;
    for (const row of card.rows) {
      const host = normalizeRuleHost(row.host);
      if (!host) continue;
      const list = projectsByHost.get(host) ?? [];
      if (!list.some((p) => projectKey(p) === projectKey(project))) list.push(project);
      projectsByHost.set(host, list);
    }
  }
  for (const [host, list] of projectsByHost) if (list.length < 2) projectsByHost.delete(host);
  return projectsByHost;
}
