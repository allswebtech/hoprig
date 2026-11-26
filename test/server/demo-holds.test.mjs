// The built-in demo writes a hold file for each of its sessions (src/demo/index.mjs demoHolds), so a demo session's
// Hands-off switch can be turned on and shown. It writes into the demo's OWN state folder only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const { demoHolds } = await import('../../src/demo/index.mjs');
const { sessionHasHold } = await import('../../src/server/handsoff.mjs');

test('demo holds: each session record gets a hold file with the wall\'s matcher, in the demo\'s own state folder', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-demo-holds-')));
  const was = process.env.HOPRIG_STATE_DIR;
  try {
    process.env.HOPRIG_STATE_DIR = path.join(root, 'state');
    const runs = path.join(root, 'state', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'r1.json'), JSON.stringify({ runId: 'r1', pid: 1, cwd: '/w/shop' }));
    fs.writeFileSync(path.join(runs, 'c1.json'), JSON.stringify({ runId: 'c1', pid: 1, kind: 'chat' }));
    assert.equal(sessionHasHold('r1'), false, 'before: the switch would be refused');
    assert.deepEqual(await demoHolds(root), ['r1'], 'a terminal session, never an App chat');
    assert.equal(sessionHasHold('r1'), true, 'after: the server lets its switch be turned on');
    assert.equal(sessionHasHold('c1'), false);
    const file = path.join(root, 'state', 'hook-settings', 'r1.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the user reads it');
    assert.deepEqual(await demoHolds(root), [], 'a session that has one is left as it is');
  } finally {
    if (was === undefined) delete process.env.HOPRIG_STATE_DIR;
    else process.env.HOPRIG_STATE_DIR = was;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('demo holds: a state folder outside the demo\'s folder is never written', async () => {
  const box = sandbox('demo-holds-out');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-demo-holds-')));
  try {
    fs.mkdirSync(path.join(box.state, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(box.state, 'runs', 'r1.json'), JSON.stringify({ runId: 'r1', pid: 1 }));
    assert.deepEqual(await demoHolds(root), [], 'nothing written');
    assert.equal(fs.existsSync(path.join(box.state, 'hook-settings')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    box.cleanup();
  }
});

test('demo: a session\'s Hands-off switch can be turned on', { timeout: 120_000, skip: process.platform === 'win32' && 'the demo sessions run through a POSIX shell' }, async () => {
  const box = sandbox('demo-holds-guard');
  const { main } = await import('../../src/demo/index.mjs');
  const hooks = { onReady: (i) => (hooks.info = i) };
  try {
    assert.equal(await main(['--no-open', '--quiet'], hooks), null);
    const { url, link, root } = hooks.info;
    assert.equal(process.env.HOPRIG_STATE_DIR, path.join(root, 'state'), 'the demo\'s own state folder');
    const token = link.split('#link=')[1];
    const login = await fetch(`${url}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = (p, body) => fetch(`${url}${p}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const state = await (await call('/api/state')).json();
    const s = state.sessions.find((x) => x.kind === 'claude' && x.tool === 'claude' && x.handsOff);
    assert.ok(s, 'a demo coding session with its Hands-off state');
    const ids = fs.readdirSync(path.join(root, 'state', 'runs')).filter((n) => n.endsWith('.json'));
    assert.ok(ids.length >= 5, 'the demo\'s run records');
    for (const n of ids) {
      const chat = JSON.parse(fs.readFileSync(path.join(root, 'state', 'runs', n), 'utf8')).kind === 'chat';
      if (!chat) assert.ok(fs.existsSync(path.join(root, 'state', 'hook-settings', n)), `${n}: its hold file is in the demo's state folder`);
    }
    const r = await call('/api/handsoff/session', { name: s.name, on: true });
    assert.equal(r.status, 200, `the switch turns on: ${await r.clone().text()}`);
    const off = await call('/api/handsoff/session', { name: s.name, on: false });
    assert.equal(off.status, 200);
    await hooks.stop();
    assert.equal(fs.existsSync(root), false, 'its folder is removed');
  } finally {
    await hooks.stop?.();
    box.cleanup();
  }
});
