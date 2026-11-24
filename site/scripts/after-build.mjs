#!/usr/bin/env node
// The step after `next build`: the files Next does not make, written into the exported folder from the same content
// layer the pages were made from (lib/pages.mjs, lib/seo.mjs), and every page's content security policy.
//
//   node scripts/after-build.mjs [--out <folder>]     (default: $SITE_NEXT_DIST, else out/)
//
//  - each page's Markdown twin at the same address with .md, and the bundled skill as it ships (/skill/SKILL.md);
//  - llms.txt, llms-full.txt, sitemap.xml, robots.txt, CNAME and .nojekyll;
//  - in every HTML file, first in its head, a policy that allows the site's own files and each inline script of that
//    page by its hash (Next writes its page data as inline scripts, different on every page), nothing from another
//    origin, no inline style and no eval.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPages, skillFiles } from '../lib/pages.mjs';
import { llmsFull, llmsTxt, robots, sitemap } from '../lib/seo.mjs';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE_DIR, '..');

/** The inline scripts a browser runs: no src, and JavaScript (a JSON-LD data block is not run, so it needs no hash). */
export function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\ssrc=/.test(m[1]) && !/\stype="(?!text\/javascript|module)[^"]*"/.test(m[1]))
    .map((m) => m[2]);
}

const hashOf = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** The policy of one page: its own files, and its inline scripts by their hashes. */
export function policyOf(html) {
  const hashes = [...new Set(inlineScripts(html).map(hashOf))];
  return ["default-src 'none'", `script-src 'self'${hashes.map((h) => ` ${h}`).join('')}`, "style-src 'self'", "img-src 'self'", "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"].join('; ');
}

/** The page with its policy as the first thing after its charset, before any script or style. */
export function withPolicy(html) {
  if (/http-equiv="Content-Security-Policy"/.test(html)) throw new Error('a page already has a content security policy');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyOf(html)}"/>`;
  const at = /<meta charSet="utf-8"\/?>/i.exec(html);
  if (!at) throw new Error('a page has no <meta charset> to put its policy after');
  return html.slice(0, at.index + at[0].length) + meta + html.slice(at.index + at[0].length);
}

const write = (out, rel, text) => {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/**
 * What the step writes besides the pages' HTML, from the content layer alone (no Next build needed, so the product's
 * own test job checks it too): { pages, files: Map(published path -> text or bytes) }.
 */
export async function siteFiles(root = ROOT) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const pages = await loadPages(root);
  const files = new Map();
  for (const p of pages) files.set(p.mdUrl.slice(1), p.twin);
  for (const f of skillFiles(root)) files.set(`skill/${f}`, fs.readFileSync(path.join(root, 'templates/skills/hoprig', f)));
  const listed = pages.filter((p) => p.url !== '/404.html');
  files.set('llms.txt', llmsTxt(listed, { version }));
  files.set('llms-full.txt', llmsFull(listed));
  files.set('sitemap.xml', sitemap(listed));
  files.set('robots.txt', robots());
  files.set('CNAME', 'hoprig.com\n');
  files.set('.nojekyll', '');
  return { pages, files };
}

export async function afterBuild({ root = ROOT, out }) {
  if (!out || !fs.existsSync(path.join(out, 'index.html'))) throw new Error(`no built site in ${out} (run next build first)`);
  const { pages, files } = await siteFiles(root);
  for (const [rel, body] of files) write(out, rel, body);
  // Next also writes the 404 page at /404/ and /_not-found/; GitHub Pages serves 404.html at every missing address, so
  // those two would only be addresses of today's site that answer 200 with a missing page.
  for (const dir of ['404', '_not-found']) fs.rmSync(path.join(out, dir), { recursive: true, force: true });
  const html = fs.readdirSync(out, { recursive: true }).map(String).filter((f) => f.endsWith('.html'));
  for (const f of html) fs.writeFileSync(path.join(out, f), withPolicy(fs.readFileSync(path.join(out, f), 'utf8')));
  return { out, pages: pages.map((p) => ({ url: p.url, mdUrl: p.mdUrl, kind: p.kind, title: p.title })), html: html.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(SITE_DIR, i > -1 ? process.argv[i + 1] : process.env.SITE_NEXT_DIST || 'out');
  afterBuild({ out }).then((r) => console.log(`site: ${r.pages.length} pages, their twins and llms.txt, and a policy in ${r.html} HTML files in ${path.relative(process.cwd(), r.out) || '.'}`), (e) => {
    console.error(`site: ${e.message}`);
    process.exit(1);
  });
}
