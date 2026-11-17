// Draws the toolbar and extension icons into src/icons/ (run once: npm run icons).
// The picture: folded projects as small labels on top, the open project below.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
mkdirSync(out, { recursive: true });

const BLUE = '#2F6BEA';
const ORANGE = '#FA903E';

const large = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <rect x="6" y="6" width="116" height="116" rx="28" fill="${BLUE}"/>
  <rect x="22" y="24" width="24" height="14" rx="7" fill="#fff" fill-opacity="0.55"/>
  <rect x="52" y="24" width="24" height="14" rx="7" fill="${ORANGE}"/>
  <rect x="82" y="24" width="24" height="14" rx="7" fill="#fff" fill-opacity="0.55"/>
  <rect x="22" y="48" width="84" height="56" rx="12" fill="#fff"/>
  <rect x="34" y="62" width="44" height="8" rx="4" fill="${BLUE}" fill-opacity="0.55"/>
  <rect x="34" y="78" width="60" height="8" rx="4" fill="${BLUE}" fill-opacity="0.3"/>
</svg>`;

const small = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="100%" height="100%">
  <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="${BLUE}"/>
  <rect x="3" y="3" width="4" height="2.2" rx="1.1" fill="${ORANGE}"/>
  <rect x="9" y="3" width="4" height="2.2" rx="1.1" fill="#fff" fill-opacity="0.6"/>
  <rect x="3" y="7" width="10" height="6" rx="1.6" fill="#fff"/>
</svg>`;

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:transparent;width:${size}px;height:${size}px">${size <= 16 ? small : large}</body></html>`,
    );
    await page.screenshot({ path: join(out, `icon${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('Icons written to src/icons/');
