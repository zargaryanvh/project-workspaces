import type { GroupColor } from './lib/types.js';
import { h } from './ui.js';

/**
 * A text field with a dropdown of choices. The list opens right under the
 * field, exactly as wide as the field, as tall as the room under it (down to
 * 16 px above the window's bottom), and scrolls inside.
 * A long option is cut with "..." and shows in full on hover.
 */

export interface ComboOption {
  label: string;
  color: GroupColor;
  /** Small grey text at the right, e.g. "open". */
  note?: string;
}

const MIN_ROOM = 5 * 34; // at least five rows, or the page scrolls the field up first

export function attachCombo(
  input: HTMLInputElement,
  getOptions: () => ComboOption[],
  onPick: (label: string) => void,
): void {
  const wrap = input.parentElement;
  if (!wrap) throw new Error('A combo field needs a wrapper element');
  wrap.classList.add('combo');
  const menu = h('ul', { class: 'combo-menu', role: 'listbox', hidden: true });
  const caret = h(
    'button',
    { type: 'button', class: 'combo-caret', tabIndex: -1, 'aria-label': 'Show choices' },
    '▾',
  );
  wrap.append(caret, menu);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';

  let active = -1;
  let shown: ComboOption[] = [];
  let filterByText = false;

  const place = (): void => {
    let rect = input.getBoundingClientRect();
    if (window.innerHeight - rect.bottom - 16 < MIN_ROOM) {
      input.scrollIntoView({ block: 'center' });
      rect = input.getBoundingClientRect();
    }
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 2}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.maxHeight = `${Math.max(80, window.innerHeight - rect.bottom - 18)}px`;
  };

  const draw = (): void => {
    const text = input.value.trim().toLowerCase();
    const all = getOptions();
    shown = filterByText && text ? all.filter((o) => o.label.toLowerCase().includes(text)) : all;
    menu.replaceChildren(
      ...(shown.length
        ? shown.map((option, i) =>
            h(
              'li',
              {
                class: i === active ? 'combo-option active' : 'combo-option',
                role: 'option',
                'aria-selected': String(i === active),
                'data-color': option.color,
                title: option.label,
                onmousedown: (e: MouseEvent) => {
                  e.preventDefault(); // keep the focus in the field
                  pick(option.label);
                },
              },
              h('span', { class: 'dot', 'aria-hidden': 'true' }),
              h('span', { class: 'combo-label' }, option.label),
              option.note ? h('span', { class: 'combo-note' }, option.note) : null,
            ),
          )
        : [h('li', { class: 'combo-empty' }, 'No project with this name yet. It is made when a matching tab opens.')]),
    );
    menu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const open = (byText: boolean): void => {
    filterByText = byText;
    active = -1;
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    place();
    draw();
  };

  const close = (): void => {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  const pick = (label: string): void => {
    input.value = label;
    close();
    onPick(label);
  };

  input.addEventListener('focus', () => open(false));
  input.addEventListener('click', () => {
    if (menu.hidden) open(false);
  });
  input.addEventListener('input', () => {
    if (menu.hidden) open(true);
    filterByText = true;
    active = -1;
    draw();
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.hidden) open(false);
      if (shown.length === 0) return;
      active = e.key === 'ArrowDown' ? (active + 1) % shown.length : (active - 1 + shown.length) % shown.length;
      draw();
    } else if (e.key === 'Enter' && !menu.hidden && shown[active]) {
      e.preventDefault();
      pick(shown[active]?.label ?? input.value);
    } else if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation();
      close();
    }
  });
  caret.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (menu.hidden) {
      input.focus();
      open(false);
    } else close();
  });
  window.addEventListener('resize', () => {
    if (!menu.hidden) place();
  });
  window.addEventListener(
    'scroll',
    () => {
      if (!menu.hidden) place();
    },
    true,
  );
}
