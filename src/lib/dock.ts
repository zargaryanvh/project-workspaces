/**
 * The narrow project window: a window of its own with the project list, at
 * the edge of the screen, with Brave beside it. Brave's side panel cannot be
 * narrower than 400 px; this window can.
 */

/** A window's place on the screen, as chrome.windows uses it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Side = 'left' | 'right';

export const PROJECT_WINDOW_DEFAULT_WIDTH = 300;
export const PROJECT_WINDOW_MIN_WIDTH = 180;
export const PROJECT_WINDOW_MAX_WIDTH = 600;

/** A usable width: within the limits, and never more than half of the screen. */
export function clampWindowWidth(width: number, areaWidth = Number.POSITIVE_INFINITY): number {
  const max = Math.max(PROJECT_WINDOW_MIN_WIDTH, Math.min(PROJECT_WINDOW_MAX_WIDTH, Math.floor(areaWidth / 2)));
  if (!Number.isFinite(width)) return Math.min(PROJECT_WINDOW_DEFAULT_WIDTH, max);
  return Math.round(Math.min(max, Math.max(PROJECT_WINDOW_MIN_WIDTH, width)));
}

/**
 * Where the project window and Brave go on a screen's work area (the screen
 * without the taskbar): the list on one side, at its width, Brave in the rest.
 */
export function dockLayout(area: Rect, side: Side, width: number): { list: Rect; browser: Rect } {
  const listWidth = clampWindowWidth(width, area.width);
  const browserWidth = area.width - listWidth;
  const list: Rect = {
    left: side === 'left' ? area.left : area.left + browserWidth,
    top: area.top,
    width: listWidth,
    height: area.height,
  };
  const browser: Rect = {
    left: side === 'left' ? area.left + listWidth : area.left,
    top: area.top,
    width: browserWidth,
    height: area.height,
  };
  return { list, browser };
}
