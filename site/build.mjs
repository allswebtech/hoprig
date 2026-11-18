#!/usr/bin/env node
// Builds hoprig.com into site/dist (or --out <folder>): plain Node, no install needed.
//
//   node site/build.mjs [--out <folder>]
//
// Pages come from site/content, the product's docs/*.md and README sections (lib/sources.mjs), and the code
// itself (/tools/, lib/reference.mjs). Every page is written twice: as HTML at its address and as Markdown at the same
// address with .md. Then llms.txt, llms-full.txt, sitemap.xml, robots.txt, CNAME and the files the pages use.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml as esc, makeSlugger, plainText, renderMarkdown } from './lib/markdown.mjs';
import { toolsPage } from './lib/reference.mjs';
import { INSTALL, PLATFORMS, jsonLd, llmsFull, llmsTxt, robots, sitemap } from './lib/seo.mjs';
import { REPO, SITE, collect, describe } from './lib/sources.mjs';
import { imageSize } from './lib/images.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const NAV = [['/use-cases/', 'Use cases'], ['/docs/', 'Docs'], ['/compare/', 'Compare'], ['/tools/', 'Tools'], ['/changelog/', 'Changelog']];
const DOC_GROUPS = [
  ['Start', ['install', 'chat', 'usage-limits']],
  ['Your setup', ['workspace', 'computer-setup', 'skills']],
  ['Several computers', ['computers', 'public-link', 'hub']],
  ['More', ['work', 'automations', 'tia', 'commands']],
  ['Trust', ['security', 'is-this-allowed', 'where-it-runs', 'not-proven-yet']],
];

// Shorter names for the docs menu than the pages' own titles.
const SIDE_LABELS = { install: 'Install', work: 'Work: tasks and Do it', workspace: 'Workspace and AI brain', 'computer-setup': 'Computer setup', computers: 'Several computers', hub: 'A hub on a server' };

export const mdUrlOf = (url) => (url === '/' ? '/index.md' : url.endsWith('.html') ? url.replace(/\.html$/, '.md') : `${url.replace(/\/$/, '')}.md`);
const fileOf = (out, url) => path.join(out, url.endsWith('/') ? `${url}index.html` : url);

/** The dashboard's icons (web/icons.js), as inline SVG. */
function icons(root) {
  const src = fs.readFileSync(path.join(root, 'web/icons.js'), 'utf8');
  const map = {};
  for (const m of src.matchAll(/^\s{2}(\w+): \[(.*)\],$/gm)) map[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  map.menu = ['M4 7h16', 'M4 12h16', 'M4 17h16'];
  return (name, cls = '') => `<svg class="i-${name}${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${map[name].map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

const installBox = () => `<div class="install"><code>${esc(INSTALL)}</code><button class="copy" type="button" data-copy="${esc(INSTALL)}">Copy</button></div>`;

/** `<!-- name -->` on a line of its own: a part the generator fills, as HTML and as Markdown. */
function components(page, ctx) {
  const usecases = ctx.pages.filter((p) => p.kind === 'usecase').sort((a, b) => a.data.order - b.data.order);
  return {
    install: { html: installBox(), md: `\`\`\`sh\n${INSTALL}\n\`\`\`` },
    usecases: {
      html: `<div class="cards">${usecases.map((p) => `<a class="card" href="${p.url}"><p class="who">${esc(p.data.who || '')}${p.data.coming ? ' <span class="badge">Coming</span>' : ''}</p><h3>${esc(p.title)}</h3><p>${esc(p.data.short || '')}</p></a>`).join('')}</div>`,
      md: usecases.map((p) => `- [${p.title}](${p.url})${p.data.coming ? ' (coming)' : ''}: ${p.data.short || ''}`).join('\n'),
    },
    docs: {
      html: docGroups(ctx.pages).map(([g, list]) => `<h2>${esc(g)}</h2><ul class="doclist">${list.map((p) => `<li><a href="${p.url}"><strong>${esc(p.title)}</strong><span>${esc(p.description)}</span></a></li>`).join('')}</ul>`).join(''),
      md: docGroups(ctx.pages).map(([g, list]) => `## ${g}\n\n${list.map((p) => `- [${p.title}](${p.url}): ${p.description}`).join('\n')}`).join('\n\n'),
    },
    'skill-text': (() => {
      const text = fs.readFileSync(path.join(ctx.root, 'templates/skills/hoprig/SKILL.md'), 'utf8').trim();
      return { html: `<pre><code class="language-markdown">${esc(text)}</code></pre>`, md: `~~~~markdown\n${text}\n~~~~` };
    })(),
  };
}

function docGroups(pages) {
  const docs = pages.filter((p) => p.kind === 'doc');
  const placed = new Set(DOC_GROUPS.flatMap(([, s]) => s));
  const groups = DOC_GROUPS.map(([g, slugs]) => [g, slugs.map((s) => docs.find((p) => p.url === `/docs/${s}/`)).filter(Boolean)]);
  const rest = docs.filter((p) => !placed.has(p.url.split('/')[2]));
  if (rest.length) groups.find(([g]) => g === 'More')[1].push(...rest);
  return groups.filter(([, l]) => l.length);
}

/** The page's Markdown with the generator's parts filled in, as HTML placeholders and as plain Markdown. */
function expand(page, ctx) {
  const parts = components(page, ctx);
  const held = [];
  const forHtml = page.markdown.replace(/^<!--[ \t]*([\w-]+)[ \t]*-->[ \t]*$/gm, (all, name) => {
    if (!parts[name]) return all;
    held.push(parts[name].html);
    return `@@PART${held.length - 1}@@`;
  });
  const forMd = page.markdown
    .replace(/^<!--[ \t]*([\w-]+)[ \t]*-->[ \t]*$/gm, (all, name) => (parts[name] ? parts[name].md : all))
    .replace(/^:::.*\n/gm, '')
    .replace(/(!?\[[^\]]*\]\()([^)\s]+)/g, (_, a, href) => a + page.link(href))
    .replace(/\b(src|href)="([^"]*)"/g, (_, a, v) => `${a}="${page.link(v)}"`);
  return { forHtml, held, forMd };
}

/**
 * Width and height on every local image (no layout shift), lazy loading for all but the first. A screenshot is a link
 * to its full-size file with a visible hint (on a phone it is shown a few hundred pixels wide), and where the product
 * has a phone version of it (…-desktop-… and …-phone-…), a narrow screen gets that one.
 */
function sizeImages(html, out, { eager = false } = {}) {
  let n = 0;
  const sized = (src, attrs) => {
    const size = imageSize(path.join(out, src.split('?')[0]));
    let a = attrs;
    if (size) {
      const w = /\bwidth="(\d+)"/.exec(a);
      if (w && !/\bheight=/.test(a)) a += ` height="${Math.round((Number(w[1]) * size.height) / size.width)}"`;
      else if (!w) a += ` width="${size.width}" height="${size.height}"`;
    }
    return a;
  };
  return html.replace(/(<a\b[^>]*>\s*)?<img\b([^>]*)>/g, (all, link, attrs) => {
    const src = /\bsrc="(\/[^"]+)"/.exec(attrs);
    if (!src) return all;
    const img = `<img${sized(src[1], attrs)}${n++ === 0 && eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
    if (link || !src[1].startsWith('/screenshots/')) return `${link || ''}${img}`;
    const phone = src[1].replace(/-desktop-/, '-phone-');
    const source = phone !== src[1] && fs.existsSync(path.join(out, phone))
      ? `<source media="(max-width: 600px)" srcset="${phone}"${sized(phone, '')}>` : '';
    const picture = source ? `<picture>${source}${img}</picture>` : img;
    return `<a class="shot-link" href="${src[1]}">${picture}<span class="enlarge"><span class="on-narrow">Tap to enlarge</span><span class="on-wide">Open full size</span></span></a>`;
  });
}

function mainHtml(page, body, ctx) {
  const usecases = ctx.pages.filter((p) => p.kind === 'usecase').sort((a, b) => a.data.order - b.data.order);
  if (page.url === '/') {
    const d = page.data;
    const hero = `<section class="hero"><div class="wrap">
<p class="kicker">${esc(d.kicker)}</p>
<h1>${esc(page.title)}</h1>
<p class="lead">${esc(d.lead)}</p>
${installBox()}
<p class="under">${d.under}</p>
<div class="actions"><a class="btn btn-primary" href="#who-it-is-for">Who it is for</a><a class="btn btn-quiet" href="/docs/install/">How the install works</a></div>
<div class="hero-shot"><img src="/screenshots/hero.webp" alt="${esc(d.heroAlt)}"></div>
</div></section>`;
    // Each "## " part of the home page is a band of its own.
    // What comes before the first band (the title, the first lines, the install line) is the hero's, above.
    const bands = body.split(/(?=<h2 id=)/).filter((b) => b.trim() && !b.startsWith('<h1'));
    return hero + bands.map((b, i) => `<section class="section${i % 2 ? '' : ' section-alt'}"><div class="wrap prose">${b}</div></section>`).join('\n');
  }
  if (page.kind === 'doc' || page.url === '/docs/') {
    // One menu, twice: a list beside the text on a wide screen, a closed "All docs" on a phone (open, it would push the
    // text a screen down).
    const links = `<a href="/docs/"${page.url === '/docs/' ? ' aria-current="page"' : ''}>Overview</a>${docGroups(ctx.pages).map(([g, l]) => `<span class="group">${esc(g)}</span>${l.map((p) => `<a href="${p.url}"${p.url === page.url ? ' aria-current="page"' : ''}>${esc(SIDE_LABELS[p.url.split('/')[2]] || p.title)}</a>`).join('')}`).join('')}`;
    const side = `<aside class="side"><nav class="side-wide" aria-label="Docs">${links}</nav><details class="side-narrow"><summary>All docs</summary><nav aria-label="Docs">${links}</nav></details></aside>`;
    const crumbs = page.url === '/docs/' ? '' : '<p class="crumbs"><a href="/docs/">Docs</a></p>';
    return `<div class="wrap page"><div class="docs-layout">${side}<article class="prose">${crumbs}${body}</article></div></div>`;
  }
  if (page.kind === 'usecase') {
    const i = usecases.indexOf(page);
    const prev = usecases[i - 1];
    const next = usecases[i + 1];
    const badge = page.data.coming ? '<p><span class="badge">Coming: not built yet</span></p>' : '';
    // The first paragraph after the question is the direct answer.
    const article = body.replace(/(<\/h1>\n)<p>/, '$1<p class="answer">');
    const cta = page.data.coming ? '' : `<section class="page-cta"><h2>Try it</h2>${installBox()}<p class="muted cta-note">${esc(PLATFORMS)} Just looking? <code>hoprig demo</code> opens the dashboard with sample data.</p></section>`;
    const pager = `<nav class="pager" aria-label="Other use cases">${prev ? `<a href="${prev.url}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${next.url}"><span>Next</span>${esc(next.title)}</a>` : ''}</nav>`;
    return `<div class="wrap page"><p class="crumbs"><a href="/use-cases/">Use cases</a></p><article class="prose">${badge}${article}</article>${cta}${pager}</div>`;
  }
  const crumb = page.kind === 'compare' ? '<p class="crumbs"><a href="/compare/">Compare</a></p>' : '';
  return `<div class="wrap page">${crumb}<article class="prose">${body}</article></div>`;
}

function copyAssets(root, out) {
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
    fs.copyFileSync(path.join(root, from), path.join(out, to));
  };
  for (const f of fs.readdirSync(path.join(root, 'docs/screenshots'))) copy(`docs/screenshots/${f}`, `screenshots/${f}`);
  for (const f of fs.readdirSync(path.join(root, 'assets'))) if (/\.(svg|png)$/.test(f)) copy(`assets/${f}`, `assets/${f}`);
  copy('assets/social-preview.png', 'social-preview.png');
  copy('web/favicon.ico', 'favicon.ico');
  copy('web/icon.svg', 'icon.svg');
  copy('web/apple-touch-icon.png', 'apple-touch-icon.png');
  // The site's colours, radii, shadows and fonts are the dashboard's: its token block, then the site's own rules.
  const product = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
  const end = product.indexOf('/* ---------- base');
  if (end === -1) throw new Error('web/style.css has no "/* ---------- base" marker after its tokens');
  const css = `${product.slice(0, end).trim()}\n\n${fs.readFileSync(path.join(root, 'site/style.css'), 'utf8')}`;
  fs.writeFileSync(path.join(out, 'style.css'), css);
  const js = fs.readFileSync(path.join(root, 'site/site.js'), 'utf8');
  fs.writeFileSync(path.join(out, 'site.js'), js);
  return createHash('sha256').update(css).update(js).digest('hex').slice(0, 10);
}

// A search result shows about 60 characters: " · Hoprig" goes where it would cut the page's own title (a use case's
// question is kept whole).
export function pageTitle(page) {
  if (page.url === '/') return `Hoprig: ${page.title.replace(/\.$/, '')}`;
  const full = `${page.title} · Hoprig`;
  return full.length > 60 ? page.title : full;
}

/** The pages' policy: the site's own files, and the one inline script (the theme, before the first paint) by its hash. */
export function contentSecurityPolicy(template) {
  const inline = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return ["default-src 'none'", `script-src 'self' ${inline.join(' ')}`, "style-src 'self'", "img-src 'self'", "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"].join('; ');
}

export async function build({ root = ROOT, out = path.join(ROOT, 'site/dist') } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const assetVersion = copyAssets(root, out);
  const icon = icons(root);
  const logo = fs.readFileSync(path.join(root, 'assets/logo-mark.svg'), 'utf8').replace(/<title>[\s\S]*?<\/title>/, '').replace(/\s*role="img"\s*aria-label="[^"]*"/, ' aria-hidden="true"').replace(/\n\s*/g, '');
  const template = fs.readFileSync(path.join(root, 'site/template.html'), 'utf8');
  const csp = contentSecurityPolicy(template);

  // The docs in the order of their menu, everywhere they are listed.
  const menu = DOC_GROUPS.flatMap(([, slugs]) => slugs);
  const rank = (p) => (p.kind === 'doc' ? (menu.indexOf(p.url.split('/')[2]) + 1 || 99) : 0);
  const pages = collect(root).sort((a, b) => rank(a) - rank(b));
  const tools = await toolsPage(root);
  pages.push({ url: '/tools/', file: 'bin/hoprig.mjs', kind: 'tools', data: { title: 'Tools: the commands and Tia\'s tools', description: 'Every Hoprig command, the ones that answer in JSON, and the tools of Tia, the assistant, with their confirmation levels. Made from the code at every build.' }, markdown: tools.markdown, link: (h) => h });

  // Titles and descriptions first: the parts (cards, docs lists) of other pages use them.
  for (const p of pages) {
    const h1 = /^#\s+(.*)$/m.exec(p.markdown);
    p.title = p.data.title || (h1 ? plainText(h1[1]) : 'Hoprig');
    p.description = p.data.description || describe(p.markdown);
    p.answer = p.data.answer || describe(p.markdown, 600); // the direct answer in full, for llms.txt and schema.org
    p.mdUrl = mdUrlOf(p.url);
  }
  const ctx = { root, pages };
  const nav = (page) => NAV.map(([href, label]) => `<a href="${href}"${page.url.startsWith(href) ? ' aria-current="page"' : ''}>${label}</a>`).join('');

  for (const page of pages) {
    const { forHtml, held, forMd } = expand(page, ctx);
    // The site's own pages mark a list of alternatives themselves; the product's docs are judged by content alone.
    const copy = page.file.startsWith('site/content/') ? 'site' : 'one';
    const { html } = renderMarkdown(forHtml, { link: page.link, slug: makeSlugger(), copy });
    const body = html.replace(/<p>@@PART(\d+)@@<\/p>/g, (_, n) => held[Number(n)]);
    page.twin = `${forMd.trim()}\n\n---\n\nThis page on the web: ${SITE}${page.url === '/404.html' ? '/' : page.url} · Every page: ${SITE}/llms.txt\n`;
    const editLink = page.kind === 'tools'
      ? `This page is made at every build from <a href="${REPO}/blob/main/bin/hoprig.mjs">bin/hoprig.mjs</a>, the commands' help texts and <a href="${REPO}/blob/main/src/assistant/tools.mjs">src/assistant/tools.mjs</a>.`
      : `<a href="${REPO}/edit/main/${page.file}">Edit this page on GitHub</a> (${esc(page.file)}).`;
    const missing = page.url === '/404.html';
    const fill = {
      title: esc(pageTitle(page)),
      csp,
      ogTitle: esc(page.title),
      description: esc(page.description),
      // The 404 page is served at every missing address: not indexed, no canonical address, no schema.org data.
      indexing: missing ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${SITE}${page.url}">`,
      ogUrl: missing ? '' : `<meta property="og:url" content="${SITE}${page.url}">\n`,
      mdUrl: page.mdUrl,
      jsonLd: missing ? '' : `<script type="application/ld+json">${jsonLd(page, { version })}</script>\n`,
      kind: page.url === '/' ? 'home' : page.kind,
      logo,
      nav: nav(page),
      iconSun: icon('sun'),
      iconMoon: icon('moon'),
      iconGit: icon('git'),
      iconMenu: icon('menu'),
      editLink,
      assetVersion,
      main: sizeImages(mainHtml(page, body, ctx), out, { eager: page.url === '/' }),
    };
    const htmlPage = template.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in fill ? fill[k] : all));
    const file = fileOf(out, page.url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, htmlPage);
    fs.writeFileSync(path.join(out, page.mdUrl), page.twin);
  }

  const listed = pages.filter((p) => p.url !== '/404.html');
  fs.writeFileSync(path.join(out, 'llms.txt'), llmsTxt(listed, { version }));
  fs.writeFileSync(path.join(out, 'llms-full.txt'), llmsFull(listed));
  fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemap(listed));
  fs.writeFileSync(path.join(out, 'robots.txt'), robots());
  fs.writeFileSync(path.join(out, 'CNAME'), 'hoprig.com\n');
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return { out, pages: pages.map((p) => ({ url: p.url, mdUrl: p.mdUrl, kind: p.kind, title: p.title })), commands: tools.commands };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
  build({ out }).then((r) => console.log(`site: ${r.pages.length} pages in ${path.relative(process.cwd(), r.out) || '.'}`), (e) => {
    console.error(`site: ${e.message}`);
    process.exit(1);
  });
}
