# Changelog

## Unreleased

- New: tab lists. The arrow next to a project shows its tabs under it, without opening the project. Click a tab to go there, drag it to change its order (the tab bar follows), ✕ to close it. Only the arrow opens or closes a list, and an open list stays open after a restart.
- New: your own tab names. ✎ on a tab in the list gives it a name, for example which account a mail tab is. The name stays with the tab while it browses that site, comes back after a restart, and shows on the warning page too. The tab bar keeps the page title. No new permission.
- New: the narrow project window. Choose it in the settings ("The toolbar button opens"), and the toolbar button opens the project list in a small window of its own, attached to the side of its Brave window. It can be narrower than the side panel (300 px to start; drag its edge and it keeps the width). Each Brave window has its own, with its own projects; the toolbar button opens and closes it. The two stay together with no gap between them: drag the edge between them and both change size as you drag; move, resize, maximize or minimize Brave, or bring it to the front, and the list goes along (and the other way round). Choosing the side panel again closes them and gives Brave its screen back.
- Lighter on the browser. The side panel no longer reads every tab again on small changes (a new title, another active tab, a group folding): it updates what it has and redraws only the rows that changed. The background part ignores title and icon updates before doing any work, skips saves that would write the same data again, and handles a quick run of tab switches once.
- The tab name field shows its hint in an i inside the field, on hover, instead of small print under it.
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
