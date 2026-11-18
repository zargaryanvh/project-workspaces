/**
 * The narrow project window, from inside: it keeps itself attached to its own
 * Brave window. Each Brave window has its own project window (the worker
 * opens them, one per window, from the toolbar button).
 *
 * The window the owner moves or resizes leads, and the other follows:
 *
 * - Brave moved or resized: the list goes along, to another screen too.
 *   Dragging Brave's edge next to the list resizes both.
 * - The list moved or resized: Brave goes along. Dragging the list's edge
 *   next to Brave resizes both, and the new width is kept for next time.
 * - Brave maximized: the list takes its strip at the screen edge, Brave the rest.
 * - Brave minimized, restored, or brought to the front from another app:
 *   the list too (and the other way round).
 *
 * The visible edges touch: the invisible border Windows puts around every
 * window is measured here (see frameInset) and the windows overlap by it.
 */

import {
  centerIn,
  dockLayout,
  followBrowser,
  followList,
  frameInset,
  sameRect,
  toOuter,
  toVisible,
  type Pair,
  type Rect,
  type Side,
} from './lib/dock.js';
import { send, type ProjectWindowAttachment } from './lib/messages.js';

/**
 * A window placed here may pass through a step or two on its way (restored
 * first, then moved): bounds events this soon after are taken as that move's.
 * Short, so a real change by the owner right after is not missed.
 */
const OWN_MOVE_MS = 300;
/** The owner's change settles first: a drag can end with a few events. */
const SETTLE_MS = 120;
/** Focus moved here to bring the pair up: the focus events that causes are ignored this long. */
const RAISE_MS = 600;
/** Away from both windows this long means the owner was in another app. */
const AWAY_MS = 250;
/** A screen's measure reaches the page a moment after its window moved to that screen. */
const SCREEN_WAIT_MS = 1000;
/** After Brave lost the focus, a look whether it was minimized. */
const MINIMIZE_CHECK_MS = 150;

const NONE = chrome.windows.WINDOW_ID_NONE;

let selfId = -1;
let browserId = -1;
let side: Side = 'left';
let width = 300;
let zoom = 1;
let inset = 0;
/** The two windows as they were last placed or seen (what shows of them). */
let pair: Pair | null = null;
/** Where each window was last placed from here (outer box), and until when its bounds events are ours. */
const placed = new Map<number, { outer: Rect; until: number }>();
let raiseUntil = 0;
/** The window that had the focus last (not counting "no window"). */
let lastFocused: number = NONE;
/** Since when no window of this browser has had the focus (0: one has it). */
let awaySince = 0;
/** The list was minimized because its Brave window was: it comes back with it. */
let minimizedWithBrave = false;
let queue: Promise<void> = Promise.resolve();
const settleTimers = new Map<number, ReturnType<typeof setTimeout>>();
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

/** The work area of the screen this window is on: the screen without the taskbar. */
function workArea(): Rect {
  const s = screen as Screen & { availLeft?: number; availTop?: number };
  return { left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight };
}

function boundsOf(win: chrome.windows.Window): Rect {
  return { left: win.left ?? 0, top: win.top ?? 0, width: win.width ?? 0, height: win.height ?? 0 };
}

function getWindow(id: number): Promise<chrome.windows.Window | null> {
  return chrome.windows.get(id).catch(() => null);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One change at a time, so two quick events never place the windows at once. */
function serial(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job).catch((err: unknown) => {
    // The screen refused a place (an odd monitor layout): the windows stay where they are, and that is fine.
    console.warn('[Project workspaces] the project window could not follow:', err);
  });
  return queue;
}

/**
 * The border, measured now. Only while the list is a normal window (maximized
 * or minimized, its borders differ). It changes with the screen's scale, so it
 * is measured again before every placement and after every resize.
 */
function measureInset(list: chrome.windows.Window): void {
  if (list.state !== 'normal' || window.outerWidth <= 0 || window.innerWidth <= 0) return;
  inset = frameInset(window.outerWidth, window.innerWidth, zoom);
}

/**
 * The page is redrawn at a new screen's scale a moment after the window got
 * there, and only then is the border right: if it changed, the pair is placed again.
 */
function onResize(): void {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    void serial(async () => {
      const list = await getWindow(selfId);
      if (!list) return;
      const before = inset;
      measureInset(list);
      if (inset !== before) await followBrave();
    });
  }, SETTLE_MS);
}

/** Places one window, unless it is there already. Returns what shows of it now. */
async function moveTo(id: number, win: chrome.windows.Window, rect: Rect): Promise<Rect> {
  const outer = toOuter(rect, inset);
  if (win.state === 'normal' && sameRect(boundsOf(win), outer)) return rect;
  placed.set(id, { outer, until: Date.now() + OWN_MOVE_MS });
  const moved = await chrome.windows.update(id, { state: 'normal', ...outer });
  placed.set(id, { outer: boundsOf(moved), until: Date.now() + OWN_MOVE_MS });
  return toVisible(boundsOf(moved), inset);
}

async function place(target: Pair): Promise<void> {
  const [list, browser] = await Promise.all([getWindow(selfId), getWindow(browserId)]);
  if (!list || !browser) return;
  const [listNow, browserNow] = await Promise.all([moveTo(selfId, list, target.list), moveTo(browserId, browser, target.browser)]);
  pair = { list: listNow, browser: browserNow };
}

/** The work area around `rect`, once this window has moved there (the measure follows the move). */
async function screenAround(rect: Rect): Promise<Rect> {
  const end = Date.now() + SCREEN_WAIT_MS;
  let area = workArea();
  while (!centerIn(rect, area) && Date.now() < end) {
    await wait(50);
    area = workArea();
  }
  return area;
}

/** Brave leads: the list goes beside it, to Brave's screen first when Brave is on another one. */
async function followBrave(hop = 0): Promise<void> {
  const [list, browser] = await Promise.all([getWindow(selfId), getWindow(browserId)]);
  if (!list || !browser) return;
  if (list.state === 'minimized' || browser.state === 'minimized' || browser.state === 'fullscreen') return;
  measureInset(list);
  const area = workArea();
  const seen = toVisible(boundsOf(browser), inset);
  if (!centerIn(seen, area)) {
    if (hop > 0) return;
    // Brave is on another screen: step onto it, inside Brave's edge, and learn that screen's measure.
    const strip = { left: side === 'left' ? seen.left : seen.left + seen.width - width, top: seen.top, width, height: seen.height };
    await moveTo(selfId, list, strip);
    await screenAround(strip);
    await wait(SETTLE_MS); // and its scale
    return followBrave(hop + 1);
  }
  if (browser.state === 'maximized') {
    // Maximized while they were together: the list takes its strip, and Brave is maximized again when the list closes.
    void send({ type: 'dockWindow', selfId, browserMaximized: true }).catch(() => undefined);
    await place(dockLayout(area, side, width));
    return;
  }
  await place(followBrowser(area, side, width, seen, pair));
}

/** The list leads: Brave goes along. */
async function followSelf(): Promise<void> {
  const [list, browser] = await Promise.all([getWindow(selfId), getWindow(browserId)]);
  if (!list || !browser) return;
  if (list.state === 'minimized' || browser.state === 'minimized' || browser.state === 'fullscreen') return;
  if (list.state === 'maximized') {
    // A maximized list makes no sense beside Brave: back to its strip.
    await place(dockLayout(workArea(), side, width));
    return;
  }
  measureInset(list);
  const seen = toVisible(boundsOf(list), inset);
  const area = await screenAround(seen);
  const before = pair ?? { list: seen, browser: toVisible(boundsOf(browser), inset) };
  const next = followList(area, seen, before);
  side = next.side;
  if (next.list.width !== width) {
    width = next.list.width;
    void send({ type: 'setProjectWindowWidth', width }).catch(() => undefined);
  }
  await place({ list: next.list, browser: next.browser });
}

function onBoundsChanged(win: chrome.windows.Window): void {
  const id = win.id;
  if (id === undefined || (id !== selfId && id !== browserId)) return;
  // A move made here: the window is where it was put (or on its way there). Maximized,
  // minimized or somewhere else, it was the owner, whenever it happened.
  const mine = placed.get(id);
  if (mine && win.state === 'normal' && (sameRect(boundsOf(win), mine.outer, 2) || Date.now() < mine.until)) return;
  const timer = settleTimers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  settleTimers.set(
    id,
    setTimeout(() => {
      settleTimers.delete(id);
      void serial(id === selfId ? followSelf : () => followBrave());
    }, SETTLE_MS),
  );
}

/** Brave lost the focus: if the owner minimized it, the list goes too. */
function checkMinimized(): void {
  setTimeout(() => {
    void serial(async () => {
      const [list, browser] = await Promise.all([getWindow(selfId), getWindow(browserId)]);
      if (browser?.state !== 'minimized' || !list || list.state === 'minimized') return;
      minimizedWithBrave = true;
      placed.set(selfId, { outer: boundsOf(list), until: Date.now() + OWN_MOVE_MS });
      await chrome.windows.update(selfId, { state: 'minimized' });
    });
  }, MINIMIZE_CHECK_MS);
}

/** One of the pair came to the front from another app: the other one comes up behind it. */
async function bringUp(front: number, other: number): Promise<void> {
  const win = await getWindow(other);
  if (!win) return;
  if (win.state === 'minimized' && other === selfId && !minimizedWithBrave) return; // the owner put the list away
  minimizedWithBrave = false;
  raiseUntil = Date.now() + RAISE_MS;
  await chrome.windows.update(other, win.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true });
  await chrome.windows.update(front, { focused: true });
  raiseUntil = Date.now() + RAISE_MS;
  lastFocused = front;
  await followBrave(); // in case Brave moved while the list was away
}

function onFocusChanged(id: number): void {
  const now = Date.now();
  if (id === NONE) {
    if (awaySince === 0) awaySince = now;
    if (lastFocused === browserId) checkMinimized();
    return;
  }
  const previous = lastFocused;
  const cameBack = (awaySince !== 0 && now - awaySince >= AWAY_MS) || (previous !== selfId && previous !== browserId);
  awaySince = 0;
  lastFocused = id;
  if (previous === browserId && id !== browserId) checkMinimized();
  if (now < raiseUntil || !cameBack) return;
  if (id === browserId) void serial(() => bringUp(browserId, selfId));
  else if (id === selfId) void serial(() => bringUp(selfId, browserId));
}

/**
 * Starts the project window: asks the worker which Brave window it belongs to,
 * attaches to it, and keeps attached. Returns that Brave window's id, or null
 * when this window closes instead (the side panel was chosen again, or it has
 * no Brave window).
 */
export async function startProjectWindow(): Promise<number | null> {
  const self = (await chrome.windows.getCurrent()).id;
  if (self === undefined) return null;
  selfId = self;
  const attachment = (await send({ type: 'dockWindow', selfId })) as ProjectWindowAttachment | null;
  if (!attachment) return null;
  ({ browserId, width, side } = attachment);
  lastFocused = selfId;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) zoom = await chrome.tabs.getZoom(tab.id);
  } catch {
    // zoom 1
  }
  chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
  window.addEventListener('resize', onResize);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  void serial(() => followBrave());
  return browserId;
}
