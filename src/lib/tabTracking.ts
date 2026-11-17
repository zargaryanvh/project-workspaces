import { hostKey } from './rules.js';
import { NO_GROUP } from './types.js';

/**
 * A tab opened from a link inside a group joins that group by itself, as Brave
 * inserts it, before its page loads. A group change on a tab that has an
 * opener, has not shown a page yet and is this new counts as that automatic
 * join. Any other group change is the owner's choice.
 */
export const AUTO_JOIN_MS = 1500;

/** What the extension remembers about one tab during one browser session. */
export interface TabTrack {
  /** Host (with port) of the last address seen. '' for pages that are not web pages. */
  host: string;
  /** When the tab was created, in ms. 0 when it was open before the extension started watching. */
  created: number;
  /** The tab was opened from another tab (a link). */
  opener: boolean;
  /** Group the tab is in without the owner choosing it: joined from its opener, or put there by a rule. */
  auto?: number;
  /** Group the owner put the tab in by hand (-1: taken out of a group by hand). Rules leave it there. */
  manual?: number;
}

export type GroupChange = 'own' | 'auto' | 'manual';

export function trackNewTab(args: { url: string | undefined; groupId: number; hasOpener: boolean; now: number }): TabTrack {
  const track: TabTrack = { host: hostKey(args.url), created: args.now, opener: args.hasOpener };
  if (args.groupId !== NO_GROUP && args.hasOpener) track.auto = args.groupId;
  return track;
}

/** Who moved a tab into or out of a group: this extension, Brave on its own, or the owner. */
export function classifyGroupChange(args: {
  byExtension: boolean;
  track: TabTrack | undefined;
  newGroupId: number;
  now: number;
}): GroupChange {
  if (args.byExtension) return 'own';
  const t = args.track;
  const brandNew = t !== undefined && t.created > 0 && args.now - t.created < AUTO_JOIN_MS;
  if (t && brandNew && t.opener && t.host === '' && args.newGroupId !== NO_GROUP) return 'auto';
  return 'manual';
}

/** Applies a group change to what is remembered about the tab. */
export function noteGroupChange(track: TabTrack, kind: GroupChange, newGroupId: number): void {
  if (kind === 'auto') {
    track.auto = newGroupId;
    delete track.manual;
  } else if (kind === 'manual') {
    track.manual = newGroupId;
    delete track.auto;
  }
}

/**
 * May a rule move this tab? Never a pinned tab, and never out of a group the
 * owner chose: only tabs with no group, or in a group they joined on their own.
 * Tabs Brave restored at start-up count as placed by the owner.
 */
export function rulesMayMove(tab: { groupId: number; pinned: boolean }, track: TabTrack | undefined): boolean {
  if (tab.pinned) return false;
  if (track?.manual !== undefined && track.manual === tab.groupId) return false;
  if (tab.groupId === NO_GROUP) return true;
  return track?.auto === tab.groupId;
}
