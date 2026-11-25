// hoprig.com: a Next.js app in site/, exported to plain files; site/scripts/after-build.mjs adds the Markdown twins,
// llms.txt and the other files Next does not make, and every page's content security policy. What it promises:
//  - from the content layer alone (site/lib, no install needed, so the product's own test job checks it too): every
//    address of today, llms.txt and the README name every use case, the tools page names every command the CLI knows,
//    raw HTML in a doc cannot put code into a page, copy buttons copy only what can be run as it stands, the licence
//    is Apache-2.0 (never MIT for Hoprig), and no file holds a home path, an e-mail address or this computer's names;
//  - from the Next build (when site/node_modules is installed; site.yml installs it): every internal link and anchor
//    leads somewhere, every page is built in the frame with its schema.org data, title, description and policy, the
//    docs pages show the docs' own text, nothing is asked of another origin, and nothing of a paid version shows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const { describe } = await import('../../site/lib/sources.mjs');
const { loadPages } = await import('../../site/lib/pages.mjs');
const { siteFiles } = await import('../../site/scripts/after-build.mjs');
// Every page, and every file the step after the build writes (twins, llms.txt, sitemap, robots, CNAME, the skill).
const { pages, files: written } = await siteFiles(root);
const readWritten = (f) => {
  assert.ok(written.has(f), `the build writes ${f}`);
  return String(written.get(f));
};
const pageOf = (url) => pages.find((p) => p.url === url);

// ---------- the Next build: needs site/node_modules (site.yml installs it; the product's own test job does not) ----------

const nextBin = path.join(root, 'site/node_modules/next/dist/bin/next');
const needsBuild = fs.existsSync(nextBin) ? false : 'site/node_modules is not installed (npm ci --ignore-scripts in site/ installs it)';
let nextOut = null;
async function nextBuild() {
  if (nextOut) return nextOut;
  // The site's own build (site/scripts/build.mjs, what npm run build runs), every step of it: site/public/ is
  // git-ignored, so a fresh clone has none until the build's first step makes it. Next builds only into a folder inside
  // the app's own folder: one of the test's own, removed afterwards.
  const { buildSite } = await import('../../site/scripts/build.mjs');
  nextOut = await buildSite({ root, dist: `.test-out-${process.pid}`, quiet: true });
  return nextOut;
}
// Removed once, after the whole file (a hook added inside a test would run when that test ends).
test.after(() => { if (nextOut) fs.rmSync(nextOut, { recursive: true, force: true }); });

const builtFiles = (out) => fs.readdirSync(out, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => fs.statSync(path.join(out, f)).isFile());
const fileOfUrl = (url) => (url === '/' ? 'index.html' : url === '/404.html' ? '404.html' : `${url.slice(1)}index.html`);
const unescape = (s) => s.replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Next repeats each page's HTML as data inside it (its flight data): "<" and ">" there are < and >.
const unflight = (s) => s.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&').replace(/\\"/g, '"');

/** What a home path, an e-mail address or a private word in a file is called, if the file holds one. */
const generic = new Set(['runner', 'root', 'user', 'node', 'ubuntu', 'admin', 'build', 'test', 'dev', 'app', 'vscode', 'codespace', 'localhost']);
const me = os.userInfo();
// What this checks: this computer's user name, host name and home folder (on CI those are the runner's, so it proves
// little there), and the words a maintainer hands in through SITE_PRIVATE_WORDS (comma-separated). The owner's own
// list of private words is checked before a release outside this repository, since that list cannot be public.
const privateWords = [me.username, os.hostname().split('.')[0], ...(process.env.SITE_PRIVATE_WORDS || '').split(',')]
  .map((w) => w.trim()).filter((w) => w.length >= 3 && !generic.has(w.toLowerCase()));
function privateIn(name, body) {
  const found = [];
  if (body.includes(me.homedir)) found.push(`${name}: this computer's home folder`);
  // `box`: /home/box is the box's own fixed home (docs/BOX.md), a path that names no person.
  for (const m of body.matchAll(/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)([A-Za-z][\w.-]*)/g)) if (!['you', 'me', 'name', 'user', 'alex', 'box'].includes(m[1])) found.push(`${name}: a home path (${m[0]})`);
  for (const m of body.matchAll(/\b[\w.+-]+@([\w-]+\.)+[a-z]{2,}\b/gi)) {
    if (/^git@/.test(m[0]) || /@([\w-]+\.)*(example\.(com|org|net)|example|invalid|test)$/i.test(m[0]) || /@\d+\.\d+\.\d+/.test(m[0])) continue;
    found.push(`${name}: an e-mail address (${m[0]})`);
  }
  for (const w of privateWords) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)) found.push(`${name}: a private name`);
  return found;
}

// ---------- the pages and the files beside them, from the content layer: no build needed ----------

const { STAGES, stageFaults } = await import('../../site/scripts/stage-check.mjs');

test('a page\'s description skips a leading note blockquote and uses the first real paragraph', () => {
  const md = '# A page\n\n> **A note at the top.** It is a callout, not the summary of the page, so it is not the description.\n\nThis first real paragraph is what a search result should show, and what the description is made from.\n';
  const d = describe(md);
  assert.doesNotMatch(d, /^>|note at the top/, 'the blockquote is not the description');
  assert.match(d, /^This first real paragraph/);
});

test('the site has the pages SITE.md names, and the files beside them', () => {
  for (const url of ['/', '/use-cases/', '/docs/', '/docs/install/', '/skill/', '/tools/', '/compare/', '/changelog/', '/404.html']) assert.ok(pageOf(url), `no page ${url}`);
  assert.equal(pages.filter((p) => p.kind === 'compare').length, 3, 'three comparison pages');
  assert.equal(pages.filter((p) => p.kind === 'usecase').length, 19, 'nineteen use cases');
  assert.ok(pages.filter((p) => p.kind === 'doc').length >= fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).length, 'every docs/*.md is a page');
  for (const f of ['llms.txt', 'llms-full.txt', 'sitemap.xml', 'robots.txt', 'CNAME', '.nojekyll', 'skill/SKILL.md']) assert.ok(written.has(f), `no ${f}`);
  assert.equal(readWritten('CNAME').trim(), 'hoprig.com');
  assert.match(readWritten('robots.txt'), /^User-agent: \*\nAllow: \//);
  assert.match(readWritten('robots.txt'), /User-agent: ClaudeBot\nAllow: \//);
  assert.match(readWritten('robots.txt'), /Sitemap: https:\/\/hoprig\.com\/sitemap\.xml/);
});

test('a line that is an HTML comment is a note for the editor: no page shows it as text', () => {
  for (const p of pages) assert.doesNotMatch(p.body, /&lt;!--/, p.url);
});

test('raw HTML in a doc keeps only the README\'s tags: a script or an onerror builds to text, not markup', async () => {
  // A copy of the repository whose docs hold one more file, with what a careless or hostile change could bring.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'site-evil-'));
  try {
    for (const e of fs.readdirSync(root)) if (!['docs', 'site', 'node_modules', '.git'].includes(e)) fs.symlinkSync(path.join(root, e), path.join(fake, e));
    fs.mkdirSync(path.join(fake, 'docs'));
    for (const e of fs.readdirSync(path.join(root, 'docs'))) fs.symlinkSync(path.join(root, 'docs', e), path.join(fake, 'docs', e));
    fs.mkdirSync(path.join(fake, 'site'));
    fs.symlinkSync(path.join(root, 'site/content'), path.join(fake, 'site/content'));
    fs.writeFileSync(path.join(fake, 'docs', 'EVIL.md'), [
      '# Evil', '',
      '<p align="center"><img src="x.png" onerror="alert(1)" alt="x"><script>alert(2)</script></p>', '',
      '<div><iframe src="https://example.com"></iframe><a href="javascript:alert(3)">x</a></div>', '',
      '<p><a href="/docs/" onclick="alert(4)" style="color:red">ok</a></p>', '',
      'A [link](https://en.wikipedia.org/wiki/Tmux_(software)) with parentheses.', '',
    ].join('\n'));
    const evil = (await loadPages(fake)).find((p) => p.url === '/docs/evil/');
    assert.ok(evil, 'the new doc is a page');
    const main = evil.body;
    assert.doesNotMatch(main, /<script|<iframe|\son[a-z]+=|javascript:|\sstyle=/i);
    assert.match(main, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/, 'the script tag is shown as text');
    assert.match(main, /<img src="\/docs\/evil\/x\.png" alt="x"|<img src="[^"]*x\.png" alt="x"/, 'the image stays, without its onerror');
    assert.match(main, /<a href="\/docs\/">ok<\/a>/, 'an allowed link stays, without its handler and style');
    assert.match(main, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Tmux_\(software\)">link<\/a> with parentheses/);
    // The page shows the body as the content layer made it: the Next page puts it in as it stands.
    assert.match(fs.readFileSync(path.join(root, 'site/app/(site)/Content.tsx'), 'utf8'), /dangerouslySetInnerHTML=\{\{ __html: sized\(html\) \}\}/);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('copy buttons only on one command or a sequence to run as it stands: never a placeholder, never alternatives', async () => {
  const copyable = (url) => [...pageOf(url).body.matchAll(/<pre data-copyable><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => unescape(m[1]));
  const lines = (block) => block.split('\n').map((l) => l.replace(/(^|\s+)#(\s.*)?$/, '')).filter((l) => l.trim());
  for (const p of pages) {
    const ownDocs = p.kind === 'doc' || p.kind === 'tools';
    for (const block of copyable(p.url)) {
      assert.doesNotMatch(block, /<[^<>\s][^<>]*>/, `${p.url}: a block with a placeholder has a copy button`);
      if (ownDocs) assert.equal(lines(block).length, 1, `${p.url}: a block of several lines from the product's docs has a copy button: ${block}`);
    }
  }
  assert.deepEqual(copyable('/use-cases/production-ready/'), [], 'hop skills add <id> is not copied');
  assert.ok(copyable('/docs/install/').every((b) => lines(b).length === 1), 'the install page copies single commands only');
  // Seen 20 Nov 2026: the curl block had Copy and the PowerShell block under it had none.
  assert.ok(copyable('/docs/install/').some((b) => /^irm https:\/\/\S+\/install\.ps1 \| iex$/.test(b.trim())), 'the Windows install line is copied like the curl one');
  const { renderMarkdown } = await import('../../site/lib/markdown.mjs');
  assert.match(renderMarkdown('```pwsh\nhoprig doctor\n```').html, /<pre data-copyable>/);
  assert.doesNotMatch(renderMarkdown('```powershell\nhoprig get <name>\n```').html, /data-copyable/, 'a placeholder is never copied, in PowerShell too');
  assert.equal(copyable('/use-cases/two-computers-one-workspace/').length, 1, 'only the first computer\'s commands are copied');
  assert.doesNotMatch(copyable('/use-cases/two-computers-one-workspace/')[0], /restore/);
});

test('llms.txt and the README list every use case, and the sitemap every page', () => {
  const llms = readWritten('llms.txt');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const sitemap = readWritten('sitemap.xml');
  const cases = fs.readdirSync(path.join(root, 'site/content/use-cases')).filter((f) => f.endsWith('.md') && f !== 'index.md');
  assert.equal(cases.length, 19);
  for (const c of cases) {
    assert.ok(llms.includes(`https://hoprig.com/use-cases/${c.replace(/\.md$/, '')}.md`), `llms.txt does not list ${c}`);
    assert.ok(readme.includes(`(https://hoprig.com/use-cases/${c.replace(/\.md$/, '')}/)`), `the README's "Who it is for" does not list ${c}`);
  }
  for (const p of pages.filter((x) => x.url !== '/404.html')) assert.ok(sitemap.includes(`<loc>https://hoprig.com${p.url}</loc>`), `the sitemap lacks ${p.url}`);
  assert.ok(readWritten('llms-full.txt').length > llms.length * 5, 'llms-full.txt holds the pages themselves');
});

test('the site\'s own words name the lowest Node.js as 24.13.1 or newer', () => {
  // The lowest supported Node.js is 24.13.1; the content's own words are another file's (site/content, docs, README).
  assert.match(readWritten('llms.txt'), /Needs Node\.js 24\.13\.1 or newer/);
  assert.doesNotMatch(readWritten('llms.txt'), /Node\.js 22/);
  for (const f of siteSources().filter((x) => !x.startsWith('site/content/'))) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /Node(\.js)? 22 or newer/, f);
});

test('llms.txt says what Hoprig does not do', () => {
  const part = /^## What it does not do\n\n((?:- .*\n)+)/m.exec(readWritten('llms.txt'));
  assert.ok(part, 'llms.txt has a "What it does not do" list');
  for (const word of [/no cloud/i, /does not replace the coding tools/i, /OpenCode never runs on a Claude subscription/, /Auto mode is Claude Code's only/, /Codex is not offered/, /macOS/, /Windows is not ready/, /stand-ins/, /One dashboard password and no user accounts or roles/, /Remote Control does not work/, /No triggers from outside/]) {
    assert.match(part[1], word);
  }
});

test('the tools page\'s JSON table: each row is a usage line with what it gives, never a comment\'s prose', async () => {
  // Seen 22 Nov 2026 at 390 px: the row "hoprig move-to-user ..." said "What it gives: —" (its usage text puts the words
  // on the lines under it), and a row "hoprig version }; proc: its identity ..." was a header comment's prose that
  // starts with the word "version".
  const { jsonCommands } = await import('../../site/lib/reference.mjs');
  const rows = jsonCommands(root);
  assert.ok(rows.length >= 20, 'the commands that answer in JSON are found');
  for (const r of rows) {
    assert.match(r.usage, /^hoprig [a-z][a-z-]*(?: (?:[a-z][a-z-]*|[[<(-]\S*|\||NAME\]*|[A-Z]+\]*|[^\s;`{}]+))*$/, `${r.usage}: a usage line`);
    assert.doesNotMatch(r.usage, /[;`{}]|\.\s/, `${r.usage}: no prose in the command`);
    assert.ok(r.text.length > 10, `${r.usage}: says what it gives`);
  }
  const move = rows.find((r) => r.usage.startsWith('hoprig move-to-user '));
  assert.match(move?.text || '', /^move Hoprig from root to an ordinary user/);
});

test('the tools page\'s JSON table never shows a note for the code\'s readers', async () => {
  // A header comment's usage line said "= hoprig get (getproject.mjs)": a shorthand and a source file's name, which a
  // visitor cannot read. The row says the command's own line in hoprig help instead.
  const { jsonCommands } = await import('../../site/lib/reference.mjs');
  const rows = jsonCommands(root);
  for (const r of rows) assert.doesNotMatch(r.text, /^=|\b[\w-]+\.mjs\b/, `${r.usage}: plain words, no shorthand or file name`);
  const clone = rows.find((r) => r.usage.startsWith('hoprig project clone '));
  assert.match(clone?.text || '', /^get an existing project/);
});

test('the tools page lists every command in the order of hoprig help, so "the same" and "as above" point at the right line', async () => {
  // The rows were grouped by the switch's order: "hoprig get: the same, short" came under "hoprig pc status", and
  // "hoprig opencode: -c, --resume ID ... as above" had no row above it that names them.
  const { toolsPage } = await import('../../site/lib/reference.mjs');
  const { markdown } = await toolsPage(root);
  const every = markdown.split('## Every command')[1].split('###')[0];
  const rows = every.split('\n').filter((l) => l.startsWith('| `hoprig'));
  const at = (re) => rows.findIndex((l) => re.test(l));
  assert.equal(at(/^\| `hoprig get /), at(/^\| `hoprig project clone /) + 1, 'hoprig get comes right under hoprig project clone');
  const opencode = at(/^\| `hoprig opencode /);
  const resume = at(/^\| `hoprig <profile> \[args\]` \|.*--resume ID/);
  assert.ok(resume !== -1 && resume < opencode, 'the -c and --resume ID examples stand above hoprig opencode');
});

test('the tools page lists every command the CLI knows, and Tia\'s tools', async () => {
  // Read here from bin/hoprig.mjs on its own, not through the content layer, so a mistake there cannot hide itself.
  const bin = fs.readFileSync(path.join(root, 'bin/hoprig.mjs'), 'utf8');
  const commands = [...bin.slice(bin.indexOf('async function main(')).matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]);
  assert.ok(commands.length > 20, 'the switch in bin/hoprig.mjs was found');
  // A code word with a hyphen is wrapped in a span in a table cell (kept whole on a phone): the text is what is read.
  const page = pageOf('/tools/').body.replace(/<\/?span[^>]*>/g, '');
  for (const c of commands) assert.ok(page.includes(`<code>hoprig ${c}`), `the tools page lacks hoprig ${c}`);
  for (const c of ['doctor', 'pc status', 'workspace status', 'profiles']) assert.match(page, new RegExp(`<code>hoprig ${c}[^<]*--json`), `--json of hoprig ${c}`);
  const { TOOLS } = await import('../../src/assistant/tools.mjs');
  for (const t of TOOLS) assert.ok(page.includes(`<code>${t.name}</code>`), `the tools page lacks Tia's tool ${t.name}`);
});

const LICENCE = 'https://github.com/allswebtech/hoprig/blob/main/LICENSE';
test('the licence is Apache-2.0 in the answer to "Is Hoprig free?" and in llms.txt, and links to the licence', () => {
  assert.ok(pageOf('/').body.includes(`open source under the <a href="${LICENCE}">Apache License 2.0</a>`), 'the answer to "Is Hoprig free?"');
  assert.ok(readWritten('llms.txt').includes(`- Licence: open source (Apache-2.0): ${LICENCE}`), 'llms.txt');
});

// The Happy page names Happy's own licence, as a bullet of its facts and in the licence row, where Hoprig's cell says
// Apache-2.0. Versions up to 0.2.1 were MIT; the site speaks of the current one.
const HAPPY_MIT = [
  'MIT licence, and about',
  '| Licence | Open source (Apache-2.0) | Open source (MIT) |',
  '<tr><th scope="row">Licence</th><td data-label="Hoprig">Open source (Apache-2.0)</td><td data-label="Happy">Open source (MIT)</td></tr>',
];
const saysMit = (body) => /\bMIT\b/.test(HAPPY_MIT.reduce((b, ok) => b.split(ok).join(''), unflight(body)));

test('no page says Hoprig is under MIT: only Happy\'s licence is MIT, on its comparison page', () => {
  for (const p of pages) assert.ok(!saysMit(p.body), p.url);
  for (const [f, body] of written) assert.ok(!saysMit(String(body)), f);
  assert.ok(pageOf('/compare/happy/').body.includes(HAPPY_MIT[2]), 'the licence row of the Happy page');
  for (const f of fs.readdirSync(path.join(root, 'site'), { recursive: true }).map(String)) {
    const full = path.join(root, 'site', f);
    // Build output, installed tools and the licence check's allow-list (which names the licence on purpose) are not
    // the site's words.
    if (f.split(path.sep).some((part, n) => ['node_modules', 'dist', '.next', 'out', '.measure'].includes(part) || (n === 0 && (part === 'public' || part.startsWith('.test-out-')))) || !fs.statSync(full).isFile() || f.endsWith('package-lock.json') || f === path.join('scripts', 'licences.mjs') || /\.(webp|avif|png|ico)$/.test(f)) continue; // pictures are bytes, not words
    assert.ok(!saysMit(fs.readFileSync(full, 'utf8')), `site/${f}`);
  }
});

// The site's own source: the content layer, the scripts, the Next app and the design system, and the content.
const siteSources = () => ['site/next.config.mjs', 'site/package.json', ...['lib', 'scripts', 'app', 'design', 'content'].flatMap((d) => fs.readdirSync(path.join(root, 'site', d), { recursive: true }).map((f) => `site/${d}/${String(f).split(path.sep).join('/')}`))]
  .filter((f) => /\.(mjs|mts|ts|tsx|css|md|json)$/.test(f) && fs.statSync(path.join(root, f)).isFile());

test('no file of the site holds a home path, an e-mail address, this computer\'s user, host or home folder, or a word a maintainer lists', () => {
  const found = [];
  for (const f of siteSources()) found.push(...privateIn(f, fs.readFileSync(path.join(root, f), 'utf8')));
  for (const [f, body] of written) found.push(...privateIn(f, String(body)));
  assert.deepEqual(found, []);
});

// ---------- the built pages: every link leads somewhere, every page is described for search (needs the build) ----------

/** The file a site address is served from, as GitHub Pages does it (a folder serves its index.html). */
function target(out, address) {
  const p = decodeURIComponent(address.split(/[?#]/)[0]);
  const full = path.join(out, p);
  if (p.endsWith('/')) return fs.existsSync(path.join(full, 'index.html')) ? path.join(full, 'index.html') : null;
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  return fs.existsSync(path.join(full, 'index.html')) ? path.join(full, 'index.html') : null;
}
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...fs.readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))));
  return ids.get(file);
};

test('the test builds the site as npm run build does: every file of the build\'s first step is in the built site', { skip: needsBuild }, async () => {
  // Seen 22 Nov 2026 in a fresh worktree (no site/public/, which is git-ignored): the test's build ran next build and
  // the step after it but not scripts/public.mjs, so /favicon.ico, /icon.svg and the story's pictures were missing
  // and four tests failed, while every worktree that had built once passed on its old site/public/.
  const { STEPS } = await import('../../site/scripts/build.mjs');
  assert.deepEqual(STEPS, ['public', 'next', 'after'], 'site/public is filled first, then next build, then the step after it');
  const out = await nextBuild();
  // What the first step would make, asked of it in a folder of the test's own (the worktree's site/public is not read).
  const { fillPublic } = await import('../../site/scripts/public.mjs');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'site-public-'));
  try {
    const made = builtFiles(fillPublic({ root, out: path.join(own, 'public') }));
    assert.ok(made.length > 50 && made.includes('favicon.ico') && made.some((f) => f.startsWith('story/')), 'the step makes the icons and the story\'s pictures');
    const missing = made.filter((f) => !fs.existsSync(path.join(out, f)));
    assert.deepEqual(missing, [], 'every file of site/public is in the built site');
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});

test('every internal link and image leads to a file, and every anchor to a heading', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const broken = [];
  for (const f of builtFiles(out).filter((x) => x.endsWith('.html'))) {
    for (const m of fs.readFileSync(path.join(out, f), 'utf8').matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const v = m[1].replace(/&amp;/g, '&');
      if (/^(https?:|mailto:|data:)/.test(v) || v.startsWith('//')) continue;
      if (!v.startsWith('/') && !v.startsWith('#')) {
        broken.push(`${f}: ${v} (relative: a 404 page is served at every address, so links must start with /)`);
        continue;
      }
      const file = v.startsWith('#') ? path.join(out, f) : target(out, v);
      if (!file) {
        broken.push(`${f}: ${v}`);
        continue;
      }
      const hash = v.split('#')[1];
      if (hash && file.endsWith('.html') && !idsOf(file).has(decodeURIComponent(hash))) broken.push(`${f}: ${v} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});

const text1 = (v) => typeof v === 'string' && v.trim().length > 0;

test('every page carries schema.org data with the properties its kind requires, a description and Open Graph tags', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  const ldOf = (f) => {
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read(f));
    return ld ? JSON.parse(ld[1]) : null;
  };
  const kinds = new Map();
  for (const f of pages.filter((p) => p.url !== '/404.html').map((p) => fileOfUrl(p.url))) {
    const page = read(f);
    const data = ldOf(f);
    assert.ok(data, `${f} has no schema.org data`);
    assert.equal(data['@context'], 'https://schema.org');
    assert.ok(data['@graph'].length, f);
    for (const x of data['@graph']) {
      kinds.set(x['@type'], (kinds.get(x['@type']) || 0) + 1);
      if (x['@type'] === 'SoftwareApplication') {
        for (const k of ['name', 'operatingSystem', 'applicationCategory']) assert.ok(text1(x[k]), `${f}: the software has no ${k}`);
        assert.equal(x.offers?.['@type'], 'Offer', `${f}: the software has no offer`);
        assert.ok(x.offers.price !== undefined && text1(x.offers.priceCurrency), `${f}: the offer has no price and currency`);
      } else if (x['@type'] === 'FAQPage') {
        assert.ok(x.mainEntity.length, `${f}: questions and answers without a question`);
        for (const q of x.mainEntity) {
          assert.equal(q['@type'], 'Question', f);
          assert.ok(text1(q.name), `${f}: a question without its text`);
          assert.ok(q.acceptedAnswer?.['@type'] === 'Answer' && text1(q.acceptedAnswer.text), `${f}: "${q.name}" has no accepted answer`);
        }
      } else if (x['@type'] === 'HowTo') {
        assert.ok(text1(x.name), `${f}: a how-to without a name`);
        assert.ok(x.step.length, `${f}: a how-to without steps`);
        for (const st of x.step) {
          const list = st['@type'] === 'HowToSection' ? (assert.ok(text1(st.name), `${f}: a section without a name`), st.itemListElement) : [st];
          assert.ok(list.length, `${f}: an empty section`);
          for (const one of list) assert.ok(one['@type'] === 'HowToStep' && text1(one.text), `${f}: a step without text`);
        }
      } else if (x['@type'] === 'BreadcrumbList') {
        assert.ok(x.itemListElement.every((c) => text1(c.name) && text1(c.item)), `${f}: a breadcrumb without name or address`);
      } else {
        assert.ok(text1(x.name || x.headline), `${f}: ${x['@type']} has no name`);
      }
    }
    assert.match(page, /<meta name="description" content="[^"]{20,}"\/>/, `${f} has no description`);
    assert.match(page, /<meta property="og:image" content="https:\/\/hoprig\.com\/social-preview\.png"\/>/, f);
  }
  assert.equal(kinds.get('SoftwareApplication'), 1, 'the home page describes the software');
  assert.ok(ldOf('index.html')['@graph'].some((x) => x['@type'] === 'FAQPage' && x.mainEntity.length >= 3), 'the home page has its questions and answers');
  const usecase = ldOf('use-cases/usage-limit/index.html')['@graph'];
  assert.ok(usecase.some((x) => x['@type'] === 'HowTo' && x.step.length >= 3), 'a use case has its how-to steps');
  // Two phases (before, on the new computer) stay apart.
  const restore = ldOf('use-cases/new-computer/index.html')['@graph'].find((x) => x['@type'] === 'HowTo');
  assert.deepEqual(restore.step.map((x) => [x['@type'], x.itemListElement.length]), [['HowToSection', 2], ['HowToSection', 6]]);
  assert.match(restore.step[1].name, /new computer/);
});

test('titles fit a search result, descriptions are 70 to 160 characters, and the 404 page is not indexed', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  for (const p of pages) {
    const f = fileOfUrl(p.url);
    const page = read(f);
    const title = unescape(/<title>([^<]*)<\/title>/.exec(page)[1]);
    // A use case's question is kept whole; the suffix goes where it would be cut.
    assert.ok(title.length <= 60 || title === p.title, `${f}: the title "${title}" is ${title.length} characters, with a suffix`);
    const d = unescape(/<meta name="description" content="([^"]*)"\/>/.exec(page)[1]);
    assert.ok(d.length >= 70 && d.length <= 160, `${f}: the description is ${d.length} characters: ${d}`);
  }
  const missing = read('404.html');
  assert.match(missing, /<meta name="robots" content="noindex"\/>/);
  assert.doesNotMatch(missing, /rel="canonical"/);
  assert.doesNotMatch(missing, /application\/ld\+json/);
  for (const p of pages.filter((x) => x.url !== '/404.html')) assert.ok(read(fileOfUrl(p.url)).includes(`<link rel="canonical" href="https://hoprig.com${p.url}"/>`), p.url);
});

test('the licence is Apache-2.0 on the built landing page and in every footer, and links to the licence', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<ul class="pills"[^>]*>[\s\S]*?Open source<\/li>/, 'the first screen says open source');
  assert.ok(home.includes(`open source under the <a href="${LICENCE}">Apache License 2.0</a>`), 'the answer to "Is Hoprig free?"');
  for (const f of builtFiles(out).filter((x) => x.endsWith('.html'))) {
    const page = fs.readFileSync(path.join(out, f), 'utf8');
    const foot = page.match(/<footer class="foot">[\s\S]*?<\/footer>/);
    assert.ok(foot, `${f} has the footer`);
    assert.ok(foot[0].includes(`open source (<a href="${LICENCE}">Apache-2.0</a>)`), `${f}: the footer names the licence and links to it`);
  }
  for (const f of builtFiles(out).filter((x) => /\.(html|txt|md|xml|css|js)$/.test(x))) assert.ok(!saysMit(fs.readFileSync(path.join(out, f), 'utf8')), `${f} says MIT`);
});

// ---------- the Next.js app's tools (site/package.json, its lock): checks that need no install, so they always run ----------

const sitePkg = JSON.parse(fs.readFileSync(path.join(root, 'site/package.json'), 'utf8'));
const siteLock = JSON.parse(fs.readFileSync(path.join(root, 'site/package-lock.json'), 'utf8'));

test('the site\'s tools are pinned to exact versions, and the lock holds those versions', () => {
  const all = { ...sitePkg.dependencies, ...sitePkg.devDependencies };
  assert.ok(all.next && all.react && all['react-dom'], 'the site is a Next.js app');
  for (const [name, v] of Object.entries(all)) {
    if (v.startsWith('file:./stubs/')) continue; // a stand-in of the site's own (see site/stubs/)
    assert.match(v, /^\d+\.\d+\.\d+$/, `${name}: an exact version, not a range (${v})`);
    assert.equal(siteLock.packages[`node_modules/${name}`]?.version, v, `${name}: the lock holds ${v}`);
  }
});

test('every package of the site\'s lock is under a licence the repository may ship with', async () => {
  const { refused, allowed } = await import('../../site/scripts/licences.mjs');
  assert.deepEqual(refused(siteLock), []);
  // The rule itself: copyleft and a missing licence fail; an OR passes on one allowed side, an AND needs both.
  assert.equal(allowed('MIT'), true);
  assert.equal(allowed('(MIT OR GPL-3.0-only)'), true);
  assert.equal(allowed('Apache-2.0 AND LGPL-3.0-or-later'), false);
  assert.equal(allowed('LGPL-3.0-or-later'), false);
  assert.equal(allowed(undefined), false);
  assert.deepEqual(refused({ packages: { '': {}, 'node_modules/x': { license: 'GPL-2.0-only' }, 'node_modules/y': {} } }).map((p) => p.name), ['x', 'y']);
  // sharp's image binaries (LGPL) are kept out: Next's optional sharp is the site's own stand-in.
  assert.ok(!Object.keys(siteLock.packages).some((k) => /sharp-libvips|@img\//.test(k)), 'no sharp binaries in the lock');
});

test('Next\'s telemetry is off in every build the site\'s package runs', () => {
  for (const [name, cmd] of Object.entries(sitePkg.scripts)) if (/\bnext\s+build\b/.test(cmd)) assert.match(cmd, /NEXT_TELEMETRY_DISABLED=1/, `site script "${name}"`);
});

test('the publishing workflow builds the Next site with the same care: pinned actions, no install scripts, checks first', () => {
  // The workflow without its comments (one of them says why there is no pull_request trigger).
  const wf = fs.readFileSync(path.join(root, '.github/workflows/site.yml'), 'utf8').replace(/^\s*#.*\n/gm, '').replace(/\s+# .*$/gm, '');
  // The same triggers: a push to main of this repository, or by hand. Never a pull request (a fork's code would run
  // with the rights to publish).
  const on = /^on:\n([\s\S]*?)^\S/m.exec(wf)[1];
  assert.match(on, /^ {2}push:\n {4}branches: \[main\]/m);
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(wf, /pull_request/);
  assert.match(wf, /if: github\.repository == 'allswebtech\/hoprig'/);
  // Every action pinned by its full hash.
  const uses = [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 5, 'the actions are found');
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u}: pinned by its hash`);
  // The site's tools exactly as locked, with no install scripts, in site/ only.
  assert.match(wf, /run: npm ci --ignore-scripts --no-audit --no-fund\n\s+working-directory: site/);
  assert.doesNotMatch(wf.replace(/npm ci --ignore-scripts[^\n]*/, ''), /npm (ci|install|i)\b/, 'one install, the site\'s');
  assert.match(wf, /NEXT_TELEMETRY_DISABLED: '1'/, 'Next sends no usage data');
  // The order: the checks, the build (the site's own script: next build, then the step after it), the npx check on the
  // built folder, then the upload of that folder.
  const at = (s) => wf.indexOf(s);
  const steps = ['run: node tools/test.mjs test/site/site.test.mjs test/skill/site.test.mjs', 'run: npm run build', 'run: node tools/npx-held.mjs site/out', 'upload-pages-artifact'];
  for (const st of steps) assert.ok(at(st) > 0, `site.yml: ${st}`);
  for (let i = 1; i < steps.length; i++) assert.ok(at(steps[i - 1]) < at(steps[i]), `${steps[i - 1]} comes before ${steps[i]}`);
  assert.match(wf, /upload-pages-artifact@\S+[^\n]*\n\s+with:\n\s+path: site\/out\n/, 'the folder checked is the folder published');
  assert.equal(sitePkg.scripts.build, 'node scripts/build.mjs', 'the build is the one list of steps in scripts/build.mjs');
  assert.ok(!fs.existsSync(path.join(root, 'site/build.mjs')), 'the old generator is gone');
});

// ---------- the design system (site/design/) and the public frame (site/app/(site)/): no build needed ----------

const siteFile = (f) => fs.readFileSync(path.join(root, 'site', f), 'utf8');
const tokenNames = (block) => [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
// A rule of a stylesheet of the site, comments taken out: the declarations of `sel` anywhere in the file, in every
// block of one @media query, or (media 'top') outside every @media block. A block is matched one level deep (an @media
// block holds rules, a rule holds none), on one line or many.
const BLOCK = '\\{((?:[^{}]|\\{[^{}]*\\})*)\\}';
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cssRule = (f, sel, media = null) => {
  let css = siteFile(f).replace(/\/\*[\s\S]*?\*\//g, '');
  if (media === 'top') css = css.replace(new RegExp(`@media[^{]*${BLOCK}`, 'g'), '');
  else if (media) css = [...css.matchAll(new RegExp(`@media ${reEsc(media)} ${BLOCK}`, 'g'))].map((m) => m[1]).join('\n');
  return new RegExp(`(^|\\n)\\s*${reEsc(sel)} \\{([^}]*)\\}`).exec(css)?.[2] || '';
};

test('the design system\'s colours are tokens with a light and a dark value, dark both by the system and by choice', () => {
  const css = siteFile('design/tokens.css');
  const light = /^:root \{([\s\S]*?)^\}/m.exec(css)[1];
  const bySystem = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([\s\S]*?)\}\s*\}/.exec(css)?.[1];
  const byChoice = /:root\[data-theme='dark'\] \{([\s\S]*?)\}/.exec(css)?.[1];
  assert.ok(bySystem && byChoice, 'a dark block for the system\'s preference (unless light is chosen) and one for a chosen dark');
  const colours = tokenNames(light).filter((n) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(new RegExp(`${n}\\s*:([^;]*);`).exec(light)[1]) && !/^--(shadow|grid)/.test(n));
  assert.ok(colours.length >= 15, 'the colour tokens are found');
  // The install line is a dark console in both themes: its text colours are one pair for both, on purpose.
  const SAME_IN_BOTH = ['--console-text', '--console-muted'];
  for (const n of colours) {
    if (SAME_IN_BOTH.includes(n)) continue;
    assert.ok(tokenNames(bySystem).includes(n), `${n} has a dark value by the system's preference`);
    assert.ok(tokenNames(byChoice).includes(n), `${n} has a dark value when dark is chosen`);
  }
  assert.deepEqual(tokenNames(bySystem), tokenNames(byChoice), 'both dark blocks set the same tokens');
});

test('the site\'s pages take every colour from the design system\'s tokens', () => {
  // A colour written into a page's own styles is a second design system; the logo is the brand mark and keeps its own.
  const files = fs.readdirSync(path.join(root, 'site/app'), { recursive: true }).map(String).filter((f) => /\.(css|tsx?)$/.test(f));
  files.push(...fs.readdirSync(path.join(root, 'site/design')).filter((f) => f.endsWith('.css') && f !== 'tokens.css').map((f) => `../design/${f}`));
  const found = [];
  for (const f of files) {
    // A mask uses only the alpha of its colour (the story's floor fades out by one): not a colour of the page.
    const body = fs.readFileSync(path.join(root, 'site/app', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(-webkit-)?mask-image:[^;]*;/g, '');
    for (const m of body.matchAll(/#[0-9a-f]{3,8}\b(?![\w-])|rgba?\([^)]*\)/gi)) if (!/^#(fff|ffffff)$/i.test(m[0]) || f.endsWith('.css')) found.push(`${f}: ${m[0]}`);
  }
  // White is the kit's focus ring on the dark install line, a fixed pair in both themes. The browser bar's colour
  // (layout.tsx, themeColor) is a meta tag, which cannot read a token: it must equal --bg of each theme.
  const tokens = siteFile('design/tokens.css');
  const bg = [/^:root \{[\s\S]*?--bg: (#[0-9a-f]+)/m.exec(tokens)[1], /:root\[data-theme='dark'\] \{[\s\S]*?--bg: (#[0-9a-f]+)/.exec(tokens)[1]];
  assert.match(siteFile('app/layout.tsx'), new RegExp(`light\\)', color: '${bg[0]}'[\\s\\S]*dark\\)', color: '${bg[1]}'`), 'the browser bar takes --bg of each theme');
  assert.deepEqual(found.filter((x) => !/kit\.css: #fff$/.test(x) && !bg.some((c) => x === `layout.tsx: ${c}`)), []);
});

test('the theme is set from the saved choice before the first paint, by the same key the switch saves', () => {
  const layout = siteFile('app/layout.tsx');
  assert.match(layout, /<head>[\s\S]*THEME_SCRIPT[\s\S]*<\/head>/, 'the theme script is in the document\'s head');
  const { THEME_SCRIPT } = { THEME_SCRIPT: /THEME_SCRIPT = "(.*)";/.exec(siteFile('design/theme-script.ts'))[1] };
  assert.match(THEME_SCRIPT, /localStorage\.getItem\('theme'\)/);
  assert.match(siteFile('design/ThemeSwitch.tsx'), /localStorage\.setItem\('theme', next\)/);
  // A chosen theme picks each <picture>'s file as the page is read, before the picture is chosen: seen 20 Nov 2026,
  // a dark choice on a light system showed the light picture of the first screen until the page's scripts ran.
  assert.match(THEME_SCRIPT, /new MutationObserver\(/);
  assert.match(THEME_SCRIPT, /e\.matches\('source\[data-dark\]'\)\)e\.media=m/);
  assert.match(THEME_SCRIPT, /m=t==='dark'\?'all':'not all'/);
  assert.match(siteFile('design/ThemeSwitch.tsx'), /t === 'dark' \? 'all' : t === 'light' \? 'not all' :/, 'the switch sets the same media');
  // Which icon the switch shows is CSS, so it is right before any script runs.
  assert.match(siteFile('design/kit.css'), /:root\[data-theme='dark'\] \.theme-switch \.sun \{ display: none; \}/);
});

test('a long command inside a sentence breaks where it must, so a page never scrolls sideways on a phone', () => {
  // The changelog names "hoprig ship status|together|check|…" with no space in it: at 390 px it was 438 px wide.
  const css = siteFile('app/(site)/pages.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.prose :not\(pre\) > code \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.prose \{[^}]*overflow-wrap: break-word;/);
});

test('on a phone every control is a target as tall as a finger (44 px): copy buttons, menus, crumbs, footer links', async () => {
  // Measured at 390 px (20 Nov 2026): the install line's Copy was 38 px tall, the docs menu's links 40, the footer's
  // links 36, a code block's Copy 40, the crumbs 19. WCAG 2.5.8 asks 24 px at least; 44 is the kit's --tap.
  const strip = (f) => siteFile(f).replace(/\/\*[\s\S]*?\*\//g, '');
  const kit = strip('design/kit.css');
  assert.match(siteFile('design/tokens.css'), /--tap: 44px;/);
  assert.match(/@media \(max-width: 599px\) \{([\s\S]*?)\n\}/.exec(kit.slice(kit.indexOf('.install {')))[1], /\.install \.btn \{[^}]*min-height: var\(--tap\)/, 'the install line\'s Copy on a phone');
  const rule = (css, sel) => new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2] || '';
  const frame = strip('app/(site)/frame.css');
  const pages = strip('app/(site)/pages.css');
  // The footer's links: 44 px where a finger taps, the list's own line on a desktop (seen 20 Nov 2026: 46 px a line at
  // 1440 px); the edit link stands alone in its line, so it is one of them (it measured 160 by 19 px at 390 px).
  const PHONE = '(max-width: 719px), (pointer: coarse)';
  assert.doesNotMatch(rule(frame, '.foot nav a'), /min-height/, 'no finger-sized footer lines on a desktop');
  assert.match(cssRule('app/(site)/frame.css', '.foot nav a', PHONE), /min-height: var\(--tap\)/, 'the footer\'s links on a phone');
  assert.match(cssRule('app/(site)/frame.css', '.foot-edit > a:first-child', PHONE), /min-height: var\(--tap\)/, 'the edit link on a phone');
  assert.match(siteFile('app/(site)/Footer.tsx'), /<p className="foot-edit">\{edit\}<\/p>/);
  for (const [css, sel] of [[pages, '.crumbs a'], [pages, '.pre-copy'], [pages, '.side nav a'], [pages, '.prose li.link-item > a']]) {
    assert.match(rule(css, sel), /min-height: var\(--tap\)/, `${sel} is 44 px tall`);
  }
  // A list item that is only a link is marked as one; a link inside a sentence is not.
  const { linkItems } = await import('../../site/lib/pages.mjs');
  assert.equal(linkItems('<ul>\n<li><a href="/docs/">All docs</a></li>\n<li>See <a href="/x/">x</a> first</li>\n</ul>'), '<ul>\n<li class="link-item"><a href="/docs/">All docs</a></li>\n<li>See <a href="/x/">x</a> first</li>\n</ul>');
  assert.match(siteFile('app/(site)/site-pages.tsx'), /export const sized = [^\n]*linkItems\(/, 'the content pages mark them');
  assert.match(siteFile('app/(site)/Sections.tsx'), /__html: linkItems\(html\)/, 'the landing page\'s bands mark them');
});

test('with scripts off no control that needs one is shown: the theme switch and the Copy buttons wait for a script', () => {
  // Seen 20 Nov 2026 with scripts off: the switch and three Copy buttons were drawn and did nothing when pressed.
  const { THEME_SCRIPT } = { THEME_SCRIPT: /THEME_SCRIPT = "(.*)";/.exec(siteFile('design/theme-script.ts'))[1] };
  assert.match(THEME_SCRIPT, /^document\.documentElement\.dataset\.js='1';/, 'the head\'s script marks the page first');
  const kit = siteFile('design/kit.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(kit, /:root:not\(\[data-js\]\) \.theme-switch, :root:not\(\[data-js\]\) \.copy \{ display: none; \}/);
  // The code blocks' Copy buttons are made by a script (PageScripts), so they never exist without one.
  // Their room is kept before the script runs, so nothing moves when they come (Lighthouse saw a shift of 0.02 there).
  // The room is beside the first line (seen 20 Nov 2026: 60 px above a one-line block read as an empty band).
  assert.match(siteFile('app/(site)/pages.css').replace(/\/\*[\s\S]*?\*\//g, ''), /:root\[data-js\] \.prose pre\[data-copyable\] \{ padding-right: 96px; min-height: 60px; \}/);
  assert.match(cssRule('app/(site)/pages.css', '.pre-copy'), /top: 8px; right: 8px;/);
  assert.match(siteFile('app/(site)/PageScripts.tsx'), /document\.createElement\('button'\)/);
});

test('every data cell of a content table has a header: its column\'s, and the row\'s name where the table has one', () => {
  // Lighthouse (td-has-header) on / at 20 Nov 2026: the comparison's cells were tied to no header, its first column of
  // row names was plain cells under an empty heading.
  let tables = 0;
  for (const p of pages) {
    for (const [t] of p.body.matchAll(/<table>[\s\S]*?<\/table>/g)) {
      tables++;
      const head = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(t)[1];
      const cols = [...head.matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/g)];
      const named = cols.map(([, tag, attrs, text]) => tag === 'th' && /scope="col"/.test(attrs) && !!text.trim());
      for (const [, row] of t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        if (row === head) continue;
        const cells = [...row.matchAll(/<(t[hd])\b([^>]*)>/g)];
        cells.forEach(([, tag, attrs], n) => {
          if (tag === 'th') return assert.match(attrs, /scope="row"/, `${p.url}: a row's name says it is one`);
          assert.ok(named[n], `${p.url}: a cell in column ${n + 1} without a column header: ${row.slice(0, 80)}`);
        });
      }
      if (!/<th\b[^>]*>\s*<\/th>/.test(head)) continue;
      assert.fail(`${p.url}: an empty column header (the row names' column has a plain cell there)`);
    }
  }
  assert.ok(tables >= 30, `the content tables are found (${tables})`);
  assert.match(pageOf('/').body, /<tr><th scope="row">Sets up a fresh computer for coding<\/th>/, 'the comparison names its rows');
});

test('the frame never offers "hoprig demo" to someone who has not installed: the command exists only after the install', () => {
  // Seen 20 Nov 2026: every use case said "Just looking? hoprig demo ...", which a visitor without Hoprig cannot run
  // (the package is not on npm, so there is no npx form, and there is no demo on the web).
  const frame = fs.readdirSync(path.join(root, 'site/app'), { recursive: true }).map(String).filter((f) => /\.(tsx?|mjs)$/.test(f));
  for (const f of frame) {
    const body = fs.readFileSync(path.join(root, 'site/app', f), 'utf8');
    for (const m of body.matchAll(/[^.]*hoprig demo<\/code>[^.]*\./g)) assert.match(m[0], /After the install/, `site/app/${f}: ${m[0].trim()}`);
  }
  assert.match(siteFile('app/(site)/Content.tsx'), /After the install, <code>hoprig demo<\/code> opens the dashboard with sample data\./);
});

test('a code block has a visible edge in both themes: its dark box is 1.02:1 against the dark page', () => {
  // Seen 20 Nov 2026 on /docs/install/ in dark: --console-bg #0a0c15 on --bg #0d0f17, and no border or ring.
  assert.match(cssRule('app/(site)/pages.css', '.prose pre'), /border: 1px solid var\(--border\)/);
});

test('the landing page\'s cards keep the kit\'s flex column: a card\'s last link sits at its foot, in line with the others', () => {
  // Seen 20 Nov 2026: pages.css made every .prose .card a block, so in "What does Hoprig do?" (a band inside .prose)
  // margin-top: auto did nothing and card 1's link sat 55 px lower than the others'.
  assert.doesNotMatch(cssRule('app/(site)/pages.css', '.prose .card'), /display:/, 'a band\'s card is the kit\'s (display: flex)');
  assert.match(cssRule('app/(site)/pages.css', '.page .prose .card'), /display: block/, 'the content pages keep their block cards');
  assert.match(cssRule('design/kit.css', '.card'), /display: flex; flex-direction: column;/);
  assert.match(cssRule('app/(site)/sections.css', '.band .cards.three .card p:last-child'), /margin-top: auto/);
});

test('the top bar hides what scrolls under it', () => {
  // Seen 20 Nov 2026 with the story moving: at 86 % its headings showed through the bar and ran into the menu's words,
  // and at 97 % a heading still showed as a ghost. So the bar is one token of the design system, solid in both themes,
  // with nothing see-through and no blur of what is behind it (site/scripts/bar-check.mjs compares its pixels).
  const bar = cssRule('app/(site)/frame.css', '.bar');
  const bg = /(?:^|;)\s*background: var\((--[\w-]+)\);/.exec(bar);
  assert.ok(bg, `the bar's background is one token: ${bar}`);
  assert.doesNotMatch(bar, /color-mix|transparent|rgba|hsla|opacity|backdrop-filter/, 'nothing see-through');
  const tokens = siteFile('design/tokens.css');
  const blocks = {
    light: /:root \{([^}]*)\}/.exec(tokens)?.[1],
    'dark by the system': /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/.exec(tokens)?.[1],
    'dark by choice': /:root\[data-theme='dark'\] \{([^}]*)\}/.exec(tokens)?.[1],
  };
  for (const [theme, block] of Object.entries(blocks)) {
    assert.ok(block, `the ${theme} tokens are found`);
    const value = new RegExp(`${bg[1]}: ([^;]+);`).exec(block)?.[1];
    assert.match(value || '', /^#[0-9a-f]{6}$/i, `${bg[1]} is an opaque colour in ${theme} (${value})`);
  }
});

test('a content page\'s reading line keeps to about 68 characters', () => {
  // Measured 20 Nov 2026 at 1440 px: /changelog/ read 95 characters a line, /docs/install/ 91, /skill/ 82.
  assert.match(cssRule('app/(site)/pages.css', '.page .prose > p, .page .prose > ul, .page .prose > ol, .page .prose > blockquote'), /max-width: 68ch/);
});

test('a Copy button is one piece of the kit wherever it stands, with a white ring on the dark console', async () => {
  // Seen 20 Nov 2026: a code block's Copy was an outlined button of pages.css whose ring was the accent on the console
  // (3.01:1), the install line's a filled kit button with a white ring, and the content's install lines a third style.
  assert.match(cssRule('design/kit.css', '.copy:focus-visible'), /outline: 2px solid #fff;/);
  assert.match(siteFile('app/(site)/PageScripts.tsx'), /b\.className = 'btn btn-primary btn-small copy pre-copy';/, 'a code block\'s Copy');
  assert.match(siteFile('design/CopyButton.tsx'), /className="btn btn-primary btn-small copy"/, 'the install line\'s Copy');
  const { installHtml } = await import('../../site/lib/pages.mjs');
  assert.match(installHtml(), /<button class="btn btn-primary btn-small copy" type="button"/, 'a content page\'s install line');
  assert.doesNotMatch(cssRule('app/(site)/pages.css', '.pre-copy'), /border|background|color|font/, 'nothing of its look outside the kit');
  assert.doesNotMatch(siteFile('app/(site)/pages.css'), /\.install \.copy/);
});

test('the story\'s screen labels are captions, not buttons: no pill, no shadow, and no label that reads as an action', async () => {
  // Seen 20 Nov 2026: a white rounded pill with a shadow said "Get started" under the first step; it was a figcaption,
  // and a newcomer took it for the start button.
  for (const sel of ['.pane-label', '.step-screens li']) {
    const r = cssRule('app/(site)/story.css', sel);
    assert.ok(r, `${sel} is styled`);
    assert.doesNotMatch(r, /border-radius|box-shadow|font: 6\d\d|font: 7\d\d/, `${sel}: a caption`);
    assert.match(r, /color: var\(--muted\)/, `${sel}: lighter text`);
  }
  const { SHOTS } = await import('../../site/app/(site)/story-data.mjs');
  for (const s of SHOTS) assert.doesNotMatch(s.label, /^(Get started|Start|Install|Try|Sign|Open|Continue)$/i, `${s.name}: "${s.label}" reads as a button`);
});

test('the step\'s screen names read as captions: no bar under the one in front, as tabs have', () => {
  // Seen 20 Nov 2026: the front screen's name was underlined in the accent colour, the way real tabs look; a newcomer
  // clicked one and nothing happened (they are aria-hidden captions).
  for (const sel of ['.step-screens li', '.step-screens li[data-now]']) assert.doesNotMatch(cssRule('app/(site)/story.css', sel, 'top'), /border/, `${sel}: no bar`);
  assert.match(cssRule('app/(site)/story.css', '.step-screens li[data-now]::before', 'top'), /background: var\(--accent\);/, 'the front one is marked by a dot');
});

test('the step at the limit says the plans and keys are the visitor\'s own and Hoprig stays free', async () => {
  // Seen 20 Nov 2026: the step 3 screen's biggest words were "Continue on Team plan" and "API (pay as you go)", which a
  // newcomer could take for Hoprig's own prices.
  const { STEPS } = await import('../../site/app/(site)/story-data.mjs');
  assert.match(STEPS.find((x) => x.id === 'limit').text, /your own plans and keys, while Hoprig itself stays free\./);
});

test('the story says in plain words what a session is and where Auto mode is, the first time it names them', async () => {
  // Seen 20 Nov 2026: "session" and "Auto mode" were in the story's headings and sentences with no word of what they are.
  const { STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const words = STEPS.flatMap((s) => [s.title, s.text]);
  const first = (re) => words.find((w) => re.test(w)) || '';
  assert.match(first(/\bsessions?\b/), /sessions? \(your conversations? with the AI\)/, 'session, at its first use');
  assert.match(first(/\bAuto mode\b/), /Auto mode, a choice on the Providers page,/, 'Auto mode, at its first use');
  for (const s of STEPS) assert.doesNotMatch(s.title, /\bAuto mode\b|\bgateways?\b/, `${s.id}: a heading a newcomer has to look up`);
});

test('the header\'s Install shows where it led: the install line is marked for a moment, also with reduced motion', () => {
  // Seen 20 Nov 2026 at 1440 px: a mouse click on Install moved the focus to Copy with no ring and did not scroll (the
  // line was in view), so nothing on screen changed.
  const jump = siteFile('app/(site)/InstallJump.tsx');
  assert.match(jump, /line\.classList\.add\('install-flash'\)/);
  // Seen 20 Nov 2026: a second press 1 s after the first lost its mark 0.2 s later, to the first press's timer.
  assert.match(jump, /clearTimeout\(flashTimer\);\n\s*flashTimer = setTimeout\(\(\) => line\.classList\.remove\('install-flash'\), 1200\);/, 'a new press ends the last one\'s timer');
  assert.match(cssRule('design/kit.css', '.install-flash'), /animation: install-flash/);
  assert.match(cssRule('design/kit.css', '.install-flash', '(prefers-reduced-motion: reduce)'), /animation: none; box-shadow: 0 0 0 4px var\(--accent\)/);
});

test('the story has no empty room above its screens: the still floor fits them, the moving one is pinned under the bar', () => {
  // Measured 20 Nov 2026 at 1440 px: each still desktop floor had 156 px of empty top and the gaps between the steps
  // were 223, 287, 262 and 188 px; with the motion on, about 300 px stood blank under the bar for the whole pin.
  // Only from 700 px: these selectors outweigh the phone's own floor rules, and at 390 px (measured 20 Nov 2026) they
  // made each desktop floor 180 px high with 219 px of screens in it, cut at the bottom with their captions gone.
  // Since 21 Nov 2026 the still desktop floor is a grid (the front screen over the two others): it is as tall as its
  // screens, with no aspect ratio and no screen placed up from its bottom.
  for (const [sel, body] of [[".story:not([data-motion='on']) .floor:not(.floor-tall)", /aspect-ratio: auto; perspective: none; display: grid;/], [".story:not([data-motion='on']) .floor:not(.floor-tall) .pane", /position: relative; inset: auto; width: auto; transform: none;/]]) {
    assert.match(cssRule('app/(site)/story.css', sel, '(min-width: 700px)'), body, `${sel}: from 700 px`);
    assert.equal(cssRule('app/(site)/story.css', sel, 'top'), '', `${sel}: not on a phone`);
  }
  // The moving form pins one stage per step right under the bar (61 px: 60 and its border).
  assert.match(cssRule('app/(site)/story.css', ".story[data-motion='on'] .step-stage", 'top'), /position: sticky; top: 61px;/);
});

test('every page\'s text has one h1 first and skips no heading level, so a screen reader\'s outline holds', () => {
  // Seen 20 Nov 2026: the use cases list put its cards' titles (h3) straight under the page's h1.
  const bad = [];
  for (const p of pages) {
    const levels = [...p.body.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    if (!levels.length) continue;
    if (levels[0] !== 1 || levels.filter((l) => l === 1).length !== 1) bad.push(`${p.url}: h1 ${levels.filter((l) => l === 1).length}, first h${levels[0]}`);
    for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) { bad.push(`${p.url}: h${levels[i - 1]} then h${levels[i]}`); break; }
  }
  assert.deepEqual(bad, []);
});

test('the picture a link shows is the site\'s own, from the demo, 1200 by 630, and says only what the landing page says', async () => {
  const { LINK_PICTURE, cardHtml, lightTokens, linkWords, visibleText } = await import('../../site/scripts/link-picture.mjs');
  const { imageSize } = await import('../../site/lib/images.mjs');
  const file = path.join(root, 'site', LINK_PICTURE.file);
  assert.deepEqual(imageSize(file), { width: 1200, height: 630 }, `${LINK_PICTURE.file} (site/scripts/link-picture.mjs makes it)`);
  assert.ok(fs.statSync(file).size <= 400 * 1024, `${LINK_PICTURE.file}: at most 400 KB`);
  // It is served at today's address, and every page names its size.
  assert.match(siteFile('scripts/public.mjs'), /copy\('site\/social\/link\.png', 'social-preview\.png'\)/);
  assert.match(siteFile('app/(site)/site-pages.tsx'), /social-preview\.png`, width: 1200, height: 630,/);
  // Its words are the name and the landing page's own headline; its colours are the light tokens; its picture the demo's.
  const words = linkWords(root);
  const { frontMatter } = await import('../../site/lib/markdown.mjs');
  assert.equal(words.title, frontMatter(fs.readFileSync(path.join(root, 'site/content/index.md'), 'utf8')).data.title);
  const t = lightTokens(siteFile('design/tokens.css'));
  assert.equal(t.bg, /^:root \{[\s\S]*?--bg: (#[0-9a-f]+)/m.exec(siteFile('design/tokens.css'))[1]);
  assert.doesNotMatch(Object.values(t).join(' '), /var\(/, 'every token written out');
  const html = cardHtml({ ...words, t, picture: 'p', logo: 'l' });
  assert.equal(visibleText(html), `${words.name} ${words.title}`.replace(/\s+/g, ' '), 'no word on the picture that the page does not say');
  assert.match(siteFile('scripts/link-picture.mjs'), /story\/home-light\.webp/, 'the demo\'s Home');
});

test('a footer list is named for a screen reader as it is headed on screen', () => {
  // Seen 20 Nov 2026: "For AI tools" on screen was "For agents" to a screen reader.
  const footer = siteFile('app/(site)/Footer.tsx');
  const navs = [...footer.matchAll(/<nav aria-label="([^"]+)">\s*<p className="foot-head">([^<]+)<\/p>/g)];
  assert.equal(navs.length, 2, 'both footer lists have a name and a heading');
  for (const [, label, head] of navs) assert.equal(label, head);
});

test('the public pages live in their own layout group, beside room for another frame', () => {
  assert.ok(fs.existsSync(path.join(root, 'site/app/(site)/layout.tsx')), 'app/(site)/layout.tsx is the public frame');
  assert.ok(fs.existsSync(path.join(root, 'site/app/(site)/page.tsx')), 'the landing page is in app/(site)/');
  const rootLayout = siteFile('app/layout.tsx');
  assert.doesNotMatch(rootLayout, /Header|Footer/, 'the root layout has no header or footer of the public site');
  assert.match(rootLayout, /design\/tokens\.css/);
  for (const f of fs.readdirSync(path.join(root, 'site/app'))) assert.ok(['layout.tsx', '(site)', 'not-found.tsx', 'favicon.ico'].includes(f) || f.startsWith('('), `site/app/${f}: a page outside a layout group`);
});

// ---------- the content layer (site/lib/pages.mjs), read by the Next pages at build time: no build needed ----------

// Every file the base's generator made (site/build.mjs at the start of the Next app), less the copied screenshots and
// brand files, which follow their own folders. The new site makes each one at the same address.
const BASE_FILES = fs.readFileSync(path.join(root, 'test/site/fixtures/base-files.txt'), 'utf8').trim().split('\n');
const pageUrlOf = (f) => (f === 'index.html' ? '/' : f === '404.html' ? '/404.html' : `/${f.replace(/index\.html$/, '')}`);

test('the content layer has a page for every address of today, with its title, description, body and twin', async () => {
  const { loadPages, mdUrlOf } = await import('../../site/lib/pages.mjs');
  const pages = await loadPages(root);
  const urls = new Set(pages.map((p) => p.url));
  assert.equal(urls.size, pages.length, 'each address once');
  for (const f of BASE_FILES.filter((x) => x.endsWith('.html'))) assert.ok(urls.has(pageUrlOf(f)), `no page for ${pageUrlOf(f)} (${f})`);
  for (const p of pages) {
    assert.ok(p.title && p.description && p.body.includes('<'), `${p.url}: a title, a description and a body`);
    assert.equal(p.mdUrl, mdUrlOf(p.url));
    assert.ok(BASE_FILES.includes(p.mdUrl.slice(1)) || !BASE_FILES.includes(`${p.url.slice(1)}index.html`), `${p.url}: its twin ${p.mdUrl} is at today's address`);
    assert.match(p.twin, /^# \S/m, `${p.url}: the twin has a title`);
    assert.doesNotMatch(p.body, /@@PART\d+@@|<p><!--/, `${p.url}: every part of the content is filled`);
  }
});

// ---------- the built landing page (needs the Next build) ----------

test('the built landing page sets its theme in the head, before any of its body', { skip: needsBuild }, async () => {
  const html = fs.readFileSync(path.join(await nextBuild(), 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('<body'));
  assert.ok(head.includes("localStorage.getItem('theme')"), 'the theme script is in the head');
  assert.match(html, /<a class="skip" href="#main">/, 'a skip link');
  assert.match(html, /<header class="bar">[\s\S]*<footer class="foot">/, 'the header and the footer');
});

test('on a phone the first screen says what to do there, and the install line breaks after a "/", never inside a word', async () => {
  // Seen 20 Nov 2026 at 390x844: the only action was Copy under "Paste this line into the Terminal app", which a phone
  // does not have, and the line wrapped mid-word ("allswebt / ech").
  const words = siteFile('app/(site)/words.ts');
  assert.ok(words.includes("phone: 'On a phone? Run this line on your computer, then scan the QR code it shows: the dashboard opens here.',"));
  const hero = siteFile('app/(site)/Hero.tsx');
  assert.match(hero, /<InstallLine command=\{INSTALL\} \/>\n\s*<p className="hero-phone">\{WORDS\.phone\}<\/p>/, 'right under the install line');
  assert.match(cssRule('app/(site)/landing.css', '.hero-phone', 'top'), /display: none;/, 'not on a computer');
  assert.match(cssRule('app/(site)/landing.css', '.hero-phone', '(max-width: 699px)'), /display: block;/, 'on a phone');
  // The line breaks after each "/" (a <wbr>), and a word is not cut where it need not be.
  const line = siteFile('design/InstallLine.tsx');
  assert.match(line, /const parts = command\.split\(\/\(\?<=\\\/\)\/\);/);
  assert.match(line, /parts\.map\(\(p, i\) => \(i \? \[<wbr key=\{i\} \/>, p\] : p\)\)/);
  const { INSTALL } = await import('../../site/lib/seo.mjs');
  assert.equal(INSTALL.split(/(?<=\/)/).join(''), INSTALL, 'the parts make the line as it is copied');
  assert.match(cssRule('design/kit.css', '.install code', '(max-width: 599px)'), /overflow-wrap: break-word;/);
  assert.doesNotMatch(cssRule('design/kit.css', '.install code', '(max-width: 599px)'), /anywhere/);
});

test('the landing page\'s first screen is plain HTML: the facts, the headline, the second line, the install line and one picture', { skip: needsBuild }, async () => {
  const { INSTALL } = await import('../../site/lib/seo.mjs');
  const { frontMatter } = await import('../../site/lib/markdown.mjs');
  const { data } = frontMatter(fs.readFileSync(path.join(root, 'site/content/index.md'), 'utf8'));
  const html = fs.readFileSync(path.join(await nextBuild(), 'index.html'), 'utf8');
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const hero = /<div class="hero">([\s\S]*?)<div class="stage-fade"/.exec(html)?.[1];
  assert.ok(hero, 'the first screen is in the built HTML');
  assert.equal(text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(hero)[1]), data.title, 'the headline is the content\'s title');
  assert.ok(text(hero).includes(data.lead), 'the second line is the content\'s lead');
  assert.match(hero, /<li class="chip">[\s\S]*Free/, 'Free is said first');
  // Seen 20 Nov 2026: the first screen said "Free" and nothing of what costs money, and showed a shell line with no word
  // of where it goes; both were said only far down the page.
  const COST = 'Hoprig is free; the AI is not: it uses your own Claude plan or API key.';
  const PASTE = 'Paste this line into the Terminal app and press Enter.';
  for (const w of [COST, PASTE]) assert.ok(siteFile('app/(site)/words.ts').includes(`'${w}'`), `a frame word of words.ts: ${w}`);
  assert.ok(text(hero).includes(COST), 'the first screen says that the AI is the visitor\'s own plan or key');
  assert.ok(text(hero).includes(PASTE), 'the first screen says where the line goes');
  assert.match(hero, /<a href="\/use-cases\/not-a-developer\/">New to this\? Start here<\/a>/, 'and leads a newcomer to the page that walks through it');
  assert.ok(hero.indexOf('Terminal app') < hero.indexOf('id="install"') && hero.indexOf('id="install"') < hero.indexOf('your own Claude plan'), 'over the line where it goes, under it what costs money');
  // One main action: the only button of the first screen is Copy, and it copies exactly the install line.
  const buttons = [...hero.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 1, 'one button on the first screen');
  assert.ok(buttons[0].includes(`data-copy="${INSTALL.replace(/&/g, '&amp;')}"`) || buttons[0].includes(`data-copy="${INSTALL}"`), 'Copy copies the install line');
  assert.ok(text(/<code id="install-cmd">([\s\S]*?)<\/code>/.exec(hero)[1]).endsWith(INSTALL), 'the line shown is the line copied');
  const imgs = [...hero.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 1, 'one picture');
  for (const a of ['width="', 'height="', 'fetchPriority="high"']) assert.ok(imgs[0].includes(a), `the picture has ${a}`);
  assert.match(imgs[0], /alt="[^"]{30,}"/, 'the picture is described');
  assert.match(imgs[0], /src="\/story\/home-light\.webp"/, 'a picture of the demo (site/story)');
  assert.match(hero, /<source data-dark="true" media="\(prefers-color-scheme: dark\)" srcSet="\/story\/home-dark-640\.webp 640w, \/story\/home-dark\.webp 1280w"/, 'its dark form for a dark page');
  // Seen 20 Nov 2026 at 390x844: the whole desktop Home shrunk to 356 px, its words about 4 px tall. On a phone the
  // picture is Home at phone width from its top, in either theme, also a chosen one (data-width keeps the width).
  assert.match(hero, /<picture><source data-dark="true" data-width="\(max-width: 699px\)" media="\(max-width: 699px\) and \(prefers-color-scheme: dark\)" srcSet="\/story\/home-dark-phone-top\.webp" width="780" height="1040"\/><source media="\(max-width: 699px\)" srcSet="\/story\/home-light-phone-top\.webp" width="780" height="1040"\/><source data-dark="true" media="\(prefers-color-scheme: dark\)"/, 'the phone picture first, dark then light');
  // The header's Install leads to the install line; it is not a second destination.
  assert.match(html, /<a class="btn btn-primary btn-small bar-install" href="\/#install" data-install-jump="true">Install<\/a>/);
});

// ---------- every page of today in the new frame ----------

const pageText = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('every page of today is built as HTML in the public frame, with its title and its place in the menu', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  for (const f of BASE_FILES.filter((x) => x.endsWith('.html'))) {
    assert.ok(fs.existsSync(path.join(out, f)), `the Next build makes ${f}`);
    const page = fs.readFileSync(path.join(out, f), 'utf8');
    assert.match(page, /<a class="skip" href="#main">[\s\S]*<header class="bar">[\s\S]*<main id="main"[\s\S]*<\/main>[\s\S]*<footer class="foot">/, `${f}: the skip link, the header, the page and the footer`);
    assert.match(page, /<h1\b/, `${f}: a heading`);
    const top = NAV_TOPS.find((t) => `/${f}`.startsWith(t));
    if (top) assert.match(page, new RegExp(`<a href="${top}" aria-current="page">`), `${f}: the menu marks ${top}`);
  }
  // The 404 page says it in its own words and is not indexed.
  const missing = fs.readFileSync(path.join(out, '404.html'), 'utf8');
  assert.ok(pageText(missing).includes('This page does not exist'), 'the 404 page is the content\'s');
  assert.match(missing, /<meta name="robots" content="noindex"\/?>/);
});
const NAV_TOPS = ['/use-cases/', '/docs/', '/compare/', '/tools/', '/changelog/'];

test('the docs pages show the docs\' own text, with their side menu', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const { loadPages } = await import('../../site/lib/pages.mjs');
  const { renderMarkdown } = await import('../../site/lib/markdown.mjs');
  const docs = (await loadPages(root)).filter((p) => p.kind === 'doc');
  assert.ok(docs.length >= fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).length, 'every docs/*.md is a page');
  for (const p of docs) {
    const page = fs.readFileSync(path.join(out, p.url.slice(1), 'index.html'), 'utf8');
    const article = /<article class="prose[^"]*" data-content="true">([\s\S]*?)<\/article>/.exec(page)?.[1];
    assert.ok(article, `${p.url}: the doc's text in an article`);
    // The text of the source itself, rendered on its own: the page says exactly that, nothing cut, nothing added.
    const source = p.file === 'README.md' ? p.markdown : fs.readFileSync(path.join(root, p.file), 'utf8');
    // The frame's hint under a screenshot ("Open full size") is the site's, not the doc's.
    const own = article.replace(/<span class="enlarge">[\s\S]*?<\/span><\/span>/g, '');
    assert.equal(pageText(own), pageText(renderMarkdown(source, { link: () => '#', copy: 'one' }).html), `${p.url}: the text of ${p.file}`);
    assert.match(page, new RegExp(`<nav class="side-wide" aria-label="Docs">[\\s\\S]*<a href="${p.url}" aria-current="page">`), `${p.url}: the side menu marks it`);
  }
});

// ---------- the files after the build: twins, llms.txt, sitemap, robots, CNAME, the policy ----------

test('the new build makes every file the base\'s build made, at the same address', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const made = new Set(builtFiles(out));
  // The old generator's one stylesheet and one script are Next's own files under /_next/ now.
  const replaced = new Set(['style.css', 'site.js']);
  assert.deepEqual(BASE_FILES.filter((f) => !made.has(f) && !replaced.has(f)), []);
  // The copied folders come along whole.
  for (const dir of ['screenshots', 'assets']) for (const f of fs.readdirSync(path.join(root, dir === 'screenshots' ? 'docs/screenshots' : 'assets')).filter((x) => dir === 'screenshots' || /\.(svg|png)$/.test(x))) assert.ok(made.has(`${dir}/${f}`), `${dir}/${f}`);
});

test('the twins, llms.txt, llms-full.txt, the sitemap, robots.txt and CNAME come from the pages the HTML was made from', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  const { loadPages } = await import('../../site/lib/pages.mjs');
  const pages = await loadPages(root);
  for (const p of pages) {
    const file = p.url === '/' ? 'index.html' : p.url === '/404.html' ? '404.html' : `${p.url.slice(1)}index.html`;
    assert.equal(read(p.mdUrl.slice(1)), p.twin, `${p.mdUrl}: the twin`);
    assert.ok(read(file).includes(`<link rel="alternate" type="text/markdown" href="https://hoprig.com${p.mdUrl}" title="This page as Markdown"/>`), `${file} points to its twin`);
    assert.match(read(file), new RegExp(`<a href="${p.mdUrl.replace(/[.]/g, '\\.')}">This page as Markdown</a>`), `${file}: the footer links its own twin`);
  }
  const listed = pages.filter((p) => p.url !== '/404.html');
  for (const p of listed) {
    assert.ok(read('sitemap.xml').includes(`<loc>https://hoprig.com${p.url}</loc>`), `the sitemap lists ${p.url}`);
    assert.ok(read('llms-full.txt').includes(`<!-- https://hoprig.com${p.url} -->`), `llms-full.txt holds ${p.url}`);
  }
  assert.doesNotMatch(read('sitemap.xml'), /404/);
  for (const p of listed.filter((x) => ['usecase', 'doc', 'compare'].includes(x.kind))) assert.ok(read('llms.txt').includes(`(https://hoprig.com${p.mdUrl})`), `llms.txt lists ${p.mdUrl}`);
  assert.equal(read('CNAME'), 'hoprig.com\n');
  assert.match(read('robots.txt'), /^User-agent: \*\nAllow: \/[\s\S]*User-agent: ClaudeBot\nAllow: \/[\s\S]*Sitemap: https:\/\/hoprig\.com\/sitemap\.xml\n$/);
  assert.equal(read('skill/SKILL.md'), fs.readFileSync(path.join(root, 'templates/skills/hoprig/SKILL.md'), 'utf8'));
  assert.ok(fs.existsSync(path.join(out, '.nojekyll')), 'GitHub Pages serves the _next folder (no Jekyll)');
});

test('every built page carries a policy first in its head that allows its own inline scripts by their hashes, and nothing else', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const { inlineScripts } = await import('../../site/scripts/after-build.mjs');
  const html = builtFiles(out).filter((f) => f.endsWith('.html'));
  assert.ok(html.length >= 52, 'every page');
  for (const f of html) {
    const page = fs.readFileSync(path.join(out, f), 'utf8');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"\/>/.exec(page);
    assert.ok(csp, `${f} has a content security policy`);
    assert.ok(page.indexOf(csp[0]) < page.search(/<script|<link rel="stylesheet"/), `${f}: the policy comes before any script or style`);
    assert.match(csp[1], /^default-src 'none'; script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self';/, `${f}: only the site's own files`);
    assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval|\*|https?:/, f);
    const allowed = new Set([...csp[1].matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]));
    const inline = inlineScripts(page);
    assert.ok(inline.length >= 1, `${f}: the theme script at least`);
    for (const s of inline) assert.ok(allowed.has(createHash('sha256').update(s).digest('base64')), `${f}: an inline script without its hash: ${s.slice(0, 80)}`);
    assert.equal(allowed.size, new Set(inline).size, `${f}: no hash of a script the page does not have`);
    assert.doesNotMatch(page, /\sstyle="|<style\b|\son[a-z]+="/i, `${f}: an inline style or event handler, which the policy blocks`);
  }
});

test('no built file asks another origin for anything, and none holds a home path, a build path, an e-mail address or a private name', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const found = [];
  for (const f of builtFiles(out).filter((x) => /\.(html|css|js|txt|md|xml)$/.test(x))) {
    const body = fs.readFileSync(path.join(out, f), 'utf8');
    if (body.includes(root) || body.includes(os.homedir()) || /\.test-out-|\/_next\/static\/[^"]*\/home\//.test(body)) found.push(`${f}: a path of this computer or of the build`);
    found.push(...privateIn(f, unflight(body))); // Next's page data writes ">git@…" as "\u003egit@…"
    if (f.endsWith('.html')) {
      // What a page loads by itself: scripts, styles, pictures, frames, preloads. A link a person follows is not asked for.
      for (const m of body.matchAll(/<(script|link|img|source|iframe|video|audio)\b[^>]*>/g)) {
        if (m[1] === 'link' && !/rel="(stylesheet|preload|modulepreload|icon|apple-touch-icon|manifest|prefetch|preconnect|dns-prefetch)"/.test(m[0])) continue;
        for (const a of m[0].matchAll(/\s(?:src|href|srcSet|srcset)="([^"]*)"/g)) if (/(^|[\s,])(https?:)?\/\//.test(a[1])) found.push(`${f}: ${m[1]} from ${a[1]}`);
      }
    }
    if (f.endsWith('.css')) for (const m of body.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^)'"]+)/g)) found.push(`${f}: ${m[1]}`);
    if (f.endsWith('.css')) for (const m of body.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) found.push(`${f}: @import ${m[1]}`);
  }
  assert.deepEqual(found, []);
});

// ---------- more than today: every page, not only the landing ----------

test('nothing of a paid version on any built page: no price, no sign-in, no account, no "Pro", no address for them', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  // "Sign in" is not in the list: the content speaks of signing in to git and to a Claude account. A way into an
  // account or sign-in area of the site is caught by its address, above.
  const PAID = /\bPro\b|\$\s?\d|€\s?\d|\bper month\b|\bpricing\b|\bsign up\b|\bsubscribe\b|\blog ?in\b|\bmy account\b|\bcheckout\b/i;
  for (const f of builtFiles(out).filter((x) => x.endsWith('.html'))) {
    const page = fs.readFileSync(path.join(out, f), 'utf8');
    // The site's own words: everything but the content's text (a doc may speak of a Claude subscription or /login).
    const frame = page.replace(/<article class="prose[^"]*" data-content="true">[\s\S]*?<\/article>/g, '');
    assert.doesNotMatch(f === 'index.html' ? page : frame, /<a [^>]*href="\/(account|login|signin|sign-in|signup|pricing|pro|billing|checkout)\b/i, `${f}: a link into a paid area`);
    const words = pageText(frame.slice(frame.indexOf('<body')));
    const hit = PAID.exec(words);
    assert.ok(!hit, `${f}: "${hit?.[0]}" in the site's own words`);
  }
});

test('every built page sets its theme before the first paint and starts with a skip link to its content', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  for (const f of builtFiles(out).filter((x) => x.endsWith('.html'))) {
    const page = fs.readFileSync(path.join(out, f), 'utf8');
    const head = page.slice(0, page.indexOf('<body'));
    assert.ok(head.includes("localStorage.getItem('theme')"), `${f}: the theme script is in the head`);
    const body = page.slice(page.indexOf('<body'));
    assert.match(body, /^<body[^>]*>(?:<div hidden=""><!--\$--><!--\/\$--><\/div>)?<a class="skip" href="#main">Skip to the content<\/a>/, `${f}: the skip link comes first`);
    assert.equal((page.match(/<main id="main"/g) || []).length, 1, `${f}: one main`);
    assert.equal((page.match(/<h1\b/g) || []).length, 1, `${f}: one h1`);
  }
});

// ---------- the landing page's story: words and still pictures in the HTML ----------

test('every picture of the story is in site/story in both themes, sized for where it is shown, as WebP', async () => {
  const { SHOTS, STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const { imageSize } = await import('../../site/lib/images.mjs');
  const files = new Set(fs.readdirSync(path.join(root, 'site/story')));
  for (const s of SHOTS) {
    assert.ok(s.alt && s.alt.length >= 30 && s.label, `${s.name}: a description and a label`);
    for (const theme of ['light', 'dark']) {
      // A phone screen and every desktop screen's phone form at 780×1688 (390×844 at 2×: at 585 px the phone's story drew
      // them 1.2× up, soft); the moving story's front screen at 1088×680 and 2176×1360, a texel a device pixel at 1440.
      const want = s.phone ? [[`${s.name}-${theme}.webp`, 780, 1688]] : [[`${s.name}-${theme}.webp`, 1280, 800], [`${s.name}-${theme}-640.webp`, 640, 400], [`${s.name}-${theme}-1088.webp`, 1088, 680], [`${s.name}-${theme}-2176.webp`, 2176, 1360], [`${s.name}-${theme}-phone.webp`, 780, 1688]];
      for (const [f, w, h] of want) {
        assert.ok(files.has(f), `site/story/${f} is there (site/scripts/story-shots.mjs makes it)`);
        assert.deepEqual(imageSize(path.join(root, 'site/story', f)), { width: w, height: h }, `${f}: ${w}×${h}`);
        assert.ok(fs.statSync(path.join(root, 'site/story', f)).size <= 140 * 1024, `${f}: at most 140 KB`);
      }
    }
  }
  // Nothing in the folder that the story does not show, and every step has three screens it knows.
  const names = new Set(SHOTS.map((s) => s.name));
  for (const f of files) assert.ok(names.has(f.replace(/-(light|dark)(-640|-1088|-2176|-phone|-phone-top)?\.webp$/, '')), `site/story/${f} is not one of the story's pictures`);
  // The first screen's picture on a phone: Home from its top at phone width, 780×1040, within that screen's budget.
  for (const f of [...files].filter((x) => x.endsWith('-phone-top.webp'))) assert.match(f, /^home-(light|dark)-phone-top\.webp$/, `${f}: only Home has a phone top`);
  for (const theme of ['light', 'dark']) {
    const f = path.join(root, 'site/story', `home-${theme}-phone-top.webp`);
    assert.deepEqual(imageSize(f), { width: 780, height: 1040 }, `home-${theme}-phone-top.webp: 780×1040`);
    assert.ok(fs.statSync(f).size <= 60_000, `home-${theme}-phone-top.webp: within the first screen's picture budget`);
  }
  assert.equal(STEPS.length, 4);
  for (const step of STEPS) {
    assert.equal(step.panes.length, 3, `${step.id}: three screens`);
    for (const p of step.panes) assert.ok(names.has(p), `${step.id}: ${p} is a picture of the story`);
  }
});

test('the story is in the built HTML: per step a heading, its sentence and its three described pictures', { skip: needsBuild }, async () => {
  const { SHOTS, STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const out = await nextBuild();
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const unescape = (s) => s.replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const step of STEPS) {
    const part = new RegExp(`<li class="step" id="story-${step.id}"[\\s\\S]*?</ul></div></div></li>`).exec(html)?.[0];
    assert.ok(part, `${step.id}: a section of its own`);
    assert.ok(unescape(part).includes(`>${step.title}</h3>`), `${step.id}: its heading`);
    assert.ok(unescape(part).includes(step.text), `${step.id}: its sentence`);
    for (const name of step.panes) {
      const s = SHOTS.find((x) => x.name === name);
      // One picture per screen: the light file in the <img>, the dark one in a source the theme picks, so only the
      // shown one is fetched (seen 20 Nov 2026 with scripts off: both themes' 41 files, 1.2 MB, on a phone).
      const pic = new RegExp(`<picture>(?:<source[^>]*-phone\\.webp"[^>]*/?>){0,2}<source data-dark="true" media="\\(prefers-color-scheme: dark\\)" srcSet="/story/${name}-dark[^"]*"[^>]*/?><img[^>]*src="/story/${name}-light\\.webp"[^>]*></picture>`).exec(part)?.[0];
      assert.ok(pic, `${step.id}: ${name} as one picture, the dark file in its source`);
      const img = /<img[^>]*>/.exec(pic)[0];
      assert.ok(unescape(img).includes(`alt="${s.alt}"`), `${name}: described`);
      assert.match(img, /width="\d+" height="\d+"/, `${name}: its size`);
      assert.match(img, /loading="lazy"/, `${name}: loaded when it comes near`);
      assert.equal((part.match(new RegExp(`/story/${name}-light\\.webp"`, 'g')) || []).length, 1, `${name}: one <img>, not one per theme`);
      assert.ok(unescape(part).includes(`>${s.label}</figcaption>`), `${name}: its label is text, not only in the picture`);
      assert.ok(fs.existsSync(path.join(out, 'story', `${name}-light.webp`)), `${name}: copied into the built site`);
    }
  }
});

test('on a phone the still story shows each desktop screen at phone width, in either theme, also a chosen one', () => {
  // Seen 20 Nov 2026 at 390 px with WebGL refused: the still story showed whole desktop screens shrunk to 335 px.
  const pic = siteFile('app/(site)/Pic.tsx');
  assert.match(pic, /const NARROW = '\(max-width: 699px\)';/);
  assert.match(pic, /<source data-dark data-width=\{NARROW\} media=\{`\$\{NARROW\} and \(prefers-color-scheme: dark\)`\} srcSet=\{phoneSet\('dark'\)\}/, 'the dark phone picture first');
  assert.match(pic, /<source media=\{NARROW\} srcSet=\{phoneSet\('light'\)\}/, 'then the light one');
  assert.ok(pic.indexOf('phoneSet(\'light\')}') < pic.indexOf('media="(prefers-color-scheme: dark)"'), 'both before the wide sources');
  // A chosen theme keeps the width: dark chosen gives the narrow dark source its width alone, light chosen turns it off.
  const { THEME_SCRIPT } = { THEME_SCRIPT: /THEME_SCRIPT = "(.*)";/.exec(siteFile('design/theme-script.ts'))[1] };
  const src = (width) => ({ nodeType: 1, attrs: { 'data-width': width }, media: '', getAttribute(n) { return this.attrs[n] ?? null; }, matches: () => true, querySelectorAll: () => [] });
  for (const [theme, width, want] of [['dark', '(max-width: 699px)', '(max-width: 699px)'], ['dark', null, 'all'], ['light', '(max-width: 699px)', 'not all']]) {
    const s = src(width);
    let observer;
    const doc = { documentElement: { dataset: {} }, };
    new Function('document', 'localStorage', 'MutationObserver', 'addEventListener', THEME_SCRIPT)(
      { ...doc, documentElement: doc.documentElement },
      { getItem: () => theme },
      class { constructor(f) { observer = f; } observe() {} disconnect() {} },
      () => {},
    );
    observer([{ addedNodes: [s] }]);
    assert.equal(s.media, want, `${theme} chosen, a source for ${width || 'every width'}`);
  }
  assert.match(siteFile('design/ThemeSwitch.tsx'), /const media = !w \|\| base === 'not all' \? base : base === 'all' \? w : `\$\{w\} and \$\{base\}`;/, 'the switch keeps the width too');
  assert.match(cssRule('app/(site)/story.css', '.floor:not(.floor-tall) .pic', '(max-width: 699px)'), /aspect-ratio: 3 \/ 4; object-fit: cover; object-position: top;/, 'shown from its top');
});

test('the still story on a desktop shows one big screen per step, under its words, as the moving form at rest', () => {
  // Seen 20 Nov 2026 at 1440x900 with reduced motion (also what a slow window and no WebGL show): each step's front
  // screen was about 415 by 260 px beside a 320 px column of words, "2 things to fix" about 5 px tall; the moving form's
  // was 1115 px and readable.
  const css = (sel, media) => cssRule('app/(site)/story.css', sel, media);
  assert.match(css(".story:not([data-motion='on']) .floor:not(.floor-tall)", '(min-width: 700px)'), /display: grid; grid-template-columns: 1fr 1fr;/);
  assert.match(css(".story:not([data-motion='on']) .floor:not(.floor-tall) .pane-b", '(min-width: 700px)'), /grid-column: 1 \/ -1; order: -1;/, 'the front screen first, across the floor');
  // From 1000 px the words stand over the screens (one column), the sentence beside the heading.
  assert.match(css(".story:not([data-motion='on']) .step", '(min-width: 1000px)'), /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css(".story:not([data-motion='on']) .step-words", '(min-width: 1000px)'), /display: grid;/);
  // The big screen takes the files made for the moving story's front screen (1088 and 2176 px), sized for its width.
  const tsx = siteFile('app/(site)/Story.tsx');
  assert.match(tsx, /i === 1 \? '\(max-width: 699px\) 86vw, \(max-width: 1179px\) 92vw, 1124px'/);
  assert.match(siteFile('app/(site)/Pic.tsx'), /\$\{s\.name\}-\$\{theme\}-1088\.webp 1088w, [^`]*\$\{s\.name\}-\$\{theme\}-2176\.webp 2176w/);
});

// ---------- the moving story: three.js over the still story, loaded late ----------

test('the 3D story loads three.js by a dynamic import, after the page has loaded, only with WebGL and without reduced motion', () => {
  const loader = siteFile('app/(site)/StoryMotion.tsx');
  assert.match(loader, /await import\('\.\/story-motion\/scene\.mjs'\)/, 'a dynamic import, not a static one');
  assert.doesNotMatch(loader, /^import .*(three|scene\.mjs)/m, 'nothing of the 3D code is imported statically');
  assert.match(loader, /prefers-reduced-motion: reduce/);
  assert.match(loader, /if \(io \|\| ended \|\| reduce\.matches \|\| !webgl\(\)\) return;/, 'no WebGL or reduced motion: nothing is loaded');
  assert.match(loader, /addEventListener\('load', idle/, 'after the page has loaded');
  // The story stands right under the first screen: without waiting for a scroll, everyone would fetch the 3D code.
  assert.match(loader, /requestIdleCallback\(arm,/, 'when idle, it only gets ready');
  assert.match(loader, /if \(scrollY > 0\) begin\(\); else addEventListener\('scroll', begin, \{ once: true, passive: true \}\)/, 'and begins at the first scroll');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /canvas\.setAttribute\('aria-hidden', 'true'\)/, 'the canvas is hidden from screen readers');
  // A phone draws at its own pixel ratio (up to 2) with pictures of its own size: seen 20 Nov 2026 at ratio 1 with the
  // half-size ones, its screens were soft and unreadable beside the sharp still story.
  assert.match(scene, /const ratio = \(\) => Math\.min\(devicePixelRatio \|\| 1, 2\);[\s\S]*r\.setPixelRatio\(ratio\(\)\);/, 'every screen draws at its pixel ratio, up to 2');
  assert.match(scene, /L\.form === 'tall' \? '-phone'/, 'a floor higher than wide takes the dashboard at phone width');
  assert.match(scene, /const pace = paceLadder\(\{ lean: software, onLean: [^\n]*, onSlow \}\);/, 'a window that cannot hold the frame rate gets the still story');
  // No animation library: the site's tools are exactly these.
  assert.deepEqual(Object.keys(sitePkg.dependencies).sort(), ['next', 'react', 'react-dom', 'sharp', 'three']);
});

test('a pinned step\'s ring runs from the step\'s own position: 0 when its stage reaches the bar, 1 when it is let go', async () => {
  const { pinProgress } = await import('../../site/app/(site)/story-motion/ring.mjs');
  // A step 3240 px high whose stage is 839 px (900 - the bar's 61): it runs while its top goes from 61 to 61 - 2401.
  assert.equal(pinProgress(400, 3240, 839, 61), 0, 'not reached yet');
  assert.equal(pinProgress(61, 3240, 839, 61), 0, 'at the start');
  assert.equal(pinProgress(61 - 2401 / 2, 3240, 839, 61), 0.5, 'half way');
  assert.equal(pinProgress(-5000, 3240, 839, 61), 1, 'past');
  assert.equal(pinProgress(0, 800, 839, 61), 0, 'a step no longer than its stage does not run');
});

// The band of the step's words as Chrome lays it out on the built site, each step held (site/scripts/stage-check.mjs
// holds the table and checks it, and the screens the scene draws, against the browser): from the bar's bottom (61 px)
// to a height of each step; the floor is the rest of the window. Seen 21 Nov 2026: a table of four sizes, written by
// hand, passed while 700x900 drew the front screen 340 px under the words.
const wordsOf = (size, step) => { const r = STAGES[size]; return [r.left, 61, r.right, r.bottom[step]]; };
const stageOf = async (size, phones, step = phones ? 'phone' : 'ready') => {
  const R = await import('../../site/app/(site)/story-motion/ring.mjs');
  const [W, H] = size.split('x').map(Number);
  const words = wordsOf(size, step);
  const L = R.layout({ W, H: H - words[3], phones });
  // A screen's corners in the window: the floor starts under the words.
  const at = (t) => R.ringState(t, L).map((st) => ({ ...st, quad: st.quad.map(([x, y]) => [x, y + words[3]]) }));
  return { R, W, H, words, L, at, empty: (t) => R.emptyShare({ screens: at(t), words, W, H, top: 61 }) };
};

test('while a step is pinned, its stage fills the window under the bar: at most 10 % empty at every size named', async () => {
  // Seen 20 Nov 2026 at 1440x900 (the first pass): the stage took the upper 45 % of the window and about 350 px under
  // it stood empty. Seen 21 Nov 2026 at 700x900: the step's words ended at 224, the front screen started at 566 and
  // was 508 px wide. Measured as the design step did (16 px cells covered neither by the words nor by a screen), and
  // as stage-check.mjs measures the browser: the front screen right under the words, down to the window's bottom.
  assert.deepEqual(Object.keys(STAGES).sort(), ['1024x768', '1280x720', '1440x900', '1920x1080', '390x844', '700x900', '768x1024', '820x1180', '999x700']);
  // Every size and step first, then one assertion: a failure names each place that breaks, not only the first.
  const faults = [];
  for (const size of Object.keys(STAGES)) for (const step of Object.keys(STAGES[size].bottom)) {
    const phones = step === 'phone';
    const { R, W, H, L, at, words, empty } = await stageOf(size, phones, step);
    for (const t of [0, 1, 2]) {
      const front = R.box(at(t).find((st) => st.i === t && Math.abs(st.d) < 0.01).quad);
      const e = empty(t);
      const where = `${size} ${step}, screen ${t + 1} pinned (${L.form}, front ${L.w}x${L.h} at ${front.map(Math.round).join(',')})`;
      if (e > 0.1) faults.push(`${where}: ${(e * 100).toFixed(1)} % empty`);
      if (!(front[3] <= H && front[3] >= H - 32)) faults.push(`${where}: the front screen does not stand within 32 px of the window's bottom`);
      for (const f of stageFaults({ W, H, words, front, screens: at(t) })) faults.push(`${where}: ${f}`);
    }
    if (L.form === 'wide') {
      const boxes = at(1).filter((st) => st.alpha > 0.2).map((st) => R.box(st.quad));
      if (!(Math.min(...boxes.map((b) => b[0])) <= 0 && Math.max(...boxes.map((b) => b[2])) >= W)) faults.push(`${size} ${step}: the side screens do not reach the window's edges`);
    }
  }
  assert.deepEqual([...new Set(faults)], [], 'every pinned stage fills the window');
  // The scene writes the front screen it drew, so stage-check.mjs compares the browser with these numbers.
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const front = pose\(s, L, s\.t, taps\)\.map\(Math\.round\)\.join\(','\);/);
  assert.match(scene, /if \(s\.li\.dataset\.front !== front\) s\.li\.dataset\.front = front;/);
  assert.match(fs.readFileSync(path.join(root, 'site/scripts/stage-check.mjs'), 'utf8'), /li\.dataset\.front/, 'and the check reads it');
  // The stage is the window under the bar, pinned there: its words at the top, the floor the rest of it.
  const css = (sel) => cssRule('app/(site)/story.css', sel, 'top');
  assert.match(css(".story[data-motion='on'] .step-stage"), /position: sticky; top: 61px; height: calc\(100vh - 61px\); height: calc\(100svh - 61px\);/);
  assert.match(css(".story[data-motion='on'] .step-words"), /flex: none;/);
  assert.match(css(".story[data-motion='on'] .step-floor"), /flex: 1 1 auto; min-height: 0;/);
});

test('the screen in front is big and sharp at 1440x900: a texel a device pixel, no blur, no dimming, no tint', async () => {
  // Seen 20 Nov 2026 (the first pass): the front screen about 560 px wide, its words unreadable, soft and washed out.
  const { R, L, at } = await stageOf('1440x900', false);
  assert.ok(L.w >= 1060, `the front screen is ${L.w} px wide`);
  const front = at(1).find((st) => st.i === 1);
  assert.deepEqual([front.blur, front.dim, front.alpha, front.ry], [0, 0, 1, 0], 'sharp, full contrast, facing the visitor');
  // At depth 0 a unit is a CSS pixel: the front screen lands on its own box, not scaled.
  const b = R.box(front.quad);
  assert.ok(Math.abs(b[2] - b[0] - L.w) < 0.01 && Math.abs(b[3] - b[1] - L.h) < 0.01, 'drawn at its own size');
  // Its picture is taken at its size (story-shots.mjs: the dashboard at 1088×680, at 1× and 2×).
  for (const dpr of [1, 2]) {
    const px = R.frontSize(L.w, dpr);
    const ratio = (L.w * dpr) / px;
    assert.ok(ratio > 0.9 && ratio < 1.1, `pixel ratio ${dpr}: ${px} px picture drawn ${ratio.toFixed(3)}× (a texel about a device pixel)`);
  }
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const ratio = \(\) => Math\.min\(devicePixelRatio \|\| 1, 2\);[\s\S]*r\.setPixelRatio\(ratio\(\)\);/, 'the device\'s pixel ratio, up to 2');
  assert.match(scene, /r\.toneMapping = NoToneMapping;/);
  assert.match(scene, /t\.colorSpace = SRGBColorSpace; t\.anisotropy = aniso;/);
  assert.match(scene, /aniso = gl\.capabilities\.getMaxAnisotropy\(\);/, 'the highest anisotropy');
  assert.doesNotMatch(scene, /generateMipmaps = false|Fog\b|\.fog\b/, 'mipmaps, no fog');
  assert.match(scene, /\$\{frontSize\(L\.w, devicePixelRatio\)\}/, 'the picture for the front screen\'s size');
});

test('the moving story is judged all the time it moves: fast at first and slow later still gets the still story', async () => {
  // Measured 20 Nov 2026: 16.7 ms over the first 90 frames, which come before the costly part of the scroll, then a
  // median of 50 ms with a floor in view; the motion stayed on at about 20 frames a second.
  const { slowWatch } = await import('../../site/app/(site)/story-motion/pace.mjs');
  const run = (frames) => { const watch = slowWatch(); return frames.map(watch).filter(Boolean); };
  const fastThenSlow = run([...Array(90).fill(16.7), ...Array(120).fill(50)]);
  assert.ok(fastThenSlow.some((j) => j.slow), 'slow after a fast start');
  assert.equal(fastThenSlow.find((j) => j.slow).median, 50);
  assert.ok(!fastThenSlow.slice(0, 2).some((j) => j.slow), 'not while it was fast');
  assert.ok(run(Array(600).fill(16.7)).every((j) => !j.slow), 'never while it stays fast');
  assert.ok(run(Array(600).fill(0).map((_, i) => (i % 10 ? 16.7 : 120))).every((j) => !j.slow), 'a slow frame now and then is not slow');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const pace = paceLadder\(/);
  assert.doesNotMatch(scene, /measured/, 'no first-frames-only judgement left');
});

test('a slow window first gets lean moving frames and one sharp frame at rest, and only then the still story', async () => {
  // Measured 20 Nov 2026 on software WebGL at 1440x900: the full frames 100 to 150 ms, the lean ones (pixel ratio x 0.6,
  // a one-tap blur) a median of 16.7 ms. One rule for all frames sent this computer straight to the still story.
  const { paceLadder } = await import('../../site/app/(site)/story-motion/pace.mjs');
  const run = (frames) => { const seen = []; const l = paceLadder({ onLean: (ms) => seen.push(['lean', ms]), onSlow: (ms) => seen.push(['still', ms]) }); frames.forEach((ms) => l.frame(ms)); return { seen, lean: l.lean }; };
  assert.deepEqual(run(Array(300).fill(16.7)).seen, [], 'fast: full frames all the way');
  const slowFull = run([...Array(3).fill(120), ...Array(300).fill(16.7)]);
  assert.deepEqual(slowFull.seen, [['lean', 120]], 'slow full frames: lean after 3 frames, and the lean ones hold');
  assert.ok(slowFull.lean);
  const slowLean = run([...Array(3).fill(120), ...Array(60).fill(60)]);
  assert.deepEqual(slowLean.seen, [['lean', 120], ['still', 60]], 'lean frames slow too: the still story');
  assert.deepEqual(run([...Array(3).fill(120), ...Array(59).fill(60)]).seen, [['lean', 120]], 'the lean frames are judged over 60');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const thin = pace\.lean && time - movedAt < 150;\n[^\n]*\n\s*const pr = thin \? ratio\(\) \* 0\.5 : ratio\(\);\n\s*const taps = thin \? 1 : 5;/, 'lean while the ring turns, sharp when it rests');
  assert.match(scene, /if \(drew && turning\) \{\n\s*const judged = last \? pace\.frame\(time - last\) : null;/, 'only frames drawn while a ring turns are judged');
  assert.match(scene, /onSlow \}\);/, 'the lean frames slow too: the still story');
});

test('a scroll that stops in the middle of a change finishes the turn: the ring never stands half turned and blurred', async () => {
  // Seen 24 Nov 2026 at 1440x900, light: a scroll that stopped in step 1's first change left the ring at 0.775 for as
  // long as the page rested, drawn at full resolution, the screen in front turned and blurred all over.
  const { ringRest } = await import('../../site/app/(site)/story-motion/ring.mjs');
  const aim = ringRest();
  assert.equal(aim(0, false), 0);
  assert.equal(aim(0.2, false), 0.2, 'while the visitor scrolls, the ring follows the scroll');
  assert.equal(aim(0.2, true), 1, 'at rest in a change: the turn the visitor was making is finished');
  assert.equal(aim(0.3, false), 1, 'scrolling on toward that screen keeps it: no turn back');
  assert.equal(aim(1, false), 1, 'and the held screen takes over');
  assert.equal(aim(1.2, false), 1.2, 'the next change follows the scroll again');
  const back = ringRest();
  assert.equal(back(1.6, false), 1.6);
  assert.equal(back(1.5, false), 1.5);
  assert.equal(back(1.5, true), 1, 'scrolling back: the turn back is finished');
  assert.equal(back(1.55, false), 1.55, 'scrolling the other way gives the ring back to the scroll');
  assert.equal(ringRest()(0.3, true), 0, 'no way known yet (a page opened scrolled): the nearest screen');
  assert.equal(ringRest()(0.7, true), 1);
  assert.equal(ringRest()(2, true), 2, 'a held screen is its own rest');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const aim = s\.rest\(target, time - scrolledAt > REST\);/, 'each step aims its ring through it');
  assert.match(scene, /s\.t = s\.t < 0 \? aim : s\.t \+ \(aim - s\.t\) \* 0\.25;/, 'and eases toward that aim');
  assert.match(scene, /const poke = \(\) => \{ scrolledAt = performance\.now\(\); wake\(\); \};/, 'a scroll marks the time');
  assert.match(scene, /return turning \|\| thin \|\| drew \|\| restless;/, 'the loop stays awake until the rest is seen');
});

test('the first turn of the ring is not drawn in slow full frames: a software renderer starts lean, the others are judged over 3', async () => {
  // Measured 20 Nov 2026 on software WebGL (SwiftShader) at 1440x900 and 390x844: every page load drew six full frames
  // of 67 to 117 ms before the ladder went lean, 0.3 to 0.7 s at 9 to 15 frames a second on the first turn.
  const { paceLadder, softwareRenderer } = await import('../../site/app/(site)/story-motion/pace.mjs');
  for (const name of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 17.0.6, 256 bits)', 'Microsoft Basic Render Driver']) assert.ok(softwareRenderer(name), name);
  for (const name of ['ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', 'Apple M2', 'Adreno (TM) 640', '', undefined]) assert.ok(!softwareRenderer(name), String(name));
  const ladder = (opts, frames) => { const seen = []; const l = paceLadder({ ...opts, onLean: (ms) => seen.push(['lean', ms]), onSlow: (ms) => seen.push(['still', ms]) }); const full = []; frames.forEach((ms) => { full.push(!l.lean); l.frame(ms); }); return { seen, lean: l.lean, full: full.filter(Boolean).length }; };
  const soft = ladder({ lean: true }, Array(120).fill(16.7));
  assert.ok(soft.lean && soft.full === 0, 'a software renderer draws no full frame while it moves');
  assert.deepEqual(soft.seen, [], 'and its lean frames hold');
  assert.deepEqual(ladder({ lean: true }, Array(60).fill(60)).seen, [['still', 60]], 'lean frames too slow there: the still story');
  const slow = ladder({}, Array(30).fill(100));
  assert.equal(slow.full, 3, 'a slow graphics card: three full frames judged, then lean');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const info = glc\?\.getExtension\('WEBGL_debug_renderer_info'\);\n\s*const software = !!glc && softwareRenderer\(info \? glc\.getParameter\(info\.UNMASKED_RENDERER_WEBGL\) : glc\.getParameter\(glc\.RENDERER\)\);/, 'the renderer\'s name read from the first step\'s context');
  assert.match(scene, /paceLadder\(\{ lean: software,/);
});

test('a step\'s pictures go to the graphics card and its shader is built before its first frame, one job per idle moment, never while a ring turns', async () => {
  // Measured 21 Nov 2026 on software WebGL, a wheel through the story at 1440x900: frames of 200 to 417 ms at each step's
  // start, 41 to 77 ms of them in the picture uploads of the step coming in (its first frame sent them to the card).
  const { warmQueue } = await import('../../site/app/(site)/story-motion/pace.mjs');
  const idles = [];
  const retries = [];
  let busy = false;
  const q = warmQueue({ busy: () => busy, idle: (f) => idles.push(f), retry: (f) => retries.push(f) });
  const done = [];
  q.add(() => done.push('a'), () => done.push('b'));
  assert.equal(idles.length, 1, 'one idle moment asked for, not one per job');
  idles.shift()();
  assert.deepEqual(done, ['a'], 'one job per idle moment');
  busy = true;
  idles.shift()();
  assert.deepEqual(done, ['a'], 'a ring turning: the job waits');
  assert.equal(retries.length, 1);
  busy = false;
  retries.shift()();
  idles.shift()();
  assert.deepEqual(done, ['a', 'b'], 'and runs when it stands');
  assert.equal(idles.length, 0, 'nothing left: no idle moment asked for');
  q.add(() => done.push('c'));
  q.stop();
  while (idles.length) idles.shift()();
  assert.deepEqual(done, ['a', 'b'], 'a stopped queue runs nothing');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /warm\.add\(\.\.\.tex\.map\(\(t\) => \(\) => \{ if \(live\(\)\) s\.gl\.initTexture\(t\); \}\), \(\) => \{ if \(live\(\)\) s\.gl\.compile\(s\.scene, s\.camera\); \}\);/, 'each picture of a step that arrived, then its shader');
  assert.match(scene, /const warm = warmQueue\(\{ busy: \(\) => performance\.now\(\) - movedAt < 300 \}\);/, 'not while a ring turns');
  assert.match(scene, /stopped = true;\n\s*warm\.stop\(\);/, 'and stopped with the motion');
});

test('once the moving story stops, its frame loop asks for no new frame, also when a frame itself stops it', async () => {
  // Seen 20 Nov 2026 with the CPU slowed 6x: the slow check stopped the motion from inside a frame, the frame then asked
  // for the next one, and the loop kept measuring the floors and judging the frame rate on the slow computer.
  const { frameLoop } = await import('../../site/app/(site)/story-motion/pace.mjs');
  // A stand-in for the browser's frames: run(n) plays up to n frames that were asked for and not cancelled.
  const play = (draw) => {
    const pending = new Map();
    let asked = 0;
    const raf = (f) => { pending.set(++asked, f); return asked; };
    const cancel = (id) => pending.delete(id);
    const loop = { drawn: 0, error: null, get asked() { return asked; } };
    loop.stop = frameLoop((t) => { loop.drawn++; draw(t, loop); }, { raf, cancel, onError: (e) => { loop.error = e; } });
    loop.run = (n) => {
      for (let i = 0; i < n && pending.size; i++) {
        const [id, f] = pending.entries().next().value;
        pending.delete(id);
        f(i * 16);
      }
    };
    return loop;
  };
  const fromInside = play((t, l) => { if (l.drawn === 3) l.stop(); });
  fromInside.run(10);
  assert.equal(fromInside.drawn, 3, 'no frame is drawn after the stop');
  assert.equal(fromInside.asked, 3, 'and none is asked for after it');
  const fromOutside = play(() => {});
  fromOutside.run(2);
  fromOutside.stop();
  fromOutside.run(10);
  assert.equal(fromOutside.drawn, 2);
  const throws = play((t, l) => { if (l.drawn === 2) throw new Error('lost context'); });
  throws.run(10);
  assert.ok(throws.error, 'a frame that throws goes to onError');
  assert.equal(throws.asked, 2, 'and ends the loop');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const stopLoop = frameLoop\(draw, \{ onError \}\);/, 'the story runs its frames through it');
  assert.doesNotMatch(scene, /requestAnimationFrame/, 'and has no frame loop of its own');
});

test('the moving story draws nothing while the page rests: its frame loop sleeps until it is woken', async () => {
  // On this kind of computer WebGL is software: a frame of the story costs most of a CPU, and the first pass drew one
  // every 16 ms also while nobody scrolled.
  const { frameLoop } = await import('../../site/app/(site)/story-motion/pace.mjs');
  const pending = new Map();
  let asked = 0;
  const raf = (f) => { pending.set(++asked, f); return asked; };
  const run = (n) => { for (let i = 0; i < n && pending.size; i++) { const [id, f] = pending.entries().next().value; pending.delete(id); f(i * 16); } };
  let moving = 3;
  let drawn = 0;
  const stop = frameLoop(() => { drawn++; return moving-- > 0; }, { raf, cancel: (id) => pending.delete(id) });
  run(50);
  assert.equal(drawn, 4, 'three moving frames, then one that found nothing to draw');
  assert.equal(pending.size, 0, 'and no frame is asked for while it rests');
  stop.wake();
  stop.wake();
  assert.equal(pending.size, 1, 'a wake asks for one frame, however often it is called');
  moving = 1;
  run(50);
  assert.equal(drawn, 6);
  stop();
  stop.wake();
  assert.equal(pending.size, 0, 'a stopped loop is not woken');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /if \(sig === s\.sig\) continue;/, 'a step whose ring stands is not drawn again');
  assert.match(scene, /return turning \|\| thin \|\| drew \|\| restless;/, 'a frame with nothing new draws nothing, and the loop sleeps (once a scroll has rested)');
  for (const ev of ['scroll', 'resize']) assert.match(scene, new RegExp(`addEventListener\\('${ev}', poke`), `woken by a ${ev}`);
});

test('when the moving story starts or ends, the visitor stays in the step they were reading', async () => {
  // Measured 20 Nov 2026 at 1440 px: the page grew from 10227 to 14743 px when the motion began, scrollY stayed at
  // 2575, and the window's middle showed step 1 again instead of step 2; a slow window going still jumped back.
  const { keepPlace } = await import('../../site/app/(site)/story-motion/progress.mjs');
  // A story at page y 1000 of four steps, each `h` tall with `gap` between them; the window is 900 high, scrolled to `y`.
  const page = (h, gap = 0) => { const p = { y: 0, h, steps: [] }; for (let i = 0; i < 4; i++) p.steps.push({ getBoundingClientRect: () => ({ top: 1000 + i * (p.h + gap) - p.y, bottom: 1000 + i * (p.h + gap) + p.h - p.y, height: p.h }) }); return p; };
  const storyOf = (p, gap = 0) => ({ querySelectorAll: () => p.steps, getBoundingClientRect: () => ({ top: 1000 - p.y, bottom: 1000 + 4 * p.h + 3 * gap - p.y, height: 4 * p.h + 3 * gap }) });
  const run = (p, to) => { keepPlace(storyOf(p), () => { p.h = to; }, { vh: 900, scrollBy: (d) => { p.y += d; } }); return p; };
  // In step 2 (index 1), a quarter of the way into it, when its steps grow from 600 to 1600 px.
  const inStep = page(600); inStep.y = 1000 + 600 + 150 - 450;
  run(inStep, 1600);
  assert.equal(inStep.steps[1].getBoundingClientRect().top + 0.25 * 1600, 450, 'the same share of the same step under the middle');
  run(inStep, 600);
  assert.equal(inStep.y, 1000 + 600 + 150 - 450, 'and back where it was when the motion ends');
  // Past the story: the content after it stays put on screen.
  const past = page(600); past.y = 1000 + 2400 + 500;
  run(past, 1600);
  assert.equal(past.y, 1000 + 6400 + 500, 'past the story, the same place after it');
  // Between two steps (measured 20 Nov 2026 at 1440 px: the middle 44 px above step 2's top, in the 88 px gap): step 2's
  // top stays 44 px below the middle. Without this, scrollY stayed and step 2's top went from 494 to 1768 px.
  const gap = page(600, 88); gap.y = 1000 + 688 - 44 - 450;
  keepPlace(storyOf(gap, 88), () => { gap.h = 1600; }, { vh: 900, scrollBy: (d) => { gap.y += d; } });
  assert.equal(gap.steps[1].getBoundingClientRect().top, 450 + 44, 'in the gap, the next step stays as far below the middle');
  // Above the story: nothing moves.
  const above = page(600); above.y = 0;
  run(above, 1600);
  assert.equal(above.y, 0, 'above the story, no scroll');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /keepPlace\(story, \(\) => \{ story\.dataset\.motion = 'on'; \}\)/, 'when it starts');
  assert.match(scene, /keepPlace\(story, \(\) => \{ delete story\.dataset\.motion; \}\)/, 'when it ends');
});

test('a keyboard focus on a step\'s screens shows its first screen held, never the middle of a change; a click leaves the page in place', async () => {
  // Seen 20 Nov 2026 at 1440x900: Tab from the top focused step 2's screens with its ring at 0.625, turning between its
  // first and second screen, where neither could be read.
  const { pinStart } = await import('../../site/app/(site)/story-motion/progress.mjs');
  const step = (top, height, stage) => ({ getBoundingClientRect: () => ({ top, height }), querySelector: () => ({ offsetHeight: stage }) });
  // A step 3179 px high whose stage is 839 px, its top 1500 px above the window (the page at 6000): its pin starts where
  // its top meets the bar's bottom (61 px), at 6000 - 1500 - 61.
  assert.equal(pinStart(step(-1500, 3179, 839), { bar: 61, scrollY: 6000 }), 4439);
  assert.equal(pinStart(step(700, 3179, 839), { bar: 61, scrollY: 0 }), 639, 'also when the step is still below');
  assert.equal(pinStart(step(700, 839, 839), { bar: 61, scrollY: 0 }), null, 'not pinned (the still story): no scroll');
  // The handler itself, on stand-in floors: a keyboard focus (:focus-visible) moves the page to the pin's start; a mouse
  // click or a tap focuses the floor too and leaves the page where it is. Seen 21 Nov 2026 at 1440x900 and 390x844:
  // one click on step 3's screens while it held its last one threw the page 2060 px back to its first.
  const { focusHandler } = await import('../../site/app/(site)/story-motion/progress.mjs');
  const floorOf = (keyboard) => ({ matches: (sel) => sel === ':focus-visible' && keyboard });
  const run = ({ keyboard, motion = true }) => {
    const floor = floorOf(keyboard);
    const moves = [];
    const onFocus = focusHandler({ steps: [{ floor, li: step(-1500, 3179, 839) }], on: () => motion, bar: 61, scrollY: () => 6000, scrollTo: (y) => moves.push(y) });
    onFocus({ currentTarget: floor });
    return moves;
  };
  assert.deepEqual(run({ keyboard: true }), [4439], 'a keyboard focus shows the first screen held');
  assert.deepEqual(run({ keyboard: false }), [], 'a click or a tap leaves the page where it is');
  assert.deepEqual(run({ keyboard: true, motion: false }), [], 'the still story: no scroll');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const onFocus = focusHandler\(\{ steps, on: \(\) => story\.dataset\.motion === 'on', bar: BAR \}\);/);
  assert.match(scene, /for \(const s of steps\) s\.floor\.addEventListener\('focus', onFocus\);/, 'on each step\'s screens');
  assert.match(scene, /for \(const s of steps\) s\.floor\.removeEventListener\('focus', onFocus\);/, 'and let go when the motion ends');
});

test('every change between two screens is designed: at no place of a fine sweep are two screens readable over each other', async () => {
  // Seen 20 Nov 2026 between two screens (the first pass): two windows lay half over each other with their text crossing.
  for (const size of Object.keys(STAGES)) for (const phones of [false, true]) {
    const { R, W, L, at } = await stageOf(size, phones);
    // At every 1 % of each change (t from 0 to 2, 201 places), and at every 0.1 % of the pin as the scroll maps it.
    for (let k = 0; k <= 200; k++) {
      const st = at(k / 100);
      assert.ok(!R.twoReadable(st), `${size} ${phones ? 'phones' : 'desk'}: two screens readable over each other at t = ${(k / 100).toFixed(2)}`);
      // What is not in front is soft: a screen not facing the visitor is never sharp.
      for (const s of st) if (Math.abs(s.d) > 0.42) assert.ok(s.blur >= 0.74 && s.dim > 0.25, `t = ${(k / 100).toFixed(2)}: screen ${s.i} away from the front is blurred and dimmed`);
    }
    let none = 0;
    for (let k = 0; k <= 1000; k++) if (!at(R.ringT(k / 1000)).some((s) => s.readable)) none++;
    assert.ok(none / 1001 <= 0.12, `${size}: no screen readable for ${((none / 1001) * 100).toFixed(1)} % of the pin (only the middles of the changes)`);
    // In the middle of a change the leaving and the coming screen stand side by side with no hole between them, and the
    // window stays full.
    for (const t of [0.5, 1.5]) {
      const boxes = at(t).filter((s) => s.alpha > 0.2).map((s) => R.box(s.quad)).filter((b) => b[2] > W * 0.1 && b[0] < W * 0.9).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] - boxes[i - 1][2] <= W / 5, `${size} t = ${t}: a gap of ${(boxes[i][0] - boxes[i - 1][2]).toFixed(0)} px`);
    }
    assert.ok(L.w > 0);
  }
  const { ringT } = await import('../../site/app/(site)/story-motion/ring.mjs');
  // Each screen is held (the ring stands still) for most of the pin; the change takes 14 % of it, eased at both ends.
  assert.equal(ringT(0), 0);
  assert.equal(ringT(0.2), 0, 'the first screen held');
  assert.equal(ringT(0.5), 1, 'the second held in the middle');
  assert.equal(ringT(1), 2, 'the last at the end');
  const held = Array.from({ length: 1001 }, (_, k) => ringT(k / 1000)).filter((t) => Number.isInteger(t)).length;
  assert.ok(held / 1001 >= 0.7, `held for ${((held / 1001) * 100).toFixed(0)} % of the pin`);
  assert.match(siteFile('app/(site)/story-motion/scene.mjs'), /const target = ringT\(pinProgress\(/, 'the scene turns the ring by it');
});

test('a screen turning in or away keeps a crisp outline while its contents are soft', () => {
  // Seen 20 Nov 2026 at 1440x900 in the middle of a change: the turning screen showed as a blurred column, its edge
  // dimmed away with its contents, which read as a smudge rather than a screen.
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /c = mix\(c, bg, min\(dim, 0\.5\) \* [^\n]*\n\s*c = mix\(c, border, smoothstep\(-1\.6, -0\.4, d\)\);/, 'the outline drawn after the dimming');
  assert.match(scene, /colours\.border\.set\(css\.getPropertyValue\('--border-strong'\)/, 'in the stronger border colour');
});

test('a dark part of a screen turning in or away stays dark: a blurred terminal is not dimmed to a grey slab', () => {
  // Seen 21 Nov 2026 at 1440x900, light, in the middle of step 3's change and of the phone step's: the coming screen's
  // terminal was a flat mid-grey slab, its dark blurred and then dimmed toward the light page as much as the rest.
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  const line = /c = mix\(c, bg, min\(dim, 0\.5\) \* mix\(([\d.]+), 1\.0, smoothstep\(([\d.]+), ([\d.]+), dot\(c, vec3\(0\.2126, 0\.7152, 0\.0722\)\)\)\)\);/.exec(scene);
  assert.ok(line, 'the dimming is weighted by the texel\'s luminance');
  // The shader's dimming in numbers (linear light): the terminal's dark (about 0.01) toward the light page (0.93).
  const [floor, lo, hi] = line.slice(1).map(Number);
  const k = (lum) => { const x = Math.min(1, Math.max(0, (lum - lo) / (hi - lo))); return floor + (1 - floor) * x * x * (3 - 2 * x); };
  const dimmed = (lum, dim = 0.5) => lum + (0.93 - lum) * dim * k(lum);
  const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  assert.ok(srgb(dimmed(0.012)) < 0.35, `a dimmed terminal stays dark: ${srgb(dimmed(0.012)).toFixed(2)} of white (it was ${srgb(0.012 + (0.93 - 0.012) * 0.5).toFixed(2)})`);
  assert.ok(dimmed(0.8) - 0.8 > 0.9 * (0.5 * (0.93 - 0.8)), 'a light part is dimmed as before');
});

test('on a phone the moving story shows the dashboard at phone width, one screen at a time, big enough to read', async () => {
  // Seen 20 Nov 2026 at 390x844 (the first pass): a whole desktop screen shrunk to 320 px, nothing could be read.
  const { R, L, at } = await stageOf('390x844', false);
  assert.equal(L.form, 'tall', 'a floor higher than wide');
  assert.ok(L.w >= 320, `the front screen is ${L.w} px wide`);
  // Its picture is the demo at 390 px (780 px at 2×): drawn at 2×, a texel is about one device pixel, never shrunk
  // from a desktop screen.
  assert.ok((L.w * 2) / 780 > 0.8 && (L.w * 2) / 780 <= 1, `drawn ${((L.w * 2) / 780).toFixed(2)}× its picture`);
  // One screen at a time: at each pinned place one screen is readable and the others are only edges at the sides.
  for (const t of [0, 1, 2]) {
    const st = at(t);
    assert.equal(st.filter((x) => x.readable).length, 1, `screen ${t + 1}: one readable screen`);
    const front = R.box(st.find((y) => y.readable).quad);
    for (const x of st.filter((y) => !y.readable && y.alpha > 0.2)) {
      // What shows of it: the part inside the window and beside the front screen (the rest lies behind the front).
      const b = R.box(x.quad);
      const shown = Math.max(0, Math.min(b[2], front[0]) - Math.max(b[0], 0)) + Math.max(0, Math.min(b[2], 390) - Math.max(b[0], front[2]));
      assert.ok(shown <= 40, `screen ${t + 1}: the others show as edges of at most 40 px (${shown.toFixed(0)} px)`);
    }
  }
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const kind = s\.phones \? '' : L\.form === 'tall' \? '-phone' :/, 'the dashboard at phone width on a floor higher than wide');
  // The step's own phone order: Computers is half empty at 390 px, the at-the-limit session tells step 3 best.
  const { STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const step = (id) => STEPS.find((x) => x.id === id);
  assert.deepEqual(step('together').phoneOrder, ['home', 'projects', 'computers']);
  assert.equal(step('limit').phoneOrder[0], 'limit-reached');
  for (const x of STEPS) if (x.phoneOrder) assert.deepEqual([...x.phoneOrder].sort(), [...x.panes].sort(), `${x.id}: the same three screens`);
  assert.match(siteFile('app/(site)/Story.tsx'), /data-phone-order=\{\(step as \{ phoneOrder\?: string\[\] \}\)\.phoneOrder\?\.join\(','\)\}/);
  assert.match(scene, /const order = L\.form === 'tall' && s\.phoneOrder \? s\.phoneOrder : s\.names\.map\(\(_, i\) => i\);/);
});

test('on a wide window the phone step shows phones: a phone\'s shape at about a phone\'s size, in a row to the window\'s edges', async () => {
  // Seen 20 Nov 2026 at 1440x900 and 999x700: the phone step's front screen was a box 734 by 666 px with the top of a
  // phone picture in it, its terminal text about 24 px tall, twice the other steps'; it read as a zoomed screenshot.
  for (const size of ['1440x900', '1280x720', '999x700']) {
    const { R, W, L, at } = await stageOf(size, true);
    assert.equal(L.form, 'phones', `${size}: a wide floor with the phone's screens`);
    assert.ok(L.w / L.h >= 0.45 && L.w / L.h <= 0.62, `${size}: a phone's shape (${L.w} by ${L.h} px)`);
    // The phone picture is the demo at 390 px (780 px wide): drawn at 0.6 to 1.3 times a phone's own size, never blown up.
    assert.ok(L.w >= 0.6 * 390 && L.w <= 1.3 * 390, `${size}: ${L.w} px wide, ${(L.w / 390).toFixed(2)}x a phone`);
    for (const t of [0, 1, 2]) {
      const st = at(t);
      assert.equal(st.filter((x) => x.readable).length, 1, `${size} screen ${t + 1}: one readable phone`);
      const boxes = st.filter((x) => x.alpha > 0.2).map((x) => R.box(x.quad));
      assert.ok(Math.min(...boxes.map((b) => b[0])) <= 0 && Math.max(...boxes.map((b) => b[2])) >= W, `${size} screen ${t + 1}: the row reaches the window's edges`);
    }
  }
  // The row shows each of the step's screens once, and no phone of it is a blank card: past the step's three it shows
  // other phone screens of the demo (story-data.mjs rowFill), dimmed and soft as a side screen. Seen 21 Nov 2026 at
  // 1440x900: the same phone at both edges, five phones in view for a step of three. Seen 22 Nov 2026 at 1280x720 and
  // 999x700: those copies faded to the page's colour (dim 1) read as an empty white card at each edge. With only the
  // three phones the window was 19 to 31 % empty (stage-check.mjs's rule: at most 10 %).
  const { STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const step4 = STEPS.find((x) => x.id === 'phone');
  assert.equal(step4.rowFill.length, 6, 'three screens at each end of the row');
  assert.equal(new Set(step4.rowFill).size, 6, 'each once');
  for (const n of step4.rowFill) {
    assert.ok(!step4.panes.includes(n), `${n}: not one of the step's own screens`);
    for (const theme of ['light', 'dark']) assert.ok(fs.existsSync(path.join(root, `site/story/${n}-${theme}-phone.webp`)), `${n}: a phone picture in ${theme}`); // site/public is made by the build
  }
  for (const size of ['1440x900', '1280x720', '999x700', '1920x1080', '1024x768']) {
    const { W, at } = await stageOf(size, true);
    const R = await import('../../site/app/(site)/story-motion/ring.mjs');
    for (let k = 0; k <= 200; k++) {
      const seen = at(k / 100).filter((x) => x.alpha > 0.2).filter((x) => { const b = R.box(x.quad); return b[2] > 0 && b[0] < W; });
      const where = `${size} t = ${(k / 100).toFixed(2)}`;
      for (let i = 0; i < 3; i++) assert.ok(seen.filter((x) => x.i === i && !x.fill).length <= 1, `${where}: screen ${i + 1} seen twice`);
      for (const x of seen) assert.ok(x.dim <= 0.5, `${where}: a phone of the row dimmed to ${x.dim.toFixed(2)}, an empty card`);
      assert.ok(seen.filter((x) => x.fill).every((x) => !x.readable && Math.abs(x.d) >= 1), `${where}: another screen never stands in front`);
    }
  }
  assert.match(siteFile('app/(site)/Story.tsx'), /data-row-fill=\{\(step as \{ rowFill\?: string\[\] \}\)\.rowFill\?\.join\(','\)\}/);
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const meshes = Array\.from\(\{ length: names\.length \* \(phones \? 3 : 1\) \}/, 'a plane for each copy in the row');
  assert.match(scene, /const m = s\.meshes\[st\.slot - st\.i \+ order\[st\.i\]\];/, 'each copy drawn by its own plane');
  assert.match(scene, /return \{ key: `\$\{theme\}\$\{kind\}-row`, urls: \[\.\.\.fill\.slice\(0, s\.names\.length\), \.\.\.urls, \.\.\.fill\.slice\(s\.names\.length\)\] \};/, 'the row\'s planes in slot order, the other screens at both ends');
  assert.doesNotMatch(scene, /max\(dim - 0\.5/, 'no fade to the page\'s colour: that drew the empty cards');
});

test('a fall back to the still story on a phone opens the strip on the screen the moving form showed', async () => {
  // Seen 22 Nov 2026 at 390x844: reduced motion asked for in the middle of step 2, its ring on Workspace, and the still
  // strip opened on its first screen, Home. A strip of three panes 300 px wide, 12 px apart, in a floor 390 px wide.
  const P = await import('../../site/app/(site)/story-motion/progress.mjs');
  assert.equal(typeof P.showPane, 'function', 'progress.mjs has showPane');
  const strip = (names, width = 390) => {
    const floor = { scrollLeft: 0, clientWidth: width, scrollWidth: 16 + names.length * 312 + 4, getBoundingClientRect: () => ({ left: 0, width }) };
    const panes = names.map((n, k) => ({ dataset: { pane: n }, getBoundingClientRect: () => ({ left: 16 + k * 312 - floor.scrollLeft, width: 300 }) }));
    floor.querySelectorAll = () => panes;
    return floor;
  };
  const f = strip(['home', 'projects', 'computers']);
  P.showPane(f, 'projects');
  assert.equal(f.scrollLeft, 16 + 312 - 45, 'Workspace in the middle of the window');
  P.showPane(f, 'computers');
  assert.equal(f.scrollLeft, f.scrollWidth - f.clientWidth, 'the last screen: as far as the strip goes');
  P.showPane(f, 'home');
  assert.equal(f.scrollLeft, 0, 'the first screen: at its start');
  const wide = strip(['a', 'b', 'c'], 1440);
  wide.scrollWidth = 1440;
  P.showPane(wide, 'b');
  assert.equal(wide.scrollLeft, 0, 'a floor that does not scroll sideways is left as it is');
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /s\.frontName = s\.names\[order\[now\]\];/, 'the scene keeps the screen in front');
  assert.match(scene, /keepPlace\(story, \(\) => \{ delete story\.dataset\.motion; \}\);\n[^\n]*\n\s*for \(const s of steps\) showPane\(s\.floor, s\.frontName\);/, 'and opens the still strip on it when the motion ends');
});

test('the still story never scrolls sideways from 700 px: the phone floor\'s grid is clipped to the floor', () => {
  // Seen 21 Nov 2026 with reduced motion: the phone step's floor keeps its grid in perspective (left and right -10 %),
  // and the page was 1065 px wide at 999, 868 at 820, 751 at 700 and 1324 at 1300. Hiding that grid, or clipping the
  // floor sideways, brought every width back to the window's.
  assert.match(cssRule('app/(site)/story.css', '.floor::before', 'top'), /left: -10%; right: -10%;/, 'the grid runs past the floor');
  assert.match(cssRule('app/(site)/story.css', ".story:not([data-motion='on']) .floor-tall", '(min-width: 700px)'), /overflow-x: clip;/, 'so the still phone floor clips it');
  assert.doesNotMatch(cssRule('app/(site)/story.css', ".story:not([data-motion='on']) .floor-tall", '(min-width: 700px)'), /overflow(-y)?: (hidden|clip)/, 'only sideways: the screens\' shadows stay');
});

test('step 2 on a phone opens on Home and shows one computer\'s Overview, not the half-empty Computers, in both forms', async () => {
  // Seen 20 Nov 2026 at 390x844: the still phone story opened step 2 on Computers ('.pane-b { order: -1 }' never read the
  // step's phone order), and the moving form held Computers with its lower 60 % an empty white card.
  const { STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const together = STEPS.find((x) => x.id === 'together');
  assert.deepEqual(together.phoneSwap, { computers: 'computer-overview' });
  const tsx = siteFile('app/(site)/Story.tsx');
  assert.match(tsx, /const phoneAt = \(name: string, i: number\) => \(phoneOrder \? phoneOrder\.indexOf\(name\) : \[1, 0, 2\]\[i\]\);/, 'each pane\'s place on a phone, the front one first by default');
  assert.match(tsx, /data-pane=\{name\} data-phone-at=\{phoneAt\(name, i\)\}/);
  // The still phone form follows that place; nothing puts the middle pane first by its class.
  const phone = '(max-width: 699px)';
  assert.equal(cssRule('app/(site)/story.css', '.pane-b', phone).includes('order'), false, 'no order by the middle pane\'s class');
  assert.match(cssRule('app/(site)/story.css', ".pane[data-phone-at='1']", phone), /order: 1;/);
  assert.match(cssRule('app/(site)/story.css', ".pane[data-phone-at='2']", phone), /order: 2;/);
  // Step 2's places: Home first, Workspace, then Computers.
  const at = Object.fromEntries(together.panes.map((name, i) => [name, together.phoneOrder.indexOf(name)]));
  assert.deepEqual(at, { home: 0, projects: 1, computers: 2 });
  // The moving form on a floor higher than wide takes the swapped screen's phone picture, and names it.
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const pic = \(n, i\) => \(tall && s\.items\[i\]\?\.dataset\.phoneName\) \|\| n;/);
  assert.match(scene, /li\.textContent = \(L\.form === 'tall' && li\.dataset\.phoneLabel\) \|\| s\.labels\[i\];/, 'its caption follows');
  assert.match(tsx, /data-phone-name=\{phoneSwap\?\.\[name\]\} data-phone-label=\{phoneSwap\?\.\[name\] && shot\(phoneSwap\[name\]\)\.label\}/);
  assert.ok(fs.existsSync(path.join(root, 'site/story/computer-overview-light-phone.webp')) && fs.existsSync(path.join(root, 'site/story/computer-overview-dark-phone.webp')), 'its phone pictures are there');
});

test('the step\'s words are never under the canvas: each step draws in its own floor box, under its words, also while its pin ends', async () => {
  // Seen 20 Nov 2026 at 820x1180 and 999x700 (the first pass): one canvas over the whole window, cut by a guard
  // (words.top >= floor.top) that let the screens be drawn over the step's words while each step's pin ended.
  // Now the canvas is a child of the step's floor box, which comes after the words in the stage's column: the two
  // move together, and nothing is drawn outside the box.
  const scene = siteFile('app/(site)/story-motion/scene.mjs');
  assert.match(scene, /const box = li\.querySelector\('\.step-floor'\);\n\s*const gl = renderer\(box\);/, 'a renderer per step, in its floor box');
  assert.match(scene, /box\.append\(canvas\);/);
  assert.doesNotMatch(scene, /story\.append\(canvas\)/, 'no canvas over the whole story');
  const css = (sel) => cssRule('app/(site)/story.css', sel, 'top');
  assert.match(css('.story-canvas'), /position: absolute; inset: 0;/, 'the canvas fills its box and scrolls with it');
  assert.doesNotMatch(css('.story-canvas'), /fixed/);
  assert.match(css(".story[data-motion='on'] .step-floor"), /display: block; position: relative; flex: 1 1 auto; min-height: 0;/);
  assert.match(css(".story[data-motion='on'] .step-stage"), /display: flex; flex-direction: column;/, 'the words over the box, in one column');
  assert.match(css(".story[data-motion='on'] .step-words"), /flex: none;/);
  const tsx = siteFile('app/(site)/Story.tsx');
  assert.ok(tsx.indexOf('className="step-words"') < tsx.indexOf('className="step-floor"'), 'the floor box after the words');
  assert.doesNotMatch(cssRule('app/(site)/story.css', ".story[data-motion='on'] .step-words", '(min-width: 900px)'), /position|order/, 'the band stays in the column at every width');
});

test('a stage let go at its pin\'s end shows its screens whole down to its bottom: the canvas has a surface of its own', () => {
  // Seen 20 Nov 2026 at 1440x900 and 390x844: after step 1's stage was let go, Chrome culled its canvas under the solid
  // top bar by a line that rose twice as fast as the stage, so the window showed a screen sliced mid-line over a third of
  // empty grid before step 2. A canvas with a surface of its own (will-change: filter) is drawn whole.
  assert.match(cssRule('app/(site)/story.css', '.story-canvas', 'top'), /will-change: filter;/);
});

test('in a short window the pinned stage ends at the window\'s bottom: the screens\' bottom and the screen names in view', async () => {
  // Seen 20 Nov 2026 at 999x700 (the first pass): the pinned floor ran past the window's bottom and hid the screens'
  // bottom and the caption. The stage is the window under the bar; the floor is what the words leave of it.
  assert.match(cssRule('app/(site)/story.css', ".story[data-motion='on'] .step-stage", 'top'), /height: calc\(100vh - 61px\); height: calc\(100svh - 61px\);/);
  for (const size of ['999x700', '820x1180', '1280x720', '390x844']) for (const phones of [false, true]) {
    const { R, H, words, at } = await stageOf(size, phones);
    for (let k = 0; k <= 200; k += 5) for (const s of at(k / 100).filter((x) => x.alpha > 0.2)) {
      const b = R.box(s.quad);
      if (Math.abs(s.d) < 0.01) assert.ok(b[3] <= H - 8 && b[1] >= words[3], `${size}: the front screen lies whole between the words and the window's bottom (${b[1].toFixed(0)} to ${b[3].toFixed(0)})`);
    }
  }
  // The screen names are part of the band (its last row), not under the screens.
  assert.match(siteFile('app/(site)/Story.tsx'), /<ol className="step-screens" aria-hidden="true">[\s\S]*?<\/ol>\n\s*<\/div>\n[\s\S]*?className="step-floor"/);
});

test('the built landing page loads no 3D code with its first screen; three.js is a chunk of its own', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const first = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]))];
  assert.ok(first.length, 'the page names its scripts');
  for (const f of first) assert.doesNotMatch(fs.readFileSync(path.join(out, f), 'utf8'), /WebGLRenderer/, `${f}: a first-load script holds three.js`);
  const chunks = fs.readdirSync(path.join(out, '_next/static/chunks')).filter((f) => f.endsWith('.js'));
  assert.ok(chunks.some((f) => /WebGLRenderer/.test(fs.readFileSync(path.join(out, '_next/static/chunks', f), 'utf8'))), 'three.js is in the build, for later');
  // The canvas is not in the HTML: only the words and the still pictures are.
  assert.doesNotMatch(html, /<canvas/);
});

test('the landing page\'s first screen keeps to its budget: its HTML, styles, scripts and picture, and no font file', { skip: needsBuild }, async () => {
  const out = await nextBuild();
  const { gzipSync } = await import('node:zlib');
  const html = fs.readFileSync(path.join(out, 'index.html'));
  const gz = (f) => gzipSync(fs.readFileSync(path.join(out, f))).length;
  const named = (re) => [...new Set([...String(html).matchAll(re)].map((m) => m[1].slice(1)))];
  // Measured 20 Nov 2026 (gzip, as GitHub Pages sends text): HTML 21.6 KB, styles 8.0 KB, scripts 176 KB, picture 45 KB.
  // The budget leaves room to grow a little; a step past it is a choice to make, not a slip.
  const budget = { html: 32_000, css: 12_000, js: 200_000, picture: 60_000 };
  assert.ok(gzipSync(html).length <= budget.html, `index.html: ${gzipSync(html).length} B gzip`);
  const css = named(/<link rel="stylesheet" href="([^"]+)"/g).reduce((n, f) => n + gz(f), 0);
  assert.ok(css <= budget.css, `the first screen's styles: ${css} B gzip`);
  const js = named(/<script src="([^"]+)"/g).reduce((n, f) => n + gz(f), 0);
  assert.ok(js > 0 && js <= budget.js, `the first screen's scripts: ${js} B gzip`);
  const picture = /<img class="shot" src="([^"]+)"/.exec(String(html))[1].slice(1);
  assert.ok(fs.statSync(path.join(out, picture)).size <= budget.picture, `${picture}: ${fs.statSync(path.join(out, picture)).size} B`);
  // A phone fetches its own first picture instead: within the same budget.
  for (const f of named(/srcSet="(\/story\/home-(?:light|dark)-phone-top\.webp)"/g)) assert.ok(fs.statSync(path.join(out, f)).size <= budget.picture, `${f}: ${fs.statSync(path.join(out, f)).size} B`);
  assert.equal(named(/srcSet="(\/story\/home-(?:light|dark)-phone-top\.webp)"/g).length, 2, 'the phone pictures are named by the first screen');
  // The type is the computer's own (a system font stack): nothing to download, no flash of another font.
  assert.deepEqual(builtFiles(out).filter((f) => /\.(woff2?|ttf|otf|eot)$/.test(f)), [], 'no font file is built');
  assert.doesNotMatch(siteFile('design/tokens.css') + siteFile('design/kit.css'), /@font-face/);
});

// ---------- the rest of the landing page (SITE.md section 2), from site/content/index.md ----------

test('the built landing page holds every part of its content, the use cases as cards, and nothing of a paid version', { skip: needsBuild }, async () => {
  const { INSTALL } = await import('../../site/lib/seo.mjs');
  const { frontMatter } = await import('../../site/lib/markdown.mjs');
  const out = await nextBuild();
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const { body } = frontMatter(fs.readFileSync(path.join(root, 'site/content/index.md'), 'utf8'));
  // Every "## " part of the content is a band with its title.
  const titles = [...body.matchAll(/^## (.*)$/gm)].map((m) => m[1].trim());
  assert.ok(titles.length >= 6, 'the content\'s parts are found');
  for (const t of titles) assert.match(html, new RegExp(`<h2 id="[\\w-]+" class="t-h2 band-title">${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '(?:\'|&#x27;)')}</h2>`), `a band for "${t}"`);
  // The three things, the steps, the comparison and every question, in words.
  for (const h of [...body.matchAll(/^### (.*)$/gm)].map((m) => m[1].trim())) assert.ok(text.includes(h), `"${h}" is on the page`);
  assert.match(html, /<div class="table table-wide"><table>/, 'the comparison table');
  // The story sits after the three things.
  assert.ok(html.indexOf('id="what-does-hoprig-do"') < html.indexOf('data-story') && html.indexOf('data-story') < html.indexOf('id="who-it-is-for"'), 'the story follows the three things');
  // Every use case is a card that leads to its page.
  const cases = fs.readdirSync(path.join(root, 'site/content/use-cases')).filter((f) => f.endsWith('.md') && f !== 'index.md');
  for (const f of cases) assert.match(html, new RegExp(`<a class="card" href="/use-cases/${f.replace(/\.md$/, '')}/">`), `a card for ${f}`);
  // Every install line copies exactly the install command.
  const copies = [...html.matchAll(/data-copy="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.ok(copies.length >= 3, 'the install line at the top, after the steps and at the end');
  for (const c of copies) assert.equal(c, INSTALL);
  // Nothing of a paid version: no price, no sign-in or account, no "Pro".
  assert.doesNotMatch(text, /\bPro\b|\$\s?\d|€\s?\d|\bper month\b|\bpricing\b|\bsign up\b|\bsubscribe\b|\blog ?in\b|\bmy account\b/i);
});
