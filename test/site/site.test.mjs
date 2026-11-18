// hoprig.com (site/build.mjs), built into a temporary folder: every internal link and anchor leads somewhere, every
// page has its Markdown twin, llms.txt and the README name every use case, the tools page names every command the CLI knows, the
// licence named is Apache-2.0 (never MIT for Hoprig), raw HTML in a doc cannot put code into a page, copy buttons copy only what can
// be run as it stands, and no file holds a home path, an e-mail address or this computer's names.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'site-test-'));
test.after(() => fs.rmSync(out, { recursive: true, force: true }));

const { build } = await import('../../site/build.mjs');
const result = await build({ root, out });

const files = fs.readdirSync(out, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => fs.statSync(path.join(out, f)).isFile());
const html = files.filter((f) => f.endsWith('.html'));
const text = files.filter((f) => /\.(html|md|txt|xml|css|js)$/.test(f) || f === 'CNAME');
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
const urlOf = (f) => (f === 'index.html' ? '/' : f.endsWith('/index.html') ? `/${f.slice(0, -'index.html'.length)}` : `/${f}`);

/** The file a site address is served from, as GitHub Pages does it (a folder serves its index.html). */
function target(address) {
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

test('the build makes the pages SITE.md names', () => {
  for (const url of ['/', '/use-cases/', '/docs/', '/docs/install/', '/skill/', '/tools/', '/compare/', '/changelog/', '/404.html']) {
    assert.ok(result.pages.some((p) => p.url === url), `no page ${url}`);
  }
  assert.equal(result.pages.filter((p) => p.kind === 'compare').length, 3, 'three comparison pages');
  assert.equal(result.pages.filter((p) => p.kind === 'usecase').length, 13, 'thirteen use cases');
  assert.ok(result.pages.filter((p) => p.kind === 'doc').length >= fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).length, 'every docs/*.md is a page');
  for (const f of ['llms.txt', 'llms-full.txt', 'sitemap.xml', 'robots.txt', 'CNAME', 'style.css', 'site.js', 'social-preview.png']) assert.ok(files.includes(f), `no ${f}`);
  assert.equal(read('CNAME').trim(), 'hoprig.com');
  assert.match(read('robots.txt'), /^User-agent: \*\nAllow: \//);
  assert.match(read('robots.txt'), /User-agent: ClaudeBot\nAllow: \//);
  assert.match(read('robots.txt'), /Sitemap: https:\/\/hoprig\.com\/sitemap\.xml/);
});

test('every internal link and image leads to a file, and every anchor to a heading', () => {
  const broken = [];
  for (const f of html) {
    for (const m of read(f).matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const v = m[1].replace(/&amp;/g, '&');
      if (/^(https?:|mailto:|data:)/.test(v) || v.startsWith('//')) continue;
      if (!v.startsWith('/') && !v.startsWith('#')) {
        broken.push(`${f}: ${v} (relative: a 404 page is served at every address, so links must start with /)`);
        continue;
      }
      const file = v.startsWith('#') ? path.join(out, f) : target(v);
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

test('every page has its Markdown twin at the same address with .md, and says where it is', () => {
  for (const f of html) {
    const url = urlOf(f);
    const twin = url === '/' ? 'index.md' : url.endsWith('.html') ? url.slice(1).replace(/\.html$/, '.md') : `${url.slice(1, -1)}.md`;
    assert.ok(files.includes(twin), `${f} has no ${twin}`);
    assert.ok(read(f).includes(`<link rel="alternate" type="text/markdown" href="/${twin}"`), `${f} does not point to /${twin}`);
    assert.match(read(twin), /^# \S/m, `${twin} has no title`);
  }
});

const ldOf = (f) => {
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read(f));
  return ld ? JSON.parse(ld[1]) : null;
};
const text1 = (v) => typeof v === 'string' && v.trim().length > 0;

test('every page carries schema.org data with the properties its kind requires, a description and Open Graph tags', () => {
  const kinds = new Map();
  for (const f of html.filter((x) => x !== '404.html')) {
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
    assert.match(page, /<meta name="description" content="[^"]{20,}">/, `${f} has no description`);
    assert.match(page, /<meta property="og:image" content="https:\/\/hoprig\.com\/social-preview\.png">/, f);
  }
  assert.equal(kinds.get('SoftwareApplication'), 1, 'the home page describes the software');
  assert.ok(ldOf('index.html')['@graph'].some((x) => x['@type'] === 'FAQPage' && x.mainEntity.length >= 3), 'the home page has its questions and answers');
  const usecase = ldOf('use-cases/usage-limit/index.html')['@graph'];
  assert.ok(usecase.some((x) => x['@type'] === 'HowTo' && x.step.length >= 3), 'a use case has its how-to steps');
  // Two phases (before, on the new computer) stay apart.
  const restore = ldOf('use-cases/new-computer/index.html')['@graph'].find((x) => x['@type'] === 'HowTo');
  assert.deepEqual(restore.step.map((x) => [x['@type'], x.itemListElement.length]), [['HowToSection', 2], ['HowToSection', 5]]);
  assert.match(restore.step[1].name, /new computer/);
});

test('titles fit a search result, descriptions are 70 to 160 characters, and the 404 page is not indexed', () => {
  for (const f of html) {
    const page = read(f);
    const title = /<title>([^<]*)<\/title>/.exec(page)[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const h1 = result.pages.find((p) => p.url === urlOf(f))?.title;
    // A use case's question is kept whole; the suffix goes where it would be cut.
    assert.ok(title.length <= 60 || title === h1, `${f}: the title "${title}" is ${title.length} characters, with a suffix`);
    const d = /<meta name="description" content="([^"]*)">/.exec(page)[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    assert.ok(d.length >= 70 && d.length <= 160, `${f}: the description is ${d.length} characters: ${d}`);
  }
  const missing = read('404.html');
  assert.match(missing, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(missing, /rel="canonical"/);
  assert.doesNotMatch(missing, /application\/ld\+json/);
  for (const f of html.filter((x) => x !== '404.html')) assert.match(read(f), /<link rel="canonical" href="https:\/\/hoprig\.com\//, f);
});

test('every page has a content security policy that allows the theme script by its hash and nothing inline else', () => {
  for (const f of html) {
    const page = read(f);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page);
    assert.ok(csp, `${f} has no content security policy`);
    assert.ok(page.indexOf(csp[0]) < page.indexOf('<script'), `${f}: the policy comes after a script`);
    assert.match(csp[1], /default-src 'none'/);
    assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval|\*/, f);
    const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(inline.length, 1, `${f}: one inline script, the theme`);
    const hash = createHash('sha256').update(inline[0]).digest('base64');
    assert.match(csp[1], new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, '\\$&')}'(;|$)`), `${f}: the theme script's hash`);
    assert.doesNotMatch(page, /\sstyle="|\son[a-z]+=/i, `${f}: an inline style or event handler, which the policy would block`);
  }
});

test('a line that is an HTML comment is a note for the editor: no page shows it as text', () => {
  for (const f of html) assert.doesNotMatch(read(f), /&lt;!--/, f);
});

test('raw HTML in a doc keeps only the README\'s tags: a script or an onerror builds to text, not markup', async () => {
  // A copy of the repository whose docs hold one more file, with what a careless or hostile change could bring.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'site-evil-'));
  const fakeOut = path.join(fake, 'out');
  try {
    for (const e of fs.readdirSync(root)) if (!['docs', 'site', 'node_modules', '.git'].includes(e)) fs.symlinkSync(path.join(root, e), path.join(fake, e));
    fs.mkdirSync(path.join(fake, 'docs'));
    for (const e of fs.readdirSync(path.join(root, 'docs'))) fs.symlinkSync(path.join(root, 'docs', e), path.join(fake, 'docs', e));
    fs.mkdirSync(path.join(fake, 'site'));
    for (const e of fs.readdirSync(path.join(root, 'site'))) if (!['dist', 'node_modules'].includes(e)) fs.symlinkSync(path.join(root, 'site', e), path.join(fake, 'site', e));
    fs.writeFileSync(path.join(fake, 'docs', 'EVIL.md'), [
      '# Evil', '',
      '<p align="center"><img src="x.png" onerror="alert(1)" alt="x"><script>alert(2)</script></p>', '',
      '<div><iframe src="https://example.com"></iframe><a href="javascript:alert(3)">x</a></div>', '',
      '<p><a href="/docs/" onclick="alert(4)" style="color:red">ok</a></p>', '',
      'A [link](https://en.wikipedia.org/wiki/Tmux_(software)) with parentheses.', '',
    ].join('\n'));
    const { build: buildAgain } = await import('../../site/build.mjs');
    await buildAgain({ root: fake, out: fakeOut });
    const page = fs.readFileSync(path.join(fakeOut, 'docs/evil/index.html'), 'utf8');
    const main = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    assert.doesNotMatch(main, /<script|<iframe|\son[a-z]+=|javascript:|\sstyle=/i);
    assert.match(main, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/, 'the script tag is shown as text');
    assert.match(main, /<img src="\/docs\/evil\/x\.png" alt="x"|<img src="[^"]*x\.png" alt="x"/, 'the image stays, without its onerror');
    assert.match(main, /<a href="\/docs\/">ok<\/a>/, 'an allowed link stays, without its handler and style');
    assert.match(main, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Tmux_\(software\)">link<\/a> with parentheses/);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('copy buttons only on one command or a sequence to run as it stands: never a placeholder, never alternatives', () => {
  const copyable = (f) => [...read(f).matchAll(/<pre data-copyable><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  const lines = (block) => block.split('\n').map((l) => l.replace(/(^|\s+)#(\s.*)?$/, '')).filter((l) => l.trim());
  for (const f of html) {
    const ownDocs = result.pages.find((p) => p.url === urlOf(f))?.kind === 'doc' || f.startsWith('tools/');
    for (const block of copyable(f)) {
      assert.doesNotMatch(block, /<[^<>\s][^<>]*>/, `${f}: a block with a placeholder has a copy button`);
      if (ownDocs) assert.equal(lines(block).length, 1, `${f}: a block of several lines from the product's docs has a copy button: ${block}`);
    }
  }
  assert.deepEqual(copyable('use-cases/production-ready/index.html'), [], 'hop skills add <id> is not copied');
  assert.ok(copyable('docs/install/index.html').every((b) => lines(b).length === 1), 'the install page copies single commands only');
  assert.equal(copyable('use-cases/two-computers-one-workspace/index.html').length, 1, 'only the first computer\'s commands are copied');
  assert.doesNotMatch(copyable('use-cases/two-computers-one-workspace/index.html')[0], /restore/);
});

test('llms.txt and the README list every use case, and the sitemap every page', () => {
  const llms = read('llms.txt');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const sitemap = read('sitemap.xml');
  const cases = fs.readdirSync(path.join(root, 'site/content/use-cases')).filter((f) => f.endsWith('.md') && f !== 'index.md');
  assert.equal(cases.length, 13);
  for (const c of cases) {
    assert.ok(llms.includes(`https://hoprig.com/use-cases/${c.replace(/\.md$/, '')}.md`), `llms.txt does not list ${c}`);
    assert.ok(readme.includes(`(https://hoprig.com/use-cases/${c.replace(/\.md$/, '')}/)`), `the README's "Who it is for" does not list ${c}`);
  }
  for (const p of result.pages.filter((x) => x.url !== '/404.html')) assert.ok(sitemap.includes(`<loc>https://hoprig.com${p.url}</loc>`), `the sitemap lacks ${p.url}`);
  assert.ok(read('llms-full.txt').length > read('llms.txt').length * 5, 'llms-full.txt holds the pages themselves');
});

test('llms.txt says what Hoprig does not do', () => {
  const llms = read('llms.txt');
  const part = /^## What it does not do\n\n((?:- .*\n)+)/m.exec(llms);
  assert.ok(part, 'llms.txt has a "What it does not do" list');
  for (const word of [/no cloud/i, /does not replace the coding tools/i, /OpenCode never runs on a Claude subscription/, /Auto mode is Claude Code's only/, /Codex is not offered/, /macOS/, /Windows is not ready/, /stand-ins/, /One dashboard password and no user accounts or roles/, /Remote Control does not work/, /No triggers from outside/]) {
    assert.match(part[1], word);
  }
});

test('the tools page lists every command the CLI knows, and Tia\'s tools', async () => {
  // Read here from bin/hoprig.mjs on its own, not through the generator, so a mistake there cannot hide itself.
  const bin = fs.readFileSync(path.join(root, 'bin/hoprig.mjs'), 'utf8');
  const commands = [...bin.slice(bin.indexOf('async function main(')).matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]);
  assert.ok(commands.length > 20, 'the switch in bin/hoprig.mjs was found');
  const page = read('tools/index.html');
  for (const c of commands) assert.ok(page.includes(`<code>hoprig ${c}`), `the tools page lacks hoprig ${c}`);
  for (const c of ['doctor', 'pc status', 'workspace status', 'profiles']) assert.match(page, new RegExp(`<code>hoprig ${c}[^<]*--json`), `--json of hoprig ${c}`);
  const { TOOLS } = await import('../../src/assistant/tools.mjs');
  for (const t of TOOLS) assert.ok(page.includes(`<code>${t.name}</code>`), `the tools page lacks Tia's tool ${t.name}`);
});

test('the licence is Apache-2.0 on the home page, in the footer and in llms.txt, and links to the licence', () => {
  const licence = 'https://github.com/allswebtech/hoprig/blob/main/LICENSE';
  const home = read('index.html');
  assert.match(home, /<p class="kicker">[^<]*open source \(Apache-2\.0\)/, 'the line above the home page title');
  assert.ok(home.includes(`open source under the <a href="${licence}">Apache License 2.0</a>`), 'the answer to "Is Hoprig free?"');
  for (const f of text.filter((x) => x.endsWith('.html'))) {
    const foot = read(f).match(/<footer class="foot">[\s\S]*?<\/footer>/);
    assert.ok(foot, `${f} has the footer`);
    assert.ok(foot[0].includes(`open source (<a href="${licence}">Apache-2.0</a>)`), `${f}: the footer names the licence and links to it`);
  }
  assert.ok(read('llms.txt').includes(`- Licence: open source (Apache-2.0): ${licence}`), 'llms.txt');
});

test('no page says Hoprig is under MIT: only Happy\'s licence is MIT, on its comparison page', () => {
  // Versions up to 0.2.1 were MIT; the site speaks of the current one. The Happy page names Happy's own licence, as a
  // bullet of its facts and in the licence row, where Hoprig's cell says Apache-2.0.
  const happy = [
    'MIT licence, and about',
    '| Licence | Open source (Apache-2.0) | Open source (MIT) |',
    '<tr><td>Licence</td><td data-label="Hoprig">Open source (Apache-2.0)</td><td data-label="Happy">Open source (MIT)</td></tr>',
  ];
  for (const f of text) {
    const body = read(f);
    assert.doesNotMatch(happy.reduce((b, ok) => b.split(ok).join(''), body), /\bMIT\b/, f);
  }
  assert.ok(read('compare/happy/index.html').includes(happy[2]), 'the licence row of the Happy page');
  for (const f of fs.readdirSync(path.join(root, 'site'), { recursive: true }).map(String)) {
    const full = path.join(root, 'site', f);
    if (f.split(path.sep).some((part) => part === 'node_modules' || part === 'dist') || !fs.statSync(full).isFile() || f.endsWith('package-lock.json')) continue;
    assert.doesNotMatch(happy.reduce((b, ok) => b.split(ok).join(''), fs.readFileSync(full, 'utf8')), /\bMIT\b/, `site/${f}`);
  }
});

test('no file holds a home path, an e-mail address, this computer\'s user, host or home folder, or a word a maintainer lists', () => {
  // What this checks: this computer's user name, host name and home folder (on CI those are the runner's, so it proves
  // little there), and the words a maintainer hands in through SITE_PRIVATE_WORDS (comma-separated). The owner's own
  // list of private words is checked before a release outside this repository, since that list cannot be public.
  const generic = new Set(['runner', 'root', 'user', 'node', 'ubuntu', 'admin', 'build', 'test', 'dev', 'app', 'vscode', 'codespace', 'localhost']);
  const me = os.userInfo();
  const words = [me.username, os.hostname().split('.')[0], ...(process.env.SITE_PRIVATE_WORDS || '').split(',')]
    .map((w) => w.trim()).filter((w) => w.length >= 3 && !generic.has(w.toLowerCase()));
  const sources = ['site/build.mjs', 'site/template.html', 'site/style.css', 'site/site.js', ...fs.readdirSync(path.join(root, 'site/lib')).map((f) => `site/lib/${f}`), ...fs.readdirSync(path.join(root, 'site/content'), { recursive: true }).map((f) => `site/content/${String(f).split(path.sep).join('/')}`).filter((f) => f.endsWith('.md'))];
  const found = [];
  const check = (name, body) => {
    if (body.includes(me.homedir)) found.push(`${name}: this computer's home folder`);
    for (const m of body.matchAll(/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)([A-Za-z][\w.-]*)/g)) if (!['you', 'me', 'name', 'user', 'alex'].includes(m[1])) found.push(`${name}: a home path (${m[0]})`);
    for (const m of body.matchAll(/\b[\w.+-]+@([\w-]+\.)+[a-z]{2,}\b/gi)) {
      if (/^git@/.test(m[0]) || /@([\w-]+\.)*(example\.(com|org|net)|example|invalid|test)$/i.test(m[0]) || /@\d+\.\d+\.\d+/.test(m[0])) continue;
      found.push(`${name}: an e-mail address (${m[0]})`);
    }
    for (const w of words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)) found.push(`${name}: a private name`);
  };
  for (const f of text) check(f, read(f));
  for (const f of sources) check(f, fs.readFileSync(path.join(root, f), 'utf8'));
  assert.deepEqual(found, []);
});
