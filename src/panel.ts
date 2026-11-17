/**
 * The project list. Two views of the same list:
 * - the side panel (left or right, wherever Brave's sidebar is): a column with
 *   everything, from switching to making and changing projects;
 * - the project row (view=row): a row of project labels under the toolbar
 *   button, to switch quickly.
 * The order is always the tab bar's order. Every change is asked of the
 * background worker.
 */

import { readWindow } from './lib/chromeShapes.js';
import { buildList, moveTarget, type ListItem } from './lib/list.js';
import { send } from './lib/messages.js';
import { sanitizeRules } from './lib/sanitize.js';
import { cleanTitle, isStagingTitle, projectKey, withStagingMark } from './lib/titles.js';
import { GROUP_COLORS, type GroupColor, type Rule } from './lib/types.js';
import { COLOR_NAMES, h, keepFocus, plural, projectLabel } from './ui.js';

const params = new URLSearchParams(location.search);
const rowView = params.get('view') === 'row';
document.body.classList.toggle('row-view', rowView);

const listEl = document.getElementById('list') as HTMLUListElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;
const createEl = document.getElementById('create') as HTMLElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;

const data = {
  items: [] as ListItem[],
  rules: [] as Rule[],
  shortcuts: new Map<string, string>(),
  /** Selected (highlighted) tabs in this window that can join a project. */
  selected: 0,
  loaded: false,
};

const ui = {
  menuFor: null as number | null,
  renaming: null as { groupId: number; value: string } | null,
  deleting: null as { groupId: number; removeRules: boolean } | null,
  creating: null as { value: string; color: GroupColor } | null,
  dragGroupId: null as number | null,
  listWaiting: false,
  error: '',
};

let windowId = -1;

// ---------------------------------------------------------------- data

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 40);
}

async function refresh(): Promise<void> {
  refreshTimer = undefined;
  try {
    const [{ groups, tabs }, stored, highlighted] = await Promise.all([
      readWindow(windowId),
      chrome.storage.local.get(['rules']),
      chrome.tabs.query({ windowId, highlighted: true }),
    ]);
    data.rules = sanitizeRules(stored['rules']);
    data.items = buildList(groups, tabs, windowId);
    data.selected = highlighted.filter((t) => !t.pinned).length;
    data.loaded = true;
    if (ui.menuFor !== null && !data.items.some((i) => i.groupId === ui.menuFor)) closeMenu();
    renderFromOutside();
  } catch (err) {
    showError(err);
  }
}

async function refreshShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const next = new Map(
    commands.flatMap((c) => (c.name && c.shortcut ? [[c.name, c.shortcut] as [string, string]] : [])),
  );
  const same = next.size === data.shortcuts.size && [...next].every(([name, key]) => data.shortcuts.get(name) === key);
  if (same) return; // the panel got focus and nothing changed: leave the rows as they are
  data.shortcuts = next;
  renderFromOutside();
}

// ---------------------------------------------------------------- never redraw under a click

/**
 * A click is a press and a release on the same element. If the rows are drawn
 * again in between, the release lands on a new element and the browser drops
 * the click. That happened when a click also gave the panel focus: the focus
 * redrew the list and the first click was lost. So updates that come from
 * outside (tabs, groups, the panel getting focus) wait while a button is down.
 */
let pointerDown = false;
let renderWaiting = false;
let pointerSafety: ReturnType<typeof setTimeout> | undefined;

function releasePointer(): void {
  if (pointerSafety !== undefined) clearTimeout(pointerSafety);
  setTimeout(() => {
    pointerDown = false;
    if (renderWaiting) {
      renderWaiting = false;
      render();
    }
  }, 0);
}

document.addEventListener(
  'pointerdown',
  () => {
    pointerDown = true;
    if (pointerSafety !== undefined) clearTimeout(pointerSafety);
    pointerSafety = setTimeout(releasePointer, 3000); // released outside the panel: do not wait forever
  },
  true,
);
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);
window.addEventListener('blur', releasePointer);

function renderFromOutside(): void {
  if (pointerDown) {
    renderWaiting = true;
    return;
  }
  render();
}

// ---------------------------------------------------------------- actions

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showError(err: unknown): void {
  ui.error = errorText(err);
  render();
}

async function act(job: () => Promise<unknown>): Promise<void> {
  ui.error = '';
  try {
    await job();
  } catch (err) {
    ui.error = errorText(err);
  }
  render();
  scheduleRefresh();
}

function switchTo(item: ListItem): Promise<void> {
  return act(async () => {
    await send({ type: 'switch', windowId, groupId: item.groupId });
    if (rowView) window.close(); // the row is a quick switcher: done
  });
}

function closeMenu(): void {
  ui.menuFor = null;
  ui.renaming = null;
  ui.deleting = null;
}

function toggleMenu(groupId: number): void {
  const open = ui.menuFor !== groupId;
  closeMenu();
  if (open) ui.menuFor = groupId;
  render();
}

/** Moves a project in the list and its group in the tab bar: right before another one, or last (null). */
function moveProject(groupId: number, beforeGroupId: number | null): Promise<void> {
  // Show the new order at once; the tab bar follows and the next refresh confirms it.
  const moving = data.items.find((i) => i.groupId === groupId);
  if (moving) {
    const rest = data.items.filter((i) => i.groupId !== groupId);
    const at = beforeGroupId === null ? rest.length : rest.findIndex((i) => i.groupId === beforeGroupId);
    rest.splice(at < 0 ? rest.length : at, 0, moving);
    data.items = rest.map((item, i) => ({ ...item, number: i < 9 ? i + 1 : null }));
    render();
  }
  return act(() => send({ type: 'move', windowId, groupId, beforeGroupId }));
}

function moveBy(item: ListItem, step: -1 | 1): void {
  const before = moveTarget(data.items, item.groupId, step);
  if (before !== undefined) void moveProject(item.groupId, before);
}

// ---------------------------------------------------------------- drag to reorder (the grip)

function dropSide(e: DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function clearDropMarks(): void {
  for (const el of listEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

function onDragStart(e: DragEvent, item: ListItem): void {
  ui.dragGroupId = item.groupId;
  const row = (e.currentTarget as HTMLElement).closest<HTMLElement>('.row');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.title || 'project');
    if (row) e.dataTransfer.setDragImage(row, 16, 16);
  }
  row?.classList.add('dragging');
}

function onDragOver(e: DragEvent, item: ListItem): void {
  if (ui.dragGroupId === null || ui.dragGroupId === item.groupId) return;
  e.preventDefault();
  clearDropMarks();
  (e.currentTarget as HTMLElement).classList.add(dropSide(e) === 'before' ? 'drop-before' : 'drop-after');
}

function onDrop(e: DragEvent, item: ListItem): void {
  if (ui.dragGroupId === null) return;
  e.preventDefault();
  const side = dropSide(e);
  const movingId = ui.dragGroupId;
  onDragEnd();
  if (movingId === item.groupId) return;
  const others = data.items.filter((x) => x.groupId !== movingId);
  const at = others.findIndex((x) => x.groupId === item.groupId);
  const before = side === 'before' ? item.groupId : (others[at + 1]?.groupId ?? null);
  void moveProject(movingId, before);
}

function onDragEnd(): void {
  ui.dragGroupId = null;
  clearDropMarks();
  for (const el of listEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
  if (ui.listWaiting) render();
}

// ---------------------------------------------------------------- drawing

function render(): void {
  keepFocus(() => {
    if (rowView) renderRow();
    else {
      renderList();
      renderCreate();
    }
  });
  errorEl.hidden = !ui.error;
  errorEl.textContent = ui.error;
}

function displayName(item: ListItem): string {
  return item.title || 'Untitled group';
}

/** What the rows show, as a string: they are rebuilt only when it changes. */
let listKey = '';
let createKey = '';

/** The project row: labels like Brave's group labels, in tab bar order. */
function renderRow(): void {
  emptyEl.hidden = !data.loaded || data.items.length > 0;
  const key = JSON.stringify(['row', data.items]);
  if (key === listKey) return;
  listKey = key;
  listEl.replaceChildren(
    ...data.items.map((item) =>
      h(
        'li',
        { class: 'chip-item' },
        h(
          'button',
          {
            type: 'button',
            class: item.current ? 'chip current' : 'chip',
            'data-color': item.color,
            title: `${displayName(item)}: ${plural(item.tabCount, 'tab', 'tabs')}${item.number ? `. Key ${item.number}` : ''}`,
            'aria-current': item.current ? 'true' : undefined,
            onclick: () => void switchTo(item),
          },
          item.number !== null ? h('span', { class: 'chip-number' }, item.number) : null,
          h('span', { class: 'chip-name' }, displayName(item)),
        ),
      ),
    ),
  );
}

function renderList(): void {
  emptyEl.hidden = !data.loaded || data.items.length > 0;
  if (ui.dragGroupId !== null) {
    ui.listWaiting = true; // redrawing now would cancel the drag
    return;
  }
  ui.listWaiting = false;
  const deletingKey = ui.deleting ? data.items.find((i) => i.groupId === ui.deleting?.groupId)?.key : undefined;
  const key = JSON.stringify([
    data.items,
    ui.menuFor,
    ui.renaming,
    ui.deleting,
    data.items.map((i) => (i.number !== null ? (data.shortcuts.get(`project-${i.number}`) ?? '') : '')),
    deletingKey ? data.rules.filter((r) => projectKey(r.project) === deletingKey).length : 0,
  ]);
  if (key === listKey) return; // nothing to show differently: keep the same elements
  listKey = key;
  const rows: HTMLLIElement[] = [];
  data.items.forEach((item, index) => {
    rows.push(renderItem(item));
    if (ui.menuFor === item.groupId) rows.push(renderMenu(item, index));
  });
  listEl.replaceChildren(...rows);
}

function renderItem(item: ListItem): HTMLLIElement {
  const name = displayName(item);
  const label = projectLabel(name); // "🔵 Admin" shows its circle once, in the dot's place
  const tabs = plural(item.tabCount, 'tab', 'tabs');
  const shortcut = item.number !== null ? data.shortcuts.get(`project-${item.number}`) : undefined;
  const classes = ['row', item.current && 'current', ui.menuFor === item.groupId && 'menu-open'].filter(Boolean);
  return h(
    'li',
    {
      class: classes.join(' '),
      'data-color': item.color,
      'data-group': String(item.groupId),
      ondragover: (e: DragEvent) => onDragOver(e, item),
      ondrop: (e: DragEvent) => onDrop(e, item),
    },
    h('span', {
      class: 'grip',
      title: 'Drag to change the order (the tab bar follows)',
      draggable: ui.renaming === null,
      ondragstart: (e: DragEvent) => onDragStart(e, item),
      ondragend: onDragEnd,
    }),
    h(
      'button',
      {
        class: 'main',
        type: 'button',
        title: item.current ? `${name} (${tabs}) is open` : `Show ${name} (${tabs})`,
        'aria-current': item.current ? 'true' : undefined,
        onclick: () => void switchTo(item),
      },
      label.icon,
      h('span', { class: item.title ? 'name' : 'name untitled' }, label.name),
      shortcut ? h('span', { class: 'key' }, shortcut) : null,
      h('span', { class: 'count', 'aria-label': tabs }, item.tabCount),
    ),
    h(
      'button',
      {
        class: 'more',
        type: 'button',
        title: `Change ${name}`,
        'aria-label': `Change ${name}`,
        'aria-expanded': String(ui.menuFor === item.groupId),
        onclick: () => toggleMenu(item.groupId),
      },
      '⋯',
    ),
  );
}

function swatches(selected: GroupColor, onPick: (color: GroupColor) => void, label: string, disabled = false): HTMLDivElement {
  return h(
    'div',
    { class: 'swatches', role: 'group', 'aria-label': label },
    ...GROUP_COLORS.map((color) =>
      h('button', {
        type: 'button',
        class: 'swatch',
        'data-color': color,
        title: disabled ? 'Staging projects are orange' : COLOR_NAMES[color],
        'aria-label': COLOR_NAMES[color],
        'aria-pressed': String(color === selected),
        disabled,
        onclick: () => onPick(color),
      }),
    ),
  );
}

function stagingToggle(on: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  return h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: on,
      onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
    }),
    'Staging (adds \u{1F7E0} and uses orange)',
  );
}

function renderMenu(item: ListItem, index: number): HTMLLIElement {
  if (ui.renaming?.groupId === item.groupId) return renderRename(item, ui.renaming);
  if (ui.deleting?.groupId === item.groupId) return renderDelete(item, ui.deleting);
  const name = displayName(item);
  return h(
    'li',
    { class: 'menu', 'data-color': item.color },
    swatches(item.color, (color) => void act(() => send({ type: 'recolor', groupId: item.groupId, color })), `Colour of ${name}`),
    h(
      'div',
      { class: 'menu-actions' },
      h('button', { type: 'button', onclick: () => startRename(item) }, item.title ? 'Rename' : 'Name it'),
      h('button', { type: 'button', disabled: index === 0, onclick: () => moveBy(item, -1) }, 'Move up'),
      h(
        'button',
        { type: 'button', disabled: index === data.items.length - 1, onclick: () => moveBy(item, 1) },
        'Move down',
      ),
      h('button', { type: 'button', class: 'danger', onclick: () => startDelete(item) }, 'Delete'),
    ),
  );
}

function startRename(item: ListItem): void {
  ui.renaming = { groupId: item.groupId, value: item.title };
  ui.deleting = null;
  render();
  document.querySelector<HTMLInputElement>('input[data-focus="rename"]')?.select();
}

function renderRename(item: ListItem, state: { groupId: number; value: string }): HTMLLIElement {
  const title = cleanTitle(state.value);
  const canSave = title !== '' && title !== item.title;
  const save = (): void => {
    if (!canSave) return;
    void act(async () => {
      await send({ type: 'rename', groupId: item.groupId, title: state.value });
      closeMenu();
    });
  };
  const cancel = (): void => {
    ui.renaming = null;
    render();
  };
  return h(
    'li',
    { class: 'menu', 'data-color': item.color },
    h('input', {
      type: 'text',
      class: 'text',
      value: state.value,
      maxLength: 80,
      placeholder: 'Project name',
      'aria-label': 'New name',
      'data-focus': 'rename',
      oninput: (e: Event) => {
        state.value = (e.target as HTMLInputElement).value;
        render();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      },
    }),
    stagingToggle(isStagingTitle(state.value), (on) => {
      state.value = withStagingMark(state.value, on);
      render();
    }),
    h(
      'div',
      { class: 'menu-actions' },
      h('button', { type: 'button', onclick: cancel }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', disabled: !canSave, onclick: save }, 'Save'),
    ),
  );
}

function startDelete(item: ListItem): void {
  ui.deleting = { groupId: item.groupId, removeRules: false };
  ui.renaming = null;
  render();
}

function renderDelete(item: ListItem, state: { groupId: number; removeRules: boolean }): HTMLLIElement {
  const name = displayName(item);
  const rules = item.key ? data.rules.filter((r) => projectKey(r.project) === item.key).length : 0;
  const tabsLine = item.tabCount === 1 ? 'Its tab stays open.' : `All ${item.tabCount} tabs stay open.`;
  return h(
    'li',
    { class: 'menu', 'data-color': item.color },
    h('p', { class: 'confirm' }, `Delete the project “${name}”? ${tabsLine} Only the group goes away.`),
    rules > 0
      ? h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: state.removeRules,
            onchange: (e: Event) => {
              state.removeRules = (e.target as HTMLInputElement).checked;
            },
          }),
          rules === 1
            ? 'Also delete its address. If you keep it, the next matching tab makes this project again.'
            : `Also delete its ${rules} addresses. If you keep them, the next matching tab makes this project again.`,
        )
      : null,
    h(
      'div',
      { class: 'menu-actions' },
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            ui.deleting = null;
            render();
          },
        },
        'Cancel',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'primary danger',
          onclick: () =>
            void act(async () => {
              await send({ type: 'delete', groupId: item.groupId, removeRules: state.removeRules });
              closeMenu();
            }),
        },
        'Delete project',
      ),
    ),
  );
}

function renderCreate(): void {
  const count = Math.max(1, data.selected);
  const state = ui.creating;
  const key = JSON.stringify([state, count]);
  if (key === createKey) return; // unchanged: keep the button under the pointer as it is
  createKey = key;
  if (!state) {
    createEl.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: 'new',
          title: count > 1 ? `New project from the ${count} selected tabs` : 'New project from the current tab',
          onclick: () => {
            ui.creating = { value: '', color: 'blue' };
            render();
            document.querySelector<HTMLInputElement>('input[data-focus="create"]')?.focus();
          },
        },
        h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'),
        h(
          'span',
          { class: 'new-text' },
          'New project',
          h('small', null, count > 1 ? `from the ${count} selected tabs` : 'from the current tab'),
        ),
      ),
    );
    return;
  }

  const staging = isStagingTitle(state.value);
  const color: GroupColor = staging ? 'orange' : state.color;
  const canCreate = cleanTitle(state.value) !== '';
  const create = (): void => {
    if (!canCreate) return;
    void act(async () => {
      await send({ type: 'create', windowId, title: state.value, color });
      ui.creating = null;
    });
  };
  const cancel = (): void => {
    ui.creating = null;
    render();
  };
  createEl.replaceChildren(
    h('h2', null, 'New project'),
    h('input', {
      type: 'text',
      class: 'text',
      value: state.value,
      maxLength: 80,
      placeholder: 'Name, for example Admin',
      'aria-label': 'Project name',
      'data-focus': 'create',
      oninput: (e: Event) => {
        state.value = (e.target as HTMLInputElement).value;
        render();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') create();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      },
    }),
    stagingToggle(staging, (on) => {
      state.value = withStagingMark(state.value, on);
      render();
    }),
    swatches(
      color,
      (picked) => {
        state.color = picked;
        render();
      },
      'Colour',
      staging,
    ),
    h(
      'p',
      { class: 'hint' },
      count > 1
        ? `Uses the ${count} selected tabs.`
        : 'Uses the current tab. To use more, select tabs in the tab bar with Ctrl or Shift.',
    ),
    h(
      'div',
      { class: 'menu-actions' },
      h('button', { type: 'button', onclick: cancel }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', disabled: !canCreate, onclick: create }, 'Create'),
    ),
  );
}

// ---------------------------------------------------------------- start

function wireEvents(): void {
  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onHighlighted.addListener(scheduleRefresh);
  chrome.tabs.onMoved.addListener(scheduleRefresh);
  chrome.tabs.onAttached.addListener(scheduleRefresh);
  chrome.tabs.onDetached.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    if (change.groupId !== undefined || change.pinned !== undefined) scheduleRefresh();
  });
  chrome.tabGroups.onCreated.addListener(scheduleRefresh);
  chrome.tabGroups.onUpdated.addListener(scheduleRefresh);
  chrome.tabGroups.onRemoved.addListener(scheduleRefresh);
  chrome.tabGroups.onMoved.addListener(scheduleRefresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['rules']) scheduleRefresh();
  });
  window.addEventListener('focus', () => void refreshShortcuts());

  document.getElementById('open-options')?.addEventListener('click', () => void chrome.runtime.openOptionsPage());
  document
    .getElementById('open-shortcuts')
    ?.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  document.addEventListener('keydown', (e) => {
    if (rowView) {
      // The row: 1 to 9 opens that project, Escape closes the row.
      const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      const item = n ? data.items[n - 1] : undefined;
      if (item) void switchTo(item);
      if (e.key === 'Escape') window.close();
      return;
    }
    if (e.key !== 'Escape' || (ui.menuFor === null && !ui.creating)) return;
    closeMenu();
    ui.creating = null;
    render();
  });
}

async function main(): Promise<void> {
  const fromQuery = Number(params.get('windowId'));
  windowId = Number.isInteger(fromQuery) && fromQuery > 0 ? fromQuery : ((await chrome.windows.getCurrent()).id ?? -1);
  wireEvents();
  await Promise.all([refresh(), refreshShortcuts()]);
}

void main().catch(showError);
