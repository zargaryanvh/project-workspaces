/** The tab list the side panel shows under a project. */

/** A tab as the list sees it. */
export interface TabForList {
  id: number;
  groupId: number;
  index: number;
  active: boolean;
  title: string;
  url: string;
  windowId: number;
}

/** One row of a project's tab list. */
export interface TabRow {
  id: number;
  /** The owner's name for the tab, or '' to show the page title. */
  name: string;
  title: string;
  url: string;
  /** The tab the window shows. */
  active: boolean;
}

/** The tabs of one project in one window, in tab bar order. */
export function projectTabRows(
  tabs: readonly TabForList[],
  windowId: number,
  groupId: number,
  labels: ReadonlyMap<number, string>,
): TabRow[] {
  return tabs
    .filter((t) => t.windowId === windowId && t.groupId === groupId)
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ id: t.id, name: labels.get(t.id) ?? '', title: t.title, url: t.url, active: t.active }));
}

/** A web address without the scheme, ? and #, for small print: "mail.example.com/inbox". */
export function shortAddress(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

/** What a tab row says: the owner's name, else the page title, else the address. */
export function tabRowText(row: TabRow): string {
  return row.name || row.title || shortAddress(row.url) || 'New tab';
}

/** The rows with one tab moved right before another (or last, for null): the list shows it before the tab bar follows. */
export function moveTabRow(rows: readonly TabRow[], tabId: number, beforeTabId: number | null): TabRow[] {
  const moving = rows.find((r) => r.id === tabId);
  if (!moving) return [...rows];
  const rest = rows.filter((r) => r.id !== tabId);
  const at = beforeTabId === null ? rest.length : rest.findIndex((r) => r.id === beforeTabId);
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return rest;
}
