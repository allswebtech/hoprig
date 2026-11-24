// End to end for settings, notifications, the watcher's auto-switch safety net, quick actions, password change,
// profiles and Claude Code updates. Runs on tmux where it is installed, else on the built-in pty backend; uses a
// fake launcher, a local fake notification receiver and a stand-in for src/claudecode.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-launcher.mjs');
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last))})`);
};

const kind = tmuxUsable() ? 'tmux' : 'pty';

test(`settings, notifications, auto-switch safety net, password change (${kind})`, { timeout: 150_000, skip: process.platform === 'win32' && 'fake launcher is POSIX' }, async (t) => {
  const box = sandbox('phase2');
  const work = path.join(box.root, 'work');
  fs.mkdirSync(work);
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE], server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('first-password') } });
  writeProfile('work', { label: 'Work' });
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  writeProfile('spare', { label: 'Spare' });

  // a local stand-in for a webhook / ntfy receiver
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  const claudecode = {
    claudeInfo: async () => ({ installed: '2.1.323', path: '/x/claude', latest: '2.1.324', method: 'native', updateAvailable: true }),
    claudeUpdate: async ({ onLine }) => {
      onLine('Downloading 2.1.324');
      await new Promise((r) => setTimeout(r, 300));
      onLine('Installed');
      return { ok: true, version: '2.1.324', output: 'Downloading 2.1.324\nInstalled' };
    },
  };
  const emptyConf = path.join(box.root, 'empty.conf');
  fs.writeFileSync(emptyConf, '');
  const socket = `dash-p2-${process.pid}`;
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const SID = '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b'; // the fake launcher's session id
  const routerstate = {
    routerSessions: () => ({ [SID]: { profile: 'backup', at: Date.now() } }),
    profileUsage: () => ({ work: { fiveHour: { pct: 84, resetsAt: Date.now() + 3600e3 }, week: { pct: 30 }, status: 'allowed' } }),
  };
  const app = createServer({ tmuxSocket: socket, tmuxConfigFile: emptyConf, claudecode, routerstate, autoSwitchGraceMs: 1000, watchTickMs: 300 });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    console.log = origLog;
    let sock = '';
    if (kind === 'tmux') sock = (await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '')).trim();
    if (kind === 'tmux') await app.backend.killServer();
    await app.close();
    if (sock) fs.rmSync(sock, { force: true });
    receiver.closeAllConnections();
    receiver.close();
    box.cleanup();
  });

  const call = async (p, { body, cookie, headers = {} } = {}) => {
    const r = await fetch(base + p, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: { Origin: base, Cookie: cookie || '', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (password) => (await call('/api/login', { body: { password } })).cookie;
  const A = await login('first-password');
  const B = await login('first-password');
  assert.ok(A && B && A !== B);

  // --- settings: defaults, refused patches change nothing, a good patch round-trips ---
  let s = (await call('/api/settings', { cookie: A })).json;
  assert.deepEqual(s.server.quickActions.map((q) => q.label), ['continue', '/clear']);
  assert.equal(s.server.notify, null);
  assert.deepEqual(s.notifyEvents, ['waiting', 'attention', 'limit', 'ended', 'switched', 'automation']);
  assert.equal(s.backend.kind, kind);
  const before = JSON.stringify(loadConfig());
  for (const [bad, why] of [
    [{ server: { passwordHash: 'x' } }, /cannot be changed/],
    [{ server: { quickActions: [{ label: '', text: 'x' }] } }, /label/],
    [{ server: { notify: { url: 'file:///etc/passwd' } } }, /https/],
    [{ server: { roots: ['/definitely/not/here'] } }, /does not exist/],
    [{ server: { quickActions: [{ label: 'ok', text: 'ok' }] }, autoSwitch: { order: ['nope'] } }, /no profile/],
    [{ autoSwitch: { prompt: 'two\nlines' } }, /one line/],
  ]) {
    const r = await call('/api/settings', { cookie: A, body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.json.error, why);
  }
  assert.equal(JSON.stringify(loadConfig()), before, 'nothing was saved by refused patches');
  const good = await call('/api/settings', {
    cookie: A,
    body: {
      server: { quickActions: [{ label: 'go on', text: 'continue please' }], notify: { url: hookUrl, format: 'json' }, publicUrl: 'https://pc.example/' },
      autoSwitch: { enabled: true, order: ['work', 'backup'], prompt: 'please continue', returnToPreferred: true },
    },
  });
  assert.equal(good.status, 200, good.text);
  assert.deepEqual(good.json.server.quickActions, [{ label: 'go on', text: 'continue please' }]);
  assert.deepEqual(good.json.autoSwitch.order, ['work', 'backup']);
  assert.equal(loadConfig().server.publicUrl, 'https://pc.example');

  // --- notification test endpoint reaches the receiver ---
  assert.equal((await call('/api/notify/test', { cookie: A, body: {} })).status, 200);
  await until('test notification', () => received.length === 1);
  assert.equal(received[0].body.session, 'test');
  assert.equal(received[0].headers['content-type'], 'application/json');

  // --- a session: state carries quick actions, last message, profile states, recommended profile ---
  const created = await call('/api/sessions', { cookie: A, body: { dir: work, profile: 'work', mode: 'new' } });
  assert.equal(created.status, 200, created.text);
  const name = created.json.name;
  const st = await until('the card with its last message', async () => {
    const d = (await call('/api/state', { cookie: A })).json;
    const c = d.sessions.find((x) => x.name === name);
    return c && c.status === 'waiting' && c.lastMessage === 'Ready when you are.' ? d : null;
  });
  assert.deepEqual(st.quickActions, [{ label: 'go on', text: 'continue please' }]);
  assert.equal(st.recommended, 'auto', 'Auto mode on: Auto is the first choice');
  assert.deepEqual(st.profiles.map((p) => p.name), ['auto', 'backup', 'spare', 'work']);
  assert.equal(st.profiles.find((p) => p.name === 'work').usage.fiveHour.pct, 84, 'usage from the router');
  assert.equal(st.profiles.find((p) => p.name === 'work').inUse, 1);
  assert.equal(st.backend.kind, kind);

  // --- server push on a status change: working → waiting ---
  received.length = 0;
  await call(`/api/sessions/${name}/send`, { cookie: A, body: { text: 'SLOW build it' } });
  // (an earlier "waiting" push from the session's start may arrive too; this one carries the new last message)
  const waitingPush = await until('push for "waiting"', () => received.find((r) => r.body && r.body.status === 'waiting' && r.body.session === name && r.body.message === 'Done: build it'));
  assert.equal(waitingPush.body.url, `https://pc.example/#/s/${name}`);

  // --- quick action text arrives like a message ---
  await call(`/api/sessions/${name}/send`, { cookie: A, body: { text: 'continue please' } });
  await until('quick action in the session', async () => (await call(`/api/sessions/${name}/history?lines=200`, { cookie: A })).json.text.includes('GOT: continue please'));

  // --- auto-switch safety net: limit on screen, no run.limit → moved after the grace time, prompt sent once ---
  received.length = 0;
  await call(`/api/sessions/${name}/send`, { cookie: A, body: { text: 'LIMIT' } });
  if (process.env.DEBUG_P2) {
    await new Promise((r) => setTimeout(r, Number(process.env.DEBUG_P2)));
    process.stderr.write(JSON.stringify((await call(`/api/sessions/${name}/history?lines=60`, { cookie: A })).json.text.slice(-600)) + '\n');
    process.stderr.write(JSON.stringify((await call('/api/state', { cookie: A })).json.sessions.find((x) => x.name === name)) + '\n');
  }
  const moved = await until('the server moving the session to backup', async () => {
    const c = (await call('/api/state', { cookie: A })).json.sessions.find((x) => x.name === name);
    return c && c.profile && c.profile.name === 'backup' ? c : null;
  });
  assert.ok(moved);
  await until('the continue prompt in the new run', async () => (await call(`/api/sessions/${name}/history?lines=200`, { cookie: A })).json.text.includes('GOT: please continue'));
  await new Promise((r) => setTimeout(r, 1500));
  const hist = (await call(`/api/sessions/${name}/history?lines=400`, { cookie: A })).json.text;
  assert.equal(hist.split('GOT: please continue').length - 1, 1, 'prompt sent exactly once');
  const after = (await call('/api/state', { cookie: A })).json;
  const workState = after.profiles.find((p) => p.name === 'work');
  assert.equal(workState.limited.reason, 'screen');
  assert.ok(workState.limited.until > Date.now(), 'the reset time was read from "resets 5pm (UTC)"');
  assert.equal(logs.filter((l) => l.startsWith('auto-switch: moved')).length, 1, 'one log line per automatic move');
  await until('limit and switched pushes', () => received.some((r) => r.body.status === 'limit') && received.some((r) => r.body.status === 'switched'));
  assert.equal(after.recommended, 'auto');

  // --- a profile marked available again ---
  assert.equal((await call('/api/profiles/work/available', { cookie: A, body: {} })).status, 200);
  assert.equal((await call('/api/state', { cookie: A })).json.profiles.find((p) => p.name === 'work').limited, null);

  // --- Claude Code version and update with streamed output ---
  const info = (await call('/api/claude', { cookie: A })).json;
  assert.equal(info.installed, '2.1.323');
  assert.equal(info.updateAvailable, true);
  assert.equal((await call('/api/claude/update', { cookie: A, body: {} })).status, 200);
  assert.equal((await call('/api/claude/update', { cookie: A, body: {} })).status, 409, 'one update at a time');
  const upd = await until('update result', async () => {
    const r = (await call('/api/claude/update?from=0', { cookie: A })).json;
    return r.result ? r : null;
  });
  assert.deepEqual(upd.lines, ['Downloading 2.1.324', 'Installed']);
  assert.deepEqual(upd.result, { ok: true, version: '2.1.324' });

  // --- add account opens a terminal running "<launcher> add"; delete a profile ---
  const add = await call('/api/profiles/add', { cookie: A, body: {} });
  assert.equal(add.status, 200);
  await until('the add terminal', async () => (await call(`/api/sessions/${add.json.name}/history?lines=100`, { cookie: A })).json.text.includes('FAKE-LAUNCH profile=add'));
  assert.equal((await call('/api/profiles/spare/delete', { cookie: A, body: {} })).status, 200);
  assert.equal((await call('/api/profiles/spare/delete', { cookie: A, body: {} })).status, 404);
  assert.ok(!(await call('/api/profiles', { cookie: A })).json.profiles.some((p) => p.name === 'spare'));

  // --- Auto mode: start on "auto", see which account serves it, pin it to an account and back ---
  const autoS = await call('/api/sessions', { cookie: A, body: { dir: work, profile: 'auto', mode: 'new' } });
  assert.equal(autoS.status, 200, autoS.text);
  const an = autoS.json.name;
  const autoCard = await until('the Auto card', async () => {
    const c = (await call('/api/state', { cookie: A })).json.sessions.find((x) => x.name === an);
    return c && c.kind === 'claude' && c.status === 'waiting' ? c : null;
  });
  assert.deepEqual(autoCard.profile, { name: 'auto', label: 'Auto', kind: 'auto' });
  assert.equal(autoCard.autoOn.label, 'Backup');
  // The card's state and the terminal's screen arrive on separate paths: wait for the line, as the steps below do.
  await until('the Auto launch line', async () => (await call(`/api/sessions/${an}/history?lines=100`, { cookie: A })).json.text.includes('FAKE-LAUNCH profile=auto args=[]'));
  assert.equal((await call(`/api/sessions/${an}/switch`, { cookie: A, body: { profile: 'work' } })).status, 200);
  await until('pinned to work', async () => (await call(`/api/sessions/${an}/history?lines=100`, { cookie: A })).json.text.includes(`FAKE-LAUNCH profile=work args=["--verbose","--resume","${SID}"]`));
  await until('the pinned card', async () => (await call('/api/state', { cookie: A })).json.sessions.find((x) => x.name === an && x.profile && x.profile.name === 'work' && x.status === 'waiting'));
  assert.equal((await call(`/api/sessions/${an}/switch`, { cookie: A, body: { profile: 'auto' } })).status, 200);
  await until('back on auto', async () => (await call(`/api/sessions/${an}/history?lines=100`, { cookie: A })).json.text.includes(`FAKE-LAUNCH profile=auto args=["--verbose","--resume","${SID}"]`));
  assert.equal((await call('/api/settings', { cookie: A, body: { autoSwitch: { enabled: false } } })).status, 200);
  assert.equal((await call('/api/sessions', { cookie: A, body: { dir: work, profile: 'auto', mode: 'new' } })).status, 400, 'no Auto while Auto mode is off');
  assert.ok(!(await call('/api/state', { cookie: A })).json.profiles.some((p) => p.name === 'auto'));

  // --- Stop sends Escape (last: the fake launcher would read the ESC byte as part of its next line) ---
  assert.equal((await call(`/api/sessions/${name}/key`, { cookie: A, body: { key: 'Escape' } })).status, 200);
  assert.equal((await call(`/api/sessions/${name}/key`, { cookie: A, body: { key: 'C-b' } })).status, 400);

  // --- password change: wrong current refused; then every other browser is logged out ---
  assert.equal((await call('/api/settings/password', { cookie: A, body: { current: 'nope-nope', next: 'second-password' } })).status, 403);
  assert.equal((await call('/api/settings/password', { cookie: A, body: { current: 'first-password', next: 'short' } })).status, 400);
  const changed = await call('/api/settings/password', { cookie: A, body: { current: 'first-password', next: 'second-password' } });
  assert.equal(changed.status, 200);
  assert.ok(changed.cookie && changed.cookie !== A, 'this browser gets a new session');
  assert.equal((await call('/api/state', { cookie: B })).status, 401, 'other browser logged out');
  assert.equal((await call('/api/state', { cookie: A })).status, 401, 'the old cookie is gone too');
  assert.equal((await call('/api/state', { cookie: changed.cookie })).status, 200);
  assert.equal((await call('/api/login', { body: { password: 'first-password' } })).status, 401);
  assert.equal((await call('/api/login', { body: { password: 'second-password' } })).status, 200);
});
