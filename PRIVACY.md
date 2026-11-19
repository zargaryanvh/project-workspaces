# Privacy

Project workspaces runs entirely in your browser. It never connects to the internet.

## What it reads

- **Tab addresses and titles**, to match your project addresses, to warn when a site is already open, and to show your tabs in the tab lists and on the warning page.
- **Tab groups** (name, colour, folded or open), because each group is a project.
- **Window positions and sizes**, only when you use the narrow project window, to keep it beside its Brave window.

## What it keeps

All of it in your browser profile, through the browser's own extension storage:

- your projects (group names and colours), your addresses and your settings;
- for each project, the tab you used last (its address), so switching back lands on it;
- for each window, which project was open, so a reopened window gets it back;
- the names you give tabs, each with two addresses (without the part after `?` or `#`) that find its tab again after a restart, and which projects have their tab list open;
- the width of the narrow project window;
- while the browser runs, a little bookkeeping about tabs and windows (for example, which tabs you placed in a group yourself, and which project window belongs to which Brave window). This is cleared when the browser closes.

Removing the extension removes all of it.

## What it sends

Nothing. There are no network requests, no analytics and no code loaded from outside:

- The extension's pages and its background worker run under a content security policy with `connect-src 'none'`, so the browser itself blocks any request.
- A unit test scans the source for anything that could reach the network (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, web addresses) and fails if it finds one.
- The smoke test checks in a real browser that a request from the extension's pages and from its worker is blocked.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | See tab addresses and titles, for the addresses and the warning. The browser may describe this as "read your browsing history". |
| `tabGroups` | Open, fold and move tab groups. |
| `storage` | Keep your projects, addresses and settings. |
| `sidePanel` | Show the project list in the side panel. |

No host permissions and no content scripts: the extension never runs code inside the pages you visit.
