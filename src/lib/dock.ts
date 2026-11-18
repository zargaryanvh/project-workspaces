/**
 * The narrow project window: a window of its own with the project list,
 * attached to the side of one Brave window. Brave's side panel cannot be
 * narrower than 400 px; this window can.
 *
 * Every rectangle here is what you see of a window, unless a name says
 * "outer". Windows gives each window an invisible border for resizing (7 px
 * on the left, right and bottom, none at the top), and the browser places
 * windows by their outer box. Two windows placed edge to edge by their outer
 * boxes show a gap of two borders between them, so everything is worked out
 * on the visible boxes and turned into outer boxes only to place a window.
 */

/** A window's place on the screen, as chrome.windows uses it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Side = 'left' | 'right';

/** The two windows of a pair: the project list and its Brave window. */
export interface Pair {
  list: Rect;
  browser: Rect;
}

export const PROJECT_WINDOW_DEFAULT_WIDTH = 300;
export const PROJECT_WINDOW_MIN_WIDTH = 180;
export const PROJECT_WINDOW_MAX_WIDTH = 600;
/** Dragged narrower than this, the list stops shrinking (it would be no use). */
export const LIST_SMALLEST_WIDTH = 120;
/** Brave does not make a window narrower than this. */
export const BROWSER_MIN_WIDTH = 500;
/** Window edges this close count as the same edge. */
const NEAR = 2;

/** A usable width: within the limits, and never more than half of the screen. */
export function clampWindowWidth(width: number, areaWidth = Number.POSITIVE_INFINITY): number {
  const max = Math.max(PROJECT_WINDOW_MIN_WIDTH, Math.min(PROJECT_WINDOW_MAX_WIDTH, Math.floor(areaWidth / 2)));
  if (!Number.isFinite(width)) return Math.min(PROJECT_WINDOW_DEFAULT_WIDTH, max);
  return Math.round(Math.min(max, Math.max(PROJECT_WINDOW_MIN_WIDTH, width)));
}

/** A width to place the list at: what it has, but at least usable and at most half the screen. */
export function usableWidth(width: number, areaWidth: number): number {
  const most = Math.max(LIST_SMALLEST_WIDTH, Math.floor(areaWidth / 2));
  return Math.round(Math.min(most, Math.max(LIST_SMALLEST_WIDTH, Number.isFinite(width) ? width : PROJECT_WINDOW_DEFAULT_WIDTH)));
}

/**
 * The invisible border, from inside the window: the window's outer width less
 * the width its page gets, split over the two sides, less the 1 px line
 * Windows draws there (that line shows). `innerWidth` is in page pixels, so
 * the page zoom turns it back into screen pixels. Measured on Windows 11: the
 * frame is 8 on each side and 7 of it is invisible, at 100 % and at 150 %
 * alike (window positions are whole units, so 150 % can be half a pixel off).
 * 0 where windows have no such border (macOS, most Linux desktops).
 */
export function frameInset(outerWidth: number, innerWidth: number, zoom = 1): number {
  const frame = (outerWidth - innerWidth * (zoom > 0 ? zoom : 1)) / 2;
  return Number.isFinite(frame) ? Math.min(16, Math.max(0, Math.round(frame) - 1)) : 0;
}

/** The outer box that shows `visible`: the border on the left, right and bottom. */
export function toOuter(visible: Rect, inset: number): Rect {
  return { left: visible.left - inset, top: visible.top, width: visible.width + 2 * inset, height: visible.height + inset };
}

/** What shows of a window placed at `outer`. */
export function toVisible(outer: Rect, inset: number): Rect {
  return { left: outer.left + inset, top: outer.top, width: outer.width - 2 * inset, height: outer.height - inset };
}

export function sameRect(a: Rect, b: Rect, tolerance = 1): boolean {
  return (
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** Whether the middle of `rect` is on the screen whose work area is `area`. */
export function centerIn(rect: Rect, area: Rect): boolean {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  return x >= area.left && x < area.left + area.width && y >= area.top && y < area.top + area.height;
}

const right = (r: Rect): number => r.left + r.width;
const bottom = (r: Rect): number => r.top + r.height;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= NEAR;
const centerX = (r: Rect): number => r.left + r.width / 2;

/** The same layout seen in a mirror, so the right side is worked out as the left one. */
function mirror(r: Rect, area: Rect): Rect {
  return { ...r, left: area.left + right(area) - right(r) };
}

function mirrorPair(pair: Pair, area: Rect): Pair {
  return { list: mirror(pair.list, area), browser: mirror(pair.browser, area) };
}

/**
 * The project window opens beside a maximized Brave, or Brave was maximized
 * while they were together: the list takes a strip at the screen edge and
 * Brave takes the rest (the work area is the screen without the taskbar).
 */
export function dockLayout(area: Rect, side: Side, width: number): Pair {
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

/**
 * Brave was moved or resized (or the list opens beside a Brave that is not
 * maximized): the list goes along, at the same height. When Brave's edge next
 * to the list was dragged and the list sits at the screen edge, the list
 * takes the new room, whatever it is (down to LIST_SMALLEST_WIDTH); otherwise
 * it keeps its width and moves. A list that would leave the screen stays at
 * the edge and Brave's edge is pushed instead: the caller applies that part
 * only once Brave is no longer being dragged. `before` is how the two were
 * last seen, when known.
 */
export function followBrowser(area: Rect, side: Side, width: number, browser: Rect, before: Pair | null): Pair {
  if (side === 'right') {
    return mirrorPair(followBrowser(area, 'left', width, mirror(browser, area), before && mirrorPair(before, area)), area);
  }
  const top = Math.max(area.top, browser.top);
  const end = Math.min(bottom(area), bottom(browser));
  const [listTop, listHeight] = end - top >= 100 ? [top, end - top] : [area.top, area.height];
  const sharedEdgeDragged =
    before !== null &&
    near(before.list.left, area.left) &&
    near(right(browser), right(before.browser)) &&
    near(browser.top, before.browser.top) &&
    near(bottom(browser), bottom(before.browser)) &&
    !near(browser.left, before.browser.left);
  let listLeft: number;
  let listWidth: number;
  if (sharedEdgeDragged) {
    listLeft = area.left;
    listWidth = Math.max(LIST_SMALLEST_WIDTH, browser.left - area.left);
  } else {
    listWidth = usableWidth(width, area.width);
    listLeft = Math.max(area.left, browser.left - listWidth);
  }
  const browserLeft = listLeft + listWidth;
  const browserRight = Math.max(right(browser), browserLeft + BROWSER_MIN_WIDTH);
  return {
    list: { left: listLeft, top: listTop, width: listWidth, height: listHeight },
    browser: { left: browserLeft, top: browser.top, width: browserRight - browserLeft, height: browser.height },
  };
}

/**
 * The list was moved or resized: Brave goes along, at the list's height, on
 * the same side as before (on the other side only when Brave has no room left
 * on its own). When the list's edge next to Brave was dragged, Brave keeps its
 * far edge (the two share the space); when the list moved, Brave keeps its
 * width, but not past the screen edge. The list keeps the size the owner gave
 * it: only Brave moves. `before` is how the two were last seen.
 */
export function followList(area: Rect, list: Rect, before: Pair): Pair & { side: Side } {
  const listWidth = list.width;
  const roomRight = right(area) - (list.left + listWidth);
  const roomLeft = list.left - area.left;
  let side: Side = centerX(before.list) <= centerX(before.browser) ? 'left' : 'right';
  if (side === 'left' && roomRight < BROWSER_MIN_WIDTH && roomLeft >= BROWSER_MIN_WIDTH) side = 'right';
  else if (side === 'right' && roomLeft < BROWSER_MIN_WIDTH && roomRight >= BROWSER_MIN_WIDTH) side = 'left';
  if (side === 'left') return { ...followListOnLeft(area, list, before), side };
  return { ...mirrorPair(followListOnLeft(area, mirror(list, area), mirrorPair(before, area)), area), side };
}

/** followList with the list on Brave's left (the right side is worked out in a mirror). */
function followListOnLeft(area: Rect, list: Rect, before: Pair): Pair {
  const listWidth = list.width;
  const beforeOnLeft = centerX(before.list) <= centerX(before.browser);
  const resized = !near(list.width, before.list.width);
  const outerEdgeKept = near(list.left, before.list.left);
  const browserLeft = list.left + listWidth;
  let browserRight =
    beforeOnLeft && resized && outerEdgeKept ? right(before.browser) : Math.min(browserLeft + before.browser.width, right(area));
  browserRight = Math.max(browserRight, browserLeft + BROWSER_MIN_WIDTH);
  return {
    list: { left: list.left, top: list.top, width: listWidth, height: list.height },
    browser: { left: browserLeft, top: list.top, width: browserRight - browserLeft, height: list.height },
  };
}

/**
 * A project window Brave brought back after a restart has lost its Brave
 * window (window ids change). It belongs to the nearest Brave window that has
 * no project window yet: the one it touches, or else the closest.
 */
export function nearestWindow<T extends Rect>(list: Rect, windows: readonly T[]): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const win of windows) {
    const dx = Math.max(0, win.left - right(list), list.left - right(win));
    const dy = Math.max(0, win.top - bottom(list), list.top - bottom(win));
    const distance = Math.hypot(dx, dy) + Math.abs(win.top - list.top) / 10;
    if (distance < bestDistance) {
      best = win;
      bestDistance = distance;
    }
  }
  return best;
}
