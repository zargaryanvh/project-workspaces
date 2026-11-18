# Changelog

## Unreleased

- New: tab lists. The arrow next to a project shows its tabs under it, without opening the project. Click a tab to go there, drag it to change its order (the tab bar follows), ✕ to close it. Only the arrow opens or closes a list, and an open list stays open after a restart.
- New: your own tab names. ✎ on a tab in the list gives it a name, for example which account a mail tab is. The name stays with the tab while it browses that site, comes back after a restart, and shows on the warning page too. The tab bar keeps the page title. No new permission.
- When the extension does not answer, the message now says to reload it on the extensions page. That is what an update needs: the browser keeps running the old background part until the extension is reloaded.
- Settings page and README: how to put the list on the left (with pictures), and how to get a narrow project list with Brave's vertical tabs.
- A project name that starts with an emoji (like "🔵 Admin") shows it once, in the colour dot's place, instead of a dot and the emoji.
- One click selects a project, even when that click also gives the side panel focus. Before, the panel redrew its list on focus and the first click was lost. The "already open" page got the same protection.

## 0.2.0 (2026-11-18)

- The list now always has the tab bar's order. Drag a project by its grip to reorder it; the tab bar follows, and dragging a group in the tab bar moves it in the list.
- New: the project row, a row of project labels under the toolbar button, with its own shortcut.
- New: "already open" warning. Opening a project address in a new tab while that site is open offers to take you to the open tab.
- A window reopened with Ctrl+Shift+T (or after a restart) gets back the project that was open, on the tab used last. Before, the browser's first restored tab could pull the wrong project open.
- Settings page rebuilt: one card per project with any number of addresses, `*.` addresses for a domain and its subdomains, local addresses like `localhost:3000`, a dropdown of your groups, a save bar with Discard and Save changes, and a question before leaving with unsaved changes.
- Saving addresses also sorts matching tabs that are already open.
- The side panel works at narrow widths, and New project stays at the bottom while the list scrolls.
- A new install starts with no addresses.

## 0.1.0 (2026-11-18)

- First version: projects as tab groups, a project list in the side panel, switching that folds the other groups, Alt+1 to Alt+4 and more shortcuts, rules that send tabs to their project, recovery after a browser restart, and no network access.
