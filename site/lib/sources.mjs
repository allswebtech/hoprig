// Where the site's pages come from: its own Markdown (site/content), the product's docs (docs/*.md) and some
// sections of the README, read where they are so that one change updates the product, its docs and the site.
import fs from 'node:fs';
import path from 'node:path';
import { frontMatter, makeSlugger, plainText } from './markdown.mjs';

export const SITE = 'https://hoprig.com';
export const REPO = 'https://github.com/allswebtech/hoprig';

// docs/*.md → /docs/<slug>/ (a file not named here gets its own name in lower case), in the order of the docs menu.
const DOC_SLUGS = { 'INSTALL.md': 'install', 'WORKSPACE.md': 'workspace', 'PC-SETUP.md': 'computer-setup', 'COMPUTERS.md': 'computers', 'HUB.md': 'hub', 'SKILLS.md': 'skills' };

// README sections that are pages of the docs too. A heading that is gone stops the build: rename it here as well.
const README_PAGES = [
  { heading: 'Code in a chat', slug: 'chat', title: 'Code in a chat' },
  { heading: 'Hit a usage limit? Continue the same session on another provider', slug: 'usage-limits', title: 'Usage limits and providers' },
  { heading: 'From anywhere: the public link', slug: 'public-link', title: 'The public link' },
  { heading: 'It keeps going without you', slug: 'automations', title: 'Automations' },
  { heading: 'Tia (experimental, off by default)', slug: 'tia', title: 'Tia, the assistant' },
  { heading: 'Security', slug: 'security', title: 'Security' },
  { heading: 'Is this allowed?', slug: 'is-this-allowed', title: 'Is this allowed?' },
  { heading: 'Where it runs', slug: 'where-it-runs', title: 'Where it runs' },
  { heading: 'Not built, or not proven yet', slug: 'not-proven-yet', title: 'Not built, or not proven yet' },
  { heading: 'Commands', slug: 'commands', title: 'Commands' },
];

// One line per docs page for the docs overview, llms.txt and search results (a doc's own first lines are often a
// step, not a summary). A page not named here gets its first paragraph.
const DOC_DESCRIPTIONS = {
  install: 'The one line that installs Hoprig, what its first run does step by step, what it needs, and how to update, uninstall and fix problems.',
  work: 'Your tasks and a Today screen in one file of your workspace, a coding session that does a task for you (Do it), and hoprig tasks in a terminal.',
  workspace: 'One folder tree on every computer, the map of every repository, restore and sync, and how the coding tools share one AI brain.',
  'computer-setup': 'Set up a computer for coding: the kits, projects with their own rules and memory, recipes for the next computer, and the status.',
  computers: 'Several computers in one dashboard: which setup fits you, the direct link, SSH, the public link and a main computer on a server.',
  hub: 'Put the main computer on a server: one command, HTTPS by domain or IP address, its own certificate, Docker, and what it needs.',
  skills: 'Suggest, find, review and install skills for your coding tools, with every file shown before it is added.',
  chat: 'A chat with Claude Code or OpenCode for every project: what you see, what you control, the OKs, and moving between a chat and a terminal.',
  'usage-limits': 'Providers, going on with the same session on another provider or Claude account at a limit, and Auto mode.',
  'public-link': 'One switch makes the dashboard reachable from anywhere through a Cloudflare tunnel, with no server of your own.',
  automations: 'Queue, schedules, restore and retry: rules that keep the work going without you, with no AI involved.',
  tia: 'Tia, the experimental assistant: what she can do, what she does by herself, what always comes to you, and what she never does.',
  security: 'How the dashboard is protected: sign-in, passwords, tokens, git reads, the folders it never shows, and secrets.',
  'is-this-allowed': 'What Anthropic\'s documentation covers, what is yours to judge about several accounts and limits, and the sources.',
  'where-it-runs': 'Linux, macOS and Windows: what is run and tested, what is not, and what Hoprig needs.',
  'not-proven-yet': 'Everything that is not built or not proven yet in this version, said plainly.',
  commands: 'Every hop command in one list, with what each does: providers, chats, setup, projects, the workspace, skills, the dashboard and computers.',
};

const read = (f) => fs.readFileSync(f, 'utf8');
const firstParagraph = (md) => {
  const para = md.replace(/^---[\s\S]*?---\n/, '').split(/\n\s*\n/).find((b) => b.trim() && !/^\s*(#|>|<|```|\||:::|!\[|- |\d+\. )/.test(b.trim()));
  return para ? plainText(para.replace(/\n/g, ' ')) : '';
};
export const describe = (md, max = 160) => {
  const p = firstParagraph(md);
  if (p.length <= max) return p;
  const cut = p.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};

/** Where a link in the product's files leads on the site, or on GitHub when the site has no page for it. */
function linker(root, fromDir, anchors) {
  return (href) => {
    if (!href || /^(https?:|mailto:|data:)/.test(href) || href.startsWith('/')) return href;
    // In a README section, an anchor leads to the page that has that heading, or to the README on GitHub.
    if (href.startsWith('#')) return fromDir === '' ? anchors.get(href.slice(1)) || `${REPO}${href}` : href;
    const [file, hash] = href.split('#');
    const full = path.posix.normalize(path.posix.join(fromDir, file));
    if (full.startsWith('docs/screenshots/')) return `/screenshots/${full.slice('docs/screenshots/'.length)}`;
    if (full.startsWith('assets/')) return `/${full}`;
    if (/^docs\/[^/]+\.md$/.test(full)) return `/docs/${docSlug(path.posix.basename(full))}/${hash ? `#${hash}` : ''}`;
    if (full === 'README.md') return hash && anchors.has(hash) ? anchors.get(hash) : `${REPO}${hash ? `#${hash}` : ''}`;
    const kind = fs.existsSync(path.join(root, full)) && fs.statSync(path.join(root, full)).isDirectory() ? 'tree' : 'blob';
    return `${REPO}/${kind}/main/${full}${hash ? `#${hash}` : ''}`;
  };
}
export const docSlug = (name) => DOC_SLUGS[name] || name.replace(/\.md$/i, '').toLowerCase();

/** The README cut at its `## ` headings: [{ heading, slug (GitHub's id), body }]. */
function readmeSections(root) {
  const text = read(path.join(root, 'README.md'));
  const slug = makeSlugger();
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const id = slug(plainText(m[2]));
      if (m[1].length === 2) {
        cur = { heading: plainText(m[2]), slug: id, lines: [], anchors: [id] };
        out.push(cur);
        continue;
      }
      if (cur && m[1].length > 2) cur.anchors.push(id);
    }
    if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ ...s, body: s.lines.join('\n') }));
}

/**
 * Every page as { url, file (the source, for "edit on GitHub"), kind, data, markdown, link }. `markdown` is the page's
 * source; `link` rewrites its links. Pages made from code (/tools/) are added by pages.mjs.
 */
export function collect(root) {
  const pages = [];
  const contentDir = path.join(root, 'site/content');
  for (const e of fs.readdirSync(contentDir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const full = path.join(e.parentPath ?? e.path, e.name);
    const rel = path.relative(contentDir, full).split(path.sep).join('/');
    const { data, body } = frontMatter(read(full));
    const url = rel === '404.md' ? '/404.html' : `/${rel.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '/')}`;
    const kind = data.kind || (rel.startsWith('use-cases/') && rel !== 'use-cases/index.md' ? 'usecase' : rel.startsWith('compare/') && rel !== 'compare/index.md' ? 'compare' : 'page');
    pages.push({ url, file: `site/content/${rel}`, kind, data, markdown: body, link: (h) => h });
  }

  // The README's sections first, so the docs' links into the README can lead to their pages.
  const sections = readmeSections(root);
  const anchors = new Map();
  const readmePages = README_PAGES.map((p) => {
    const s = sections.find((x) => x.heading === p.heading);
    if (!s) throw new Error(`the README has no section "## ${p.heading}" (site/lib/sources.mjs, README_PAGES)`);
    const url = `/docs/${p.slug}/`;
    s.anchors.forEach((a, n) => anchors.set(a, n ? `${url}#${a}` : url));
    return { p, s, url };
  });
  for (const { p, s, url } of readmePages) {
    // The section's own heading becomes the page's title; its sub-headings move up one level.
    const body = s.body.replace(/^(#{3,6})(\s)/gm, (_, h, sp) => `${h.slice(1)}${sp}`);
    pages.push({ url, file: 'README.md', kind: 'doc', data: { title: p.title, description: DOC_DESCRIPTIONS[p.slug], order: 100 + README_PAGES.indexOf(p) }, markdown: `# ${p.title}\n\n${body.trim()}\n`, link: linker(root, '', anchors) });
  }
  const docs = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  for (const f of docs) {
    const md = read(path.join(root, 'docs', f));
    const h1 = /^#\s+(.*)$/m.exec(md);
    pages.push({ url: `/docs/${docSlug(f)}/`, file: `docs/${f}`, kind: 'doc', data: { title: h1 ? plainText(h1[1]) : f, description: DOC_DESCRIPTIONS[docSlug(f)], order: order(f) }, markdown: md, link: linker(root, 'docs', anchors) });
  }
  return pages;
}
const order = (f) => {
  const i = Object.keys(DOC_SLUGS).indexOf(f);
  return i === -1 ? 50 : i;
};
