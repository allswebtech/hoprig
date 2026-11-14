// End to end against each session backend, with the same assertions: tmux (where it is installed; its own socket)
// and the built-in pty backend (everywhere). Server on a test port and a fake launcher; nothing touches the user's
// tmux server, config or Claude sessions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from './helpers.mjs';

const hasTmux = tmuxUsable();

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-launcher.mjs');
const until = async (what, fn, ms = 15_000) => {
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const openWs = (url, headers) =>
  new Promise((resolve, reject) => {
    const w = new WebSocket(url, { headers });
    const out = { ws: w, screen: '' };
    w.on('message', (d) => (out.screen += d.toString()));
    w.on('open', () => resolve(out));
    w.on('error', reject);
  });

test('dashboard end to end on tmux', { skip: !hasTmux && 'no tmux 3.2 or newer here', timeout: 120_000 }, (t) => endToEnd(t, 'tmux'));
test('dashboard end to end on the built-in pty backend', { timeout: 120_000, skip: process.platform === 'win32' && 'the fake launcher run is written for POSIX shells' }, (t) => endToEnd(t, 'pty'));

async function endToEnd(t, kind) {
  const box = sandbox();
  const socket = `dash-test-${process.pid}`;
  const work = path.join(box.root, 'work');
  fs.mkdirSync(work);
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  // server.backend picks the backend, as a user's config.json would.
  saveConfig({ launcher: [process.execPath, FAKE], server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
  writeProfile('work', { label: 'Work' });
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });

  const emptyConf = path.join(box.root, 'empty.conf'); // so the user's tmux.conf does not apply
  fs.writeFileSync(emptyConf, '');
  const app = createServer({ tmuxSocket: socket, tmuxConfigFile: emptyConf });
  assert.equal(app.backend.kind, kind);
  assert.equal(app.backend.capabilities.nativeScrollback, kind === 'pty');
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const origin = { Origin: base };
  t.after(async () => {
    await app.close();
    if (kind === 'tmux') {
      const sock = await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
      await app.backend.killServer();
      if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
    }
    await app.backend.close();
    box.cleanup();
  });
  let cookie = '';
  const req = async (p, { body, method, headers = {}, raw } = {}) => {
    const r = await fetch(base + p, {
      method: method || (body !== undefined || raw ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: { ...origin, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json, text, headers: r.headers };
  };

  // --- logged out ---
  assert.equal((await req('/api/state')).status, 401);
  assert.equal((await req('/')).status, 302);
  assert.equal((await req('/app.js')).status, 401);
  assert.equal((await req('/login')).status, 200);
  assert.equal((await req('/api/login', { body: { password: 'wrong' } })).status, 401);
  assert.equal((await req('/api/login', { body: { password: 'test-password-1' }, headers: { Origin: 'http://evil.example' } })).status, 403);

  // --- login ---
  const login = await req('/api/login', { body: { password: 'test-password-1' } });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  assert.equal((await req('/api/state')).status, 200);
  const noOrigin = await fetch(`${base}/api/shells`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403, 'state change without Origin is refused');
  assert.equal((await req('/api/folders/browse?path=/etc')).status, 404);
  assert.equal((await req('/api/sessions', { body: { dir: '/', profile: 'work', mode: 'new' } })).status, 400);
  assert.equal((await req('/api/sessions', { body: { dir: work, profile: 'nope', mode: 'new' } })).status, 400);
  assert.equal((await req('/api/sessions', { body: { dir: work, profile: 'work', mode: 'new', effort: 'huge' } })).status, 400, 'effort from the fixed list only');
  assert.equal((await req('/api/sessions', { body: { dir: work, profile: 'work', mode: 'new', permissionMode: '--dangerous' } })).status, 400, 'permission mode from the fixed list only');
  for (const model of ['--dangerous', 'gpt-5', 'opus --print', '']) {
    assert.equal((await req('/api/sessions', { body: { dir: work, profile: 'work', mode: 'new', model } })).status, 400, `model from the fixed list only: ${model}`);
  }
  assert.deepEqual((await req('/api/settings')).json.sessionChoices.models, ['opus', 'sonnet', 'haiku'], 'the page offers the same list');

  // --- profiles never carry values ---
  const { profiles } = (await req('/api/profiles')).json;
  assert.deepEqual(profiles.map(({ name, label, kind: k }) => ({ name, label, kind: k })), [{ name: 'backup', label: 'Backup', kind: 'api' }, { name: 'work', label: 'Work', kind: 'login' }]);
  assert.equal(JSON.stringify(profiles).includes('127.0.0.1:9'), false, 'no profile values');

  // --- start a session ---
  const created = await req('/api/sessions', { body: { dir: work, profile: 'work', mode: 'new' } });
  assert.equal(created.status, 200, created.text);
  const name = created.json.name;
  assert.equal(name, 'work');
  const card = await until('the session card', async () => {
    const s = (await req('/api/state')).json.sessions.find((x) => x.name === name);
    return s && s.kind === 'claude' && s.status === 'waiting' ? s : null;
  });
  assert.equal(card.profile.name, 'work');
  assert.equal(card.cwd, fs.realpathSync(work));
  assert.equal(card.limit, null);
  assert.equal(JSON.stringify((await req('/api/state')).json).includes('127.0.0.1:9'), false, 'no profile values in the API');

  // --- WebSocket attach ---
  const wsUrl = `ws://127.0.0.1:${port}/ws/term?name=${name}&cols=100&rows=30`;
  const refused = await new Promise((resolve) => {
    const w = new WebSocket(wsUrl, { headers: { Origin: base } });
    w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
    w.on('open', () => resolve('open'));
  });
  assert.equal(refused, 401, 'upgrade needs the login');
  const badOrigin = await new Promise((resolve) => {
    const w = new WebSocket(wsUrl, { headers: { Origin: 'http://evil.example', Cookie: cookie } });
    w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
    w.on('open', () => resolve('open'));
  });
  assert.equal(badOrigin, 403, 'upgrade checks Origin');

  let screen = '';
  const ws = new WebSocket(wsUrl, { headers: { Origin: base, Cookie: cookie } });
  ws.on('message', (d) => (screen += d.toString()));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await until('launcher output on the socket', () => screen.includes('FAKE-LAUNCH profile=work args=[]'));
  assert.match(screen, /\x1b\[38;2;255;100;0m/, 'truecolor reaches the browser unchanged');
  assert.ok(screen.includes('╭─╮') && screen.includes('🙂') && screen.includes('漢字'), 'UTF-8 intact');

  // keys typed in the browser terminal
  ws.send(JSON.stringify({ t: 'in', d: 'typed\r' }));
  await until('typed keys', () => screen.includes('GOT: typed'));
  ws.send(JSON.stringify({ t: 'resize', cols: 60, rows: 20 }));
  await until('resize', async () => {
    if (kind === 'tmux') {
      const size = execFileSync('tmux', ['-L', socket, 'display', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}']).toString().trim();
      return size === '60x20'; // the whole height: tmux's status line is hidden for dashboard sessions
    }
    const term = (await app.backend.list()).find((x) => x.session === name);
    return term.cols === 60 && term.rows === 20;
  });

  // a second browser on the same session: it gets the current screen first, then live output, as the first does
  const second = await openWs(`ws://127.0.0.1:${port}/ws/term?name=${name}&cols=60&rows=20`, { Origin: base, Cookie: cookie });
  await until('the current screen in a second browser', () => second.screen.includes('GOT: typed') && second.screen.includes('漢字'));
  if (kind === 'pty') assert.match(second.screen, /\x1b\[38;2;255;100;0m/, 'the replayed screen keeps its colours');
  second.ws.send(JSON.stringify({ t: 'in', d: 'from second\r' }));
  await until('keys from the second browser, seen by both', () => second.screen.includes('GOT: from second') && screen.includes('GOT: from second'));
  second.ws.close();

  // --- message box ---
  assert.equal((await req(`/api/sessions/${name}/send`, { body: { text: 'hello there; $(echo no)' } })).status, 200);
  await until('message in the pane', () => screen.includes('GOT: hello there; $(echo no)'));
  assert.equal((await req(`/api/sessions/${name}/send`, { body: { text: 'line one\nline two' } })).status, 200);
  await until('multi-line message', () => screen.includes('GOT: line one') && screen.includes('GOT: line two'));

  // --- history: scroll and text view ---
  for (let i = 0; i < 40; i++) await req(`/api/sessions/${name}/send`, { body: { text: `fill ${i}` } });
  assert.equal((await req(`/api/sessions/${name}/scroll`, { body: { action: 'up', lines: 10 } })).status, 200);
  if (kind === 'tmux') {
    const inMode = execFileSync('tmux', ['-L', socket, 'display', '-p', '-t', `=${name}:`, '#{pane_in_mode} #{scroll_position}']).toString().trim();
    assert.equal(inMode, '1 10', 'scrolled 10 lines into the history');
  }
  await req(`/api/sessions/${name}/send`, { body: { text: 'after scroll' } });
  await until('send leaves the history view', () => screen.includes('GOT: after scroll'));
  const hist = (await req(`/api/sessions/${name}/history?lines=500`)).json.text;
  assert.ok(hist.includes('GOT: hello there') && hist.includes('GOT: fill 39'));

  // --- upload ---
  const up = await req(`/api/sessions/${name}/upload`, { raw: Buffer.from('image-bytes'), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('../shot 1.png') } });
  assert.equal(up.status, 200, up.text);
  assert.equal(path.dirname(up.json.path), path.join(fs.realpathSync(work), '.uploads'));
  assert.equal(fs.readFileSync(up.json.path, 'utf8'), 'image-bytes');

  // --- limit hit ---
  await req(`/api/sessions/${name}/send`, { body: { text: 'LIMIT' } });
  const limited = await until('limit detection', async () => (await req('/api/state')).json.sessions.find((x) => x.name === name && x.limit));
  assert.equal(limited.limit.resets, '5pm (UTC)');
  assert.equal(limited.canSwitch, true);

  // --- the run record names its terminal the way this backend matches it ---
  const { listRuns } = await import('../../src/runs.mjs');
  const termOf = async (n) => (await app.backend.list()).find((x) => x.session === n);
  const first = listRuns().find((r) => r.profile === 'work');
  if (kind === 'pty') {
    assert.equal(first.termId, (await termOf(name)).id);
    assert.equal(first.tmuxPane, null);
  } else assert.equal(first.tmuxPane, (await termOf(name)).id);

  // --- switch profile ---
  const sw = await req(`/api/sessions/${name}/switch`, { body: { profile: 'backup' } });
  assert.equal(sw.status, 200, sw.text);
  const moved = await until('session on the new profile', async () => {
    const s = (await req('/api/state')).json.sessions.find((x) => x.name === name);
    return s && s.profile && s.profile.name === 'backup' ? s : null;
  });
  await until('relaunch arguments', () => screen.includes('FAKE-LAUNCH profile=backup args=["--verbose","--resume","0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b"]'));
  assert.equal(moved.limit, null, 'the old limit line is gone after the move');
  await until('the old launcher stopped', () => !alive(first.pid));
  const movedRun = listRuns().find((r) => r.profile === 'backup');
  if (kind === 'pty') assert.equal(movedRun.termId, first.termId, 'same terminal id after the relaunch');

  // --- rename, kill ---
  const rn = await req(`/api/sessions/${name}/rename`, { body: { name: 'renamed' } });
  assert.equal(rn.status, 200, rn.text);
  assert.equal((await req(`/api/sessions/${name}/rename`, { body: { name: '-bad' } })).status, 400);
  const closed = new Promise((resolve) => ws.on('close', resolve));
  assert.equal((await req('/api/sessions/renamed/kill', { body: {} })).status, 200);
  await closed;
  await until('session gone', async () => !(await req('/api/state')).json.sessions.some((x) => x.name === 'renamed'));
  await until('the launcher ended with its session', () => !alive(movedRun.pid));

  // --- plain shell ---
  const sh = await req('/api/shells', { body: {} });
  assert.equal(sh.status, 200);
  const shellCard = await until('shell card', async () => (await req('/api/state')).json.sessions.find((x) => x.name === sh.json.name));
  assert.equal(shellCard.kind, 'shell');
  assert.equal((await req(`/api/sessions/${sh.json.name}/switch`, { body: { profile: 'work' } })).status, 409);

  // --- logout ---
  assert.equal((await req('/api/logout', { body: {} })).status, 200);
  assert.equal((await req('/api/state')).status, 401);

  // --- the server stops: pty sessions end with it, tmux ones keep running ---
  const shellPid = (await termOf(sh.json.name)).pid;
  await app.close();
  await app.backend.close();
  if (kind === 'pty') {
    assert.deepEqual(await app.backend.list(), []);
    await until('the shell ended with the server', () => !alive(shellPid));
  } else assert.equal(alive(shellPid), true);
}
