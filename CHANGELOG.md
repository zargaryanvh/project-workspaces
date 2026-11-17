# Changelog

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
