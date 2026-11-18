// `hoprig gateways add | remove`: the owner's own steps. They show exactly what Hoprig will run and ask in his terminal;
// they refuse without a terminal (a session's tool, Tia's run_command) and in a coding tool's shell, and nothing is
// written then. One run goes through a real terminal (node-pty), as the owner types it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewaycli');
test.after(() => box.cleanup());
const POSIX = { skip: process.platform === 'win32' };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const relay = path.join(box.root, 'relay');
fs.writeFileSync(relay, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const { loadConfig } = await import('../../src/config.mjs');
const { main } = await import('../../src/addons/gatewaycli.mjs');
const { binFile } = await import('../../src/paths.mjs');
const { fileSha256 } = await import('../../src/addons/localgateway.mjs');
const { nodePty, ptySpawn } = await import('../../src/server/backends/nodepty.mjs');

const ADD = ['add', 'relay', '--title', 'Relay', '--bin', relay, '--port', String(PORT), '--args', '--listen=127.0.0.1:PORT --quiet'];
const defined = () => loadConfig().gateways?.defined || [];
function io(answer, extra = {}) {
  const said = [];
  const asked = [];
  return {
    said, asked,
    out: (s) => said.push(s), err: (s) => said.push(s),
    ask: async (q) => { asked.push(q); return answer; },
    tty: true, env: {}, ...extra,
  };
}

test('refused in a coding tool\'s shell and without a terminal; nothing is asked or written', async () => {
  for (const [extra, why] of [
    [{ env: { CLAUDECODE: '1' } }, /yours alone: run it in your own terminal, not in a session or a terminal of the dashboard \(CLAUDECODE/],
    [{ env: { OPENCODE: '1' } }, /not in a session .*\(OPENCODE/],
    // A coding tool that sets neither (Codex's own marks, or a shell that dropped them with env -u): Hoprig's marks.
    [{ env: { HOPRIG_RUN_FILE: '/x/run.json' } }, /not in a session .*\(HOPRIG_RUN_FILE/],
    [{ env: { HOPRIG_TERM_ID: 't1' } }, /not in a session .*\(HOPRIG_TERM_ID/],
    [{ env: { CODEX_SANDBOX: 'seatbelt' } }, /not in a session .*\(CODEX_SANDBOX/],
    [{ tty: false }, /asks you to confirm: run it in a terminal/],
  ]) {
    for (const args of [ADD, ['remove', 'relay']]) {
      const t = io('y', extra);
      assert.equal(await main(args, t), 1);
      assert.match(t.said.join('\n'), why);
      assert.deepEqual(t.asked, []);
    }
  }
  assert.deepEqual(defined(), []);
});

test('add shows exactly what Hoprig will run and asks; No adds nothing, Yes adds it', async () => {
  let t = io('n');
  assert.equal(await main(ADD, t), 1);
  const shown = t.said.join('\n');
  assert.match(shown, new RegExp(`Hoprig runs:\\n  ${relay.replace(/[/\\.]/g, '\\$&')} --listen=127\\.0\\.0\\.1:${PORT} --quiet\\n`));
  assert.match(shown, /Nothing of it goes through a shell/);
  assert.deepEqual(t.asked, ['Add it? (y/N) ']);
  assert.deepEqual(defined(), []);
  t = io('y');
  assert.equal(await main(ADD, t), 0);
  assert.deepEqual(defined(), [{ id: 'relay', title: 'Relay', port: PORT, bin: relay, sha256: fileSha256(relay), typed: relay, args: ['--listen=127.0.0.1:PORT', '--quiet'] }]);
  assert.match(t.said.join('\n'), /hoprig addons setup relay/);
  t = io('y');
  assert.equal(await main(ADD, t), 2, 'not twice');
  assert.match(t.said.join('\n'), /already/);
  for (const bad of [['add'], ['add', 'x', '--nope', '1'], ['add', 'x', '--title']]) assert.equal(await main(bad, io('y')), 2);
  const listed = io(null, { tty: false });
  assert.equal(await main([], listed), 0, 'the list needs no terminal');
  assert.match(listed.said.join('\n'), /^relay {2}Relay \(yours\) · installed, not running$/m);
});

test('remove asks (and names the providers that start it); a shipped gateway is never removed', async () => {
  fs.writeFileSync(path.join(box.profiles, 'relay.env'), `LABEL="API via Relay"\nPRERUN="node ${binFile()} addons start relay"\nANTHROPIC_BASE_URL=http://localhost:${PORT}\nANTHROPIC_AUTH_TOKEN=k\n`, { mode: 0o600 });
  let t = io('y');
  assert.equal(await main(['remove', 'trouteai'], t), 1);
  assert.match(t.said.join('\n'), /ships: it cannot be removed/);
  t = io('n');
  assert.equal(await main(['remove', 'relay'], t), 1);
  assert.match(t.said.join('\n'), /The provider API via Relay starts Relay: its sessions will not start/);
  assert.equal(defined().length, 1);
  t = io('y');
  assert.equal(await main(['remove', 'relay'], t), 0);
  assert.deepEqual(defined(), []);
  fs.rmSync(path.join(box.profiles, 'relay.env'));
});

test('a command run without a terminal (as Tia\'s run_command or a session\'s tool runs one) adds nothing', POSIX, () => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const r = spawnSync(process.execPath, [binFile(), 'gateways', ...ADD], { env, input: 'y\n', encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /asks you to confirm: run it in a terminal/);
  const inTool = spawnSync(process.execPath, [binFile(), 'gateways', ...ADD], { env: { ...env, CLAUDECODE: '1' }, input: 'y\n', encoding: 'utf8' });
  assert.match(inTool.stderr, /not in a session/);
  assert.deepEqual(defined(), []);
});

test('in the owner\'s own terminal: hoprig gateways add, answered y', { skip: process.platform === 'win32' || !nodePty }, async () => {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'OPENCODE']) delete env[k];
  // The product's own spawn, as a dashboard's terminal starts it (on macOS it first makes node-pty's helper executable).
  const term = ptySpawn(process.execPath, [binFile(), 'gateways', ...ADD], { cols: 200, rows: 40, cwd: box.root, env });
  let screen = '';
  let answered = false;
  const code = await new Promise((resolve) => {
    term.onData((d) => {
      screen += d;
      if (!answered && screen.includes('Add it? (y/N)')) {
        answered = true;
        term.write('y\r');
      }
    });
    term.onExit((e) => resolve(e.exitCode));
  });
  assert.equal(code, 0, screen);
  assert.match(screen, /Added Relay\./);
  assert.deepEqual(defined().map((d) => d.id), ['relay']);
});

test('a provider named "gateway" (a likely name for a gateway\'s provider before this command) stays a provider', () => {
  fs.writeFileSync(path.join(box.profiles, 'gateway.env'), 'LABEL="My gateway"\nANTHROPIC_BASE_URL=http://localhost:20017\nANTHROPIC_AUTH_TOKEN=gw-key-0000\n', { mode: 0o600 });
  try {
    const r = spawnSync(process.execPath, [binFile(), 'profiles'], { env: process.env, encoding: 'utf8' });
    assert.match(r.stdout, /^gateway\tapi\tMy gateway$/m, 'hoprig profiles lists it');
  } finally {
    fs.rmSync(path.join(box.profiles, 'gateway.env'));
  }
});

test('with a dashboard password, the yes to add is that password: a wrong one or none adds nothing', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ server: { passwordHash: await hashPassword('right-password') }, gateways: { ...loadConfig().gateways, defined: [] } });
  try {
    for (const [pw, code] of [[null, 1], ['', 1], ['wrong-password', 1]]) {
      const t = io('y', { askSecret: async (q) => { t.asked.push(q); return pw; } });
      assert.equal(await main(ADD, t), code);
      assert.deepEqual(t.asked, ["To add it, type the dashboard's password (Enter alone: no): "], 'a y/N is not asked');
      assert.deepEqual(defined(), []);
    }
    const t = io('n', { askSecret: async () => 'right-password' });
    assert.equal(await main(ADD, t), 0, t.said.join('\n'));
    assert.deepEqual(defined().map((d) => d.id), ['relay']);
  } finally {
    saveConfig({ server: { passwordHash: undefined }, gateways: { ...loadConfig().gateways, defined: [] } });
  }
});

test('a definition of config.json that was not loaded: not added twice under its id, and removed with the command', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  let t = io('y');
  assert.equal(await main(ADD, t), 0, t.said.join('\n'));
  const keep = loadConfig().addons;
  saveConfig({ addons: { ...keep, trouteai: { port: PORT } } }); // the shipped gateway's port now: relay is not loaded
  try {
    const other = await freePort();
    t = io('y');
    assert.equal(await main(['add', 'relay', '--title', 'Relay', '--bin', relay, '--port', String(other)], t), 2);
    assert.match(t.said.join('\n'), new RegExp(`there is a gateway "relay" in config.json already that was not loaded \\(port ${PORT} is TRouteAI's\\): fix it there, or remove it with hoprig gateways remove relay \\(or Remove on its line in Settings → Add-ons\\)`));
    assert.equal(defined().length, 1, 'no second entry under its id');
    t = io('y');
    assert.equal(await main(['remove', 'relay'], t), 0, t.said.join('\n'));
    assert.match(t.asked.join('\n'), /Remove the gateway relay from config\.json\? It was not loaded \(port \d+ is TRouteAI's\), so Hoprig does not stop it/);
    assert.deepEqual(defined(), []);
  } finally {
    saveConfig({ addons: keep });
  }
});

test('confirm, after the owner changed his program: shows the file and its fingerprint, asks as add does, keeps sharing and keys', POSIX, async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const K = await import('../../src/gateway/keys.mjs');
  const prog = path.join(box.root, 'relay-confirm');
  fs.writeFileSync(prog, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const args = ['add', 'relay-c', '--title', 'Relay C', '--bin', prog, '--port', String(await freePort())];
  let t = io('y');
  assert.equal(await main(args, t), 0, t.said.join('\n'));
  K.setShared('relay-c', 'relay-c');
  const key = K.createKey('relay-c', 'laptop').key;
  try {
    t = io('y');
    assert.equal(await main(['confirm', 'relay-c'], t), 0);
    assert.match(t.said.join('\n'), /is the one you confirmed: there is nothing to confirm/);
    assert.deepEqual(t.asked, []);
    fs.writeFileSync(prog, '#!/bin/sh\necho version 2\n', { mode: 0o755 }); // an update
    const listed = io(null, { tty: false });
    await main([], listed);
    assert.match(listed.said.join('\n'), /^ {2}its program changed since you confirmed it, so Hoprig does not start it: if that is yours, hoprig gateways confirm relay-c$/m);
    for (const [extra, why] of [[{ env: { CLAUDECODE: '1' } }, /yours alone/], [{ tty: false }, /run it in a terminal/]]) {
      t = io('y', extra);
      assert.equal(await main(['confirm', 'relay-c'], t), 1);
      assert.match(t.said.join('\n'), why);
    }
    t = io('n');
    assert.equal(await main(['confirm', 'relay-c'], t), 1);
    const shown = t.said.join('\n');
    assert.match(shown, /The program of Relay C \(relay-c\) changed since you confirmed it\. Confirm it only if you changed it yourself/);
    assert.ok(t.said.includes(`Its fingerprint (sha256) now: ${fileSha256(prog)}`), shown);
    assert.ok(t.said.includes(`  ${prog} --port ${portOfRelayC()}`), shown);
    assert.deepEqual(t.asked, ['Confirm it? (y/N) ']);
    assert.match(shown, /Nothing was changed\./);
    assert.notEqual(defined().find((d) => d.id === 'relay-c').sha256, fileSha256(prog), 'No changes nothing');
    // With a dashboard password, the yes is that password.
    saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
    t = io('y', { askSecret: async (q) => { t.asked.push(q); return 'wrong-password'; } });
    assert.equal(await main(['confirm', 'relay-c'], t), 1);
    assert.deepEqual(t.asked, ["To confirm it, type the dashboard's password (Enter alone: no): "]);
    t = io('n', { askSecret: async () => 'right-password' });
    assert.equal(await main(['confirm', 'relay-c'], t), 0, t.said.join('\n'));
    assert.match(t.said.join('\n'), /Confirmed: Hoprig starts Relay C with this program now\. Its sharing and the keys of other computers are as they were\./);
    assert.equal(defined().find((d) => d.id === 'relay-c').sha256, fileSha256(prog));
    assert.equal(K.sharedProvider('relay-c'), 'relay-c');
    assert.equal(K.verifyKey(key, 'relay-c')?.name, 'laptop');
    t = io('y');
    assert.equal(await main(['confirm', 'nope'], t), 1);
    assert.match(t.said.join('\n'), /Not confirmed: there is no gateway "nope" of yours\./);
    assert.equal(await main(['confirm'], io('y')), 2);
  } finally {
    saveConfig({ server: { passwordHash: undefined } });
    await main(['remove', 'relay-c'], io('y'));
  }
});
const portOfRelayC = () => defined().find((d) => d.id === 'relay-c').port;
