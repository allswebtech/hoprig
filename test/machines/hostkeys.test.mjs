// The host key of a computer added with a kept key (src/machines/hostkeys.mjs): read by ssh-keyscan (a stand-in
// here, with traps behind it), its SHA256 print as ssh shows it, kept in its own file (600) under one alias, and the
// ssh options that make that file the only one ssh trusts for it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { traps } from './traps.mjs';
import { sealedPath } from '../seal.mjs';

const box = sandbox('machines-hostkeys');
test.after(() => box.cleanup());
const { ALIAS, fingerprint, hostKeyRefused, keepHostKey, keptHostKey, keyedOptions, parseKeys, scanHostKey } = await import('../../src/machines/hostkeys.mjs');

const sshStr = (b) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};
/** A made-up ed25519 host key as ssh writes it: "ssh-ed25519 <blob>". */
export function madeUpHostKey() {
  const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return `ssh-ed25519 ${Buffer.concat([sshStr(Buffer.from('ssh-ed25519')), sshStr(raw)]).toString('base64')}`;
}

test('the print is the one ssh-keygen shows for the same key', { skip: !fs.existsSync('/usr/bin/ssh-keygen') && 'no ssh-keygen here' }, () => {
  const line = madeUpHostKey();
  const file = path.join(box.root, 'k.pub');
  fs.writeFileSync(file, `${line} made-up\n`);
  process.env.HOPRIG_SEAL_REAL = 'ssh-keygen'; // seal: the print must equal the one ssh-keygen itself shows; it reads only the key file the test wrote
  let shown;
  try {
    shown = execFileSync('/usr/bin/ssh-keygen', ['-l', '-E', 'sha256', '-f', file], { encoding: 'utf8' }).split(' ')[1];
  } finally {
    delete process.env.HOPRIG_SEAL_REAL; // seal: only this one start
  }
  assert.equal(fingerprint(line.split(' ')[1]), shown);
});

test('parseKeys: keyscan lines and comments; a blob that does not say its own kind is not taken', () => {
  const a = madeUpHostKey();
  const [, b64] = a.split(' ');
  const keys = parseKeys(`# 203.0.113.7:22 SSH-2.0-x\n203.0.113.7 ${a}\n203.0.113.7 ssh-rsa ${b64}\n203.0.113.7 ssh-ed25519 not*base64\n`);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, 'ssh-ed25519');
  assert.match(keys[0].print, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('scanHostKey through a stand-in: the key, or a plain sentence; nothing real is reached', async () => {
  const t = traps(box.root);
  const bin = path.join(box.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh-keyscan'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fixtures', 'fake-keyscan.mjs')}" "$@"\n`, { mode: 0o755 });
  const key = madeUpHostKey();
  const env = { PATH: sealedPath(t.path(bin)), FAKE_HOSTKEY: key };
  const r = await scanHostKey('203.0.113.7', 2222, { env });
  assert.equal(r.ok, true);
  assert.equal(`${r.key.kind} ${r.key.b64}`, key);
  const none = await scanHostKey('203.0.113.7', 22, { env: { ...env, FAKE_KEYSCAN_MODE: 'none' } });
  assert.equal(none.ok, false);
  assert.match(none.message, /did not show a host key on port 22.*Connection refused/);
  t.check();
});

test('the kept host key: its own file, mode 600, under the alias; the options trust only it', () => {
  const file = path.join(box.config, 'ssh-keys', 'box2.known_hosts');
  const [key] = parseKeys(`x ${madeUpHostKey()}`);
  keepHostKey(file, key);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), `${ALIAS} ${key.kind} ${key.b64}\n`);
  assert.deepEqual(keptHostKey(file), key);
  assert.equal(keptHostKey(path.join(box.root, 'nothing')), null);
  const o = keyedOptions({ keyFile: '/k', knownHosts: file }).join(' ');
  for (const want of ['-i /k', 'IdentitiesOnly=yes', `HostKeyAlias=${ALIAS}`, `UserKnownHostsFile=${file}`, 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null']) assert.ok(o.includes(want), want);
  assert.ok(hostKeyRefused('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'));
  assert.ok(hostKeyRefused('Host key verification failed.'));
  assert.equal(hostKeyRefused('Permission denied (publickey).'), false);
});
