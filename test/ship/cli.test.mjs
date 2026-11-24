// `hoprig ship` (src/ship/cli.mjs): a yes is only a question answered on a terminal (without one it is refused, and
// --yes is no answer); the whole path on the command line: together, allow, check, live, status --json, back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { tempShip } from './helpers.mjs';
import { DEPLOY, SERVER, manifest } from './fixtures/shop.mjs';

const t = tempShip('ship-cli');
const shop = path.join(t.projects, 'shop');
test.after(() => {
  try {
    process.kill(Number(fs.readFileSync(path.join(shop, 'run', 'server.pid'), 'utf8')), 'SIGKILL');
  } catch {
    /* none */
  }
  t.cleanup();
});
const { main } = await import('../../src/ship/cli.mjs');
const port = await new Promise((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
t.repo(shop, { 'server.mjs': SERVER, 'deploy.mjs': DEPLOY, 'port.txt': String(port), 'project.json': manifest(port), '.gitignore': 'run/\ndata/\n' });
t.branch(shop, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');

/** Run `hoprig ship …` with `answers` typed on a terminal (null: no terminal). → { code, out, err }. */
async function ship(args, answers = null) {
  const out = [];
  const err = [];
  const queue = answers ? [...answers] : null;
  const ask = queue ? async (q) => (out.push(q), queue.shift() ?? '') : null;
  // The check is told the computer is calm: it must not read how busy the computer that runs the suite is.
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), ask, projectsDir: t.projects, busy: () => ({ over: false, why: null }) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('without a terminal nothing is confirmed, and --yes is no answer', async () => {
  assert.equal((await ship(['together', 'shop', 'lunch', 'work/menu'])).code, 0);
  const r = await ship(['allow', 'shop', 'check', 'lunch', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /terminal/);
  assert.equal((await ship(['check', 'shop', 'lunch'])).code, 1);
  assert.match((await ship(['auto', 'shop', 'on'])).err, /typed on a terminal/);
  assert.equal((await ship(['allow', 'shop', 'check', 'lunch'], ['n'])).code, 1, 'a no is a no');
});

test('the whole path on the command line', async () => {
  const a = await ship(['allow', 'shop', 'check', 'lunch'], ['y']);
  assert.equal(a.code, 0);
  assert.match(a.out, /check: +node -e 'process\.exit\(0\)'/);
  const c = await ship(['check', 'shop', 'lunch']);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /ready \(1 passed, 0 failed\)/);
  assert.equal((await ship(['live', 'shop', 'lunch'], ['y'])).code, 1, 'live commands not confirmed yet');
  assert.equal((await ship(['allow', 'shop', 'live', 'lunch'], ['yes'])).code, 0);
  assert.equal((await ship(['live', 'shop', 'lunch'], ['no'])).out.includes('Nothing ran.'), true);
  const l = await ship(['live', 'shop', 'lunch'], ['y']);
  assert.equal(l.code, 0, l.err + l.out);
  assert.match(l.out, /update: +node deploy\.mjs [0-9a-f]{40}/);
  assert.match(l.out, /Live since \d\d:\d\d\./);
  const s = await ship(['status', 'shop', '--json']);
  const j = JSON.parse(s.out);
  assert.equal(j.last.outcome, 'live');
  assert.equal(j.togethers[0].check, 'ready');
  assert.ok(!s.out.includes(t.root), 'no full path in --json');
  const b = await ship(['back', 'shop'], ['y']);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /^This will run: node deploy\.mjs [0-9a-f]{40} {2}\(up to 2 min\)$/m, 'the commit, not {before}');
  assert.match(b.out, /Taken back/);
  assert.equal((await ship(['auto', 'shop', 'on'], ['shop'])).out, "It will go live by itself after a passed check, inside the hours. Type the project's name (shop) to turn it on: \nBy itself: on, 09:00 to 18:00");
  assert.equal((await ship(['nope', 'shop'])).code, 2);
  assert.deepEqual(t.trapped(), []);
});

test('a check on the command line never lets a project whose update restarts the dashboard go live by itself', async () => {
  // Only the dashboard sees the turns a restart would cut and waits for them (rule 6b).
  const kiosk = path.join(t.projects, 'kiosk');
  const mark = path.join(t.root, 'kiosk-updated');
  const touch = (f) => ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(f)}, '1')`];
  t.repo(kiosk, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { update: [touch(mark)], verify: [['node', '-e', '0']], back: [['node', '-e', '0']], restarts: 'hoprig', turnSeconds: 60 } }) });
  t.branch(kiosk, 'work/sign', { 'sign.txt': 'open\n' }, 'A sign');
  assert.equal((await ship(['together', 'kiosk', 'one', 'work/sign'])).code, 0);
  assert.equal((await ship(['allow', 'kiosk', 'check', 'one'], ['y'])).code, 0);
  assert.equal((await ship(['allow', 'kiosk', 'live', 'one'], ['y'])).code, 0);
  assert.equal((await ship(['auto', 'kiosk', 'on', '--from', '00:00', '--to', '23:59'], ['kiosk'])).code, 0);
  const c = await ship(['check', 'kiosk', 'one']);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /Not by itself: its update restarts the dashboard: it goes live by itself only from the dashboard\./);
  assert.equal(fs.existsSync(mark), false, 'the update did not run');
  // goLive itself refuses such a step without the wait for turns that only the dashboard gives.
  const { goLive } = await import('../../src/ship/live.mjs');
  const { readTogether, togetherId } = await import('../../src/ship/together.mjs');
  await assert.rejects(goLive(fs.realpathSync(kiosk), readTogether(togetherId(fs.realpathSync(kiosk), 'one')), { by: 'auto' }), (e) => e.details.code === 'page-only');
  assert.equal(fs.existsSync(mark), false);
  assert.deepEqual(t.trapped(), []);
});

test('in a shell a coding tool or Hoprig started, the terminal asks nothing, even when it is a terminal', async () => {
  // script(1) or a pty makes a terminal for any program: the marks of a coding tool's shell decide instead.
  const { terminalAsk } = await import('../../src/ship/cli.mjs');
  const { forget } = await import('../../src/ship/allow.mjs');
  forget(fs.realpathSync(shop), 'live'); // the whole path above confirmed it
  const tty = { isTTY: true };
  assert.equal(terminalAsk({ env: {}, input: {}, output: tty }), null, 'no terminal: nothing to ask on');
  for (const mark of ['CLAUDECODE', 'OPENCODE', 'HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID']) {
    const ask = terminalAsk({ env: { [mark]: '1' }, input: tty, output: tty });
    await assert.rejects(ask('Confirm? (y/N) '), (e) => e.details.code === 'coding-tool' && e.message.includes(mark));
    const out = [];
    const err = [];
    const code = await main(['allow', 'shop', 'live', 'lunch'], { out: (s) => out.push(s), err: (s) => err.push(s), ask, projectsDir: t.projects });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /your own terminal/);
  }
  const { loadConfig } = await import('../../src/config.mjs');
  assert.equal(loadConfig().ship.allowed[fs.realpathSync(shop)].live, undefined, 'no yes was kept');
});

test('the question before a yes says that it covers the words, not the scripts they run', async () => {
  const { COVERS } = await import('../../src/ship/cli.mjs');
  const r = await ship(['allow', 'shop', 'check', 'lunch'], ['n']);
  assert.ok(r.out.includes(COVERS.check), r.out);
  assert.match(COVERS.check, /code of the branches that were put together/);
  const l = await ship(['allow', 'shop', 'live', 'lunch'], ['n']);
  assert.ok(l.out.includes(COVERS.live), l.out);
  assert.match(COVERS.live, /unless it checks out \{before\} first/);
});

test('help prints the usage on the standard output and ends with 0', async () => {
  const { USAGE } = await import('../../src/ship/cli.mjs');
  const h = await ship(['help']);
  assert.deepEqual([h.code, h.out, h.err], [0, USAGE, '']);
  assert.equal((await ship([])).code, 2, 'no command at all is still a usage error');
});

test('a tree that passed and failed is said with its own counts', async () => {
  const { checkWords } = await import('../../src/ship/cli.mjs');
  assert.equal(checkWords({ state: 'mixed', passed: 2, failed: 1 }), 'passed 2 times and failed 1 time: not counted as passed');
  assert.equal(checkWords({ state: 'mixed', passed: 1, failed: 1 }), 'passed 1 time and failed 1 time: not counted as passed');
  assert.equal(checkWords({ state: 'ready', passed: 3, failed: 0 }), 'ready (3 passed, 0 failed)');
  const deli = path.join(t.projects, 'deli');
  const count = path.join(t.root, 'deli-count');
  const once = `const fs = require('node:fs'); const f = ${JSON.stringify(count)}; const n = fs.existsSync(f) ? 1 : 0; fs.writeFileSync(f, '1'); process.exit(n ? 0 : 1);`;
  t.repo(deli, { 'project.json': JSON.stringify({ check: [['node', '-e', once]] }) });
  t.branch(deli, 'work/soup', { 'soup.txt': 'soup\n' }, 'Soup');
  assert.equal((await ship(['together', 'deli', 'one', 'work/soup'])).code, 0);
  assert.equal((await ship(['allow', 'deli', 'check', 'one'], ['y'])).code, 0);
  for (let i = 0; i < 2; i++) await ship(['check', 'deli', 'one']);
  const c = await ship(['check', 'deli', 'one']);
  assert.match(c.out, /The check of this tree: passed 2 times and failed 1 time: not counted as passed\./);
});

test('the command line says what runs now after a go-live that was not verified', async () => {
  const { OUTCOME } = await import('../../src/ship/cli.mjs');
  assert.equal(OUTCOME['not-verified'], 'running now, but it does not answer as it should');
  assert.equal(OUTCOME.changed, 'running now, and kept files changed');
});

test('a put-together stopped at a conflict can be dropped; its branch stays and the tasks can be picked again', async () => {
  const diner = path.join(t.projects, 'diner');
  t.repo(diner, { 'menu.txt': 'soup\n' });
  t.branch(diner, 'work/a', { 'menu.txt': 'salad\n' }, 'Salad');
  t.branch(diner, 'work/b', { 'menu.txt': 'pasta\n' }, 'Pasta');
  const r = await ship(['together', 'diner', 'one', 'work/a', 'work/b']);
  assert.equal(r.code, 1);
  assert.match(r.out, /meets/);
  assert.equal((await ship(['drop', 'diner', 'one'])).code, 1, 'without a terminal nothing is dropped');
  assert.equal(JSON.parse((await ship(['status', 'diner', '--json'])).out).togethers.length, 1);
  const d = await ship(['drop', 'diner', 'one'], ['y']);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /Dropped\./);
  assert.deepEqual(JSON.parse((await ship(['status', 'diner', '--json'])).out).togethers, [], 'the picker is back');
  assert.ok(t.git(diner, 'rev-parse', '--verify', 'work/one-all'), 'its branch stays');
  assert.equal((await ship(['together', 'diner', 'two', 'work/a'])).code, 0, 'the tasks can be put together again');
});
