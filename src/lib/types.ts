/** Colours a Chromium tab group can have. */
export type GroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange';

export const GROUP_COLORS: readonly GroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

/** The group id Chromium gives a tab that is not in a group. */
export const NO_GROUP = -1;

/** A project the extension remembers. The list order is the array order. */
export interface StoredProject {
  title: string;
  color: GroupColor;
}

/** Sends a tab whose address has exactly this host to the project with this title. */
export interface Rule {
  id: string;
  host: string;
  project: string;
  enabled: boolean;
}

/** What the toolbar button opens: the side panel (left or right, as Brave's sidebar) or the project row at the top. */
export type Surface = 'sidePanel' | 'row';

export interface Settings {
  /**
   * Keep one project open: when a tab or a folded group of another project is
   * opened from the tab bar, the other groups fold.
   */
  follow: boolean;
  /** What the toolbar button opens. */
  surface: Surface;
  /** Warn when a project address is opened while that site is already open in another tab. */
  duplicateCheck: boolean;
}

/** The tab last used in a project, so switching back lands on it. */
export interface LastActive {
  tabId: number;
  url: string;
}

/**
 * A name the owner gave a tab. The project list shows it instead of the page
 * title; the tab bar keeps the title. Tab ids change after a restart, so the
 * name is found again by address.
 */
export interface TabName {
  /** Opaque and permanent. */
  id: string;
  name: string;
  /** Where the tab got its name (no ? or #). A tab that opens it later gets the name back. */
  home: string;
  /** The address the named tab showed last (no ? or #). Finds the tab again after a restart. */
  last: string;
  /** When the name was given or last found a tab (ms). When the list is full, the oldest unused name goes. */
  seen: number;
}

/** Everything kept in chrome.storage.local. */
export interface LocalState {
  projects: StoredProject[];
  rules: Rule[];
  /** Keyed by projectKey(title). */
  lastActive: Record<string, LastActive>;
  /**
   * The project that was open in a window, keyed by that window's set of
   * project names (see windowSignature). Brings it back after Ctrl+Shift+T.
   */
  openProjects: Record<string, string>;
  settings: Settings;
  /** Names the owner gave tabs. */
  tabNames: TabName[];
  /** Projects whose tab list is open in the side panel, by projectKey(title). Only the arrow changes this. */
  expanded: string[];
}

/** A tab group as the pure helpers see it. */
export interface GroupInfo {
  id: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  windowId: number;
}

/** A tab as the pure helpers see it. */
export interface TabInfo {
  id: number;
  groupId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  url: string;
  windowId: number;
}
