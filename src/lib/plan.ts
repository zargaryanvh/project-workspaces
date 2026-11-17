import type { GroupInfo, LastActive, TabInfo } from './types.js';

/** What to do to show one project in one window. */
export interface SwitchPlan {
  /** Tab to make active, or null when the active tab is already in the project. */
  activateTabId: number | null;
  /** The project's group, when it is folded and has to open. */
  expandGroupId: number | null;
  /** The other open groups in the window. They fold. */
  collapseGroupIds: number[];
}

export interface SwitchInput {
  windowId: number;
  groupId: number;
  groups: readonly GroupInfo[];
  tabs: readonly TabInfo[];
  /** The tab last used in this project, if the extension saw one. */
  lastActive?: LastActive | undefined;
  /** False to open the project without folding the others. */
  foldOthers?: boolean;
}

/**
 * Decides how to switch a window to one project. It never closes, discards or
 * reloads a tab: it only picks a tab to activate and groups to open or fold.
 * Returns null when the group is not in that window or has no tabs.
 */
export function planSwitch(input: SwitchInput): SwitchPlan | null {
  const { windowId, groupId } = input;
  const groups = input.groups.filter((g) => g.windowId === windowId);
  const tabs = input.tabs.filter((t) => t.windowId === windowId);
  const target = groups.find((g) => g.id === groupId);
  if (!target) return null;

  const inGroup = tabs.filter((t) => t.groupId === groupId).sort((a, b) => a.index - b.index);
  const first = inGroup[0];
  if (!first) return null;

  const active = tabs.find((t) => t.active);
  const activateTabId = active && active.groupId === groupId ? null : pickTab(inGroup, input.lastActive, first).id;

  return {
    activateTabId,
    expandGroupId: target.collapsed ? target.id : null,
    collapseGroupIds: input.foldOthers === false ? [] : groupsToFold(groups, windowId, groupId),
  };
}

/** The tab last used in the project if it is still there, else the project's first tab. */
function pickTab(inGroup: readonly TabInfo[], last: LastActive | undefined, first: TabInfo): TabInfo {
  if (!last) return first;
  return (
    inGroup.find((t) => t.id === last.tabId && t.url === last.url) ??
    (last.url ? inGroup.find((t) => t.url === last.url) : undefined) ??
    inGroup.find((t) => t.id === last.tabId) ??
    first
  );
}

/** The open groups in a window other than keepGroupId: folding them leaves one project open. */
export function groupsToFold(groups: readonly GroupInfo[], windowId: number, keepGroupId: number): number[] {
  return groups.filter((g) => g.windowId === windowId && g.id !== keepGroupId && !g.collapsed).map((g) => g.id);
}

export function isEmptyPlan(plan: SwitchPlan): boolean {
  return plan.activateTabId === null && plan.expandGroupId === null && plan.collapseGroupIds.length === 0;
}
