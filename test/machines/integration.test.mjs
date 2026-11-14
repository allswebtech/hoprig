// Two real dashboards on this computer, each in its own process with its own config, state and profiles folders,
// the fake launcher and the built-in pty backend: B is paired to the hub A by code and by SSH (fake ssh, real
// tunnel), and everything goes through A: the sessions of both, a terminal, send, profile switch, upload, then B
// revokes A's token and A shows "not authorised". Nothing touches the user's own setup.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { REPO, fakeRemote } from './harness.mjs';

const integrated = fs.readFileSync(path.join(REPO, 'src', 'server', 'server.mjs'), 'utf8').includes('../machines/index.mjs');
const skip = !integrated ? 'src/server/server.mjs does not call src/machines yet (phase 2)' : process.platform === 'win32' && 'POSIX scripts';

const BIN = path.join(REPO, 'bin', 'hoprig.mjs');
const FAKE_LAUNCHER = path.join(REPO, 'test', 'server', 'fixtures', 'fake-launcher.mjs');
const PASSWORD = 'test-password-1';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

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

/** A machine: its folders, its config written through the real modules (run in a child with its env). */
async function machine(root, name, extraEnv = {}) {
  const dir = path.join(root, name);
  const d = { config: path.join(dir, 'config'), state: path.join(dir, 'state'), profiles: path.join(dir, 'profiles'), claude: path.join(dir, 'claude'), work: path.join(dir, 'work') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOPRIG_CONFIG_DIR: d.config, HOPRIG_STATE_DIR: d.state, HOPRIG_PROFILES_DIR: d.profiles, CLAUDE_CONFIG_DIR: d.claude, ...extraEnv };
  const setup = `
    const { saveConfig } = await import(${JSON.stringify(path.join(REPO, 'src', 'config.mjs'))});
    const { writeProfile } = await import(${JSON.stringify(path.join(REPO, 'src', 'profiles.mjs'))});
    const { hashPassword } = await import(${JSON.stringify(path.join(REPO, 'src', 'server', 'auth.mjs'))});
    saveConfig({ launcher: [process.execPath, ${JSON.stringify(FAKE_LAUNCHER)}], server: { backend: 'pty', host: '127.0.0.1', port: ${port}, roots: [${JSON.stringify(dir)}], passwordHash: await hashPassword(${JSON.stringify(PASSWORD)}) } });
    writeProfile('work', { label: 'Work' });
    writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });`;
  execFileSync(process.execPath, ['--input-type=module', '-e', setup], { env });
  const cli = (...args) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { name, dir, port, env, base: `http://127.0.0.1:${port}`, work: d.work, cli, ...d };
}

function serve(m) {
  const child = spawn(process.execPath, [BIN, 'serve'], { env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  m.child = child;
  m.output = () => out;
  return until(`${m.name} to listen`, async () => (await fetch(`${m.base}/login`)).status === 200);
}

/** A browser on `m`: logs in, then fetch with the cookie and Origin. */
async function browser(m) {
  const login = await fetch(`${m.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: m.base }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, { body, raw, headers = {} } = {}) => {
    const r = await fetch(m.base + p, {
      method: body !== undefined || raw !== undefined ? 'POST' : 'GET',
      headers: { Origin: m.base, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  req.cookie = cookie;
  return req;
}

test('two dashboards: pair, see, drive and revoke through the hub', { skip, timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-two-'));
  const b = await machine(root, 'b');
  // The hub's ssh is the fake one; its "remote user" runs B's hoprig, found only in the login shell.
  const ssh = fakeRemote(path.join(root, 'ssh'), {
    script: `export HOPRIG_CONFIG_DIR='${b.config}' HOPRIG_STATE_DIR='${b.state}' HOPRIG_PROFILES_DIR='${b.profiles}' CLAUDE_CONFIG_DIR='${b.claude}'\nexec "${process.execPath}" "${BIN}" "$@"`,
  });
  const a = await machine(root, 'a', { PATH: ssh.sshEnv.PATH, FAKE_SSH_LOG: ssh.log, FAKE_SSH_SHELL: ssh.sshEnv.FAKE_SSH_SHELL });
  t.after(() => {
    for (const m of [a, b]) if (m.child && m.child.exitCode === null) m.child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([serve(a), serve(b)]);
  const hub = await browser(a);

  // --- pair by code: `hoprig pair` on B (not a terminal: prints the code and exits) ---
  const code = /([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/.exec(b.cli('pair'))[1];
  const added = await hub('/api/machines/url', { body: { url: b.base, code, name: 'b' } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.machine.state, 'online');
  assert.match(b.cli('tokens'), /Who may control this computer/);

  // --- start a session on B, through the hub ---
  const started = await hub('/m/b/api/sessions', { body: { dir: b.work, profile: 'work', mode: 'new' } });
  assert.equal(started.status, 200, started.text);
  const name = started.json.name;
  const card = await until('the session on B, in the list of all machines', async () => {
    const all = (await hub('/api/machines/sessions')).json.machines;
    const mb = all.find((x) => x.machine === 'b');
    return mb && mb.status === 'online' && mb.sessions.find((s) => s.name === name && s.status === 'waiting');
  });
  assert.equal(card.profile.name, 'work');
  const all = (await hub('/api/machines/sessions')).json.machines;
  assert.ok(all.some((x) => x.machine === null && Array.isArray(x.sessions)), "the hub's own sessions are in the list too");
  assert.equal(JSON.stringify(all).includes('127.0.0.1:9'), false, 'no profile values');

  // --- the terminal, through the hub's WebSocket relay ---
  let screen = '';
  const ws = new WebSocket(`ws://127.0.0.1:${a.port}/m/b/ws/term?name=${name}&cols=100&rows=30`, { headers: { Origin: a.base, Cookie: hub.cookie } });
  ws.on('message', (d) => (screen += d.toString()));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await until('launcher output through the hub', () => screen.includes('FAKE-LAUNCH profile=work'));
  assert.ok(screen.includes('漢字') && screen.includes('🙂'), 'UTF-8 intact through the relay');
  ws.send(JSON.stringify({ t: 'in', d: 'typed via hub\r' }));
  await until('typed keys', () => screen.includes('GOT: typed via hub'));

  // --- send, upload, switch profile ---
  assert.equal((await hub(`/m/b/api/sessions/${name}/send`, { body: { text: 'hello from the hub' } })).status, 200);
  await until('the message', () => screen.includes('GOT: hello from the hub'));
  const up = await hub(`/m/b/api/sessions/${name}/upload`, { raw: Buffer.from('bytes-through-the-hub'), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('shot.png') } });
  assert.equal(up.status, 200, up.text);
  assert.equal(path.dirname(up.json.path), path.join(fs.realpathSync(b.work), '.uploads'));
  assert.equal(fs.readFileSync(up.json.path, 'utf8'), 'bytes-through-the-hub');
  assert.equal((await hub(`/m/b/api/sessions/${name}/switch`, { body: { profile: 'backup' } })).status, 200);
  await until('the session on the other profile', () => screen.includes('FAKE-LAUNCH profile=backup'));

  // --- B's password stays B's: not reachable through the hub ---
  const pw = await hub('/m/b/api/settings/password', { body: { current: PASSWORD, next: 'another-password' } });
  assert.equal(pw.status, 403);
  assert.equal(pw.json.code, 'bad-answer');

  // --- add by SSH in one step (fake ssh, real tunnel, hoprig only in the login shell) ---
  const viaSsh = await hub('/api/machines/ssh', { body: { target: 'alex@b-host', name: 'bssh' } });
  assert.equal(viaSsh.status, 200, viaSsh.text);
  assert.equal(viaSsh.json.machine.state, 'online');
  assert.ok((await hub('/m/bssh/api/state')).json.sessions.some((s) => s.name === name));
  assert.ok(ssh.calls().some((c) => c.at(-1).startsWith('$SHELL -lic')), 'found through the login shell');

  // --- B revokes the code-paired hub: "not authorised" at once ---
  const tokens = JSON.parse(b.cli('tokens', '--json'));
  assert.equal(tokens.length, 2);
  b.cli('tokens', 'revoke', tokens[0].id);
  const after = await hub('/m/b/api/state');
  assert.equal(after.status, 403);
  assert.equal(after.json.code, 'not-authorised');
  const list = (await hub('/api/machines?fresh=1')).json.machines;
  assert.equal(list.find((m) => m.name === 'b').state, 'unauthorised');
  assert.equal(list.find((m) => m.name === 'bssh').state, 'online', 'the other token still works');

  // --- removing the SSH one revokes its token on B too ---
  assert.equal((await hub('/api/machines/bssh/remove', { body: {} })).json.revoked, true);
  assert.deepEqual(JSON.parse(b.cli('tokens', '--json')), []);
  ws.close();
  await hub(`/m/b/api/sessions/${name}/kill`, { body: {} }).catch(() => {});
});

test('a computer behind a router joins the hub by itself: driven from the hub, back after a restart, then leaves', { skip, timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-join-'));
  const a = await machine(root, 'a');
  // B can SSH to A's machine (fake ssh; A's hoprig is found only in the login shell). A cannot reach B at all.
  const toA = fakeRemote(path.join(root, 'ssh-to-a'), {
    script: `export HOPRIG_CONFIG_DIR='${a.config}' HOPRIG_STATE_DIR='${a.state}' HOPRIG_PROFILES_DIR='${a.profiles}' CLAUDE_CONFIG_DIR='${a.claude}'\nexec "${process.execPath}" "${BIN}" "$@"`,
  });
  const b = await machine(root, 'b', { PATH: toA.sshEnv.PATH, FAKE_SSH_LOG: toA.log, FAKE_SSH_SHELL: toA.sshEnv.FAKE_SSH_SHELL });
  t.after(() => {
    for (const m of [a, b]) if (m.child && m.child.exitCode === null) m.child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([serve(a), serve(b)]);
  const hub = await browser(a);
  const home = await browser(b);

  // --- on B: Settings → Connect this computer to another dashboard ---
  const joined = await home('/api/joins', { body: { target: 'alex@a-server' } });
  assert.equal(joined.status, 200, joined.text);
  const jid = joined.json.joined.id;
  const machineOf = async () => (await hub('/api/machines?fresh=1')).json.machines.find((m) => m.via === 'join');
  const m = await machineOf();
  assert.equal(m.state, 'online');
  assert.ok(toA.calls().every((c) => !JSON.stringify(c).includes('hop_')), 'the token never on a command line');
  assert.deepEqual(JSON.parse(a.cli('tokens', '--json')), [], 'B got no right to control A');
  assert.equal(JSON.parse(b.cli('tokens', '--json')).length, 1, 'A got a token for B');

  // --- A drives B through the reverse tunnel ---
  const started = await hub(`/m/${m.name}/api/sessions`, { body: { dir: b.work, profile: 'work', mode: 'new' } });
  assert.equal(started.status, 200, started.text);
  let screen = '';
  const ws = new WebSocket(`ws://127.0.0.1:${a.port}/m/${m.name}/ws/term?name=${started.json.name}&cols=80&rows=24`, { headers: { Origin: a.base, Cookie: hub.cookie } });
  ws.on('message', (d) => (screen += d.toString()));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await until('B\'s terminal on A', () => screen.includes('FAKE-LAUNCH profile=work'));
  ws.send(JSON.stringify({ t: 'in', d: 'from the hub\r' }));
  await until('typed keys reach B', () => screen.includes('GOT: from the hub'));
  ws.close();

  // --- B restarts: offline on A meanwhile, then back by itself (the service keeps the tunnel, not the command) ---
  b.child.kill('SIGTERM');
  await new Promise((r) => b.child.once('exit', r));
  await until('B offline on A', async () => (await machineOf()).state === 'offline');
  assert.match((await machineOf()).error, /connects again by itself/);
  await serve(b);
  await until('B online again on A', async () => (await machineOf()).state === 'online', 30_000);

  // --- B leaves: A forgets it ---
  const home2 = await browser(b);
  const left = await home2(`/api/joins/${jid}/leave`, { body: {} });
  assert.equal(left.status, 200, left.text);
  assert.equal(left.json.hubForgot, true);
  assert.equal(await machineOf(), undefined);
  assert.deepEqual(JSON.parse(b.cli('tokens', '--json')), []);
});

test('direct link: B joins A by address + code; A drives B (terminal, resize, 5 MB upload); B restarts; Leave', { skip, timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-link-'));
  const [a, b] = await Promise.all([machine(root, 'a'), machine(root, 'b')]);
  t.after(() => {
    for (const m of [a, b]) if (m.child && m.child.exitCode === null) m.child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([serve(a), serve(b)]);
  const hub = await browser(a);
  const home = await browser(b);

  // --- A: "Add a computer that connects by itself" → a code; B: address + code ---
  const c = (await hub('/api/links/code', { body: {} })).json;
  const joined = await home('/api/joins', { body: { url: a.base, code: c.code } });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.json.joined.via, 'link');
  assert.equal(joined.json.joined.state, 'up');
  const machineOf = async () => (await hub('/api/machines?fresh=1')).json.machines.find((m) => m.via === 'link');
  const m = await machineOf();
  assert.equal(m.state, 'online');
  assert.deepEqual(JSON.parse(a.cli('tokens', '--json')), [], 'B got no right to control A');
  assert.equal(fs.readFileSync(path.join(a.config, 'machines.json'), 'utf8').includes('ccl_'), false, 'A keeps only the secret\'s hash');

  // --- A sees B's sessions and drives a terminal on B: typing and resizing ---
  const sh = await hub(`/m/${m.name}/api/shells`, { body: {} });
  assert.equal(sh.status, 200, sh.text);
  await until('B\'s shell in the list of all computers', async () => {
    const all = (await hub('/api/machines/sessions')).json.machines.find((x) => x.machine === m.name);
    return all && all.status === 'online' && all.sessions.some((s) => s.name === sh.json.name);
  });
  let screen = '';
  const ws = new WebSocket(`ws://127.0.0.1:${a.port}/m/${m.name}/ws/term?name=${sh.json.name}&cols=80&rows=24`, { headers: { Origin: a.base, Cookie: hub.cookie } });
  ws.on('message', (d) => (screen += d.toString()));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ t: 'resize', cols: 71, rows: 23 }));
  await new Promise((r) => setTimeout(r, 300));
  ws.send(JSON.stringify({ t: 'in', d: 'stty size; echo typed-through-the-link\r' }));
  await until('the resize and the typing reached B', () => screen.includes('23 71') && screen.includes('typed-through-the-link'));
  ws.close();

  // --- a 5 MB upload through the link arrives byte for byte ---
  const data = crypto.randomBytes(5 * 1024 * 1024);
  const up = await hub(`/m/${m.name}/api/sessions/${sh.json.name}/upload`, { raw: data, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'big.bin' } });
  assert.equal(up.status, 200, up.text);
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(sha(fs.readFileSync(up.json.path)), sha(data));

  // --- B restarts: offline on A meanwhile, then back by itself ---
  b.child.kill('SIGTERM');
  await new Promise((r) => b.child.once('exit', r));
  await until('B offline on A', async () => (await machineOf()).state === 'offline');
  await serve(b);
  await until('B online again on A', async () => (await machineOf()).state === 'online', 30_000);

  // --- Leave on B: A forgets it ---
  const home2 = await browser(b);
  const list = (await home2('/api/joins')).json.joined;
  const left = await home2(`/api/joins/${list[0].id}/leave`, { body: {} });
  assert.equal(left.status, 200, left.text);
  assert.equal(left.json.hubForgot, true);
  assert.equal(await machineOf(), undefined);
});
