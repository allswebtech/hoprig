// A schedule that names another computer (src/work/schedfeature.mjs): computer B is a real dashboard (`hoprig serve`
// in a home of its own, with a stand-in coding tool), computer A (this test) is linked to it by its address and a
// token. At the slot A asks B over that link; B runs it by itself on a branch of its own and keeps the result. When B
// cannot be reached the slot is missed with the reason and nothing runs on A.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '..', '..', 'bin', 'hoprig.mjs');
const FAKE = path.join(here, 'fixtures', 'fake-alone.mjs');
const t = tempWork('work-alonelink');
test.after(() => t.cleanup());
const { putMachine } = await import('../../src/machines/store.mjs');
const { createHub } = await import('../../src/machines/hub.mjs');
const { loadConfig } = await import('../../src/config.mjs');
const { schedPart } = await import('../../src/work/schedfeature.mjs');
const { listRuns } = await import('../../src/work/runs.mjs');

// ---- computer B: its own homes, a project "shop" (a git repository), a provider, a stand-in coding tool ----
const B = path.join(t.root, 'box-b');
const bws = path.join(B, 'Workspace');
const bshop = path.join(bws, 'projects', 'shop');
t.repo(bshop, { 'README.md': '# shop on B\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const token = `hop_${crypto.randomBytes(32).toString('base64url')}`;
const tool = path.join(B, 'fake-claude');
fs.writeFileSync(tool, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
fs.mkdirSync(path.join(B, 'config'), { recursive: true });
fs.writeFileSync(path.join(B, 'config', 'config.json'), JSON.stringify({
  claudeBin: tool,
  work: { place: 'project', project: 'shop', path: 'docs/plans' },
  server: { machineLabel: 'Box B', tokens: [{ id: 'aaaaaaaaaaaa', name: 'box a', hash: crypto.createHash('sha256').update(token).digest('hex'), created: Date.now() }] },
}));
fs.mkdirSync(path.join(B, 'profiles'), { recursive: true });
fs.writeFileSync(path.join(B, 'profiles', 'sub.env'), 'LABEL=Main\n');
// Both ports are handed out by the system: a fixed number is held by another run of the suite on the same computer
// (two runs at once then fail with "port is in use by another program"). DEAD is one nothing listens on.
async function freePort() {
  const srv = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}
const PORT = await freePort();
const DEAD = await freePort();

function get(p, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const child = spawn(process.execPath, [BIN, 'serve', '--port', String(PORT), '--host', '127.0.0.1'], {
  env: {
    ...process.env, HOME: path.join(B, 'home'), USERPROFILE: path.join(B, 'home'), APPDATA: path.join(B, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(B, 'home', 'AppData', 'Local'), HOPRIG_CONFIG_DIR: path.join(B, 'config'), HOPRIG_STATE_DIR: path.join(B, 'state'),
    HOPRIG_PROFILES_DIR: path.join(B, 'profiles'), HOPRIG_WORKSPACE_DIR: bws, CLAUDE_CONFIG_DIR: path.join(B, 'claude'),
    HOPRIG_PASSWORD_FILE: path.join(B, 'pw.txt'), HOPRIG_HUB: '1', // no terminals at all: never a tmux server
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (out += c));
const exited = new Promise((r) => child.once('exit', r));
const stopB = async () => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await exited;
};
test.after(stopB);

async function upB() {
  for (let i = 0; i < 150; i++) {
    const r = await get('/api/work/computer').catch(() => null);
    if (r && r.status === 200) return r.json;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`computer B did not start: ${out.slice(-800)}`);
}

// ---- computer A: this process, linked to B by address and token ----
putMachine({ name: 'box-b', label: 'Box B', via: 'url', url: `http://127.0.0.1:${PORT}`, token });
const part = schedPart({ sctx: { notify: () => {} }, cfg: () => loadConfig(), places: () => ({}), place: () => null, store: () => { throw new Error('no Work list on A'); }, hub: createHub(), timeoutMs: 4000 });
test.after(() => part.runner.close());
const action = { type: 'alone', project: 'shop', prompt: 'Make the notes. DO:commit', provider: 'sub', minutes: 5 };

test('a schedule that names computer B runs on B through the link, on its own branch, its result kept on B', async () => {
  const b = await upB();
  assert.match(b.id, /^[0-9a-f]{16}$/);
  assert.equal(b.label, 'Box B');
  const list = await part.computers();
  assert.deepEqual(list.map((c) => [c.label === 'Box B' ? 'B' : 'A', c.here, c.reachable]), [['A', true, true], ['B', false, true]]);
  assert.equal(list[1].id, b.id);
  assert.notEqual(list[0].id, b.id, 'two computers, two ids');

  const r = await part.hooks.alone({ id: 'nightly1', label: 'Nightly notes', computer: b.id, action });
  assert.equal(r.on, 'Box B');
  assert.equal(r.run.branch, 'work/nightly1');
  const runFile = path.join(bshop, 'docs', 'plans', 'runs', `${r.run.id}.json`);
  let fin = null;
  for (let i = 0; i < 200 && !(fin && fin.state !== 'running'); i++) {
    await new Promise((res) => setTimeout(res, 100));
    try {
      fin = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch {
      /* not yet */
    }
  }
  assert.equal(fin.state, 'done', `${fin.reason} ${out.slice(-500)}`);
  assert.equal(fin.by, 'schedule');
  assert.equal(fin.schedule, 'nightly1');
  assert.deepEqual(fin.commits.map((c) => c.subject), ['Add the notes']);
  assert.equal(t.git(bshop, 'log', '-1', '--format=%s', 'work/nightly1'), 'Add the notes');
  assert.equal(t.git(bshop, 'log', '-1', '--format=%s', 'main'), 'Start', 'nothing on B\'s default branch');
  assert.equal(fs.existsSync(path.join(bshop, 'notes.txt')), false, 'nothing in B\'s own checkout');
  // B says what it ran in its activity log
  const st = await get('/api/automation/log?limit=20');
  assert.ok(st.json.entries.some((e) => /ran "Nightly notes" by itself on work\/nightly1/.test(e.did)), JSON.stringify(st.json));
  // B checks the action itself: a project it does not have is refused there
  const bad = await get('/api/work/alone/run', { method: 'POST', body: { schedule: { id: 'nightly2' }, action: { ...action, project: 'nope' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /not a project/);
  // asked by A at a slot, that refusal is B's own word, not "cannot be reached"
  await assert.rejects(part.hooks.alone({ id: 'nightly5', label: 'Lacks it', computer: b.id, action: { ...action, project: 'nope' } }), (e) => !e.missed && /^Box B refused it: .*not a project/.test(e.message));
});

test('computer B cannot be reached: the slot is missed with the reason, and it runs nowhere else', async () => {
  const b = await upB();
  await stopB();
  await assert.rejects(part.hooks.alone({ id: 'nightly3', label: 'Nightly notes', computer: b.id, action }), (e) => e.missed === true && /Box B cannot be reached, so it did not run \(and not anywhere else\)/.test(e.message));
  // a computer A has never met (not linked): missed too, not run here
  putMachine({ name: 'box-c', label: 'Box C', via: 'url', url: `http://127.0.0.1:${DEAD}`, token });
  await assert.rejects(part.hooks.alone({ id: 'nightly4', computer: 'c3c3c3c3c3c3c3c3', action }), (e) => e.missed && /not linked to this dashboard, or is not on/.test(e.message));
  assert.deepEqual(part.runner.waiting(), [], 'nothing waits on A');
  assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'work-trees')), false, 'no worktree was made on A');
  assert.deepEqual(listRuns({ folder: path.join(t.root, 'none'), label: 'none' }), []);
});

test('a computer met once and not linked now is named by the label it had, not its internal name', async () => {
  const known = path.join(process.env.HOPRIG_STATE_DIR, 'work-alone', 'computers.json');
  const was = fs.existsSync(known) ? fs.readFileSync(known) : null;
  fs.mkdirSync(path.dirname(known), { recursive: true });
  fs.writeFileSync(known, JSON.stringify({ 'box-gone': { id: 'd4d4d4d4d4d4d4d4', label: 'Box Gone' } }));
  try {
    assert.equal(part.labelOf('d4d4d4d4d4d4d4d4'), 'Box Gone');
  } finally {
    if (was) fs.writeFileSync(known, was);
    else fs.rmSync(known);
  }
});
