// What `hoprig drop` removes without a word (dropsilent.mjs): ONLY a folder of build output that git ignores as a
// whole and what is in it, a provable credential link (dropcreds.test.mjs), and a plain file .DS_Store or Thumbs.db. A
// private folder anywhere else is on the typed list, whatever .gitignore says of it, and so is every other path that is
// not on the git server (an ignored apps/ too: it left the list). The proofs: the cases of the last look (a private
// folder under a tracked apps/ or vendor/ that .gitignore ignores), the system files in each shape, apps/, a grep for a
// second place that decides, and a property test on random trees: every path a drop removes is on the server, on the
// list the owner confirmed, inside such a folder, a provable credential link, or a system file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assert, dropOn, dropWorld, owner, reset } from './dropfix.mjs';
import { quietUi } from './gitfix.mjs';

const w = await dropWorld('silent');
test.after(() => w.cleanup());
const [A] = w.computers;
const api = () => path.join(A.shop, 'code', 'shop-api');
const API = 'projects/shop/code/shop-api';

test('a private folder under a tracked apps/ or vendor/ that .gitignore ignores is on the typed list, like one at the top; never removed without the name', async () => {
  await reset(A);
  w.commit(api(), '.gitignore', 'node_modules/\ndist/\n.env\n*.pem\nno-ai/\n');
  w.commit(api(), 'apps/web/index.js', 'x\n');
  w.commit(api(), 'vendor/kit/index.js', 'x\n');
  w.sh(api(), 'push', '-q');
  for (const rel of ['apps/web/no-ai/notes.md', 'no-ai/notes.md', 'vendor/kit/no-ai/notes.md']) {
    await reset(A);
    const file = path.join(api(), ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'the only copy of my notes\n');
    const folder = path.posix.dirname(rel);
    const chk = await dropOn(A, ['shop', '--check']);
    assert.equal(chk.code, 1, `${rel}: ${chk.text}`);
    assert.match(chk.text, new RegExp(`${API}/${folder}/ {2}private folder, not in git, 1 file`), `${rel}: ${chk.text}`);
    assert.doesNotMatch(chk.text, /notes\.md/, 'no name from inside it');
    const none = await dropOn(A, ['shop']);
    assert.equal(none.code, 1, none.text);
    assert.ok(fs.existsSync(file), `${rel}: kept without a terminal`);
    const wrong = await dropOn(A, ['shop'], { answers: (q) => (/Type the project/.test(q) ? 'shoop' : null) });
    assert.equal(wrong.code, 1, wrong.text);
    assert.ok(fs.existsSync(file), `${rel}: kept when the name is wrong`);
    const ok = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
    assert.equal(ok.code, 0, ok.text);
    assert.ok(ok.asked.some((q) => /Type the project/.test(q)), `${rel}: the name was asked for`);
  }
});

test('one place decides what goes without a word: the build-folder list and git check-ignore of drop are only in dropsilent.mjs, and every skip asks it', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const text = (f) => fs.readFileSync(f, 'utf8');
  const rel = (f) => path.relative(src, f).split(path.sep).join('/');
  // The drop modules and every module they import, statically or with import(): what a drop's decisions can come
  // from. Features further away keep skip lists of their own for other jobs (the chat's file picker, the skill finder
  // get runs after a clone); none of them is asked what a drop removes.
  const mods = fs.readdirSync(path.join(src, 'workspace')).filter((n) => /^drop[a-z]*\.mjs$/.test(n)).map((n) => path.join(src, 'workspace', n));
  const closure = new Set(mods);
  for (const f of mods) for (const m of text(f).matchAll(/(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+\.mjs)'/g)) closure.add(path.resolve(path.dirname(f), m[1]));
  assert.ok(closure.has(path.join(src, 'workspace', 'dropsilent.mjs')) && closure.size > 15, `the drop modules and their imports: ${closure.size}`);
  const others = [...closure].filter((f) => rel(f) !== 'workspace/dropsilent.mjs');
  // The list itself: two of its names that none of these has reason to spell.
  for (const f of others) assert.doesNotMatch(text(f), /'__pycache__'|'\.svelte-kit'|\bREBUILT\b/, `${rel(f)} holds a second list of build folders`);
  const drops = others.filter((f) => /^workspace\/drop[a-z]*\.mjs$/.test(rel(f)));
  assert.deepEqual(drops.map(rel).sort(), ['workspace/drop.mjs', 'workspace/dropacts.mjs', 'workspace/dropcheck.mjs', 'workspace/dropcli.mjs', 'workspace/dropfind.mjs', 'workspace/dropweb.mjs']);
  for (const f of drops) {
    assert.doesNotMatch(text(f), /check-ignore|DS_Store|Thumbs\.db/, `${rel(f)} judges ignored paths itself`);
    assert.doesNotMatch(text(f), /export (async )?function withoutAWord/, `${rel(f)} has its own withoutAWord`);
  }
  // Who asks: the ignored list of every repository (through ignoredItems' `silent`) and the private folders.
  const asks = drops.filter((f) => /withoutAWord\(/.test(text(f))).map(rel).sort();
  assert.deepEqual(asks, ['workspace/drop.mjs', 'workspace/dropcheck.mjs']);
  assert.match(text(path.join(src, 'workspace', 'dropcheck.mjs')), /ignoredItems\(wt, \[[^\]]*\], repos, \{ silent,/);
  assert.match(text(path.join(src, 'workspace', 'dropfind.mjs')), /const s = await silent\(abs/);
  // The credential check is get's own (credlinks.mjs planCredLinks), asked only by the one function.
  assert.deepEqual(drops.filter((f) => /planCredLinks/.test(text(f))).map(rel), [], 'no drop module asks about credential links itself');
  assert.match(text(path.join(src, 'workspace', 'dropsilent.mjs')), /import \{ planCredLinks \} from '\.\/credlinks\.mjs'/);
});

test('.DS_Store and Thumbs.db go without a word only as a plain file of that exact name; a folder or a link of that name is listed', async () => {
  await reset(A);
  w.commit(api(), '.gitignore', 'node_modules/\ndist/\n.env\n*.pem\n.DS_Store\nThumbs.db\n');
  w.sh(api(), 'push', '-q');
  for (const name of ['.DS_Store', 'Thumbs.db']) {
    // A plain file: at the top, and alone in a folder (git then lists the folder as ignored).
    await reset(A);
    fs.writeFileSync(path.join(api(), name), 'made by the system\n');
    fs.mkdirSync(path.join(api(), 'assets'));
    fs.writeFileSync(path.join(api(), 'assets', name), 'made by the system\n');
    const plain = await dropOn(A, ['shop', '--check']);
    assert.equal(plain.code, 0, `${name}, a plain file: ${plain.text}`);
    assert.doesNotMatch(plain.text, new RegExp(`${name.replace('.', '\\.')}|assets`), `${name}: not listed`);
    for (const shape of ['folder', 'link']) {
      await reset(A);
      const p = path.join(api(), name);
      if (shape === 'folder') {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'inside.txt'), 'x\n');
      } else fs.symlinkSync('README.md', p);
      const chk = await dropOn(A, ['shop', '--check']);
      assert.equal(chk.code, 1, `${name}, a ${shape}: ${chk.text}`);
      assert.match(chk.text, new RegExp(`${API}/${name.replace('.', '\\.')}${shape === 'folder' ? '/ {2}folder, 2 B, 1 file' : ' {2}link'}`), `${name}, a ${shape}: ${chk.text}`);
      const d = await dropOn(A, ['shop']);
      assert.equal(d.code, 1, d.text);
      assert.ok(fs.lstatSync(p), `${name}, a ${shape}: kept without a terminal`);
    }
  }
  // The plain files go with the project when it is dropped, without a question.
  await reset(A);
  fs.writeFileSync(path.join(api(), '.DS_Store'), 'x\n');
  const d = await dropOn(A, ['shop']);
  assert.equal(d.code, 0, d.text);
});

test('apps/ is no longer build output: an ignored apps/ with a file is on the typed list', async () => {
  await reset(A);
  w.sh(api(), 'rm', '-r', '-q', '--', 'apps');
  w.commit(api(), '.gitignore', 'node_modules/\ndist/\n.env\n*.pem\napps/\n');
  w.sh(api(), 'push', '-q');
  await reset(A);
  fs.mkdirSync(path.join(api(), 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(api(), 'apps', 'web', 'main.js'), 'my app\n');
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 1, chk.text);
  assert.match(chk.text, new RegExp(`${API}/apps/ {2}folder, 7 B, 1 file`), chk.text);
  assert.doesNotMatch(chk.text, /makes again: .*apps/, 'not said as build output');
  const d = await dropOn(A, ['shop']);
  assert.equal(d.code, 1, d.text);
  assert.ok(fs.existsSync(path.join(api(), 'apps', 'web', 'main.js')), 'kept without a terminal');
  const ok = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
  assert.equal(ok.code, 0, ok.text);
  assert.ok(ok.asked.some((q) => /Type the project/.test(q)), 'the name was asked for');
});

// ---- the property ----

// The test's own copy of the rule, as the lead wrote it: a folder of this list that git ignores as a whole; a plain
// file of one of these names; a link project.json names that points to the very file it names in credentials/.
const LIST = ['node_modules', 'vendor', '.next', '.nuxt', '.svelte-kit', '.turbo', '.dart_tool', '.gradle', 'Pods', 'build', 'dist', 'target', '__pycache__', '.pytest_cache', '.venv', 'coverage'];
const SYSTEM = ['.DS_Store', 'Thumbs.db'];
// The credential links project.json names in the property's world (relative to shop-api), and their targets.
const CREDS = { '.env.local': 'shop/api.env', 'web/.env.local': 'shop/web.env' };
const credsDir = () => path.join(A.ws, 'credentials');
const DIRS = ['src', 'apps', 'vendor', 'build', 'dist', 'node_modules', 'no-ai', 'ignore', 'test-data', 'lib', 'web', '.venv'];
const FILES = ['a.js', 'b.log', 'notes.md', '.DS_Store', 'Thumbs.db', 'x.o', 'data.sql', '.env'];
const RULES = ['no-ai/', 'ignore/', 'build/', '/build/', 'dist/', '/dist/', '*.log', 'apps/', 'vendor/', 'node_modules/', 'test-data/', '.DS_Store', '*.o', 'lib/', 'web/', '.venv/', '.env'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const blob = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');

/** A random tree in shop-api: ignore rules at several depths, tracked and untracked files. → [{ rel, text }] */
function makeTree(r, seed) {
  const dir = api();
  const files = [];
  const n = 6 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const depth = Math.floor(r() * 4);
    const parts = Array.from({ length: depth }, () => pick(r, DIRS));
    files.push({ rel: [...parts, pick(r, FILES)].join('/'), tracked: r() < 0.4 });
  }
  // Half the trees hold the case of the last look on purpose: a private folder under a folder named like build output
  // that the repository tracks a file of, with .gitignore ignoring the private name.
  const planted = r() < 0.5;
  let plantRule = '';
  if (planted) {
    const top = pick(r, ['apps', 'vendor', 'build', 'dist']);
    const sub = r() < 0.5 ? `${top}/web` : top;
    const priv = pick(r, ['no-ai', 'ignore']);
    files.push({ rel: `${sub}/index.js`, tracked: true }, { rel: `${sub}/${priv}/notes.md`, tracked: false });
    plantRule = `${priv}/\n`;
  }
  const uniq = [...new Map(files.map((f) => [f.rel, f])).values()];
  const rules = (k) => Array.from({ length: k }, () => pick(r, RULES)).join('\n') + '\n';
  const ignores = [{ rel: '.gitignore', text: `.env.local\n${plantRule}${rules(2 + Math.floor(r() * 4))}` }];
  const homes = [...new Set(uniq.map((f) => path.posix.dirname(f.rel)).filter((d) => d !== '.' && !d.split('/').some((x) => x === 'no-ai' || x === 'ignore')))];
  for (let i = 0; i < 2 && homes.length; i++) if (r() < 0.6) ignores.push({ rel: `${pick(r, homes)}/.gitignore`, text: rules(1 + Math.floor(r() * 2)) });
  const out = [];
  for (const g of new Map(ignores.map((g) => [g.rel, g])).values()) {
    fs.mkdirSync(path.dirname(path.join(dir, g.rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, g.rel), g.text);
    w.sh(dir, 'add', '-f', '--', g.rel);
  }
  for (const f of uniq) {
    const text = `seed ${seed}: ${f.rel}\n`;
    const abs = path.join(dir, ...f.rel.split('/'));
    if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) continue; // a file named like a folder of the tree
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    if (f.tracked && !f.rel.split('/').some((x) => x === 'no-ai' || x === 'ignore')) w.sh(dir, 'add', '-f', '--', f.rel);
    out.push({ rel: f.rel, text });
  }
  w.sh(dir, 'commit', '-q', '--allow-empty', '-m', `tree ${seed}`);
  w.sh(dir, 'push', '-q');
  // At each place project.json names a credential link: nothing, the right link, a link elsewhere in credentials/, a
  // real file, or a folder; and sometimes a link project.json does not name.
  const linkTo = (abs, target) => fs.symlinkSync(path.relative(path.dirname(abs), path.join(credsDir(), ...target.split('/'))), abs);
  for (const [place, target] of Object.entries(CREDS)) {
    const abs = path.join(dir, ...place.split('/'));
    fs.rmSync(abs, { recursive: true, force: true }); // what get made: a link is removed as a link
    const shape = pick(r, ['none', 'link', 'link', 'elsewhere', 'file', 'folder']);
    if (shape === 'none') continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (shape === 'link' || shape === 'elsewhere') {
      linkTo(abs, shape === 'link' ? target : 'shop/other.env');
      out.push({ rel: place, text: fs.readlinkSync(abs), link: true });
    } else if (shape === 'file') {
      fs.writeFileSync(abs, `seed ${seed}: my own ${place}\n`);
      out.push({ rel: place, text: `seed ${seed}: my own ${place}\n` });
    } else {
      fs.mkdirSync(abs);
      fs.writeFileSync(path.join(abs, 'mine.txt'), `seed ${seed}: in a folder\n`);
      out.push({ rel: `${place}/mine.txt`, text: `seed ${seed}: in a folder\n` });
    }
  }
  if (r() < 0.4) {
    const abs = path.join(dir, pick(r, ['deploy.key', 'web/deploy.key']));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) {
      linkTo(abs, 'shop/api.env');
      out.push({ rel: path.relative(dir, abs).split(path.sep).join('/'), text: fs.readlinkSync(abs), link: true });
    }
  }
  return out;
}

/** A provable credential link, by the test's own reading of the rule (asked before the drop). */
function provable(f) {
  if (!f.link || !Object.hasOwn(CREDS, f.rel)) return false;
  const abs = path.join(api(), ...f.rel.split('/'));
  try {
    return fs.lstatSync(abs).isSymbolicLink() && fs.realpathSync(abs) === fs.realpathSync(path.join(credsDir(), ...CREDS[f.rel].split('/')));
  } catch {
    return false;
  }
}
/** A plain file of a system's own name. */
const systemFile = (f) => !f.link && SYSTEM.includes(path.posix.basename(f.rel)) && fs.lstatSync(path.join(api(), ...f.rel.split('/'))).isFile();

/** Inside a folder of the list that git ignores as a whole (asked of git before the drop). */
function inIgnoredBuild(rel) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (!LIST.includes(parts[i])) continue;
    try {
      w.sh(api(), 'check-ignore', '-q', '--', `${parts.slice(0, i + 1).join('/')}/`);
      return true;
    } catch {
      /* not ignored as a whole */
    }
  }
  return false;
}

/** Every "path\0blob" on any branch of the server's shop-api. */
function onServerNow() {
  const bare = path.join(w.server, 'team', 'shop-api.git');
  const out = new Set();
  for (const ref of w.sh(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').filter(Boolean)) {
    for (const l of w.sh(bare, 'ls-tree', '-r', ref).split('\n').filter(Boolean)) {
      const [meta, p] = l.split('\t');
      out.add(`${p}\0${meta.split(' ')[2]}`);
    }
  }
  return out;
}

test('property: on random trees, every path a drop removes is on the git server, on the list the owner confirmed, inside a build folder git ignores as a whole, a provable credential link, or a system file', async () => {
  const { dropProject } = await import('../../src/workspace/drop.mjs');
  // The credentials folder, and project.json naming two links in shop-api.
  fs.mkdirSync(path.join(credsDir(), 'shop'), { recursive: true });
  for (const n of ['api.env', 'web.env', 'other.env']) fs.writeFileSync(path.join(credsDir(), 'shop', n), `KEY=${n}\n`);
  const seed0 = path.join(w.root, 'seed-shop');
  w.sh(seed0, 'pull', '-q');
  const pj = JSON.parse(fs.readFileSync(path.join(seed0, 'project.json'), 'utf8'));
  w.commit(seed0, 'project.json', JSON.stringify({ ...pj, credentials: Object.fromEntries(Object.entries(CREDS).map(([k, v]) => [`code/shop-api/${k}`, v])) }, null, 2) + '\n');
  w.sh(seed0, 'push', '-q');
  const there = (rel) => {
    try {
      return Boolean(fs.lstatSync(path.join(api(), ...rel.split('/'))));
    } catch {
      return false;
    }
  };
  const kinds = { provable: 0, system: 0 };
  const trees = Number(process.env.DROP_PROP_TREES || 20);
  const first = Number(process.env.DROP_PROP_SEED || 1);
  let dropped = 0;
  const bad = [];
  for (let seed = first; seed < first + trees; seed++) {
    await reset(A);
    const r = rng(seed);
    const files = makeTree(r, seed);
    const silentOk = new Map(files.map((f) => {
      const ok = inIgnoredBuild(f.rel) || provable(f) || systemFile(f);
      if (provable(f)) kinds.provable++;
      if (systemFile(f)) kinds.system++;
      return [f.rel, ok];
    }));
    let confirmed = [];
    const ask = { work: async () => true, defaultBranch: async () => 'wip', confirm: async (_name, items) => ((confirmed = items), true) };
    const q = await quietUi();
    A.use();
    const res = await dropProject('shop', { ctx: A.ctx, ask, ui: q.ui });
    if (fs.existsSync(A.shop)) {
      // Not dropped (refused, stopped): then every file is still where it was.
      for (const f of files) if (!there(f.rel)) bad.push(`seed ${seed}: ${f.rel} is gone though the drop said ${res.result}`);
      continue;
    }
    dropped++;
    const server = onServerNow();
    const listed = confirmed.map((i) => path.posix.join(i.repo.split(path.sep).join('/'), i.path));
    for (const f of files) {
      const full = `${API}/${f.rel}`;
      if (server.has(`${f.rel}\0${blob(f.text)}`)) continue;
      if (listed.some((l) => full === l.replace(/\/$/, '') || (l.endsWith('/') && full.startsWith(l)))) continue;
      if (silentOk.get(f.rel)) continue;
      bad.push(`seed ${seed}: ${f.rel} was removed without being on the server, on the list, or in ignored build output`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(dropped >= trees / 3, `enough trees were dropped to prove something: ${dropped} of ${trees}`);
  assert.ok(kinds.provable > 0 && kinds.system > 0, `the trees held both new cases: ${JSON.stringify(kinds)}`);
});
