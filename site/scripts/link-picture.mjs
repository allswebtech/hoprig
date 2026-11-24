#!/usr/bin/env node
// The picture a link to hoprig.com shows (Open Graph, X, chat apps): 1200×630, made from the built-in demo's Home
// (site/story/home-light.webp, which story-shots.mjs takes from `hoprig demo`) under the landing page's own headline.
// It says nothing the page does not: the name and the headline of site/content/index.md, the colours of the design
// system's light tokens. The local Chrome draws it (tools/chrome.mjs), headless, into site/social/link.png, which
// scripts/public.mjs serves at /social-preview.png.
//
//   node site/scripts/link-picture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontMatter } from '../lib/markdown.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
export const LINK_PICTURE = { file: 'social/link.png', width: 1200, height: 630 };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The light tokens of design/tokens.css (the first :root block), by name. */
export function lightTokens(css) {
  const block = /^:root \{([\s\S]*?)\n\}/m.exec(css)[1];
  const t = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  // A token made of another (--glow reads --accent) is written out, since the card is a page of its own.
  for (const k of Object.keys(t)) t[k] = t[k].replace(/var\(--([\w-]+)\)/g, (all, n) => t[n] ?? all);
  return t;
}

/** The words on the picture: the name and the landing page's headline, from the content. */
export function linkWords(root = ROOT) {
  const { data } = frontMatter(fs.readFileSync(path.join(root, 'site/content/index.md'), 'utf8'));
  return { name: 'Hoprig', title: data.title };
}

/** The page Chrome draws: the logo and name, the headline (its last clause after " is " in the accent, as on the
 * page), and the demo's Home in a window tipped back, cut by the picture's lower edge. */
export function cardHtml({ name, title, picture, logo, t }) {
  const i = title.lastIndexOf(' is ');
  const head = i === -1 ? esc(title) : `${esc(title.slice(0, i + 4))}<em>${esc(title.slice(i + 4))}</em>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:radial-gradient(60% 55% at 50% 0%,${t.glow || t['accent-soft']},transparent 70%),${t.bg};color:${t.text};font-family:${t.font};text-align:center}
.brand{display:inline-flex;align-items:center;gap:14px;margin-top:44px;font-weight:700;font-size:30px}
.brand img{width:46px;height:46px}
h1{margin:18px auto 0;max-width:1000px;font-size:54px;line-height:1.06;letter-spacing:-.035em;font-weight:750}
h1 em{font-style:normal;color:${t.accent}}
.stage{perspective:1800px;width:1000px;margin:34px auto 0}
.window{transform:rotateX(14deg);transform-origin:50% 100%;border-radius:22px;overflow:hidden;background:${t.surface};border:1px solid ${t.border};box-shadow:${t['shadow-2']}}
.chrome{display:flex;gap:7px;align-items:center;height:30px;padding:0 14px;background:${t['surface-3']};border-bottom:1px solid ${t.border}}
.chrome i{width:10px;height:10px;border-radius:99px;background:${t['border-strong']}}
.window img{display:block;width:100%}
</style></head><body><div class="brand"><img src="${logo}" alt="">${esc(name)}</div><h1>${head}</h1>
<div class="stage"><div class="window"><div class="chrome"><i></i><i></i><i></i></div><img src="${picture}" alt=""></div></div></body></html>`;
}

export function visibleText(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

export async function draw() {
  const t = lightTokens(fs.readFileSync(path.join(SITE, 'design/tokens.css'), 'utf8'));
  const data = (f, type) => `data:${type};base64,${fs.readFileSync(f).toString('base64')}`;
  const html = cardHtml({ ...linkWords(), t, picture: data(path.join(SITE, 'story/home-light.webp'), 'image/webp'), logo: data(path.join(ROOT, 'web/icon.svg'), 'image/svg+xml') });
  const { launchChrome } = await import(path.join(ROOT, 'tools/chrome.mjs'));
  const chrome = await launchChrome();
  try {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: LINK_PICTURE.width, height: LINK_PICTURE.height, deviceScaleFactor: 1, mobile: false });
    await chrome.goto('about:blank', 200);
    const { frameTree } = await chrome.send('Page.getFrameTree');
    await chrome.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await chrome.sleep(800);
    const png = await chrome.shot({ clip: { x: 0, y: 0, width: LINK_PICTURE.width, height: LINK_PICTURE.height } });
    fs.mkdirSync(path.join(SITE, 'social'), { recursive: true });
    fs.writeFileSync(path.join(SITE, LINK_PICTURE.file), png);
    console.log(`site: ${LINK_PICTURE.file}, ${png.length} B`);
  } finally {
    await chrome.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await draw();
}
