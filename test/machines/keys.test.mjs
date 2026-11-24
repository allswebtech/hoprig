// The kept SSH keys (src/machines/keys.mjs): only in <config>/ssh-keys (folder 700, file 600), a key with a
// passphrase refused in plain words, text that is not a private key refused without being quoted back, a public key
// named as such, and the key and its host keys gone after dropKey. Every key here is made up in this test.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('machines-keys');
test.after(() => box.cleanup());
const { KeyError, checkKey, dropKey, hasKey, keepKey, keyFile, keysDir, knownHostsFile } = await import('../../src/machines/keys.mjs');

const str = (s) => {
  const b = Buffer.from(s, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};
/** An OpenSSH-format private key whose cipher is `cipher` ("none": no passphrase). Only its head is real. */
const openssh = (cipher) => {
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), str(cipher), str(cipher === 'none' ? 'none' : 'bcrypt'), str(''), crypto.randomBytes(48)]).toString('base64');
  return { text: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`, body };
};
const pkcs8 = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const pkcs8Locked = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'made-up' });

test('a key without a passphrase is kept in its own folder: folder 700, file 600, the text as given', () => {
  const k = openssh('none');
  const file = keepKey('box2', k.text.replace(/\n/g, '\r\n'));
  assert.equal(file, path.join(box.config, 'ssh-keys', 'box2'));
  assert.equal(fs.statSync(keysDir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), k.text, 'line ends made plain');
  assert.ok(hasKey('box2'));
  assert.deepEqual(fs.readdirSync(keysDir()), ['box2'], 'no temporary file is left');
  assert.equal(checkKey(pkcs8), pkcs8.trim() + '\n', 'a PKCS#8 key without a passphrase is taken too');
});

test('a key with a passphrase is refused in plain words, in every format, and nothing is written', () => {
  const rsaLocked = '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00112233445566778899AABBCCDDEEFF\n\nAAAABBBBCCCC\n-----END RSA PRIVATE KEY-----\n';
  for (const t of [openssh('aes256-ctr').text, pkcs8Locked, rsaLocked]) {
    assert.throws(() => keepKey('locked', t), (e) => e instanceof KeyError && e.code === 'passphrase' && /passphrase/.test(e.message) && /never asks for one or keeps one/.test(e.message));
  }
  assert.equal(hasKey('locked'), false);
});

test('text that is not a private key is refused and never quoted back; a public key is named', () => {
  const secret = 'sk-ant-made-up-0123456789';
  const notKeys = [secret, `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.from(secret).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', 'x'.repeat(20_000)];
  for (const t of notKeys) {
    assert.throws(() => checkKey(t), (e) => e.code === 'not-a-key' && !e.message.includes(secret) && !e.message.includes(Buffer.from(secret).toString('base64')));
  }
  assert.throws(() => checkKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUp alex@box2'), (e) => e.code === 'public-key' && !e.message.includes('AAAA'));
  assert.throws(() => checkKey(''), (e) => e.code === 'no-key');
  assert.throws(() => checkKey({}), (e) => e.code === 'no-key');
});

test('a computer name is checked before it becomes a file name', () => {
  for (const bad of ['../x', 'a/b', '', '-x', 'A']) assert.throws(() => keyFile(bad));
});

test('dropKey removes the key and its host keys; a missing one is fine', () => {
  keepKey('gone', openssh('none').text);
  fs.writeFileSync(knownHostsFile('gone'), '[203.0.113.7]:22 ssh-ed25519 AAAA\n', { mode: 0o600 });
  dropKey('gone');
  assert.equal(hasKey('gone'), false);
  assert.equal(fs.existsSync(knownHostsFile('gone')), false);
  dropKey('never-was');
});
