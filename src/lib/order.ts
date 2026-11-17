import type { TabInfo } from './types.js';
import { NO_GROUP } from './types.js';

/**
 * The index to give chrome.tabGroups.move so that a group lands right before
 * another group (beforeGroupId), or after every other group (null).
 *
 * Brave reads the index as the group's final position, counted without the
 * group itself, and refuses an index inside another group, so this only ever
 * returns a group edge, or -1 for "at the end". Null when nothing has to move.
 */
export function groupMoveIndex(
  tabs: readonly TabInfo[],
  windowId: number,
  movingGroupId: number,
  beforeGroupId: number | null,
): number | null {
  const inWindow = tabs.filter((t) => t.windowId === windowId);
  const moving = inWindow.filter((t) => t.groupId === movingGroupId);
  if (moving.length === 0 || beforeGroupId === movingGroupId) return null;
  const start = Math.min(...moving.map((t) => t.index));

  if (beforeGroupId === null) {
    const others = inWindow.filter((t) => t.groupId !== NO_GROUP && t.groupId !== movingGroupId);
    if (others.length === 0) return null;
    const lastOther = Math.max(...others.map((t) => t.index));
    return start > lastOther ? null : -1;
  }

  const target = inWindow.filter((t) => t.groupId === beforeGroupId);
  if (target.length === 0) return null;
  const targetStart = Math.min(...target.map((t) => t.index));
  const index = start < targetStart ? targetStart - moving.length : targetStart;
  return index === start ? null : index;
}
