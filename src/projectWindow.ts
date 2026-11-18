/**
 * The narrow project window, from inside: it keeps itself attached to its own
 * Brave window. Each Brave window has its own project window (the worker
 * opens them, one per window, from the toolbar button).
 *
 * The window the owner moves or resizes leads, and the other follows:
 *
 * - The list's edge dragged: Brave's edge goes along while the drag lasts
 *   (the page hears every step of its own resize), and the new width is kept.
 * - The list moved by its title bar: Brave goes along when the move ends.
 * - Brave moved or resized: the list goes along, to another screen too. Brave
 *   reports its size only now and then during a drag, so from the first
 *   report on (or from the pointer leaving the list at the edge next to
 *   Brave) the page looks again every few frames until Brave stops.
 * - Brave maximized: the list takes its strip at the screen edge, Brave the rest.
 * - Brave minimized, restored, or brought to the front from another app:
 *   the list too (and the other way round).
 *
 * While the owner drags one window, only the other one is moved: moving the
 * window in their hand would end the drag. Nothing here activates a window
 * by moving it, for the same reason.
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
 * A window placed here may pass through a step or two on its way: bounds
 * events this soon after are taken as that move's. Short, so a real change by
 * the owner right after is not missed.
 */
const OWN_MOVE_MS = 300;
/** The end of a move: a few events can come together. */
const SETTLE_MS = 120;
/** The list's own drag counts as over when its size has not changed for this long. */
const LIST_DRAG_END_MS = 300;
/**
 * While Brave may be being dragged: how often to look at it, and how long it
 * must stay still before the drag counts as over and Brave itself may be moved
 * (only to keep the list on screen or usable). A pointer resting mid-drag for
 * longer than that will feel Brave's edge jump once.
 */
const BRAVE_POLL_MS = 40;
const BRAVE_SETTLE_MS = 1000;
/** The pointer left the list at the edge next to Brave: watch Brave this long for a drag. */
const BRAVE_WATCH_MS = 3000;
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
/** The border measured at each screen scale (device pixel ratio). */
const insets = new Map<number, number>();
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
let listMoveTimer: ReturnType<typeof setTimeout> | undefined;
let listDragEndTimer: ReturnType<typeof setTimeout> | undefined;
let liveFrame = 0;
let liveRunning = false;
let liveAgain = false;
let bravePoll: ReturnType<typeof setTimeout> | undefined;
let braveChanged = false;
let braveWatchUntil = 0;

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

function warn(err: unknown): void {
  // The screen refused a place (an odd monitor layout): the windows stay where they are, and that is fine.
  console.warn('[Project workspaces] the project window could not follow:', err);
}

/** One change at a time, so two quick events never place the windows at once. */
function serial(job: () => Promise<void>): Promise<void> {
  queue = queue
    .then(job)
    .catch(warn);
  return queue;
}

/**
 * Measures the border, from inside this window. Read twice, a moment apart: a
 * page caught in the middle of a redraw (a resize, a new screen scale) gives
 * two different answers, and then the last good one stays.
 */
async function measureInset(): Promise<void> {
  const read = (): number =>
    window.outerWidth > 0 && window.innerWidth > 0 ? frameInset(window.outerWidth, window.innerWidth, zoom) : -1;
  const first = read();
  await wait(100);
  const second = read();
  if (first < 0 || first !== second) return;
  inset = first;
  insets.set(window.devicePixelRatio, first);
}

/** The border changes with the screen's scale (the window moved to another screen, or the page was zoomed). */
function watchScale(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      watchScale();
      void serial(async () => {
        const known = insets.get(window.devicePixelRatio);
        if (known !== undefined) inset = known;
        await readZoom();
        await wait(SETTLE_MS);
        const list = await getWindow(selfId);
        if (list?.state === 'normal') await measureInset();
        await followBrave();
      });
    },
    { once: true },
  );
}

async function readZoom(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) zoom = await chrome.tabs.getZoom(tab.id);
  } catch {
    // zoom stays as it was
  }
}

/**
 * Places one window, unless it is there already. Only the bounds change: a
 * window that is not maximized or minimized is not restored, which would
 * bring it to the front and end a drag the owner is making. Returns what shows of it now.
 */
async function moveTo(id: number, win: chrome.windows.Window, rect: Rect): Promise<Rect> {
  const outer = toOuter(rect, inset);
  if (win.state === 'normal' && sameRect(boundsOf(win), outer)) return rect;
  placed.set(id, { outer, until: Date.now() + OWN_MOVE_MS });
  const moved = await chrome.windows.update(id, win.state === 'normal' ? outer : { state: 'normal', ...outer });
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

/**
 * Brave leads: the list goes beside it, to Brave's screen first when Brave is
 * on another one. `live`: Brave is still being dragged, so only the list moves.
 */
async function followBrave(hop = 0, live = false): Promise<void> {
  const [list, browser] = await Promise.all([getWindow(selfId), getWindow(browserId)]);
  if (!list || !browser) return;
  if (list.state === 'minimized' || browser.state === 'minimized' || browser.state === 'fullscreen') return;
  const area = workArea();
  const seen = toVisible(boundsOf(browser), inset);
  // The list's width as it is now (the owner may have dragged it); before the first placement, the remembered one.
  const listWidth = pair ? toVisible(boundsOf(list), inset).width : width;
  if (!centerIn(seen, area)) {
    if (live || hop > 0) return;
    // Brave is on another screen: step onto it, inside Brave's edge, and learn that screen's measure.
    const strip = { left: side === 'left' ? seen.left : seen.left + seen.width - listWidth, top: seen.top, width: listWidth, height: seen.height };
    await moveTo(selfId, list, strip);
    await screenAround(strip);
    await wait(SETTLE_MS); // and its scale
    await measureInset();
    return followBrave(hop + 1);
  }
  if (browser.state === 'maximized') {
    if (live) return;
    // Maximized while they were together: the list takes its strip, and Brave is maximized again when the list closes.
    void send({ type: 'dockWindow', selfId, browserMaximized: true }).catch(() => undefined);
    await place(dockLayout(area, side, listWidth));
    return;
  }
  const target = followBrowser(area, side, listWidth, seen, pair);
  if (live) {
    pair = { list: await moveTo(selfId, list, target.list), browser: seen };
    return;
  }
  await place(target);
  // A list that could not get as narrow as the room (Brave keeps windows above a smallest size): Brave's edge waits at it.
  if (pair && pair.list.left + pair.list.width > pair.browser.left + 1 && side === 'left') {
    const listEnd = pair.list.left + pair.list.width;
    const browserNow = await getWindow(browserId);
    if (browserNow) pair = { ...pair, browser: await moveTo(browserId, browserNow, { ...pair.browser, left: listEnd, width: pair.browser.left + pair.browser.width - listEnd }) };
  } else if (pair && pair.browser.left + pair.browser.width > pair.list.left + 1 && side === 'right') {
    const browserNow = await getWindow(browserId);
    if (browserNow) pair = { ...pair, browser: await moveTo(browserId, browserNow, { ...pair.browser, width: pair.list.left - pair.browser.left }) };
  }
  keepWidth(pair?.list.width ?? target.list.width);
}

/** The list got a new width from the owner's drag (of its edge, or of Brave's): new windows open at it. */
function keepWidth(next: number): void {
  if (Math.abs(next - width) < 1) return;
  width = next;
  void send({ type: 'setProjectWindowWidth', width }).catch(() => undefined);
}

/** The list leads (the end of its move or resize): Brave goes along, and the width is kept. The list itself is never moved. */
async function followSelf(): Promise<void> {
  const [list, browser] = await Promise.all([getWindow(selfId), getWindow(browserId)]);
  if (!list || !browser) return;
  if (list.state === 'minimized' || browser.state === 'minimized' || browser.state === 'fullscreen') return;
  if (list.state === 'maximized') {
    // A maximized list makes no sense beside Brave: back to its strip.
    await place(dockLayout(workArea(), side, width));
    return;
  }
  const seen = toVisible(boundsOf(list), inset);
  const area = await screenAround(seen);
  const before = pair ?? { list: seen, browser: toVisible(boundsOf(browser), inset) };
  const next = followList(area, seen, before);
  side = next.side;
  keepWidth(next.list.width);
  pair = { list: seen, browser: await moveTo(browserId, browser, next.browser) };
}

/**
 * The list is being resized by the owner: this page hears every step, so
 * Brave's edge goes along at once (only Brave moves; the list is in their hand).
 */
async function liveFollowList(): Promise<void> {
  if (liveRunning) {
    liveAgain = true;
    return;
  }
  liveRunning = true;
  try {
    const browser = await getWindow(browserId);
    if (!pair || !browser || browser.state !== 'normal') return;
    const seen = toVisible({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight }, inset);
    pair = { list: seen, browser: await moveTo(browserId, browser, followList(workArea(), seen, pair).browser) };
  } catch (err) {
    warn(err);
  } finally {
    liveRunning = false;
    if (liveAgain) {
      liveAgain = false;
      scheduleLiveFollow();
    }
  }
}

function scheduleLiveFollow(): void {
  if (liveFrame !== 0) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    void liveFollowList();
  });
}

function onResize(): void {
  const mine = placed.get(selfId);
  if (mine && Date.now() < mine.until) return; // a placement made here
  scheduleLiveFollow();
  if (listDragEndTimer !== undefined) clearTimeout(listDragEndTimer);
  listDragEndTimer = setTimeout(() => {
    listDragEndTimer = undefined;
    void serial(followSelf);
  }, LIST_DRAG_END_MS);
}

/**
 * Brave reports its size only now and then while it is dragged, so the page
 * looks at it every few frames: from Brave's first report, or from the moment
 * the pointer left the list at the edge next to Brave (about to grab Brave's
 * edge). Each change moves the list at once; Brave itself is placed only when
 * it has stayed still for BRAVE_SETTLE_MS. Nothing changed for BRAVE_WATCH_MS: no drag.
 */
function watchBraveDrag(changed: boolean): void {
  braveChanged ||= changed;
  braveWatchUntil = Math.max(braveWatchUntil, Date.now() + BRAVE_WATCH_MS);
  if (bravePoll !== undefined) return;
  let last = '';
  let stillSince = Date.now();
  const tick = async (): Promise<void> => {
    const browser = await getWindow(browserId);
    const now = browser ? `${browser.state} ${browser.left} ${browser.top} ${browser.width} ${browser.height}` : '';
    if (now !== last) {
      // Brave where this page put it (following the list's drag) is not the owner dragging Brave.
      const mine = browser ? placed.get(browserId) : undefined;
      const ours = mine !== undefined && browser?.state === 'normal' && sameRect(boundsOf(browser), mine.outer, 2);
      const listInHand = listDragEndTimer !== undefined;
      if (last !== '' && !ours && !listInHand) braveChanged = true;
      last = now;
      stillSince = Date.now();
      if (braveChanged && !ours && !listInHand) await serial(() => followBrave(0, true));
    }
    const still = Date.now() - stillSince;
    if (!browser || (braveChanged ? still >= BRAVE_SETTLE_MS : Date.now() >= braveWatchUntil)) {
      bravePoll = undefined;
      if (braveChanged) void serial(() => followBrave()); // over: Brave may be placed too now
      braveChanged = false;
      return;
    }
    bravePoll = setTimeout(() => void tick(), BRAVE_POLL_MS);
  };
  bravePoll = setTimeout(() => void tick(), 0);
}

/** The pointer leaves the list through the edge next to Brave: the owner may be about to drag Brave's edge. */
function onPointerLeave(event: MouseEvent): void {
  const edge = 16;
  const atSeam = side === 'left' ? event.clientX >= window.innerWidth - edge : event.clientX <= edge;
  if (atSeam) watchBraveDrag(false);
}

function onBoundsChanged(win: chrome.windows.Window): void {
  const id = win.id;
  if (id === undefined || (id !== selfId && id !== browserId)) return;
  // A move made here: the window is where it was put (or on its way there). Maximized,
  // minimized or somewhere else, it was the owner, whenever it happened.
  const mine = placed.get(id);
  if (mine && win.state === 'normal' && (sameRect(boundsOf(win), mine.outer, 2) || Date.now() < mine.until)) return;
  if (id === browserId) {
    watchBraveDrag(true);
    return;
  }
  // The list moved by its title bar, or the end of its resize (followed live already).
  if (listMoveTimer !== undefined) clearTimeout(listMoveTimer);
  listMoveTimer = setTimeout(() => {
    listMoveTimer = undefined;
    void serial(followSelf);
  }, SETTLE_MS);
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
  chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  window.addEventListener('resize', onResize);
  document.documentElement.addEventListener('mouseleave', onPointerLeave);
  watchScale();
  void serial(async () => {
    await readZoom();
    await measureInset();
    await followBrave();
  });
  return browserId;
}
