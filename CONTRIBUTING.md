# Contributing

Thanks for helping. A few things keep this extension what it is.

## Principles

- **No network, ever.** No requests, no analytics, no remote code. The content security policy blocks connections, and `test/unit/privacy.test.ts` fails on anything that could reach the network.
- **Few permissions.** Only `tabs`, `tabGroups`, `storage` and `sidePanel`. A change that needs more needs a very good reason.
- **Hands off the user's tabs.** Never close, reload or discard a tab on the extension's own initiative.
- **Logic in pure helpers.** Decisions live in `src/lib/` as pure functions with unit tests. The background worker reads the browser, asks a helper, then acts.
- **Light on the browser.** It runs all day next to every tab. Busy events (titles, icons, loading) must stay nearly free, saves are batched, and the side panel redraws only what changed. See "Staying light" in [docs/how-it-works.md](docs/how-it-works.md).
- **Plain words in the interface.** Short sentences that a non-native English reader understands, and no em dashes.

## Working on it

```bash
npm ci
npm run build        # TypeScript to dist/, then load dist/ as an unpacked extension
npm run typecheck
npm test             # unit tests, no browser
npx playwright install chromium
npm run smoke        # the real extension in Chromium, throwaway profile
```

Run `npm run smoke:brave` too if you have Brave installed.

If you load `dist/` in the browser you use every day, build and test somewhere else, so your own copy is not changed under it: `DIST_DIR=.tmp/dist-dev` works for `node scripts/build.mjs` and for the smoke tests.

The narrow project window has a part the headless tests cannot see: Windows' invisible window borders, focus and minimizing. After changing `src/projectWindow.ts` or `src/lib/dock.ts`, try it on a real screen (on Windows, at 100 % and at another scale if you have one): no gap between the list and Brave, the pair follows a move or a maximize, and minimizing or bringing one to the front takes the other along.

When you change how something behaves, add or change a unit test for the helper and, if it is visible in the browser, a step in the smoke test (`test/smoke/`).

## Releases

1. Update the version in `package.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag: `git tag v0.3.0` and `git push origin v0.3.0`.
3. GitHub Actions build the extension and attach `project-workspaces-0.3.0.zip` to a new release.
