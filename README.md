# Project workspaces

Workspaces for Brave and Chrome, built on tab groups. Each tab group is a project. Pick a project and its tabs open in the tab bar; the other groups fold into small labels.

![The project list in the side panel, in the same order as the tab bar](docs/side-panel.png)

Private by design: no network requests, no analytics, no code from outside. See [PRIVACY.md](PRIVACY.md).

## A quick tour

**Before:** every tab group is open, and the tab bar is full of tiny tabs.

![Before: every group open](docs/tour-before.png)

**After:** click **Mail** in the list (or press its key). Only Mail is open; the other projects wait as small labels. Click a label to switch.

![After: only Mail open, the other projects folded](docs/tour-after.png)

**Change a project** with **⋯**: colour, rename, move up or down, delete (deleting keeps every tab open). Drag the dots on the left to reorder; the tab bar follows. The list also fits a narrow panel.

<table>
  <tr>
    <td><img src="docs/tour-menu.png" width="320" alt="The project menu: colours, rename, move, delete"></td>
    <td><img src="docs/tour-narrow.png" width="150" alt="The list in a narrow side panel"></td>
  </tr>
</table>

**See a project's tabs** with the arrow next to it, without opening the project. Click a tab to go to it. Point at a tab for ✎, to give it a name of your own (for example, which account a mail tab is), and ✕, to close it. Drag tabs to change their order; the tab bar follows.

![The tabs of two projects under them, two of them with names of their own](docs/tab-list.png)

**The project row** opens under the toolbar button, for quick switching. Press 1 to 9 to open a project.

![The project row under the toolbar button](docs/project-row.png)

**Settings:** each project has its addresses. A tab that opens one of them moves to the project. The dropdown lists your groups, and a wrong address gets a red outline with a hint.

![Settings: projects and their addresses](docs/tour-settings.png)

**Already open:** open a project address in a new tab while that site is open, and the new tab offers to take you to the tab you have.

![The warning that a site is already open](docs/already-open.png)

## Features

- **Project list** in the side panel, in the same order as the tab bar. Drag a project by its grip to reorder it; the tab bar follows, and dragging a group in the tab bar moves it in the list.
- **One project at a time.** Opening a project folds the other groups. Opening a folded group or one of its tabs from the tab bar does the same. You can turn this off.
- **Tab lists:** the arrow next to a project shows its tabs under it, without opening the project. Click a tab to go there. Only the arrow opens or closes a list, and an open list stays open, also after a restart.
- **Your own tab names:** ✎ on a tab gives it a name for the list, like `Personal` and `Team` for two mail accounts. The name stays with the tab while it browses that site, and comes back after a restart. The warning page shows it too.
- **Keys:** Alt+1 to Alt+4 open projects 1 to 4. Project 5 to 9, Next project, Previous project and Open the project row can be set on the shortcuts page.
- **Project row:** a row of project labels under the toolbar button, for quick switching. Press 1 to 9 to open a project.
- **Addresses per project:** a tab that opens `app.example.com`, `*.example.com` or `localhost:3000` moves to its project. Saving new addresses also sorts matching tabs that are already open. A tab you put in a group yourself is never moved.
- **"Already open" warning:** open a project address in a new tab while that site is already open, and the new tab offers to take you to the tab you have (or open it anyway).
- **Reopened windows** (Ctrl+Shift+T) and browser restarts get back the project that was open, on the tab you used last.
- **Staging projects:** a name that starts with 🟠 gets the orange group colour.
- **Your own icons:** a name that starts with an emoji ("🔵 Admin", "🛒 Shopping") shows that emoji in the list instead of the colour dot.
- **Hands off your tabs:** it never reloads tabs or puts them to sleep. It closes a tab only when you ask: ✕ on a tab in the list, or "Close this tab" on the warning.
- **Works with Brave's vertical tabs:** each project becomes one row there, as narrow as you like.
- **Narrow project window:** the whole list in a small window of its own, attached to the side of its Brave window, narrower than the side panel can be (300 px to start, drag to change). Each Brave window has its own, and it stays attached: move, resize, maximize or minimize Brave and the list goes along. Switch back to the side panel at any time.
- **Light on the browser:** title and icon changes cost it almost nothing, saves are batched, and the side panel redraws only the rows that changed.

## Install

### From a release

1. Download `project-workspaces-x.y.z.zip` from [Releases](../../releases) and unzip it.
2. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.
4. Click the puzzle icon in the toolbar and pin **Project workspaces**.

### From source

```bash
npm ci
npm run build
```

Then load the `dist` folder as above. After a change, run `npm run build` again and click the reload arrow on the extension. Until you do, the browser keeps running the old background part, and the list may say the extension did not answer.

## How to use it

1. Put the tabs of each project in a tab group and give it a name, or select tabs and click **New project** at the bottom of the list.
2. Click the extension's button. The list opens in the side panel.
3. Click a project, or press its key. Its tabs show; the other groups fold.
4. Click **⋯** next to a project to rename it, change its colour, move it, or delete it. Deleting only removes the group; every tab stays open.
5. Click the arrow at the left of a project to see its tabs. Point at a tab: **✎** gives it a name of your own (leave the name empty to show the page title again), **✕** closes it. Drag a tab to move it inside its project.

## Settings

Click the gear at the top of the list.

![The settings page: projects and their addresses](docs/settings.png)

- **Projects and their addresses:** one card per project. Add as many addresses as you need. Without `*.`, only the exact address matches: `example.com` does not match `www.example.com`. With `*.`, the address and everything that ends with it match.
- **Already open:** turn the warning on or off. It only checks new tabs (typed addresses, bookmarks, links opened in a new tab, links from other apps). Links within one site and sign-in redirects are never warned.
- **Behaviour:** keep one project open, and choose what the toolbar button opens: the side panel, the project row, or the narrow project window.
- **Side panel: left or right:** the browser decides the side (see the next section).
- Changes are kept when you click **Save changes** in the bar at the top. The browser asks before you leave the page with unsaved changes.

## Put the list on the left

Brave shows the side panel together with its sidebar. Open `brave://settings/appearance`, go down to **Sidebar** and click **Show on the left**:

![Brave Settings, Sidebar: click Show on the left](docs/left-settings.png)

The project list is then on the left:

![The project list on the left side of Brave](docs/left-result.png)

In Chrome: Settings > Appearance > Side panel.

## A narrow project list: Brave's vertical tabs

Brave does not let the side panel get narrower than 400 px: the minimum is built into Brave (Chrome's is 360 px), and the browser holds every side panel to it, so no setting, flag or extension can make it narrower. For a narrow list, turn on Brave's vertical tabs: `brave://settings/appearance` > **Tabs** > **Use vertical tabs**. With this extension, each project is one row there, and only the open project shows its tabs. Drag the strip's edge to make it as narrow as you like (110 px works). Click a project row to open it; the others fold.

In the same place, **Show on the right** moves the strip to the right, and **Auto expand on hover when minimized** shrinks it to a thin bar that widens when you point at it.

![Brave's vertical tabs as a narrow project list: one row per project](docs/vertical-tabs.png)

## Or: a narrow project window

If you want the full list (tab lists, your tab names, the menu) but narrower than the side panel, use the narrow project window. It is the same list in a small window of its own, attached to the side of its Brave window, with no gap between them. Each Brave window has its own, with its own projects.

1. Open the settings (the gear at the top of the list).
2. Under **Behaviour**, set **The toolbar button opens** to **a narrow project window (beside Brave)**, and click **Save changes**.
3. Click the toolbar button (or press its key) in a Brave window. Its project window opens at 300 px, on the sidebar's side: beside a maximized Brave, the list takes a strip at the screen edge and Brave the rest. Click the button again to close it.

The two stay together:

- Drag the edge between them, and both change size as you drag. The list keeps its new width for next time.
- Move or resize Brave, or the list, and the other goes along, to another screen too.
- Maximize Brave, and the list takes its strip at the screen edge again.
- Minimize Brave, or bring it to the front from another app, and the list goes with it.

To go back, choose **the side panel** in the same place: the project windows close, and Brave gets its whole screen back (maximized again if it was).

![The narrow project window at the left edge of the screen, Brave beside it](docs/project-window.png)

## Limits set by the browser

- Extensions cannot hide tabs, so the other projects stay in the tab bar as small folded labels.
- Extension panels sit on the left or the right, not at the top or the bottom. The project row covers the top.
- The browser decides how narrow the side panel can get: 400 px in Brave, 360 px in Chrome, and a saved narrower width is ignored. The list fits any width: names end with "..." and the extras hide. For a narrower list, use Brave's vertical tabs or the narrow project window (see above).
- The narrow project window is a window of its own: Windows shows it in the taskbar and in Alt+Tab, and it follows Windows' light or dark setting. Brave tells extensions its size only now and then while you drag it, so when you drag Brave itself (its title bar, or its edge from inside Brave) the list catches up a moment later. Dragging the list's edge, or Brave's edge reached from the list, both move together. Between two screens with different scaling, the two can overlap by a few pixels.
- An extension may suggest only four keyboard shortcuts. Set the others yourself.
- Your tab names show in this extension's list and on its warning page. The tab bar keeps each page's own title: changing it there would mean running code inside every site you open.
- Tabs move only inside their own project in the list. To move a tab to another project, drag it in the tab bar.
- If the browser's Memory Saver is on, the browser may put tabs you have not used for a while to sleep.

## Browser support

Brave and Chrome, version 116 or newer (the side panel API). Tested in Brave 1.99 and Chromium 156 on Windows.

## Development

```bash
npm ci
npm run typecheck
npm test
npx playwright install chromium
npm run smoke
```

- `npm test` runs the unit tests for the pure parts in `src/lib/`.
- `npm run smoke` loads `dist/` into Chromium with a throwaway profile and drives the real side panel and its tab lists, the settings page, the project row, the warning page, Ctrl+Shift+T and a browser restart. It builds first.
- `npm run smoke:brave` runs the same tests in an installed Brave (set `BRAVE_PATH` if it is not in the usual place). It never touches your own profile.
- GitHub Actions run the type check, the unit tests and the Chromium smoke tests on every push. Pushing a tag like `v0.2.0` builds the extension and attaches a zip to a new release.

How the parts fit together: [docs/how-it-works.md](docs/how-it-works.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
