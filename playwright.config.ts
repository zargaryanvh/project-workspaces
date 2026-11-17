import { defineConfig } from '@playwright/test';

/**
 * unit:     the pure parts (rules, switch plan, list order). No browser.
 * chromium: loads dist/ into Playwright's Chromium and checks the real thing.
 * brave:    the same smoke test in the Brave installed on this computer, with a
 *           throwaway profile (never the owner's own profile).
 */
export default defineConfig({
  testDir: 'test',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 180_000,
  projects: [
    { name: 'unit', testMatch: /unit[\\/].*\.test\.ts$/ },
    { name: 'chromium', testMatch: /smoke[\\/].*\.spec\.ts$/, metadata: { browser: 'chromium' } },
    { name: 'brave', testMatch: /smoke[\\/].*\.spec\.ts$/, metadata: { browser: 'brave' } },
  ],
});
