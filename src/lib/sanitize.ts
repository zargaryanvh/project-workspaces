import { normalizeRuleHost } from './rules.js';
import { cleanTitle, projectKey } from './titles.js';
import type { GroupColor, LastActive, LocalState, Rule, Settings, StoredProject } from './types.js';
import { GROUP_COLORS } from './types.js';

/**
 * Storage can hold anything (an older version, a hand edit). These turn what is
 * read back into well-formed values and drop what cannot be used.
 */

export const DEFAULT_SETTINGS: Settings = { follow: true, surface: 'sidePanel', duplicateCheck: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === 'string' && (GROUP_COLORS as readonly string[]).includes(value);
}

export function sanitizeProjects(value: unknown): StoredProject[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: StoredProject[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.title !== 'string') continue;
    const title = cleanTitle(item.title);
    const key = projectKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, color: isGroupColor(item.color) ? item.color : 'grey' });
  }
  return out;
}

export function sanitizeRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  const out: Rule[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.host !== 'string' || typeof item.project !== 'string') continue;
    const host = normalizeRuleHost(item.host);
    const project = cleanTitle(item.project);
    if (!host || !project) continue;
    let id = typeof item.id === 'string' && item.id ? item.id : `rule-${out.length + 1}`;
    while (ids.has(id)) id = `${id}-x`;
    ids.add(id);
    out.push({ id, host, project, enabled: item.enabled !== false });
  }
  return out;
}

export function sanitizeSettings(value: unknown): Settings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  let surface = DEFAULT_SETTINGS.surface;
  if (value.surface === 'sidePanel') surface = 'sidePanel';
  if (value.surface === 'row' || value.surface === 'popup') surface = 'row'; // 'popup' is the 0.1 name
  return {
    follow: typeof value.follow === 'boolean' ? value.follow : DEFAULT_SETTINGS.follow,
    surface,
    duplicateCheck: typeof value.duplicateCheck === 'boolean' ? value.duplicateCheck : DEFAULT_SETTINGS.duplicateCheck,
  };
}

export function sanitizeOpenProjects(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [signature, key] of Object.entries(value)) {
    if (signature && typeof key === 'string' && key) out[signature] = key;
  }
  return out;
}

export function sanitizeLastActive(value: unknown): Record<string, LastActive> {
  if (!isRecord(value)) return {};
  const out: Record<string, LastActive> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || !isRecord(item)) continue;
    if (typeof item.tabId !== 'number' || typeof item.url !== 'string') continue;
    out[key] = { tabId: item.tabId, url: item.url };
  }
  return out;
}

export function sanitizeLocal(raw: unknown): LocalState {
  const value = isRecord(raw) ? raw : {};
  return {
    projects: sanitizeProjects(value.projects),
    rules: sanitizeRules(value.rules),
    lastActive: sanitizeLastActive(value.lastActive),
    openProjects: sanitizeOpenProjects(value.openProjects),
    settings: sanitizeSettings(value.settings),
  };
}
