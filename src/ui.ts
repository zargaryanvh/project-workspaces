import { leadingEmoji } from './lib/titles.js';
import type { GroupColor } from './lib/types.js';

/** Tiny DOM helper. Text always goes in as text nodes, never as HTML. */

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(el.dataset, value);
    } else if (
      key.startsWith('aria-') ||
      key.startsWith('data-') ||
      key === 'role' ||
      key === 'for' ||
      key === 'list' // read-only as a property, so it must be an attribute
    ) {
      el.setAttribute(key, String(value));
    } else if (key in el) {
      Reflect.set(el, key, value);
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const COLOR_NAMES: Record<GroupColor, string> = {
  grey: 'Grey',
  blue: 'Blue',
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  pink: 'Pink',
  purple: 'Purple',
  cyan: 'Cyan',
  orange: 'Orange',
};

/** Keeps the caret in a text field when its part of the page is drawn again. */
export function keepFocus(draw: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLInputElement ? active.dataset.focus : undefined;
  const start = active instanceof HTMLInputElement ? active.selectionStart : null;
  const end = active instanceof HTMLInputElement ? active.selectionEnd : null;
  draw();
  if (!key) return;
  const again = document.querySelector<HTMLInputElement>(`input[data-focus="${key}"]`);
  if (!again) return;
  again.focus();
  if (start !== null && end !== null) again.setSelectionRange(start, end);
}

/**
 * The icon slot and the name of a project, for lists: a leading emoji in the
 * name takes the place of the colour dot (and is not repeated in the name).
 */
export function projectLabel(
  title: string,
  dotClass = 'dot',
): { icon: HTMLSpanElement; name: string } {
  const lead = leadingEmoji(title);
  return lead
    ? { icon: h('span', { class: `${dotClass} emoji`, 'aria-hidden': 'true' }, lead.icon), name: lead.rest }
    : { icon: h('span', { class: dotClass, 'aria-hidden': 'true' }), name: title };
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One small tooltip for the page, placed inside the window: under its anchor,
 * or above it when there is no room, and never cut off by a scrolling list.
 */
let tip: HTMLDivElement | null = null;
let tipAnchor: HTMLElement | null = null;

export function hideTip(): void {
  if (tip) tip.hidden = true;
  tipAnchor = null;
}

/** Hides the tooltip if its anchor was drawn away (a row rebuilt under the pointer). */
export function syncTip(): void {
  if (tipAnchor && !tipAnchor.isConnected) hideTip();
}

export function attachTip(anchor: HTMLElement, text: string): void {
  const show = (): void => {
    tip ??= document.body.appendChild(h('div', { class: 'tip', role: 'tooltip', hidden: true }));
    tip.textContent = text;
    tip.hidden = false;
    tipAnchor = anchor;
    const box = anchor.getBoundingClientRect();
    const margin = 6;
    const left = Math.max(margin, Math.min(window.innerWidth - tip.offsetWidth - margin, box.right - tip.offsetWidth));
    const below = box.bottom + 6;
    const top = below + tip.offsetHeight > window.innerHeight - margin ? box.top - tip.offsetHeight - 6 : below;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(margin, top)}px`;
  };
  anchor.addEventListener('mouseenter', show);
  anchor.addEventListener('focus', show);
  anchor.addEventListener('mouseleave', hideTip);
  anchor.addEventListener('blur', hideTip);
}
