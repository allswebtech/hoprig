// Nothing of Go live runs by itself: a real dashboard start and three ticks of its watcher, with two projects
// whose project.json has check and live blocks (each command would leave a mark), no journal, every switch off. After
// it: no mark, no command run, no lock or journal in a repository's git folder, nothing of Go live in the state
// folder, and every file of the projects as it was (bytes and times).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { closedGateways } from '../seal.mjs';
import { tempShip } from './helpers.mjs';

const t = tempShip('ship-byitself');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
// tempShip gives this dashboard a workspace of its own (HOPRIG_WORKSPACE_DIR in its root): never the real one.
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));

const marks = path.join(t.root, 'marks');
const leave = (what) => ['node', '-e', `require('node:fs').mkdirSync(${JSON.stringify(marks)}, { recursive: true }); require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(marks)}, ${JSON.stringify(what)}), '1')`];
const blocks = (name) => JSON.stringify({
  check: [{ run: leave(`${name}-check`), minutes: 1 }],
  live: { update: [leave(`${name}-update`)], verify: [leave(`${name}-verify`)], back: [leave(`${name}-back`)], keep: ['data'] },
});
for (const name of ['shop', 'blog']) {
  const dir = path.join(t.projects, name);
  t.repo(dir, { 'project.json': blocks(name), 'data/db.json': '{}\n' });
  t.branch(dir, 'work/task', { 'x.txt': 'x\n' });
}

/** Every file below `dir` with its bytes' hash and its times (a read that changes nothing still leaves a file alone). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${st.mtimeMs} ${st.size}`;
    }
  };
  walk(dir);
  return out;
}

test('a dashboard start and three ticks: nothing of Go live is read, run or written', async () => {
  saveConfig({ addons: closedGateways(), server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const before = snapshot(t.projects);
  // Every read of a file below the projects made by Go live's code (src/ship/ in the caller's stack). The workspace
  // feature reads each project.json for its own folder field at start: that is not Go live, and not counted.
  const shipReads = [];
  const real = { readFileSync: fs.readFileSync, lstatSync: fs.lstatSync, readdirSync: fs.readdirSync };
  for (const k of Object.keys(real)) {
    fs[k] = function spy(p, ...rest) {
      if (String(p).startsWith(t.projects) && /[\\/]src[\\/]ship[\\/]/.test(new Error().stack)) shipReads.push(`${k} ${path.relative(t.projects, String(p))}`);
      return real[k].call(this, p, ...rest);
    };
  }
  test.after(() => Object.assign(fs, real));
  const app = createServer({ backend: { kind: 'tmux', list: async () => [], capture: async () => '' }, watchTickMs: 200, dashboardFile: false });
  let ticks = 0;
  // An idle watcher looks every 30 s: each tick pokes the next one, so three come within a few seconds.
  const three = new Promise((res) => app.watcher.onTick(() => (++ticks >= 3 ? res() : setTimeout(() => app.watcher.poke(), 50))));
  await app.listen(0, '127.0.0.1');
  try {
    await Promise.race([three, new Promise((_, rej) => setTimeout(() => rej(new Error(`only ${ticks} ticks in 90 s`)), 90_000))]);
  } finally {
    await app.close();
  }
  assert.ok(ticks >= 3);
  assert.equal(fs.existsSync(marks), false, 'no command of a project ran');
  assert.deepEqual(shipReads, [], 'Go live read nothing of a project');
  assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship')), false, 'nothing of Go live in the state folder');
  for (const name of ['shop', 'blog']) {
    const git = fs.readdirSync(path.join(t.projects, name, '.git'));
    assert.deepEqual(git.filter((n) => n.startsWith('hoprig-ship')), [], `${name}: no lock or journal`);
  }
  const after = snapshot(t.projects);
  // git may refresh its own index file on a read by another feature; the projects' own files are compared.
  const own = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.split(path.sep).includes('.git')));
  assert.deepEqual(own(after), own(before));
  assert.deepEqual(t.trapped(), []);
});
