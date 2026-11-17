import { isGroupColor } from './sanitize.js';
import type { GroupInfo, TabInfo } from './types.js';
import { NO_GROUP } from './types.js';

/** Turns Chromium's objects into the small shapes the pure helpers use. */

export function toGroupInfo(group: chrome.tabGroups.TabGroup): GroupInfo {
  return {
    id: group.id,
    title: group.title ?? '',
    color: isGroupColor(group.color) ? group.color : 'grey',
    collapsed: group.collapsed,
    windowId: group.windowId,
  };
}

export function toTabInfo(tab: chrome.tabs.Tab): TabInfo | null {
  if (tab.id === undefined) return null;
  return {
    id: tab.id,
    groupId: tab.groupId ?? NO_GROUP,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    url: tab.url ?? '',
    windowId: tab.windowId,
  };
}

export function toTabInfos(tabs: readonly chrome.tabs.Tab[]): TabInfo[] {
  const out: TabInfo[] = [];
  for (const tab of tabs) {
    const info = toTabInfo(tab);
    if (info) out.push(info);
  }
  return out;
}

/** The groups and tabs of one window. */
export async function readWindow(windowId: number): Promise<{ groups: GroupInfo[]; tabs: TabInfo[] }> {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({ windowId }), chrome.tabs.query({ windowId })]);
  return { groups: groups.map(toGroupInfo), tabs: toTabInfos(tabs) };
}
