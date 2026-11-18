import { projectKey } from './titles.js';
import type { GroupColor, GroupInfo, TabInfo } from './types.js';
import { NO_GROUP } from './types.js';

/** One row of the project list. */
export interface ListItem {
  groupId: number;
  title: string;
  key: string;
  color: GroupColor;
  tabCount: number;
  /** The active tab of the window is in this project. */
  current: boolean;
  /** 1 to 9 for the first nine projects (their "Project N" shortcut), else null. */
  number: number | null;
}

/**
 * The projects of one window in tab bar order. The list and the tab bar always
 * agree: moving a project in the list moves its group in the tab bar, and
 * dragging a group in the tab bar moves it in the list.
 */
export function buildList(groups: readonly GroupInfo[], tabs: readonly TabInfo[], windowId: number): ListItem[] {
  const counts = new Map<number, number>();
  const firstIndex = new Map<number, number>();
  let activeGroupId = NO_GROUP;
  for (const tab of tabs) {
    if (tab.windowId !== windowId) continue;
    if (tab.active) activeGroupId = tab.groupId;
    if (tab.groupId === NO_GROUP) continue;
    counts.set(tab.groupId, (counts.get(tab.groupId) ?? 0) + 1);
    const seen = firstIndex.get(tab.groupId);
    if (seen === undefined || tab.index < seen) firstIndex.set(tab.groupId, tab.index);
  }

  return groups
    .filter((g) => g.windowId === windowId && counts.has(g.id))
    .sort((a, b) => (firstIndex.get(a.id) ?? 0) - (firstIndex.get(b.id) ?? 0))
    .map((g, i) => ({
      groupId: g.id,
      title: g.title,
      key: projectKey(g.title),
      color: g.color,
      tabCount: counts.get(g.id) ?? 0,
      current: g.id === activeGroupId,
      number: i < 9 ? i + 1 : null,
    }));
}

/**
 * The project `step` places away from fromGroupId, wrapping around.
 * With no current project: the first one for next, the last one for previous.
 */
export function stepProject(list: readonly ListItem[], fromGroupId: number | null, step: 1 | -1): ListItem | null {
  if (list.length === 0) return null;
  const at = fromGroupId === null ? -1 : list.findIndex((item) => item.groupId === fromGroupId);
  if (at === -1) return (step === 1 ? list[0] : list[list.length - 1]) ?? null;
  return list[(at + step + list.length) % list.length] ?? null;
}

/** Which project a "Project N", "Next project" or "Previous project" command goes to. */
export function commandTarget(
  command: string,
  list: readonly ListItem[],
  fallbackGroupId: number | null,
): ListItem | null {
  const numbered = /^project-([1-9])$/.exec(command);
  if (numbered) return list[Number(numbered[1]) - 1] ?? null;
  if (command !== 'next-project' && command !== 'previous-project') return null;
  const current = list.find((item) => item.current)?.groupId ?? fallbackGroupId;
  return stepProject(list, current, command === 'next-project' ? 1 : -1);
}

/**
 * The group a moved row should land in front of: for "up" the row above, for
 * "down" the row two below (null = after every other project).
 */
export function moveTarget(list: readonly ListItem[], groupId: number, step: -1 | 1): number | null | undefined {
  const at = list.findIndex((item) => item.groupId === groupId);
  if (at === -1) return undefined;
  if (step === -1) return at === 0 ? undefined : (list[at - 1]?.groupId ?? undefined);
  if (at === list.length - 1) return undefined;
  return list[at + 2]?.groupId ?? null;
}
