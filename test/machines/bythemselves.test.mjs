// Nothing of the computers part runs by itself: a real start of an isolated dashboard whose home holds a computer added with a
// kept key and a gateway the owner defined, and three of its ticks. A whole-home snapshot before and after: the key,
// its host keys, machines.json and every service folder are as they were; no ssh, ssh-keyscan, systemctl, loginctl,
// launchctl, sudo or npm was started (traps first on PATH); no gateway was started; nothing was read of the computer.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { traps } from './traps.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('machines-bythemselves');
process.env.HOME = box.home;
process.env.XDG_CONFIG_HOME = path.join(box.home, '.config');
const trap = traps(box.root);
process.env.PATH = trap.path();
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { keepKey, keyFile, knownHostsFile, keysDir } = await import('../../src/machines/keys.mjs');
const { keepHostKey } = await import('../../src/machines/hostkeys.mjs');

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sshStr = (b) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
const BODY = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sshStr(Buffer.from('none')), sshStr(Buffer.from('none')), sshStr(Buffer.alloc(0)), crypto.randomBytes(60)]).toString('base64');
const program = path.join(box.root, 'relay');
fs.writeFileSync(program, '#!/bin/sh\necho started >> "$0.ran"\nexit 0\n', { mode: 0o755 });
const gwPort = await free();
saveConfig({
  server: { passwordHash: await hashPassword('right-password') },
  gateways: { defined: [{ id: 'relay', title: 'Relay', bin: program, sha256: crypto.createHash('sha256').update(fs.readFileSync(program)).digest('hex'), port: gwPort, args: ['--port', 'PORT'] }] },
});
keepKey('box2', `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}\n-----END OPENSSH PRIVATE KEY-----\n`);
keepHostKey(knownHostsFile('box2'), { kind: 'ssh-ed25519', b64: Buffer.concat([sshStr(Buffer.from('ssh-ed25519')), sshStr(crypto.randomBytes(32))]).toString('base64') });
putMachine({ name: 'box2', label: 'Box 2', via: 'ssh', target: 'alex@203.0.113.7', remoteHost: '127.0.0.1', remotePort: 7433, token: 'hop_made-up', tokenId: null, added: 1, key: true });

/** Every file under the sandbox: path → size, mode and sha256 (mtimes move when the same text is written again). */
function snapshot() {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        out.set(path.relative(box.root, p), `${st.size}:${(st.mode & 0o777).toString(8)}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
      }
    }
  };
  walk(box.root);
  return out;
}

test('a real start and three ticks: nothing of the lane runs, connects, reads a computer or writes', { skip }, async () => {
  const before = snapshot();
  const { createServer } = await import('../../src/server/server.mjs');
  const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
  const app = createServer({ backend, watchTickMs: 50, dashboardFile: false });
  let ticks = 0;
  // With no session busy the watcher waits 30 s between looks; poke() (what a feature calls) brings the next one forward.
  const three = new Promise((resolve) => app.watcher.onTick(() => (++ticks >= 3 ? resolve() : setTimeout(() => app.watcher.poke(), 50))));
  await app.listen(0, '127.0.0.1');
  await Promise.race([three, new Promise((r) => setTimeout(r, 60_000))]);
  await app.close();
  assert.ok(ticks >= 3, `three ticks (saw ${ticks})`);
  const after = snapshot();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
  const lane = (k) => k.startsWith(path.relative(box.root, keysDir())) || /machines\.json$|systemd|LaunchAgents|\.ran$|traps\.log$/.test(k);
  assert.deepEqual(changed.filter(lane), [], 'the key, its host keys, machines.json and the service folders are as they were');
  assert.equal(before.get(path.relative(box.root, keyFile('box2'))), after.get(path.relative(box.root, keyFile('box2'))));
  assert.equal(fs.existsSync(`${program}.ran`), false, 'the gateway was not started');
  assert.deepEqual(trap.calls(), [], 'no ssh, ssh-keyscan, systemctl, loginctl, launchctl, sudo or npm was started');
  console.log(`# files changed by the start, none of the lane's: ${changed.join(', ') || 'none'}`);
});
