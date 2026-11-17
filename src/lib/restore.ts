import { projectKey } from './titles.js';
import type { GroupInfo, TabInfo } from './types.js';

/**
 * Bringing back the open project after Brave reopens a window (Ctrl+Shift+T,
 * or a restart). Window and group ids are new then, so a window is known by
 * the set of its project names.
 */

/** The names of a window's projects, as one string. Empty when it has none. */
export function windowSignature(groups: readonly GroupInfo[], windowId: number): string {
  const keys = new Set<string>();
  for (const g of groups) {
    if (g.windowId !== windowId) continue;
    const key = projectKey(g.title);
    if (key) keys.add(key);
  }
  return [...keys].sort().join('\n');
}

/** The project that is open in a window now: the active tab's group, or the only open group. */
export function openProjectKey(groups: readonly GroupInfo[], tabs: readonly TabInfo[], windowId: number): string | null {
  const inWindow = groups.filter((g) => g.windowId === windowId);
  const active = tabs.find((t) => t.windowId === windowId && t.active);
  const activeGroup = active ? inWindow.find((g) => g.id === active.groupId) : undefined;
  if (activeGroup && !activeGroup.collapsed && projectKey(activeGroup.title)) return projectKey(activeGroup.title);
  const open = inWindow.filter((g) => !g.collapsed && projectKey(g.title));
  return open.length === 1 && open[0] ? projectKey(open[0].title) : null;
}

/**
 * Which group to open once a reopened window has settled:
 * the project remembered for it, else the only group Brave restored open,
 * else the group of the active tab. Null leaves the window as it is.
 */
export function pickOpenAfterRestore(
  groups: readonly GroupInfo[],
  tabs: readonly TabInfo[],
  windowId: number,
  rememberedKey: string | undefined,
): number | null {
  const inWindow = groups.filter((g) => g.windowId === windowId);
  if (rememberedKey) {
    const remembered = inWindow.find((g) => projectKey(g.title) === rememberedKey);
    if (remembered) return remembered.id;
  }
  const open = inWindow.filter((g) => !g.collapsed);
  if (open.length === 1 && open[0]) return open[0].id;
  const active = tabs.find((t) => t.windowId === windowId && t.active);
  const activeGroup = active ? inWindow.find((g) => g.id === active.groupId) : undefined;
  return activeGroup?.id ?? null;
}

/**
 * Notes the open project of a window under its signature. The newest entry
 * goes last and only the latest `cap` windows are kept. Same object back when
 * nothing changed.
 */
export function rememberOpen(
  map: Record<string, string>,
  signature: string,
  key: string,
  cap = 30,
): Record<string, string> {
  if (!signature || !key) return map;
  const entries = Object.entries(map);
  if (map[signature] === key && entries[entries.length - 1]?.[0] === signature) return map;
  const kept = entries.filter(([sig]) => sig !== signature);
  kept.push([signature, key]);
  return Object.fromEntries(kept.slice(-cap));
}
