// The walk of an extra folder's links (src/workspace/needswalk.mjs), as decided for it:
//  1. a private folder (no-ai, ignore, ai-ignore-dir) is NEVER entered, by any path, also when it is itself a link or a
//     link leads into one: every file call is watched, none names such a folder; the need is still opened, and Read is
//     denied to the file tools on the whole private folder and on a link that leads into one;
//  3. a link that leads out of the workspace keeps the folder closed, unless it is one the owner named as his own;
//  4. it never holds the dashboard: once per session start, in pieces (the server's thread comes back between them,
//     counted, not timed), and a folder that cannot be walked within five seconds is not opened ("too large to check").
// Throw-away workspace: shop needs kits/parts (needsfix.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { needsWorld } from './needsfix.mjs';

const N = await import('../../src/workspace/needs.mjs');
const W = await import('../../src/workspace/needswalk.mjs');
const PRIV = /(^|[\\/])(no-ai|ignore|ai-ignore-dir)([\\/]|$)/;

/** Every path given to a file call of node:fs while `fn` runs. */
async function watched(fn) {
  const names = ['opendirSync', 'readdirSync', 'lstatSync', 'statSync', 'readlinkSync', 'realpathSync', 'existsSync', 'readFileSync', 'openSync', 'accessSync'];
  const had = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const seen = [];
  for (const n of names) fs[n] = function (p, ...r) { seen.push(`${n} ${String(p)}`); return had[n].call(this, p, ...r); };
  try {
    return { r: await fn(), seen };
  } finally {
    Object.assign(fs, had);
  }
}

test('decision 1: a private folder of the need is never entered; links in it are not looked for; the need is still opened', async () => {
  const w = needsWorld('walk-private');
  try {
    const d = fs.realpathSync(w.parts);
    const self = fs.realpathSync(w.shop);
    // Links inside its private folders: to the credentials folder, to the brain, to a file outside the workspace.
    fs.writeFileSync(path.join(w.root, 'outside.txt'), 'outside: grey-wolf\n');
    fs.symlinkSync(path.join(w.ws, 'credentials'), path.join(w.parts, 'ai-ignore-dir', 'keys-plum'));
    fs.mkdirSync(path.join(w.parts, 'src', 'ignore'), { recursive: true });
    fs.symlinkSync(path.join(w.ws, 'ai_brain'), path.join(w.parts, 'src', 'ignore', 'mem-plum'));
    fs.mkdirSync(path.join(w.parts, 'no-ai'));
    fs.symlinkSync(path.join(w.root, 'outside.txt'), path.join(w.parts, 'no-ai', 'far-plum.txt'));
    // A private folder that is itself a link, to a folder that holds a link to the credentials folder.
    fs.mkdirSync(path.join(w.ws, 'shared'));
    fs.symlinkSync(path.join(w.ws, 'credentials'), path.join(w.ws, 'shared', 'all-plum'));
    fs.symlinkSync(path.join(w.ws, 'shared'), path.join(w.parts, 'docs-ignore-not')); // a plain name: walked
    fs.rmSync(path.join(w.parts, 'docs-ignore-not'));
    fs.mkdirSync(path.join(w.parts, 'lib'));
    fs.symlinkSync(path.join(w.ws, 'shared'), path.join(w.parts, 'lib', 'ignore'));
    const { r, seen } = await watched(async () => {
      const f = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self });
      const s = await N.extraSettings([d], { dir: w.ws, projects: w.projects, walked: { [d]: f.walked } });
      return { f, s };
    });
    assert.equal(r.f.ok, true, r.f.why);
    assert.deepEqual(seen.filter((c) => PRIV.test(c)), [], 'no file call names a private folder');
    assert.ok(!/plum/.test(JSON.stringify(r.f)), 'no name from inside a private folder');
    for (const p of ['ai-ignore-dir', 'no-ai', 'ignore']) {
      for (const rule of [`Read(/${W.ruleForm(d)}/${p})`, `Read(/${W.ruleForm(d)}/${p}/**)`, `Read(/${W.ruleForm(d)}/**/${p})`, `Read(/${W.ruleForm(d)}/**/${p}/**)`]) assert.ok(r.s.deny.includes(rule), rule);
    }
  } finally {
    w.cleanup();
  }
});

test('decision 1: a link (outside any private folder) that leads into a private folder is not walked; Read is denied on it and where it leads', async () => {
  const w = needsWorld('walk-into-private');
  try {
    const d = fs.realpathSync(w.parts);
    // blog's private folder holds a link to the credentials folder; parts links into it.
    fs.mkdirSync(path.join(w.projects, 'blog', 'ignore'), { recursive: true });
    fs.symlinkSync(path.join(w.ws, 'credentials'), path.join(w.projects, 'blog', 'ignore', 'vault'));
    fs.symlinkSync(path.join(w.projects, 'blog', 'ignore'), path.join(w.parts, 'theirs'));
    fs.symlinkSync(path.join(w.projects, 'blog', 'ignore', 'vault', 'shop'), path.join(w.parts, 'deeper'));
    const { r, seen } = await watched(() => N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self: fs.realpathSync(w.shop) }));
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(seen.filter((c) => PRIV.test(c)), [], 'not resolved through the private folder');
    const s = await N.extraSettings([d], { dir: w.ws, projects: w.projects, walked: { [d]: r.walked } });
    const blogIgnore = W.ruleForm(path.join(fs.realpathSync(path.join(w.projects, 'blog')), 'ignore'));
    const rd = W.ruleForm(d);
    for (const rule of [`Read(/${rd}/theirs)`, `Read(/${rd}/theirs/**)`, `Read(/${blogIgnore})`, `Read(/${blogIgnore}/**)`, `Read(/${rd}/deeper)`, `Read(/${rd}/deeper/**)`]) assert.ok(s.deny.includes(rule), rule);
    // Into a private folder of the credentials folder or of the brain: never opened.
    fs.mkdirSync(path.join(w.ws, 'ai_brain', 'ignore'), { recursive: true });
    fs.symlinkSync(path.join(w.ws, 'ai_brain', 'ignore'), path.join(w.parts, 'mem'));
    const b = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self: fs.realpathSync(w.shop) });
    assert.equal(b.ok, false);
    assert.match(b.why, /its link mem leads into the AI brain/);
  } finally {
    w.cleanup();
  }
});

test('decision 3: a link out of the workspace keeps the folder closed and names the link, unless it is the owner\'s own', async () => {
  const w = needsWorld('walk-out');
  try {
    const self = fs.realpathSync(w.shop);
    fs.mkdirSync(path.join(w.root, 'elsewhere'));
    const link = path.join(w.parts, 'lib', 'far');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(path.join(w.root, 'elsewhere'), link);
    const r = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self });
    assert.equal(r.ok, false);
    assert.match(r.why, /kits\/parts: its link lib\/far leads out of the workspace \(to .*elsewhere\), so it is not opened \(if that link is yours: {2}hoprig workspace mylink add .*lib[\\/]far'?\)/); // Windows: a quoted backslash path
    // The same for --with, and for a session's need.
    const ex = await N.sessionExtras(w.shop, { withs: [], dir: w.ws, projects: w.projects });
    assert.deepEqual(ex.dirs, []);
    assert.ok(ex.warnings.some((x) => /lib\/far leads out of the workspace/.test(x)));
    const wi = await N.sessionExtras(path.join(w.projects, 'blog'), { withs: ['kits/parts'], dir: w.ws, projects: w.projects });
    assert.match(wi.refused.join(' '), /lib\/far leads out of the workspace/);
    // Named as his own (the workspace's rule, `hoprig workspace mylink add`): opened, and its place is walked too.
    process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    const { addMyLink } = await import('../../src/workspace/inside.mjs');
    addMyLink(link);
    assert.equal((await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self })).ok, true);
    fs.symlinkSync(path.join(w.ws, 'credentials'), path.join(w.root, 'elsewhere', 'keys'));
    const k = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self });
    assert.equal(k.ok, false, 'what is below his own link is checked like the rest');
    assert.match(k.why, /lib\/far\/keys leads to the credentials folder/);
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
    w.cleanup();
  }
});

test('decision 4: the walk gives the thread back between pieces, counted; a terminal start walks the need once', async () => {
  const w = needsWorld('walk-pieces');
  try {
    const nm = path.join(w.parts, 'node_modules');
    for (let i = 0; i < 40; i++) {
      const dir = path.join(nm, `pkg${i}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let j = 0; j < 500; j++) fs.writeFileSync(path.join(dir, `f${j}.js`), '');
    }
    let back = 0;
    let going = true;
    const tick = () => { if (!going) return; back++; setImmediate(tick); };
    setImmediate(tick);
    const r = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self: fs.realpathSync(w.shop) });
    going = false;
    assert.equal(r.ok, true, r.why);
    // 20,000 entries in pieces of PIECE (1000): about 20 turns of the loop, each given back.
    assert.ok(back >= 20000 / W.PIECE - 2, `the thread came back ${back} times (at once: 0 or 1)`);
    // A terminal session's start (launch.mjs startExtras): the folder is walked once, its result handed to the settings.
    process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    const L = await import('../../src/launch.mjs');
    const d = fs.realpathSync(w.parts);
    const { r: st, seen } = await watched(() => L.startExtras([], { cwd: w.shop, say: () => {} }));
    assert.ok(st.extras && st.extras.settings, 'opened');
    assert.equal(seen.filter((c) => c === `opendirSync ${d}`).length, 1, 'walked once per start');
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
    w.cleanup();
  }
});

test('decision 4: a folder that cannot be walked within five seconds is not opened, and the start says so', async () => {
  assert.equal(W.WALK_MS, 5000);
  const w = needsWorld('walk-slow');
  try {
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(w.parts, `f${i}.txt`), '');
    let t = 0;
    const now = () => (t += 1000); // a clock that runs a second per look
    const r = await N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self: fs.realpathSync(w.shop), walkOpts: { now } });
    assert.equal(r.ok, false);
    assert.match(r.why, /kits\/parts: it is too large to check where its links lead within 5 seconds, so it is not opened/);
    t = 0;
    const ex = await N.sessionExtras(w.shop, { dir: w.ws, projects: w.projects, walkOpts: { now } });
    assert.deepEqual(ex.dirs, []);
    assert.ok(N.startNote(ex).some((l) => /too large to check/.test(l)));
  } finally {
    w.cleanup();
  }
});
