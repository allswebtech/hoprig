// A mission session's one tool (src/mission/boxtool.mjs, toolserver.mjs) on a real dashboard (createServer): the stand-in
// coding tool starts the product's own tool server from the session's start arguments alone (aloneArgs, an inline
// list), speaks the tool protocol to it, and its call reaches the route with the token of that one session. The token
// is tried on every other route of the dashboard, and each refuses it; the route refuses anything but the token. The
// box here is a stand-in that records what it was asked (the real box: boxtoolrun.test.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKE, missionHome } from './helpers.mjs';

const t = missionHome('mission-boxtool');
test.after(() => t.cleanup());
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root)); // a workspace of its own: never the real one
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { aloneArgs } = await import('../../src/work/alone.mjs');
const { treeFor } = await import('../../src/work/alonegit.mjs');
const { TOOL_ROUTE } = await import('../../src/mission/boxtool.mjs');
const { sampleOf, handledRoutes } = await import('../../src/assistant/acts.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'package.json': '{ "name": "shop", "scripts": { "test": "node --test" } }\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n', 'test/a.test.js': 'ok\n' });
saveConfig({
  server: { passwordHash: await hashPassword('pw'), roots: [t.home] },
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, test: ['npm', 'test'] } }, capUsd: 5, providers: [], atOnce: 2 },
});
t.arm();
const { dir: tree } = await treeFor(shop, 'work/cart-tests');
const asked = [];
const box = { check: async () => ({ ok: true }), run: async (argv, opts) => {
  asked.push({ argv, cwd: opts.cwd, write: opts.write });
  return { ok: true, code: 0, out: `ran in ${opts.cwd}\n1 passing\n`, timedOut: false };
} };
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, work: { missions: { engine: { box: () => box } } } });
const { port } = await app.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const door = app.features.find((f) => f.name === 'mission-tool');
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
const session = () => door.tools.make({ mission: 'm-20261120-aaaaaa', task: 'cart-tests', project: 'shop', top: shop, branch: 'work/cart-tests' });
const post = (p, { token, body = { paths: [] }, headers = {} } = {}) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });

/** The stand-in coding tool, started with a mission session's arguments and the tool of `tok`. → its log lines */
async function session1(tok, lines) {
  const log = path.join(t.root, `tool-${Date.now()}.log`);
  const args = aloneArgs({ restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], tool: { url: origin, token: tok.token } });
  const child = spawn(process.execPath, [FAKE, ...args], { cwd: tree, env: { ...process.env, FAKE_TOOL_LOG: log }, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(`The task.\n${lines.join('\n')}\n`);
  await new Promise((r) => child.once('close', r));
  const first = JSON.parse(out.split('\n')[0]);
  return { first, log: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => 'toolCall' in x) };
}

test('the session\'s call goes through the product\'s own tool server to the route, and the box runs the owner\'s test command in its worktree', async () => {
  const tok = session();
  asked.length = 0;
  const s = await session1(tok, ['RUNTESTS: {"paths":["test/a.test.js"]}', 'RUNTESTS: {}']);
  assert.deepEqual(s.first.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'mcp__hoprig__run_tests'], 'the file tools and the one tool, nothing else');
  assert.deepEqual(s.first.mcp_servers.map((x) => x.name), ['hoprig']);
  assert.equal(s.log.length, 2);
  assert.match(s.log[0].answer, /^The tests passed \(npm test test\/a\.test\.js, /);
  assert.match(s.log[0].answer, /Their last lines:\nran in \.\n1 passing/, 'the worktree\'s path is cleaned from what came back');
  assert.match(s.log[1].answer, /Run 2 of at most 12/);
  assert.deepEqual(asked.map((a) => a.argv), [['npm', 'test', 'test/a.test.js'], ['npm', 'test']], 'the owner\'s command, with the paths after it as they are');
  assert.deepEqual(asked.map((a) => a.cwd), [tree, tree]);
  assert.deepEqual(asked[0].write, [tree], 'the worktree is the one folder it may write');
  tok.drop();
});

test('the session cannot shape the call: other fields, other shapes and a free command are refused by the relay or the route, and nothing runs', async () => {
  const tok = session();
  asked.length = 0;
  const s = await session1(tok, ['RUNTESTS: {"argv":["sh","-c","id"]}', 'RUNTESTS: {"paths":"test"}', 'RUNTESTS: {"paths":["test"],"cwd":"/"}', `RUNTESTS: {"paths":[${JSON.stringify('a'.repeat(401))}]}`]);
  for (const x of s.log) {
    assert.equal(x.isError, true, x.answer);
    assert.match(x.answer, /^Refused: .*nothing ran\.$/);
  }
  // Straight to the route with the token: the body is { paths } and nothing else.
  for (const body of [{ paths: [], tree: '/' }, { command: 'id' }, { paths: [], env: { A: '1' } }, []]) {
    const r = await post(TOOL_ROUTE, { token: tok.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(asked.length, 0, 'nothing ran');
  tok.drop();
});

test('the route takes only a live session\'s own token: not the owner\'s sign-in, another bearer, a token in the address, or one that ended', async () => {
  const tok = session();
  asked.length = 0;
  assert.equal((await post(TOOL_ROUTE, { headers: { Cookie: cookie, Origin: origin } })).status, 401, 'the owner\'s sign-in');
  for (const other of [`hop_${'a'.repeat(43)}`, `hwt_${'a'.repeat(43)}`, `tia_${'a'.repeat(43)}`, `hbt_${'a'.repeat(43)}`]) assert.equal((await post(TOOL_ROUTE, { token: other })).status, 401, other.slice(0, 4));
  assert.equal((await post(`${TOOL_ROUTE}?t=${tok.token}`, {})).status, 400, 'in the address');
  assert.equal((await post(TOOL_ROUTE, { token: tok.token })).status, 200, 'its own token, alive');
  tok.drop();
  assert.equal((await post(TOOL_ROUTE, { token: tok.token })).status, 401, 'after the session ended');
  assert.equal(asked.length, 1);
});

test('the token reaches nothing else of the dashboard: every other route, page, relay and socket refuses it', async () => {
  const tok = session();
  const machines = app.features.find((f) => f.name === 'machines');
  // A path for each route's pattern; a pattern the sampler cannot fill gets its fixed start (still a route of the table).
  const unfilled = [];
  const sample = (re) => {
    try {
      return sampleOf(re);
    } catch {
      unfilled.push(re.source);
      return re.source.replace(/^\^/, '').replace(/\\\//g, '/').replace(/[(?$].*$/, '');
    }
  };
  const tables = [...app.routes, ...((machines && machines.machines && machines.machines.table) || [])].map(([method, re]) => [method, sample(re)]);
  const handled = handledRoutes().map((re) => ['POST', sample(re)]).filter(([, p]) => p !== TOOL_ROUTE);
  assert.ok(unfilled.length < 5, unfilled.join(' | '));
  const more = [['GET', '/'], ['GET', '/api/me'], ['GET', '/api/local/facts'], ['GET', '/m/box2/api/sessions'], ['POST', '/gateway/relay/v1/messages'], ['GET', '/api/work/token/tasks'], ['GET', '/api/mission-tool'], ['GET', '/api/mission-tool/other']];
  const all = [...tables, ...handled, ...more];
  assert.ok(all.length > 300, String(all.length));
  const wrong = [];
  for (const [method, p] of all) {
    const r = await fetch(origin + p, { method, headers: { Authorization: `Bearer ${tok.token}`, ...(method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': 'application/json' }) }, ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }) });
    const b = await r.json().catch(() => ({}));
    const ours = p.startsWith('/api/mission-tool');
    if (ours ? ![404, 405].includes(r.status) : !(r.status === 403 && b.code === 'token-scope')) wrong.push(`${method} ${p}: ${r.status} ${b.code || ''}`);
  }
  assert.deepEqual(wrong, [], 'each route refused the token before anything ran');
  // A WebSocket with the token: refused.
  const ws = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Authorization: `Bearer ${tok.token}` } });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve('upgraded'));
    req.on('error', () => resolve('closed'));
    req.end();
  });
  assert.equal(ws, 403);
  tok.drop();
});

test('the token is kept in no file: not in the state folder, the settings, the Work file or the worktree', async () => {
  const tok = session();
  const found = [];
  const walk = (d) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && e.name !== '.git') walk(f);
      else if (e.isFile() && fs.statSync(f).size < 4_000_000 && fs.readFileSync(f, 'utf8').includes(tok.token)) found.push(f);
    }
  };
  await post(TOOL_ROUTE, { token: tok.token });
  for (const d of [process.env.HOPRIG_STATE_DIR, process.env.HOPRIG_CONFIG_DIR, t.home]) walk(d);
  assert.deepEqual(found, []);
  tok.drop();
});

test('a shown copy of the session\'s start (the process list) has the token masked', async () => {
  const { redact } = await import('../../src/server/platform.mjs');
  const tok = session();
  const line = `claude -p ${aloneArgs({ restricted: ['Read'], tool: { url: origin, token: tok.token } }).join(' ')}`;
  assert.ok(line.includes(tok.token));
  assert.equal(redact(line, 4000).includes(tok.token), false, redact(line, 4000));
  tok.drop();
});

test('two dashboards on one state folder both keep their audit lines (no read-modify-write loss)', async () => {
  const boxtool = fileURLToPath(new URL('../../src/mission/boxtool.mjs', import.meta.url));
  const child = path.join(t.root, 'audit-child.mjs');
  fs.writeFileSync(child, `import { audit } from ${JSON.stringify(boxtool)};\n`
    + 'const [idx, count] = [process.argv[2], Number(process.argv[3])];\n'
    + "for (let i = 0; i < count; i += 1) audit({ at: new Date().toISOString(), mission: 'm', task: `c${idx}`, end: `${idx}-${i}`, ms: 0, runs: i });\n");
  const stateDir = process.env.HOPRIG_STATE_DIR;
  const file = path.join(stateDir, 'mission-box-runs.jsonl');
  fs.rmSync(file, { force: true });
  const kids = 4;
  const each = 120;
  await Promise.all(Array.from({ length: kids }, (_, k) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [child, String(k), String(each)], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
    c.once('error', reject);
    c.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ${k} exited ${code}`))));
  })));
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const marks = new Set(lines.map((l) => l.end));
  assert.equal(lines.length, kids * each, `every line is kept, none overwritten (${lines.length} of ${kids * each})`);
  for (let k = 0; k < kids; k += 1) for (let i = 0; i < each; i += 1) assert.ok(marks.has(`${k}-${i}`), `line ${k}-${i} is there`);
});

test('the audit is moved aside past its cap, so no line another dashboard appends meanwhile is lost', { timeout: 120_000 }, async () => {
  const boxtool = fileURLToPath(new URL('../../src/mission/boxtool.mjs', import.meta.url));
  const { AUDIT_MAX } = await import(boxtool);
  const child = path.join(t.root, 'audit-turn-child.mjs');
  // Each writer loads the module, says it is ready, and writes once it is told to go. The audit promises the last
  // AUDIT_MAX lines, not every writer's: a writer whose lines all came before those (under load one can end before
  // another is told to go) may have none kept. So a writer's kept lines are checked as a run that ends at its last
  // line, and one round lets the writers go one after another, where the order of all lines is known and what is kept
  // must be exactly their end.
  fs.writeFileSync(child, `import { audit } from ${JSON.stringify(boxtool)};\n`
    + 'const [idx, count] = [process.argv[2], Number(process.argv[3])];\n'
    + "process.stdin.once('data', () => {\n"
    + "  for (let i = 0; i < count; i += 1) audit({ at: 'x', mission: 'm', task: `c${idx}`, end: 'passed', ms: 0, runs: i });\n"
    + '  process.exit(0);\n'
    + '});\n'
    + "process.stdout.write('ready\\n');\n");
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-box-runs.jsonl');
  const kids = 4;
  const each = 1500; // 6000 lines from four writers: the file is moved aside more than once while they append
  const writer = (k) => {
    const c = spawn(process.execPath, [child, String(k), String(each)], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    const ready = new Promise((resolve, reject) => {
      c.stdout.once('data', resolve);
      c.once('error', reject);
      c.once('close', (code) => reject(new Error(`child ${k} exited ${code} before it was ready`)));
    });
    const done = new Promise((resolve, reject) => {
      c.once('error', reject);
      c.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ${k} exited ${code}`))));
    });
    return { c, ready, done };
  };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const together of [true, true, false]) {
    for (const f of [file, `${file}.1`]) fs.rmSync(f, { force: true });
    if (together) {
      const children = Array.from({ length: kids }, (_, k) => writer(k));
      await Promise.all(children.map((x) => x.ready));
      for (const { c } of children) c.stdin.end('go\n');
      await Promise.all(children.map((x) => x.done));
    } else {
      for (let k = 0; k < kids; k += 1) {
        const w = writer(k);
        await w.ready;
        w.c.stdin.end('go\n');
        await w.done;
      }
    }
    assert.ok(read(`${file}.1`).length > AUDIT_MAX, 'the file was moved aside');
    const kept = [...read(`${file}.1`), ...read(file)];
    let some = 0;
    for (let k = 0; k < kids; k += 1) {
      const runs = kept.filter((l) => l.task === `c${k}`).map((l) => l.runs);
      if (runs.length === 0) continue; // all of its lines came before the last AUDIT_MAX
      some += 1;
      assert.equal(runs[runs.length - 1], each - 1, `writer ${k} has lines kept, so its last line is kept`);
      assert.deepEqual(runs, Array.from({ length: runs.length }, (_, i) => runs[0] + i), `writer ${k}: no line missing inside what is kept`);
    }
    assert.ok(some >= 2, `the lines of more than one writer are kept (${some})`);
    if (!together) {
      const all = Array.from({ length: kids * each }, (_, n) => `c${Math.floor(n / each)}:${n % each}`);
      assert.deepEqual(kept.map((l) => `${l.task}:${l.runs}`), all.slice(all.length - kept.length), 'one after another: what is kept is exactly the end of all lines');
    }
    assert.ok(kept.length >= AUDIT_MAX, `at least the last ${AUDIT_MAX} lines are kept (${kept.length})`);
    assert.ok(read(file).length <= AUDIT_MAX + kids, `the file stays near its cap (${read(file).length})`);
  }
});

test('a guard of the audit left by a dashboard that died while it moved the file is taken over once it is old', async () => {
  const { audit, AUDIT_MAX } = await import('../../src/mission/boxtool.mjs');
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-box-runs.jsonl');
  for (const f of [file, `${file}.1`]) fs.rmSync(f, { force: true });
  const guard = `${file}.turn`;
  fs.writeFileSync(guard, '');
  const lines = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  for (let i = 0; i < AUDIT_MAX + 5; i += 1) audit({ at: 'x', mission: 'm', task: 't', end: 'passed', ms: 0, runs: i });
  assert.equal(lines(), AUDIT_MAX + 5, 'a fresh guard: another dashboard moves it now, so this one leaves it');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(guard, old, old);
  audit({ at: 'x', mission: 'm', task: 't', end: 'passed', ms: 0, runs: AUDIT_MAX + 5 });
  assert.equal(fs.existsSync(file), false, 'moved aside: the next line begins a new file');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').split('\n').filter(Boolean).length, AUDIT_MAX + 6, 'every line kept in the one before it');
  assert.equal(fs.existsSync(guard), false, 'the old guard is gone');
  audit({ at: 'x', mission: 'm', task: 't', end: 'passed', ms: 0, runs: AUDIT_MAX + 6 });
  assert.equal(lines(), 1);
});

test('a dashboard that stops writes the refusal count of its live sessions, once', async () => {
  const { boxTools } = await import('../../src/mission/boxtool.mjs');
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-box-runs.jsonl');
  for (const f of [file, `${file}.1`]) fs.rmSync(f, { force: true });
  const tools = boxTools({ settings: () => ({ projects: {} }), box: () => null, on: () => false });
  const a = tools.make({ mission: 'm-20261120-bbbbbb', task: 'stop-a', project: 'shop', top: shop, branch: 'work/stop-a' });
  const b = tools.make({ mission: 'm-20261120-bbbbbb', task: 'stop-b', project: 'shop', top: shop, branch: 'work/stop-b' });
  for (let i = 0; i < 3; i += 1) await tools.call(a.rec, []); // missions off for the project: refused, nothing ran
  tools.dropAll();
  a.drop(); // the run settles after the stop: no second line
  b.drop();
  const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.task, l.end, l.refused]), [['stop-a', 'refused', 3]], 'one line for the session that was refused, none for the other');
  assert.equal(tools.size(), 0);
});

// Two dashboards cross the cap at the same moment while a guard a dead dashboard left is old, put in order with a hook:
// taker A judges the stale guard, and right there, before A removes it, taker B does its whole turn (takes the stale
// guard over, moves the full file aside, gives the guard back). A must then move nothing — its full file is already in
// .1, so it is never replaced by a nearly empty one — and every line before the cap is kept. (The old copy-and-rename
// lost a line here; a second move would put a near-empty file over the full .1.)
test('two takers of one stale guard crossing the cap at once: one moves the file, and the full audit file is never lost', async () => {
  const { turnAudit, AUDIT_MAX } = await import('../../src/mission/boxtool.mjs');
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-box-runs.jsonl');
  const guard = `${file}.turn`;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l).end);
  for (let round = 0; round < 20; round += 1) {
    for (const f of [file, `${file}.1`, guard]) fs.rmSync(f, { force: true });
    const want = Array.from({ length: AUDIT_MAX + 1 }, (_, i) => `pre-${i}`); // one past the cap: a turn is due
    fs.writeFileSync(file, `${want.map((e) => JSON.stringify({ end: e })).join('\n')}\n`);
    fs.writeFileSync(guard, '');
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(guard, old, old);
    let bWent = false;
    // A's turn: when A judges the stale guard, B's whole turn runs before A removes it.
    turnAudit({ judged: () => { if (!bWent) { bWent = true; turnAudit(); } } });
    assert.equal(bWent, true, `round ${round}: the second taker's turn ran inside the first's look`);
    const kept = new Set([...read(`${file}.1`), ...read(file)]);
    const missing = want.filter((w) => !kept.has(w));
    assert.deepEqual(missing, [], `round ${round}: every line before the cap is kept (${missing.length} missing)`);
    assert.equal(read(`${file}.1`).length, want.length, `round ${round}: the full file (${want.length}) went to .1, not a near-empty one`);
    assert.ok(read(file).length <= 1, `round ${round}: the current file is empty after the one move (${read(file).length})`);
    assert.equal(fs.existsSync(guard), false, `round ${round}: no guard is left behind`);
  }
});

// The same race, put in order on purpose: taker A judges the guard stale; before it takes it over, taker B takes the
// stale guard over and holds it. A must then see that what it would take is B's fresh guard, not the stale one.
test('two takers of one stale guard, one after the other\'s look: only one holds it, and the holder\'s guard stays', async () => {
  const { takeGuard, releaseGuard } = await import('../../src/mission/boxtool.mjs');
  const guard = path.join(process.env.HOPRIG_STATE_DIR, 'two-takers.turn');
  fs.writeFileSync(guard, '');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(guard, old, old);
  let b = null;
  const a = takeGuard(guard, { judged: () => { b = takeGuard(guard); } });
  assert.ok(b, 'B took the stale guard over');
  assert.equal(a, null, 'A did not take B\'s fresh guard: one holder only');
  assert.equal(fs.existsSync(guard), true, 'B\'s guard is still there');
  assert.deepEqual(fs.readdirSync(path.dirname(guard)).filter((f) => f.startsWith('two-takers.turn.')), [], 'nothing of A\'s is left beside it');
  releaseGuard(guard, b);
  assert.equal(fs.existsSync(guard), false, 'B gives back its own guard');
});

// The same on a file system that gives a freed inode to the next new file at once (ext4 does): B's fresh guard has the
// stale guard's inode, so an inode does not tell the two apart. Played here for certain: the stale guard's inode is
// kept under a name of the test's own and put in the place of B's fresh guard, with B's content and a fresh time.
test('two takers of one stale guard, and the fresh guard gets the stale one\'s inode: only one holds it', async () => {
  const { takeGuard, releaseGuard } = await import('../../src/mission/boxtool.mjs');
  const guard = path.join(process.env.HOPRIG_STATE_DIR, 'reused.turn');
  const keep = path.join(process.env.HOPRIG_STATE_DIR, 'reused-keep', 'inode');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(guard, '');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(guard, old, old);
  const stale = fs.statSync(guard);
  fs.linkSync(guard, keep); // the stale guard's inode stays alive under this name
  let b = null;
  let fresh = null;
  const a = takeGuard(guard, { judged: () => {
    b = takeGuard(guard);
    fs.writeFileSync(keep, fs.readFileSync(guard)); // B's guard as the reused inode holds it, written now
    fs.renameSync(keep, guard);
    fresh = fs.statSync(guard);
    b = { ...b, ino: fresh.ino, dev: fresh.dev }; // what B's own look at its new guard says on such a file system
  } });
  assert.ok(b, 'B took the stale guard over');
  assert.equal(fresh.ino, stale.ino, 'B\'s guard has the stale guard\'s inode, as on such a file system');
  assert.equal(a, null, 'A did not take B\'s fresh guard: one holder only');
  assert.equal(fs.existsSync(guard), true, 'B\'s guard is still there');
  assert.deepEqual(fs.readdirSync(path.dirname(guard)).filter((f) => f.startsWith('reused.turn.')), [], 'nothing of A\'s is left beside it');
  releaseGuard(guard, b);
  assert.equal(fs.existsSync(guard), false, 'B gives back its own guard');
});

// A small file put back while a new one was begun: its lines are copied into the new file. A writer that opened the
// file before it was taken away writes its line into the taken file after that copy: the line is copied too.
test('a line written into the taken file after its copy into a new file is kept', async () => {
  const { moveAside } = await import('../../src/mission/boxtool.mjs');
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'late-line.jsonl');
  const line = (e) => `${JSON.stringify({ end: e })}\n`;
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, ['a', 'b', 'c'].map(line).join(''));
  let late = false;
  moveAside(file, {
    renamed: () => fs.writeFileSync(file, line('new-1')), // another dashboard begins a new file meanwhile
    copied: (mine) => {
      if (late) return;
      late = true;
      fs.appendFileSync(mine, line('late')); // the writer that opened the file before the rename
    },
  });
  assert.equal(late, true, 'the late writer wrote');
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).end);
  assert.deepEqual(kept.sort(), ['a', 'b', 'c', 'late', 'new-1']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('late-line.jsonl.')), [], 'nothing is left beside it');
  fs.rmSync(file, { force: true });
});

test('two sessions of one project at once: each token runs only its own task\'s worktree, and ending one leaves the other', async () => {
  const { treeFor } = await import('../../src/work/alonegit.mjs');
  await treeFor(shop, 'work/wishlist-tests');
  asked.length = 0;
  const a = door.tools.make({ mission: 'm-20261120-cccccc', task: 'cart-tests', project: 'shop', top: shop, branch: 'work/cart-tests' });
  const b = door.tools.make({ mission: 'm-20261120-cccccc', task: 'wishlist-tests', project: 'shop', top: shop, branch: 'work/wishlist-tests' });
  assert.equal((await post(TOOL_ROUTE, { token: a.token })).status, 200);
  assert.equal((await post(TOOL_ROUTE, { token: b.token })).status, 200);
  assert.equal(asked.length, 2, 'each call ran');
  assert.notEqual(asked[0].cwd, asked[1].cwd, 'each token ran in its own task\'s worktree, never the other\'s');
  a.drop();
  assert.equal((await post(TOOL_ROUTE, { token: a.token })).status, 401, 'the session that ended is refused');
  assert.equal((await post(TOOL_ROUTE, { token: b.token })).status, 200, 'the other session of the same project still works');
  b.drop();
});

test('a token is dead after its session ends any way, after the dashboard stops, and a restart knows no token', async () => {
  const { boxTools } = await import('../../src/mission/boxtool.mjs');
  // However a run ends (done, failed, stopped, a limit), the engine drops its token in the run's finally; a stop or
  // Tia off closes the engine, which drops them all. Here: a dropped token is refused, dropAll refuses the rest.
  const s1 = door.tools.make({ mission: 'm-20261120-dddddd', task: 'one', project: 'shop', top: shop, branch: 'work/cart-tests' });
  const s2 = door.tools.make({ mission: 'm-20261120-dddddd', task: 'two', project: 'shop', top: shop, branch: 'work/cart-tests' });
  assert.equal((await post(TOOL_ROUTE, { token: s1.token })).status, 200, 'a live token works');
  s1.drop(); // a run that ended (any kind): the engine's finally
  assert.equal((await post(TOOL_ROUTE, { token: s1.token })).status, 401, 'the token is dead when its run settled');
  door.tools.dropAll(); // the dashboard stopped, or Tia was switched off
  assert.equal((await post(TOOL_ROUTE, { token: s2.token })).status, 401, 'every token is dead when the dashboard stops');
  // A restart: the tokens live only in the memory of the dashboard that made them, so a fresh one knows none.
  const fresh = boxTools({ settings: () => ({ projects: {} }), box: () => null, on: () => true });
  assert.equal(fresh.find(s1.token), null, 'a restarted dashboard knows no earlier token');
  assert.equal(fresh.find(s2.token), null);
});
