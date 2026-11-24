// Every page of hoprig.com as data, read at build time: by the Next pages (app/) for their HTML, and by the step after
// the Next build (scripts/after-build.mjs) for the Markdown twins, llms.txt, llms-full.txt and the sitemap. One place
// decides a page's address, title, description, body and twin, so the HTML and the Markdown cannot say different things.
//
// Pages come from site/content, the product's docs/*.md and README sections (sources.mjs), and the code itself
// (/tools/, reference.mjs). A content file's `<!-- name -->` line is a part the site fills: the install line, the
// use-case cards, the docs list, the skill's text.
import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from './images.mjs';
import { escapeHtml as esc, makeSlugger, plainText, renderMarkdown } from './markdown.mjs';
import { toolsPage } from './reference.mjs';
import { INSTALL } from './seo.mjs';
import { REPO, SITE, collect, describe } from './sources.mjs';

export const NAV = [['/use-cases/', 'Use cases'], ['/docs/', 'Docs'], ['/compare/', 'Compare'], ['/tools/', 'Tools'], ['/changelog/', 'Changelog']];
export const DOC_GROUPS = [
  ['Start', ['install', 'chat', 'usage-limits']],
  ['Your setup', ['workspace', 'computer-setup', 'skills']],
  ['Several computers', ['computers', 'public-link', 'hub']],
  ['More', ['work', 'automations', 'tia', 'commands']],
  ['Trust', ['security', 'is-this-allowed', 'where-it-runs', 'not-proven-yet']],
];

// Shorter names for the docs menu than the pages' own titles.
export const SIDE_LABELS = { install: 'Install', work: 'Work: tasks and Do it', workspace: 'Workspace and AI brain', 'computer-setup': 'Computer setup', computers: 'Several computers', hub: 'A hub on a server' };

export const mdUrlOf = (url) => (url === '/' ? '/index.md' : url.endsWith('.html') ? url.replace(/\.html$/, '.md') : `${url.replace(/\/$/, '')}.md`);

// A search result shows about 60 characters: " · Hoprig" goes where it would cut the page's own title (a use case's
// question is kept whole).
export function pageTitle(page) {
  if (page.url === '/') return `Hoprig: ${page.title.replace(/\.$/, '')}`;
  const full = `${page.title} · Hoprig`;
  return full.length > 60 ? page.title : full;
}

/** The docs in their menu's groups: [[group, [page…]]]; a doc no group names goes under "More". */
export function docGroups(pages) {
  const docs = pages.filter((p) => p.kind === 'doc');
  const placed = new Set(DOC_GROUPS.flatMap(([, s]) => s));
  const groups = DOC_GROUPS.map(([g, slugs]) => [g, slugs.map((s) => docs.find((p) => p.url === `/docs/${s}/`)).filter(Boolean)]);
  const rest = docs.filter((p) => !placed.has(p.url.split('/')[2]));
  if (rest.length) groups.find(([g]) => g === 'More')[1].push(...rest);
  return groups.filter(([, l]) => l.length);
}

export const useCasesOf = (pages) => pages.filter((p) => p.kind === 'usecase').sort((a, b) => a.data.order - b.data.order);

export const installHtml = () => `<div class="install"><code>${esc(INSTALL)}</code><button class="btn btn-primary btn-small copy" type="button" data-copy="${esc(INSTALL)}">Copy</button></div>`;

/** `<!-- name -->` on a line of its own: a part the site fills, as HTML and as Markdown. */
function parts(ctx) {
  const usecases = useCasesOf(ctx.pages);
  return {
    install: { html: installHtml(), md: `\`\`\`sh\n${INSTALL}\n\`\`\`` },
    usecases: {
      html: `<div class="cards">${usecases.map((p) => `<a class="card" href="${p.url}"><p class="who">${esc(p.data.who || '')}${p.data.coming ? ' <span class="badge">Coming</span>' : ''}</p><h2>${esc(p.title)}</h2><p>${esc(p.data.short || '')}</p></a>`).join('')}</div>`,
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

/** The page's Markdown with its parts filled in: placeholders for the HTML, plain Markdown for the twin. */
function expand(page, ctx) {
  const all = parts(ctx);
  const held = [];
  const forHtml = page.markdown.replace(/^<!--[ \t]*([\w-]+)[ \t]*-->[ \t]*$/gm, (line, name) => {
    if (!all[name]) return line;
    held.push({ name, html: all[name].html });
    return `@@PART${held.length - 1}@@`;
  });
  const forMd = page.markdown
    .replace(/^<!--[ \t]*([\w-]+)[ \t]*-->[ \t]*$/gm, (line, name) => (all[name] ? all[name].md : line))
    .replace(/^:::.*\n/gm, '')
    .replace(/(!?\[[^\]]*\]\()([^)\s]+)/g, (_, a, href) => a + page.link(href))
    .replace(/\b(src|href)="([^"]*)"/g, (_, a, v) => `${a}="${page.link(v)}"`);
  return { forHtml, held, forMd };
}

/** Where a picture of the site comes from in the repository: /screenshots/ is docs/screenshots/, /assets/ is assets/. */
export function sourceOf(root, src) {
  const p = src.split('?')[0];
  if (p.startsWith('/screenshots/')) return path.join(root, 'docs/screenshots', p.slice('/screenshots/'.length));
  if (p.startsWith('/story/')) return path.join(root, 'site/story', p.slice('/story/'.length));
  return path.join(root, p.startsWith('/assets/') ? p.slice(1) : path.join('web', p.slice(1)));
}

/** A list item that is only a link (a list of places to go) is marked, so a phone gets it as a full-height target. A
 * link inside a sentence is left as it is. */
export const linkItems = (html) => html.replace(/<li>(<a href="[^"]*">[^<]*<\/a>)<\/li>/g, '<li class="link-item">$1</li>');

/**
 * Width and height on every local image (no layout shift), lazy loading for all but the first. A screenshot is a link
 * to its full-size file with a visible hint (on a phone it is shown a few hundred pixels wide), and where the product
 * has a phone version of it (…-desktop-… and …-phone-…), a narrow screen gets that one.
 */
export function sizeImages(html, fileOf, { eager = false } = {}) {
  let n = 0;
  const sized = (src, attrs) => {
    const size = imageSize(fileOf(src));
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
    const source = phone !== src[1] && fs.existsSync(fileOf(phone))
      ? `<source media="(max-width: 600px)" srcset="${phone}"${sized(phone, '')}>` : '';
    const picture = source ? `<picture>${source}${img}</picture>` : img;
    return `<a class="shot-link" href="${src[1]}">${picture}<span class="enlarge"><span class="on-narrow">Tap to enlarge</span><span class="on-wide">Open full size</span></span></a>`;
  });
}

/**
 * Every page, in the docs menu's order, as { url, mdUrl, file, kind, data, title, description, answer, markdown, link,
 * body (HTML with its parts filled), twin (the Markdown at the same address with .md) }.
 */
export async function loadPages(root) {
  const menu = DOC_GROUPS.flatMap(([, slugs]) => slugs);
  const rank = (p) => (p.kind === 'doc' ? (menu.indexOf(p.url.split('/')[2]) + 1 || 99) : 0);
  const pages = collect(root).sort((a, b) => rank(a) - rank(b));
  const tools = await toolsPage(root);
  pages.push({ url: '/tools/', file: 'bin/hoprig.mjs', kind: 'tools', data: { title: 'Tools: the commands and Tia\'s tools', description: 'Every Hoprig command, the ones that answer in JSON, and the tools of Tia, the assistant, with their confirmation levels. Made from the code at every build.' }, markdown: tools.markdown, link: (h) => h, commands: tools.commands });

  // Titles and descriptions first: the parts (cards, docs lists) of other pages use them.
  for (const p of pages) {
    const h1 = /^#\s+(.*)$/m.exec(p.markdown);
    p.title = p.data.title || (h1 ? plainText(h1[1]) : 'Hoprig');
    p.description = p.data.description || describe(p.markdown);
    p.answer = p.data.answer || describe(p.markdown, 600); // the direct answer in full, for llms.txt and schema.org
    p.mdUrl = mdUrlOf(p.url);
  }
  const ctx = { root, pages };
  for (const page of pages) {
    const { forHtml, held, forMd } = expand(page, ctx);
    // The site's own pages mark a list of alternatives themselves; the product's docs are judged by content alone.
    const copy = page.file.startsWith('site/content/') ? 'site' : 'one';
    const { html } = renderMarkdown(forHtml, { link: page.link, slug: makeSlugger(), copy });
    page.body = html.replace(/<p>@@PART(\d+)@@<\/p>/g, (_, n) => held[Number(n)].html);
    page.twin = `${forMd.trim()}\n\n---\n\nThis page on the web: ${SITE}${page.url === '/404.html' ? '/' : page.url} · Every page: ${SITE}/llms.txt\n`;
    page.edit = page.kind === 'tools'
      ? { made: [['bin/hoprig.mjs', `${REPO}/blob/main/bin/hoprig.mjs`], ['src/assistant/tools.mjs', `${REPO}/blob/main/src/assistant/tools.mjs`]] }
      : { file: page.file, href: `${REPO}/edit/main/${page.file}` };
  }
  return pages;
}

/** The files of the bundled skill (templates/skills/hoprig), as paths relative to it: published under /skill/. */
export function skillFiles(root) {
  const dir = path.join(root, 'templates/skills/hoprig');
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'))
    .sort();
}
