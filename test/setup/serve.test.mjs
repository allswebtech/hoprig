// `serve` under a process manager that is not systemd: PORT/HOST, /healthz, the unattended first start, a hub.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const O = await import('../../src/server/serveopts.mjs');
const BIN = path.resolve(import.meta.dirname, '../../bin/hoprig.mjs');
const D = { host: '127.0.0.1', port: 7433 };

test('address: flags > HOST/PORT > config > default', () => {
  assert.deepEqual(O.resolveListen({ env: {}, defaults: D }), { host: '127.0.0.1', port: 7433 });
  assert.deepEqual(O.resolveListen({ env: {}, server: { host: '0.0.0.0', port: 9000 }, defaults: D }), { host: '0.0.0.0', port: 9000 });
  assert.deepEqual(O.resolveListen({ env: { HOST: '::', PORT: '8080' }, server: { host: '0.0.0.0', port: 9000 }, defaults: D }), { host: '::', port: 8080 });
  assert.deepEqual(O.resolveListen({ flags: { host: '127.0.0.2', port: 5000 }, env: { HOST: '::', PORT: '8080' }, server: { port: 9000 }, defaults: D }), { host: '127.0.0.2', port: 5000 });
  assert.deepEqual(O.resolveListen({ env: { PORT: '', HOST: ' ' }, defaults: D }), { host: '127.0.0.1', port: 7433 }, 'empty values do not count');
  for (const bad of ['0', '70000', 'abc', '80.5', '-1']) assert.throws(() => O.resolveListen({ env: { PORT: bad }, defaults: D }), /PORT must be a port number/);
});

test('password file: flag > HOPRIG_PASSWORD_FILE; created (600), reused, too short refused', async () => {
  assert.equal(O.passwordFileFrom({ env: {} }), null);
  assert.equal(O.passwordFileFrom({ env: { HOPRIG_PASSWORD_FILE: 'pw.txt' } }), path.resolve('pw.txt'));
  assert.equal(O.passwordFileFrom({ flags: { passwordFile: '/a/b' }, env: { HOPRIG_PASSWORD_FILE: 'pw.txt' } }), '/a/b');
  const set = [];
  const file = path.join(s.tmp, 'pw', 'deep', 'password.txt');
  assert.deepEqual(await O.firstPassword(file, { setPassword: async (p) => set.push(p), generate: () => 'generated-password-123' }), { created: true, reused: false });
  assert.equal(fs.readFileSync(file, 'utf8'), 'generated-password-123\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await O.firstPassword(file, { setPassword: async (p) => set.push(p), generate: () => 'other' }), { created: false, reused: true });
  assert.deepEqual(set, ['generated-password-123', 'generated-password-123']);
  fs.writeFileSync(path.join(s.tmp, 'short.txt'), 'abc\n');
  await assert.rejects(O.firstPassword(path.join(s.tmp, 'short.txt'), { setPassword: async () => {}, generate: () => 'x' }), /shorter than 8/);
});

function get(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function freePort() {
  const srv = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Start `serve` with `env` and `args` in its own scratch home; resolves when /healthz answers. */
async function serve(name, env, args = []) {
  const root = path.join(s.tmp, name);
  const child = spawn(process.execPath, [BIN, 'serve', ...args], {
    env: {
      ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home', 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(root, 'home', 'AppData', 'Local'), HOPRIG_CONFIG_DIR: path.join(root, 'config'), HOPRIG_STATE_DIR: path.join(root, 'state'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HOPRIG_HUB: '1', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { child, root, output: () => out, exited, stop: async () => { child.kill('SIGTERM'); await exited; } };
}

async function waitHealthy(port, exited) {
  for (let i = 0; i < 80; i++) {
    const r = await get(port, '/healthz').catch(() => null);
    if (r && r.status === 200) return r;
    const done = await Promise.race([exited, new Promise((res) => setTimeout(() => res('wait'), 100))]);
    if (done !== 'wait') return null;
  }
  return null;
}

test('unattended first start: PORT from the environment, a password generated into the file, /healthz says only ok', async () => {
  const port = await freePort();
  const pwFile = path.join(s.tmp, 'first', 'data', 'pw.txt');
  const sv = await serve('first', { PORT: String(port), HOPRIG_PASSWORD_FILE: pwFile });
  try {
    const h = await waitHealthy(port, sv.exited);
    assert.ok(h, sv.output());
    assert.equal(h.body, 'ok');
    assert.match(h.headers['content-type'], /text\/plain/);
    assert.equal((await get(port, '/healthz', 'HEAD')).status, 200);
    assert.equal((await get(port, '/healthz?x=1')).body, 'ok');
    assert.equal((await get(port, '/api/state')).status, 401, 'everything else still needs the login');
    assert.equal((await get(port, '/healthz', 'POST')).status !== 200, true);
    assert.match(fs.readFileSync(pwFile, 'utf8'), /^\S{16,}\n$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(pwFile).mode & 0o777, 0o600);
    const cfg = JSON.parse(fs.readFileSync(path.join(sv.root, 'config', 'config.json'), 'utf8'));
    assert.match(cfg.server.passwordHash, /^scrypt\$/);
    assert.doesNotMatch(sv.output(), new RegExp(fs.readFileSync(pwFile, 'utf8').trim()), 'the password is never printed');
    assert.match(sv.output(), /This computer is a main computer/);
  } finally {
    await sv.stop();
  }
});

test('--port and --password-file beat PORT and HOPRIG_PASSWORD_FILE; a bad PORT stops with a clear message', async () => {
  const port = await freePort();
  const envPort = await freePort();
  const sv = await serve('flags', { PORT: String(envPort), HOPRIG_PASSWORD_FILE: path.join(s.tmp, 'flags', 'env.txt') }, ['--port', String(port), '--password-file', path.join(s.tmp, 'flags', 'flag.txt')]);
  try {
    assert.ok(await waitHealthy(port, sv.exited), sv.output());
    assert.ok(fs.existsSync(path.join(s.tmp, 'flags', 'flag.txt')));
    assert.equal(fs.existsSync(path.join(s.tmp, 'flags', 'env.txt')), false);
    assert.equal(await get(envPort, '/healthz').catch(() => 'refused'), 'refused');
  } finally {
    await sv.stop();
  }
  const bad = await serve('badport', { PORT: 'eighty', HOPRIG_PASSWORD_FILE: path.join(s.tmp, 'badport', 'pw.txt') });
  assert.equal(await bad.exited, 2);
  assert.match(bad.output(), /PORT must be a port number, 1-65535 \(got "eighty"\)/);
});

test('without a password and without a password file, serve still refuses', async () => {
  const sv = await serve('nopw', { PORT: String(await freePort()) });
  assert.equal(await sv.exited, 1);
  assert.match(sv.output(), /no dashboard password is set/);
});

test('HOST from the environment', async () => {
  const port = await freePort();
  const sv = await serve('host', { HOST: '127.0.0.1', PORT: String(port), HOPRIG_PASSWORD_FILE: path.join(s.tmp, 'host', 'pw.txt') });
  try {
    assert.ok(await waitHealthy(port, sv.exited), sv.output());
    assert.match(sv.output(), new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
  } finally {
    await sv.stop();
  }
});
