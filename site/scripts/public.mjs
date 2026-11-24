#!/usr/bin/env node
// Fills site/public/ (git-ignored) before `next build`: the files the pages use that live elsewhere in the repository,
// copied where they are, so one change to the product's icons or screenshots updates the site.
//   the icons (web/), the link picture (site/social/, made by scripts/link-picture.mjs), the brand files (assets/),
//   the demo's screenshots (docs/screenshots/), and the landing page's own story pictures (site/story/, made by
//   scripts/story-shots.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const OUT = path.join(SITE, 'public');

export function fillPublic({ root = ROOT, out = OUT } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
    fs.copyFileSync(path.join(root, from), path.join(out, to));
  };
  copy('web/favicon.ico', 'favicon.ico');
  copy('web/icon.svg', 'icon.svg');
  copy('web/apple-touch-icon.png', 'apple-touch-icon.png');
  // The picture a link shows: the site's own, made from the demo (scripts/link-picture.mjs), at today's address.
  copy('site/social/link.png', 'social-preview.png');
  for (const f of fs.readdirSync(path.join(root, 'assets'))) if (/\.(svg|png)$/.test(f)) copy(`assets/${f}`, `assets/${f}`);
  for (const f of fs.readdirSync(path.join(root, 'docs/screenshots'))) copy(`docs/screenshots/${f}`, `screenshots/${f}`);
  const story = path.join(root, 'site/story');
  if (fs.existsSync(story)) for (const f of fs.readdirSync(story)) if (/\.(webp|avif)$/.test(f)) copy(`site/story/${f}`, `story/${f}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`site: public files in ${path.relative(process.cwd(), fillPublic()) || '.'}`);
