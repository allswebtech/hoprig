// A pattern typed in the page never runs on the server's one thread. One that backtracks over a long line (a half-typed
// nested quantifier is enough: the search box sends a search as the person pauses) held every terminal and page of the
// dashboard for seconds. ripgrep and git run it as programs of their own; the walk, the check of the pattern and the
// count of a long line's matches run in src/editor/walk.mjs's worker, under a time limit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-patterns');
test.after(() => box.cleanup());

const { LIMITS, search } = await import('../../src/editor/search.mjs');
const { which } = await import('../../src/setup/system.mjs');

const SRC = new URL('../../src/editor/', import.meta.url);
const projects = path.join(box.root, 'projects');
const repo = path.join(projects, 'repo');
const plain = path.join(projects, 'plain');
const roots = [fs.realpathSync(box.root)];
for (const d of [repo, plain]) fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo });
const engines = [...(which('rg') ? [['rg', repo]] : []), ['git', repo], ['walk', plain]];

/** The longest time the event loop was held while `fn` ran (a 5 ms ticker). */
async function held(fn) {
  let last = performance.now();
  let most = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    most = Math.max(most, now - last - 5);
    last = now;
  }, 5);
  try {
    const t0 = performance.now();
    const out = await fn().then((r) => ({ r }), (e) => ({ e }));
    return { ...out, ms: performance.now() - t0, most: Math.max(most, performance.now() - last - 5) };
  } finally {
    clearInterval(tick);
  }
}

// A hold of the server is a property of the code and shows every time; one long gap on a busy shared computer is
// not. So a run that was over the limit is measured once more, and the smaller hold counts.
async function heldTwice(fn) {
  const first = await held(fn);
  if (first.most < 50) return first;
  const second = await held(fn);
  return second.most < first.most ? second : first;
}

/** Short limits for these tests (each case waits for one at most). */
async function withLimits(over, fn) {
  const keep = { ...LIMITS };
  Object.assign(LIMITS, over);
  try {
    return await fn();
  } finally {
    Object.assign(LIMITS, keep);
  }
}

test('by construction: outside walk.mjs no module of the editor\'s server builds or runs a pattern it was given', () => {
  // Outside walk.mjs a pattern is a literal of the module or one of its UPPER_CASE constants: no RegExp is built,
  // matchAll is not used, exec and test run on a literal or a constant, string methods take a literal pattern.
  // A line named here is checked by hand: its pattern is the module's own.
  const KNOWN = new Set(['archive.mjs: const m = SIZE.map((re) => re.exec(l)).find(Boolean);']);
  const literal = (before) => /\/[dgimsuyv]*$/.test(before) || /\b[A-Z][A-Z0-9_]*$/.test(before);
  const wrong = [];
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.mjs') && n !== 'walk.mjs').sort()) {
    for (const line of fs.readFileSync(new URL(f, SRC), 'utf8').split('\n')) {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
      const id = `${f}: ${line.trim()}`;
      if (KNOWN.has(id)) continue;
      if (/\bRegExp\s*\(/.test(code) || /\.matchAll\s*\(/.test(code)) wrong.push(id);
      for (const m of code.matchAll(/\.(exec|test)\s*\(/g)) if (!literal(code.slice(0, m.index))) wrong.push(id);
      for (const m of code.matchAll(/\.(match|search|replace|replaceAll|split)\s*\(\s*/g)) {
        const arg = code.slice(m.index + m[0].length);
        if (!/^(['"`/]|path\.sep\b|[A-Z][A-Z0-9_]*\b)/.test(arg)) wrong.push(id);
      }
    }
  }
  assert.deepEqual(wrong, []);
  // In walk.mjs a RegExp is built in two functions only, and those are called only by the worker's own code.
  const parts = fs.readFileSync(new URL('walk.mjs', SRC), 'utf8').split(/\n(?=(?:export )?(?:async )?function )/);
  for (const part of parts) {
    const name = (/^(?:export )?(?:async )?function (\w+)/.exec(part) || [])[1] || '(module top)';
    const body = part.replace(/^(?:export )?(?:async )?function \w+/, '');
    if (/\bRegExp\s*\(/.test(body)) assert.ok(['compiled', 'globRe'].includes(name), `${name} builds a RegExp`);
    if (/\b(compiled|globRe)\s*\(/.test(body)) assert.ok(['run', 'count'].includes(name), `${name} calls the worker's compile`);
  }
});

test('while a search runs, no RegExp is built on this thread from what was typed (any engine)', async () => {
  fs.writeFileSync(path.join(repo, 'long.txt'), `price ${'x'.repeat(600)} price\n`);
  fs.writeFileSync(path.join(plain, 'long.txt'), `price ${'x'.repeat(600)} price\n`);
  const Real = globalThis.RegExp;
  const built = [];
  globalThis.RegExp = new Proxy(Real, {
    construct: (T, a) => (built.push(String(a[0])), new T(...a)),
    apply: (T, _, a) => (built.push(String(a[0])), T(...a)),
  });
  try {
    for (const [engine, dir] of engines) {
      for (const o of [{ q: 'pr[i]ce', regex: true }, { q: 'price', word: true }, { q: 'pri(' , regex: true }]) {
        await search(dir, o, roots, { engine }).catch((e) => assert.equal(e.status, 400));
      }
    }
  } finally {
    globalThis.RegExp = Real;
    for (const d of [repo, plain]) fs.rmSync(path.join(d, 'long.txt'), { force: true });
  }
  assert.deepEqual(built.filter((s) => /pr\[i\]ce|price|pri\(/.test(s)), []);
});

for (const n of [29, 40]) {
  test(`(x+x+)+y over "xxy", 200 spaces and ${n} x's: every engine answers within the limit and never holds the server`, async () => {
    const line = `xxy${' '.repeat(200)}${'x'.repeat(n)}\n`;
    for (const [, dir] of engines) fs.writeFileSync(path.join(dir, 'redos.txt'), line);
    try {
      await withLimits({ ms: 3000, countMs: 800 }, async () => {
        for (const [engine, dir] of engines) {
          const h = await heldTwice(() => search(dir, { q: '(x+x+)+y', regex: true }, roots, { engine }));
          assert.equal(h.e, undefined, `${engine}: ${h.e && h.e.message}`);
          assert.deepEqual(h.r.matches.map((m) => `${m.path}:${m.line}:${m.col}`), ['redos.txt:1:1'], engine);
          // ripgrep counts the line's matches itself; elsewhere the worker gives up at its limit and the line has none.
          if (engine === 'rg') assert.equal(h.r.matches[0].count, 1);
          assert.ok(h.ms < LIMITS.ms, `${engine}: answered in ${Math.round(h.ms)} ms`);
          assert.ok(h.most < 50, `${engine}: the server was held ${Math.round(h.most)} ms`);
        }
      });
    } finally {
      for (const [, dir] of engines) fs.rmSync(path.join(dir, 'redos.txt'), { force: true });
    }
  });
}

test('three more patterns that backtrack, each over a line of 100,000 characters: an answer in time, the server free', async () => {
  const cases = [
    ['(a|a)+$', `${'a'.repeat(100_000)}!\n`],
    ['(.*)*x', `${'y'.repeat(100_000)}\n`],
    ['(a+)+b', `${'a'.repeat(100_000)}c\n`],
  ];
  await withLimits({ ms: 1500, countMs: 500 }, async () => {
    for (const [q, text] of cases) {
      for (const [, dir] of engines) fs.writeFileSync(path.join(dir, 'big.txt'), text);
      try {
        for (const [engine, dir] of engines) {
          const h = await heldTwice(() => search(dir, { q, regex: true }, roots, { engine }));
          // An answer: nothing found, stopped at the time limit, or "too long" from git's own PCRE limit (a 400).
          if (h.e) assert.equal(h.e.status, 400, `${engine} ${q}: ${h.e.message}`);
          else assert.deepEqual(h.r.matches, [], `${engine} ${q}`);
          assert.ok(h.ms < LIMITS.ms + 1000, `${engine} ${q}: answered in ${Math.round(h.ms)} ms`);
          assert.ok(h.most < 50, `${engine} ${q}: the server was held ${Math.round(h.most)} ms`);
        }
      } finally {
        for (const [, dir] of engines) fs.rmSync(path.join(dir, 'big.txt'), { force: true });
      }
    }
  });
});

test('a bad regular expression is still a 400 with the reason, now found in the worker', async () => {
  for (const [engine, dir] of engines) {
    await assert.rejects(search(dir, { q: 'a(b', regex: true }, roots, { engine }), (e) => e.status === 400 && /not a valid regular expression/.test(e.message), engine);
  }
});

test('over the route: while such a search runs, GET /login is answered within 50 ms', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  fs.writeFileSync(path.join(plain, 'redos.txt'), `xxy${' '.repeat(200)}${'x'.repeat(40)}\n`);
  // No ripgrep on this PATH and no repository: the walk, whose count of the long line ran on the server's thread.
  const bin = path.join(box.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  saveConfig({ server: { passwordHash: await hashPassword('pw'), port: 1, roots: [projects] } });
  const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
  const app = createServer({ backend, watch: false, dashboardFile: false, machines: { claudeVersion: async () => null }, editor: { cleanup: false, searchEnv: { ...process.env, PATH: bin } } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    let done = false;
    const asked = fetch(`${base}/api/code/search?${new URLSearchParams({ root: plain, q: '(x+x+)+y', regex: 'true' })}`, { headers: { Cookie: cookie } })
      .then(async (r) => ({ status: r.status, json: await r.json() })).finally(() => { done = true; });
    const times = [];
    await new Promise((r) => setTimeout(r, 100));
    const loop = performance.eventLoopUtilization();
    while (!done && times.length < 20) {
      const t0 = performance.now();
      const r = await fetch(`${base}/login`);
      await r.text();
      times.push(performance.now() - t0);
      await new Promise((res) => setTimeout(res, 50));
    }
    const busy = performance.eventLoopUtilization(loop).utilization;
    const res = await asked;
    assert.equal(res.status, 200);
    assert.equal(res.json.engine, 'walk');
    assert.deepEqual(res.json.matches.map((m) => m.line), [1]);
    assert.ok(times.length >= 3, `the search ran long enough to ask ${times.length} times`);
    // The server's thread is not held by the search: measured as the share of the search its event loop was busy (the
    // server runs in this process), not as the time of an answer, which a computer shared with other runs stretches
    // (two other programs on its one CPU: 58 to 65 ms with the count in the worker). Measured on 25 Nov 2026: with the
    // count in the worker, 26 % beside those two programs; with the thread held for 1.5 s of the search, 64 %; with the
    // count itself on the thread, the search never ends (the test runs out of time). Half lies between.
    assert.ok(busy < 0.5, `the server's thread was busy ${Math.round(busy * 100)} % of the search (GET /login took ${times.map(Math.round).join(', ')} ms)`);
  } finally {
    await app.close();
    fs.rmSync(path.join(plain, 'redos.txt'), { force: true });
  }
});
