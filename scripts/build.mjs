// Builds the extension into dist/: TypeScript to JavaScript, then the static files.
// Load dist/ in Brave: brave://extensions > Developer mode > Load unpacked.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
// DIST_DIR builds somewhere else (the tests use it too), so a dist/ loaded in your own browser is not touched.
const dist = process.env.DIST_DIR ? resolve(root, process.env.DIST_DIR) : join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', dist], { stdio: 'inherit', cwd: root });

for (const file of [
  'panel.html',
  'options.html',
  'already-open.html',
  'base.css',
  'panel.css',
  'options.css',
  'already-open.css',
]) {
  cpSync(join(src, file), join(dist, file));
}
const icons = join(src, 'icons');
if (!existsSync(icons)) throw new Error('src/icons is missing. Run: npm run icons');
cpSync(icons, join(dist, 'icons'), { recursive: true });

// The manifest takes its version from package.json, so there is one place to change it.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built Project workspaces ${pkg.version} into ${dist}`);
