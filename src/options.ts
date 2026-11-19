/**
 * Settings page. Everything on it is a draft until Save: the fixed bar at the
 * top saves or discards, and leaving with unsaved changes asks first.
 */

import { attachCombo, type ComboOption } from './combo.js';
import { cardsFromRules, rulesFromCards, type AddressRow, type ProjectCard } from './lib/ruleGroups.js';
import { normalizeRuleHost } from './lib/rules.js';
import { isGroupColor, sanitizeProjects, sanitizeRules, sanitizeSettings } from './lib/sanitize.js';
import { cleanTitle, defaultColorFor, leadingEmoji, projectKey } from './lib/titles.js';
import type { GroupColor, Rule, Settings, StoredProject, Surface } from './lib/types.js';
import { h } from './ui.js';

interface Saved {
  rules: Rule[];
  settings: Settings;
}

let saved: Saved = { rules: [], settings: sanitizeSettings(undefined) };
let cards: ProjectCard[] = [];
let settings: Settings = sanitizeSettings(undefined);
let projects: StoredProject[] = [];
let openGroups: Array<{ title: string; color: GroupColor }> = [];
const touched = new Set<string>();
let triedSave = false;
let saving = false;
let dragCardId: string | null = null;

const cardsEl = document.getElementById('cards') as HTMLDivElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const discardBtn = document.getElementById('discard') as HTMLButtonElement;
const savedEl = document.getElementById('saved') as HTMLSpanElement;
const followEl = document.getElementById('follow') as HTMLInputElement;
const surfaceEl = document.getElementById('surface') as HTMLSelectElement;
const duplicateEl = document.getElementById('duplicate-check') as HTMLInputElement;
const keyList = document.getElementById('key-list') as HTMLUListElement;
const sideNow = document.getElementById('side-now') as HTMLParagraphElement;

const newId = (): string => crypto.randomUUID();

// ---------------------------------------------------------------- draft state

function snapshot(rules: readonly Rule[], s: Settings): string {
  return JSON.stringify({ rules: rules.map((r) => [r.host, r.project, r.enabled]), s });
}

/** Typed but not usable yet: an address that is not a host, or addresses with no project name. */
function hasUnfinished(): boolean {
  return cards.some(
    (card) =>
      card.rows.some((row) => row.host.trim() !== '' && normalizeRuleHost(row.host) === null) ||
      (cleanTitle(card.project) === '' && card.rows.some((row) => row.host.trim() !== '')),
  );
}

function isDirty(): boolean {
  return snapshot(rulesFromCards(cards), settings) !== snapshot(saved.rules, saved.settings) || hasUnfinished();
}

/** Field id -> message, for every field that is wrong right now. */
function validate(): Map<string, string> {
  const errors = new Map<string, string>();
  const hostOwner = new Map<string, string>();
  const nameSeen = new Set<string>();
  for (const card of cards) {
    const name = cleanTitle(card.project);
    const key = projectKey(name);
    const hasAddress = card.rows.some((row) => row.host.trim() !== '');
    if (!name && hasAddress) errors.set(`name-${card.id}`, 'Type the project name: the name of its tab group.');
    if (key && nameSeen.has(key)) {
      errors.set(`name-${card.id}`, 'Another project above has this name. Add the addresses there.');
    }
    if (key) nameSeen.add(key);
    for (const row of card.rows) {
      if (row.host.trim() === '') continue;
      const host = normalizeRuleHost(row.host);
      if (!host) {
        errors.set(`host-${row.id}`, 'Type an address like app.example.com, *.example.com or localhost:3000 (no spaces).');
        continue;
      }
      const owner = hostOwner.get(host);
      if (owner !== undefined) {
        errors.set(
          `host-${row.id}`,
          projectKey(owner) === key
            ? 'This address is already in this project.'
            : `This address is already in ${owner || 'another project'}. One address can go to one project only.`,
        );
      } else {
        hostOwner.set(host, name);
      }
    }
  }
  return errors;
}

function knownColor(title: string): GroupColor {
  const key = projectKey(title);
  const fromGroup = openGroups.find((g) => projectKey(g.title) === key);
  if (fromGroup) return fromGroup.color;
  return projects.find((p) => projectKey(p.title) === key)?.color ?? defaultColorFor(title);
}

function isOpenNow(title: string): boolean {
  const key = projectKey(title);
  return key !== '' && openGroups.some((g) => projectKey(g.title) === key);
}

function projectChoices(): ComboOption[] {
  const seen = new Set<string>();
  const out: ComboOption[] = [];
  const add = (title: string, color: GroupColor) => {
    const key = projectKey(title);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ label: cleanTitle(title), color, ...(isOpenNow(title) ? { note: 'open' } : {}) });
  };
  for (const g of openGroups) add(g.title, g.color);
  for (const p of projects) add(p.title, p.color);
  for (const card of cards) add(card.project, knownColor(card.project));
  return out;
}

// ---------------------------------------------------------------- drawing

/** Full redraw of the project cards: only for changes in structure (add, delete, order, load). */
function renderCards(): void {
  cardsEl.replaceChildren(
    ...(cards.length
      ? cards.map(renderCard)
      : [h('p', { class: 'empty-cards' }, 'No addresses yet. Click Add project, give it the name of a tab group, and add its addresses.')]),
  );
  refresh();
}

function fieldWithError(input: HTMLInputElement, fieldId: string): HTMLDivElement {
  input.dataset.field = fieldId;
  return h(
    'div',
    { class: 'field' },
    input,
    h('span', { class: 'field-error', role: 'img', 'aria-label': '', 'data-for': fieldId, tabIndex: 0 }, '!'),
  );
}

function renderCard(card: ProjectCard): HTMLElement {
  const nameInput = h('input', {
    type: 'text',
    class: 'text',
    value: card.project,
    placeholder: 'Project name, for example Work',
    spellcheck: false,
    'aria-label': 'Project name',
    oninput: (e: Event) => {
      card.project = (e.target as HTMLInputElement).value;
      refresh();
    },
    onblur: () => {
      touched.add(`name-${card.id}`);
      refresh();
    },
  });
  const nameField = fieldWithError(nameInput, `name-${card.id}`);
  attachCombo(nameInput, projectChoices, (label) => {
    card.project = label;
    touched.add(`name-${card.id}`);
    refresh();
  });

  return h(
    'article',
    {
      class: 'card',
      'data-card': card.id,
      ondragover: (e: DragEvent) => onCardDragOver(e, card),
      ondrop: (e: DragEvent) => onCardDrop(e, card),
    },
    h(
      'header',
      { class: 'card-head' },
      h('span', {
        class: 'grip',
        title: 'Drag to change the order',
        draggable: true,
        ondragstart: (e: DragEvent) => onCardDragStart(e, card),
        ondragend: onCardDragEnd,
      }),
      h('span', { class: 'dot', 'data-dot': card.id, 'aria-hidden': 'true' }),
      nameField,
      h('span', { class: 'status', 'data-status': card.id }),
      h(
        'button',
        {
          type: 'button',
          class: 'icon close',
          title: 'Delete this project and its addresses',
          'aria-label': 'Delete this project and its addresses',
          onclick: () => {
            cards = cards.filter((c) => c !== card);
            renderCards();
          },
        },
        'Delete',
      ),
    ),
    h('ul', { class: 'addresses' }, ...card.rows.map((row) => renderRow(card, row))),
    h(
      'button',
      {
        type: 'button',
        class: 'link add-address',
        onclick: () => {
          const row: AddressRow = { id: newId(), host: '', enabled: true };
          card.rows.push(row);
          renderCards();
          document.querySelector<HTMLInputElement>(`input[data-field="host-${row.id}"]`)?.focus();
        },
      },
      '+ Add address',
    ),
  );
}

function renderRow(card: ProjectCard, row: AddressRow): HTMLLIElement {
  const hostInput = h('input', {
    type: 'text',
    class: 'text',
    value: row.host,
    placeholder: 'app.example.com or localhost:3000',
    spellcheck: false,
    'aria-label': 'Address',
    oninput: (e: Event) => {
      row.host = (e.target as HTMLInputElement).value;
      refresh();
    },
    onblur: () => {
      touched.add(`host-${row.id}`);
      refresh();
    },
  });
  return h(
    'li',
    { class: row.enabled ? 'address' : 'address off' },
    h('input', {
      type: 'checkbox',
      class: 'toggle',
      checked: row.enabled,
      title: row.enabled ? 'On: tabs with this address move to the project' : 'Off: this address is ignored',
      'aria-label': 'Address on',
      onchange: (e: Event) => {
        row.enabled = (e.target as HTMLInputElement).checked;
        (e.target as HTMLInputElement).closest('li')?.classList.toggle('off', !row.enabled);
        refresh();
      },
    }),
    fieldWithError(hostInput, `host-${row.id}`),
    h(
      'button',
      {
        type: 'button',
        class: 'icon close',
        title: 'Delete this address',
        'aria-label': 'Delete this address',
        onclick: () => {
          card.rows = card.rows.filter((r) => r !== row);
          renderCards();
        },
      },
      'Delete',
    ),
  );
}

/** Light update after every key press: errors, dots, status lines, the save bar. Never rebuilds a field. */
function refresh(): void {
  const errors = validate();
  for (const input of cardsEl.querySelectorAll<HTMLInputElement>('input[data-field]')) {
    const id = input.dataset.field ?? '';
    const message = errors.get(id);
    const show = message !== undefined && (triedSave || touched.has(id));
    input.classList.toggle('invalid', show);
    input.setAttribute('aria-invalid', String(show));
    const icon = cardsEl.querySelector<HTMLElement>(`.field-error[data-for="${id}"]`);
    if (icon) {
      icon.classList.toggle('shown', show);
      icon.dataset.tip = show ? (message ?? '') : '';
      icon.setAttribute('aria-label', show ? (message ?? '') : '');
      icon.tabIndex = show ? 0 : -1;
    }
  }
  for (const card of cards) {
    const dot = cardsEl.querySelector<HTMLElement>(`[data-dot="${card.id}"]`);
    if (dot) {
      dot.dataset.color = knownColor(card.project);
      // The name field already shows a leading emoji ("🔵 Work"): one circle is enough.
      dot.classList.toggle('covered', leadingEmoji(card.project) !== null);
    }
    const status = cardsEl.querySelector<HTMLElement>(`[data-status="${card.id}"]`);
    if (status) {
      const name = cleanTitle(card.project);
      status.textContent = !name ? '' : isOpenNow(name) ? 'Group open' : 'No group yet';
      status.title = !name
        ? ''
        : isOpenNow(name)
          ? 'A tab group with this name is open now.'
          : 'No tab group has this name now. The group is made the first time a matching tab opens.';
      status.classList.toggle('open', isOpenNow(name));
    }
  }
  const dirty = isDirty();
  saveBtn.disabled = !dirty || saving;
  discardBtn.disabled = !dirty || saving;
  saveBtn.querySelector('.label')!.textContent = saving ? 'Saving...' : 'Save changes';
  document.body.classList.toggle('dirty', dirty);
}

function renderSettings(): void {
  followEl.checked = settings.follow;
  duplicateEl.checked = settings.duplicateCheck;
  surfaceEl.value = settings.surface;
  const sideOption = surfaceEl.querySelector<HTMLOptionElement>('option[value="sidePanel"]');
  if (sideOption && typeof chrome.sidePanel?.setPanelBehavior !== 'function') {
    sideOption.disabled = true;
    sideOption.textContent = 'the side panel (this Brave does not support it)';
  }
}

async function renderSide(): Promise<void> {
  if (typeof chrome.sidePanel?.getLayout !== 'function') return;
  try {
    const layout = await chrome.sidePanel.getLayout();
    sideNow.textContent = `Brave shows the side panel together with its sidebar. Now it is on the ${layout.side}.`;
  } catch {
    // older Brave: keep the general sentence
  }
}

async function renderKeys(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const order = (name: string): number => {
    if (name === '_execute_action') return 0;
    if (name === 'open-project-row') return 1;
    const n = /^project-(\d)$/.exec(name);
    if (n) return 1 + Number(n[1]);
    return name === 'next-project' ? 20 : 21;
  };
  keyList.replaceChildren(
    ...commands
      .filter((c) => c.name)
      .sort((a, b) => order(a.name ?? '') - order(b.name ?? ''))
      .map((c) =>
        h(
          'li',
          null,
          h('span', null, c.name === '_execute_action' ? 'Toolbar button' : c.description || c.name),
          c.shortcut ? h('kbd', null, c.shortcut) : h('span', { class: 'unset' }, 'Not set'),
        ),
      ),
  );
}

// ---------------------------------------------------------------- drag to reorder projects

function onCardDragStart(e: DragEvent, card: ProjectCard): void {
  dragCardId = card.id;
  const el = cardsEl.querySelector<HTMLElement>(`[data-card="${card.id}"]`);
  if (e.dataTransfer && el) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.project);
    e.dataTransfer.setDragImage(el, 20, 20);
  }
  el?.classList.add('dragging');
}

function dropSide(e: DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function clearMarks(): void {
  for (const el of cardsEl.querySelectorAll('.drop-before, .drop-after, .dragging')) {
    el.classList.remove('drop-before', 'drop-after', 'dragging');
  }
}

function onCardDragOver(e: DragEvent, card: ProjectCard): void {
  if (dragCardId === null || dragCardId === card.id) return;
  e.preventDefault();
  for (const el of cardsEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  (e.currentTarget as HTMLElement).classList.add(dropSide(e) === 'before' ? 'drop-before' : 'drop-after');
}

function onCardDrop(e: DragEvent, card: ProjectCard): void {
  if (dragCardId === null) return;
  e.preventDefault();
  const moving = cards.find((c) => c.id === dragCardId);
  const side = dropSide(e);
  onCardDragEnd();
  if (!moving || moving === card) return;
  const rest = cards.filter((c) => c !== moving);
  const at = rest.indexOf(card) + (side === 'after' ? 1 : 0);
  rest.splice(at, 0, moving);
  cards = rest;
  renderCards();
}

function onCardDragEnd(): void {
  dragCardId = null;
  clearMarks();
}

// ---------------------------------------------------------------- save, discard, load

let savedTimer: ReturnType<typeof setTimeout> | undefined;

async function save(): Promise<void> {
  triedSave = true;
  const errors = validate();
  if (errors.size > 0) {
    refresh();
    const first = [...errors.keys()][0];
    document.querySelector<HTMLInputElement>(`input[data-field="${first}"]`)?.focus();
    return;
  }
  saving = true;
  refresh();
  try {
    const rules = rulesFromCards(cards);
    const next: Settings = { ...settings };
    await chrome.storage.local.set({ rules, settings: next });
    saved = { rules, settings: next };
    cards = cardsFromRules(rules); // drops empty rows and empty projects
    touched.clear();
    triedSave = false;
    savedEl.textContent = '✓ Saved';
    if (savedTimer !== undefined) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedEl.textContent = '';
    }, 3000);
  } finally {
    saving = false;
    renderCards();
  }
}

function discard(): void {
  cards = cardsFromRules(saved.rules);
  settings = { ...saved.settings };
  touched.clear();
  triedSave = false;
  renderSettings();
  renderCards();
}

async function loadGroups(): Promise<void> {
  const groups = await chrome.tabGroups.query({});
  openGroups = groups
    .filter((g) => cleanTitle(g.title ?? '') !== '')
    .map((g) => ({ title: g.title ?? '', color: isGroupColor(g.color) ? g.color : 'grey' }));
}

async function load(): Promise<void> {
  const [stored] = await Promise.all([chrome.storage.local.get(['rules', 'projects', 'settings']), loadGroups()]);
  saved = { rules: sanitizeRules(stored['rules']), settings: sanitizeSettings(stored['settings']) };
  projects = sanitizeProjects(stored['projects']);
  cards = cardsFromRules(saved.rules);
  settings = { ...saved.settings };
  renderSettings();
  renderCards();
  await Promise.all([renderKeys(), renderSide()]);
}

// ---------------------------------------------------------------- wiring

saveBtn.addEventListener('click', () => void save());
discardBtn.addEventListener('click', discard);
document.getElementById('add-project')?.addEventListener('click', () => {
  const card: ProjectCard = { id: newId(), project: '', rows: [{ id: newId(), host: '', enabled: true }] };
  cards.push(card);
  renderCards();
  document.querySelector<HTMLInputElement>(`input[data-field="name-${card.id}"]`)?.focus();
});
followEl.addEventListener('change', () => {
  settings = { ...settings, follow: followEl.checked };
  refresh();
});
duplicateEl.addEventListener('change', () => {
  settings = { ...settings, duplicateCheck: duplicateEl.checked };
  refresh();
});
surfaceEl.addEventListener('change', () => {
  settings = { ...settings, surface: surfaceEl.value as Surface };
  refresh();
});
document
  .getElementById('edit-keys')
  ?.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
for (const id of ['open-brave-settings', 'open-tab-settings']) {
  document.getElementById(id)?.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://settings/appearance' }));
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!saveBtn.disabled) void save();
  }
});
window.addEventListener('focus', () => {
  void renderKeys();
  void renderSide();
  void loadGroups().then(refresh);
});

// Unsaved changes: Brave asks before the tab closes or reloads.
window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['projects']) {
    projects = sanitizeProjects(changes['projects'].newValue);
    refresh();
  }
  if (changes['rules'] || changes['settings']) {
    const dirty = isDirty();
    if (changes['rules']) saved = { ...saved, rules: sanitizeRules(changes['rules'].newValue) };
    if (changes['settings']) saved = { ...saved, settings: sanitizeSettings(changes['settings'].newValue) };
    if (!dirty) discard(); // nothing typed here: show what is saved now
    else refresh();
  }
});

void load();
