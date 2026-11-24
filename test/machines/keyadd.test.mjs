// Adding a computer by SSH with a pasted key (src/machines/keyadd.mjs, the /api/machines/ssh/key routes), over real
// HTTP with the mini dashboard: the host key's print first and nothing logged in before it is confirmed; then the key
// and the host key kept (600) and used with IdentitiesOnly and the kept known-hosts only; the key's text in no
// answer, no machines.json and no log; a wrong print, a missing confirmation or an expired step refused; a failed
// add leaves no file; a changed host key stops everything; removing the computer removes its files. The "server" is
// a second mini dashboard reached through the stand-in ssh, with traps for the real programs behind it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { REPO, asBrowser, fakeRemote, miniDashboard } from './harness.mjs';
import { traps } from './traps.mjs';
import { sealedPath } from '../seal.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('machines-keyadd');
const { createMachines } = await import('../../src/machines/index.mjs');
const { loadMachines, machinesFile } = await import('../../src/machines/store.mjs');
const { keyFile, knownHostsFile } = await import('../../src/machines/keys.mjs');
const { keyAdder } = await import('../../src/machines/keyadd.mjs');

const sshStr = (b) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};
const hostKey = () => {
  const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return `ssh-ed25519 ${Buffer.concat([sshStr(Buffer.from('ssh-ed25519')), sshStr(raw)]).toString('base64')}`;
};
// A made-up private key in OpenSSH's format without a passphrase: only its head is read by Hoprig.
const BODY = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sshStr(Buffer.from('none')), sshStr(Buffer.from('none')), sshStr(Buffer.alloc(0)), crypto.randomBytes(60)]).toString('base64');
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY.match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
const accepted = path.join(box.root, 'accepted-key');
fs.writeFileSync(accepted, KEY);
const HOSTKEY = hostKey();

const fast = { claudeVersion: async () => null, relayIdleMs: 800, hub: { probeTimeoutMs: 600, tunnelWaitMs: 5000, hubName: 'test-hub' } };
const server = await miniDashboard({ createMachines, opts: fast, sessions: [{ name: 'on-the-server' }] }).listen();
saveConfig({ server: { host: '127.0.0.1', port: server.port } });
const remote = fakeRemote(path.join(box.root, 'ssh'), { script: `exec "${process.execPath}" "${path.join(REPO, 'bin', 'hoprig.mjs')}" "$@"` });
fs.writeFileSync(path.join(remote.bin, 'ssh-keyscan'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fixtures', 'fake-keyscan.mjs')}" "$@"\n`, { mode: 0o755 });
const trap = traps(box.root);
const env = { ...remote.sshEnv, PATH: sealedPath(trap.path(remote.bin)), FAKE_HOSTKEY: HOSTKEY, FAKE_SSH_ACCEPT_KEY: accepted };
const hub = await miniDashboard({ createMachines, opts: { ...fast, hub: { ...fast.hub, ssh: { env } } } }).listen();
const browser = asBrowser(hub.base);
test.after(async () => {
  await hub.close();
  await server.close();
  box.cleanup();
});

/** Everything the hub wrote, read back as text: what must never hold the key. */
const written = () => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p !== keyFile('box2') && p !== accepted) out.push([p, fs.readFileSync(p, 'latin1')]);
    }
  };
  walk(box.root);
  return out;
};
const holdsKey = (text) => text.includes(BODY.slice(0, 40)) || text.includes(BODY.slice(-40));

test('step 1 shows the host key\'s print and logs in nowhere; a passphrase key or a bad address is refused', { skip }, async () => {
  const locked = KEY.replace(BODY.slice(0, 40), Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sshStr(Buffer.from('aes256-ctr'))]).toString('base64').slice(0, 40));
  const r = await browser('/api/machines/ssh/key', { body: { host: '203.0.113.7', user: 'alex', port: 22, key: locked } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'passphrase');
  for (const bad of [{ host: '-oProxyCommand=x', user: 'alex' }, { host: '203.0.113.7', user: 'al ex' }, { host: '203.0.113.7', user: 'alex', port: 70000 }]) {
    assert.equal((await browser('/api/machines/ssh/key', { body: { ...bad, key: KEY } })).status, 400, JSON.stringify(bad));
  }
  const before = remote.calls().length;
  const s = await browser('/api/machines/ssh/key', { body: { host: '203.0.113.7', user: 'alex', port: 2222, key: KEY, name: 'box2' } });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.name, 'box2');
  assert.equal(s.json.target, 'ssh://alex@203.0.113.7:2222');
  assert.match(s.json.print, /^SHA256:/);
  assert.ok(!holdsKey(s.text), 'the answer does not carry the key');
  const calls = remote.calls().slice(before);
  assert.deepEqual(calls.map((c) => c[0]), ['ssh-keyscan'], 'only the host key was read: no login');
  assert.ok(calls[0].includes('2222'));
  assert.equal(fs.existsSync(keyFile('box2')), false, 'nothing is written before the print is confirmed');
  trap.check();
});

test('step 2: the print confirmed by the computer\'s name pairs it with the kept key and host key only', { skip }, async () => {
  const s = await browser('/api/machines/ssh/key', { body: { host: '127.0.0.1', user: 'alex', key: KEY, name: 'box2' } });
  assert.equal((await browser('/api/machines/ssh/key/confirm', { body: { pending: s.json.pending, print: s.json.print } })).json.code, 'confirm', 'no confirmation');
  assert.equal((await browser('/api/machines/ssh/key/confirm', { body: { pending: s.json.pending, print: 'SHA256:other', confirm: 'box2' } })).json.code, 'print');
  const before = remote.calls().length;
  const r = await browser('/api/machines/ssh/key/confirm', { body: { pending: s.json.pending, print: s.json.print, confirm: 'box2' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.machine.state, 'online', JSON.stringify(r.json.machine));
  assert.equal(r.json.machine.key, true);
  assert.equal((await browser('/m/box2/api/state')).json.sessions[0].name, 'on-the-server');
  assert.equal(fs.statSync(keyFile('box2')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(knownHostsFile('box2')).mode & 0o777, 0o600);
  for (const c of remote.calls().slice(before)) {
    const a = c.join(' ');
    assert.ok(a.includes(`-i ${keyFile('box2')}`) && a.includes('IdentitiesOnly=yes') && a.includes(`UserKnownHostsFile=${knownHostsFile('box2')}`) && a.includes('StrictHostKeyChecking=yes'), a);
  }
  const stored = JSON.parse(fs.readFileSync(machinesFile(), 'utf8')).machines.find((m) => m.name === 'box2');
  assert.equal(stored.key, true);
  for (const [p, text] of written()) assert.ok(!holdsKey(text), `${p} holds the key`);
  assert.equal((await browser('/api/machines/ssh/key/confirm', { body: { pending: s.json.pending, print: s.json.print, confirm: 'box2' } })).status, 410, 'a step is used once');
  trap.check();
});

test('a changed host key stops every request to that computer, in words that say so', { skip }, async () => {
  hub.machines.hub.tunnels.close('box2');
  const was = env.FAKE_HOSTKEY;
  env.FAKE_HOSTKEY = hostKey();
  try {
    const r = await browser('/m/box2/api/state');
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'hostkey');
    assert.match(r.json.error, /another host key than the one kept/);
    const list = (await browser('/api/machines?fresh=1')).json.machines;
    assert.equal(list.find((m) => m.name === 'box2').state, 'hostkey');
  } finally {
    env.FAKE_HOSTKEY = was;
    hub.machines.hub.tunnels.close('box2');
  }
  trap.check();
});

test('a failed add leaves no file; removing the computer removes its key and host key', { skip }, async () => {
  const wrong = `${KEY.slice(0, -80)}${'A'.repeat(10)}${KEY.slice(-70)}`;
  const s = await browser('/api/machines/ssh/key', { body: { host: '127.0.0.1', user: 'bea', key: wrong, name: 'box3' } });
  assert.equal(s.status, 200, s.text);
  const r = await browser('/api/machines/ssh/key/confirm', { body: { pending: s.json.pending, print: s.json.print, confirm: 'box3' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'ssh-auth');
  assert.equal(r.json.error, 'box3 did not accept this key for the user bea. Check the user name and that this key is the one the company you rent it from gave you, then paste it again and press Next.');
  assert.doesNotMatch(r.json.error, /ssh-copy-id/, 'no terminal step for a key he gave');
  assert.ok(!holdsKey(r.text));
  assert.equal(fs.existsSync(keyFile('box3')), false);
  assert.equal(fs.existsSync(knownHostsFile('box3')), false);
  for (const body of [{}, { confirm: 'box3' }, { confirm: 'BOX2' }]) {
    const no = await browser('/api/machines/box2/remove', { body });
    assert.equal(no.status, 400, JSON.stringify(body));
    assert.equal(no.json.code, 'confirm');
  }
  assert.ok(loadMachines().some((m) => m.name === 'box2'), 'a remove without its confirmation leaves the computer');
  assert.equal((await browser('/api/machines/install', { body: { target: 'alex@box2' } })).json.code, 'confirm', 'an install too');
  assert.equal((await browser('/api/machines/box2/remove', { body: { confirm: 'box2' } })).status, 200);
  assert.equal((await browser('/api/machines/box2/remove', { body: { confirm: 'box2' } })).status, 404, 'twice: the second finds nothing and breaks nothing');
  assert.equal(fs.existsSync(keyFile('box2')), false);
  assert.equal(fs.existsSync(knownHostsFile('box2')), false);
  assert.ok(!loadMachines().some((m) => m.name === 'box2'));
  trap.check();
});

test('the same confirmation twice at once pairs once and leaves the computer whole', { skip }, async () => {
  const s = await browser('/api/machines/ssh/key', { body: { host: '127.0.0.1', user: 'cai', key: KEY, name: 'box5' } });
  assert.equal(s.status, 200, s.text);
  const before = remote.calls().length;
  const body = { pending: s.json.pending, print: s.json.print, confirm: 'box5' };
  const answers = await Promise.all([browser('/api/machines/ssh/key/confirm', { body }), browser('/api/machines/ssh/key/confirm', { body })]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409], answers.map((r) => r.text).join(' | '));
  // One pairing is one run of `hoprig pair` there (the stand-in finds hoprig in the login shell only).
  const pairs = remote.calls().slice(before).filter((c) => c.join(' ').includes('-lic') && c.join(' ').includes(' pair '));
  assert.equal(pairs.length, 1, 'paired once');
  assert.equal(fs.existsSync(keyFile('box5')), true, 'its key is still there');
  assert.equal(fs.existsSync(knownHostsFile('box5')), true, 'its host key is still there');
  assert.equal((await browser('/m/box5/api/state')).status, 200, 'and it answers');
  assert.equal((await browser('/api/machines?fresh=1')).json.machines.find((m) => m.name === 'box5').state, 'online');
  trap.check();
});

test('an add left waiting for its install when the dashboard restarted leaves no key, and that name can be added again', { skip }, async () => {
  const notThere = async () => {
    throw Object.assign(new Error('Hoprig is not installed there'), { status: 422, code: 'not-installed', canInstall: true });
  };
  const first = keyAdder({ addBySsh: notThere, ssh: { env } });
  const s = await first.begin({ host: '127.0.0.1', user: 'dee', key: KEY, name: 'box6' });
  await assert.rejects(first.finish({ pending: s.pending, print: s.print, confirm: 'box6' }), (e) => e.code === 'not-installed');
  assert.equal(fs.existsSync(keyFile('box6')), true, 'kept for the install');
  // The dashboard restarts (an update): a new adder, with nothing in memory. Nothing is removed by itself.
  let added = 0;
  const after = keyAdder({ addBySsh: async () => ((added += 1), { machine: { name: 'box6' } }), ssh: { env } });
  assert.equal(after.pendingCount(), 0);
  assert.equal(fs.existsSync(keyFile('box6')), true, 'nothing is removed without a press');
  const again = await after.begin({ host: '127.0.0.1', user: 'dee', key: KEY, name: 'box6' });
  assert.equal(fs.existsSync(keyFile('box6')), false, 'the left key went on his press');
  assert.equal(fs.existsSync(knownHostsFile('box6')), false);
  assert.equal(fs.existsSync(keyFile('box5')), true, 'a kept computer\'s key stays');
  const r = await after.finish({ pending: again.pending, print: again.print, confirm: 'box6' });
  assert.equal(r.machine.name, 'box6', 'added, not refused as already there');
  assert.equal(added, 1);
  trap.check();
});

test('a server that is already under Computers is not added a second time', { skip }, async () => {
  const before = loadMachines().length;
  const r = await browser('/api/machines/ssh/key', { body: { host: '127.0.0.1', user: 'cai', key: KEY } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'already-added');
  assert.match(r.json.error, /\(cai@127\.0\.0\.1\) is already under Computers/);
  assert.equal(loadMachines().length, before, 'no second computer');
  trap.check();
});

test('the same server under another address is recognised by its host key print and not added again', { skip }, async () => {
  const before = loadMachines().length;
  const keyed = loadMachines().filter((m) => m.key === true);
  assert.ok(keyed.length, 'a computer with a kept host key is there');
  const r = await browser('/api/machines/ssh/key', { body: { host: 'localhost', user: 'cai', key: KEY } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'already-added');
  assert.match(r.json.error, /has the same host key \(SHA256:[A-Za-z0-9+/]+\): it is this server, already under Computers/);
  assert.equal(loadMachines().length, before, 'no second computer');
  assert.equal(r.json.pending, undefined, 'no step left waiting');
  trap.check();
});

test('a changed host key: both prints are shown, and only his press with the print shown replaces the kept one', { skip }, async () => {
  hub.machines.hub.tunnels.close('box5');
  const was = env.FAKE_HOSTKEY;
  env.FAKE_HOSTKEY = hostKey();
  try {
    assert.equal((await browser('/api/machines?fresh=1')).json.machines.find((m) => m.name === 'box5').state, 'hostkey');
    const keptBefore = fs.readFileSync(knownHostsFile('box5'), 'utf8');
    const seen = await browser('/api/machines/box5/hostkey');
    assert.equal(seen.status, 200, seen.text);
    assert.equal(seen.json.same, false);
    assert.match(seen.json.kept, /^SHA256:/);
    assert.match(seen.json.now, /^SHA256:/);
    assert.notEqual(seen.json.kept, seen.json.now);
    for (const body of [{ print: seen.json.now }, { print: seen.json.now, confirm: 'box2' }, { print: seen.json.kept, confirm: 'box5' }, { print: 'SHA256:other', confirm: 'box5' }]) {
      const no = await browser('/api/machines/box5/hostkey', { body });
      assert.equal(no.status, 400, `${JSON.stringify(body)}: ${no.text}`);
      assert.equal(fs.readFileSync(knownHostsFile('box5'), 'utf8'), keptBefore, 'nothing changed');
    }
    const yes = await browser('/api/machines/box5/hostkey', { body: { print: seen.json.now, confirm: 'box5' } });
    assert.equal(yes.status, 200, yes.text);
    assert.equal(yes.json.kept, seen.json.now);
    assert.equal(yes.json.machine.state, 'online', JSON.stringify(yes.json.machine));
    assert.equal(fs.statSync(knownHostsFile('box5')).mode & 0o777, 0o600);
  } finally {
    env.FAKE_HOSTKEY = was;
    hub.machines.hub.tunnels.close('box5');
  }
  trap.check();
});
