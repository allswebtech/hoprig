// The transfer keys and the sealed message (transferkeys.mjs): each computer makes an X25519 and an Ed25519 key once,
// in its state folder (owner-only), and only the public keys go into its own file of the brain. A message is sealed for
// one receiver (ephemeral X25519, HKDF-SHA256 with a context naming both computers, AES-256-GCM with the header as
// associated data) and signed (Ed25519) over the whole thing. A changed key blocks until the owner presses Trust.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropWorld } from './dropfix.mjs';

const w = await dropWorld('transferkeys', { labels: ['alpha', 'gamma', 'delta'] });
const [A, C, D] = w.computers;
test.after(() => w.cleanup());
const K = await import('../../src/workspace/transferkeys.mjs');
const { computersHere, writeOwnFile, checkComputerFile } = await import('../../src/workspace/computer.mjs');

/** This computer's keys made and its file written; its file copied into every other brain (the sync of the brain). */
async function publish(c, others) {
  c.use();
  K.ensureKeys();
  await writeOwnFile(c.ctx);
  for (const o of others) fs.copyFileSync(path.join(c.brain, 'computers', `${c.home.split(path.sep).pop()}.json`), path.join(o.brain, 'computers', `${c.home.split(path.sep).pop()}.json`));
}
const idOf = (c) => (c.use(), JSON.parse(fs.readFileSync(path.join(c.brain, 'computers', `${c.home.split(path.sep).pop()}.json`), 'utf8')).id);
await publish(A, [C, D]);
await publish(C, [A, D]);
await publish(D, [A, C]);

const sealFrom = (from, to, over = {}) => {
  const ids = { alpha: idOf(A), gamma: idOf(C) }; // idOf switches to that computer: sign as the sender, after it
  from.use();
  const peer = K.peerKeys({ label: 'gamma', dir: from.ws });
  return K.seal({ me: { label: 'alpha', id: ids.alpha }, to: { label: 'gamma', id: ids.gamma, x25519: peer.x25519 }, nonce: 'n'.repeat(32), scope: { project: 'shop' }, plain: Buffer.from('{"files":[]}'), ...over });
};
const openAt = (c, label, sealed, over = {}) => {
  c.use();
  return K.open(sealed, { me: { label, id: idOf(c) }, peerOf: (l) => K.peerKeys({ label: l, dir: c.ws }).ed25519, ...over });
};

test('the keys: made once, owner-only in the state folder; only the public keys are in the brain', async () => {
  A.use();
  const file = K.keysFile();
  assert.ok(file.startsWith(A.env.HOPRIG_STATE_DIR));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const before = fs.readFileSync(file, 'utf8');
  K.ensureKeys();
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'made once, never again');
  const priv = JSON.parse(before);
  const theirs = fs.readFileSync(path.join(A.brain, 'computers', 'alpha.json'), 'utf8');
  for (const k of ['x25519', 'ed25519']) {
    assert.ok(priv[k].priv, 'the private half is in the state folder');
    assert.equal(theirs.includes(priv[k].priv), false, 'the private half is never in the brain');
  }
  const f = JSON.parse(theirs);
  assert.deepEqual(Object.keys(f.keys).sort(), ['ed25519', 'x25519']);
  assert.equal(f.keys.x25519, priv.x25519.pub);
  // The previous release's reader (strict on what it knows, keeps what it does not) still accepts the file.
  assert.equal(checkComputerFile(f, 'alpha').ok, true);
  assert.deepEqual(checkComputerFile(f, 'alpha').file.keys, f.keys, 'the key is kept');
  // And the file as it is read here carries it.
  assert.deepEqual(computersHere(A.ws).files.find((x) => x.label === 'alpha').keys, f.keys);
});

test('a file with a key of the wrong shape is read without the key, never refused as a whole', () => {
  const f = JSON.parse(fs.readFileSync(path.join(A.brain, 'computers', 'alpha.json'), 'utf8'));
  const bad = { ...f, keys: { x25519: 'not a key', ed25519: 5 } };
  assert.equal(checkComputerFile(bad, 'alpha').ok, true);
  A.use();
  const p = path.join(A.brain, 'computers', 'zeta.json');
  fs.writeFileSync(p, JSON.stringify({ ...bad, label: 'zeta' }));
  const z = computersHere(A.ws).files.find((x) => x.label === 'zeta');
  fs.rmSync(p);
  assert.ok(z, 'the file is used');
  assert.equal(z.keys, undefined, 'the key is not');
});

test('a sealed message opens only for its receiver, from its sender', () => {
  const sealed = sealFrom(A, C);
  const got = openAt(C, 'gamma', sealed);
  assert.equal(got.plain.toString(), '{"files":[]}');
  assert.equal(got.header.from, 'alpha');
  assert.equal(got.header.nonce, 'n'.repeat(32));
  // The ciphertext is not the plain text, and no key is in the message.
  assert.equal(sealed.toString('latin1').includes('files'), false);
});

test('a wrong receiver, a changed header, a changed ciphertext and a bad signature are each refused', () => {
  const sealed = sealFrom(A, C);
  assert.throws(() => openAt(D, 'delta', sealed), (e) => e.status === 403 && /not for this computer/.test(e.message), 'sealed for gamma, opened on delta');
  const m = JSON.parse(sealed.toString('utf8'));
  const put = (o) => Buffer.from(JSON.stringify({ ...m, ...o }));
  const flip = (b64) => {
    const b = Buffer.from(b64, 'base64');
    b[b.length - 1] ^= 1;
    return b.toString('base64');
  };
  // the header changed by one byte: the signature and the associated data both fail
  const h = Buffer.from(m.h, 'base64');
  h[h.length - 3] ^= 1;
  for (const [what, bad] of [['header', put({ h: h.toString('base64') })], ['ciphertext', put({ c: flip(m.c) })], ['tag', put({ t: flip(m.t) })], ['signature', put({ s: flip(m.s) })]]) {
    assert.throws(() => openAt(C, 'gamma', bad), (e) => e.status === 403 || e.status === 400, what);
  }
  // A header re-signed by someone else (delta signs a message that says it is from alpha) is not alpha's.
  D.use();
  const forged = JSON.parse(sealFrom(A, C).toString('utf8'));
  const dk = JSON.parse(fs.readFileSync(K.keysFile(), 'utf8'));
  const sig = crypto.sign(null, Buffer.from('anything'), crypto.createPrivateKey({ key: Buffer.from(dk.ed25519.priv, 'base64'), format: 'der', type: 'pkcs8' }));
  forged.s = sig.toString('base64');
  assert.throws(() => openAt(C, 'gamma', Buffer.from(JSON.stringify(forged))), (e) => e.status === 403);
  // not JSON, too large, wrong version
  assert.throws(() => openAt(C, 'gamma', Buffer.from('nope')), (e) => e.status === 400);
  assert.throws(() => openAt(C, 'gamma', put({ v: 2 })), (e) => e.status === 400);
});

test('a message older than its time is refused', () => {
  const sealed = sealFrom(A, C);
  assert.throws(() => openAt(C, 'gamma', sealed, { now: Date.now() + 60 * 60 * 1000 }), (e) => e.status === 403 && /too old/.test(e.message));
});

test('a key that changes blocks until Trust; a new computer is pinned from the brain', async () => {
  A.use();
  assert.equal(K.peerKeys({ label: 'delta', dir: A.ws }).state, 'new', 'pinned on first sight, from the brain');
  assert.equal(K.peerKeys({ label: 'delta', dir: A.ws }).state, 'ok');
  assert.equal(K.peerKeys({ label: 'gamma', dir: A.ws }).state, 'ok');
  // gamma makes new keys (a reinstall) and its file reaches alpha's brain
  C.use();
  fs.rmSync(K.keysFile());
  K.ensureKeys();
  await writeOwnFile(C.ctx);
  fs.copyFileSync(path.join(C.brain, 'computers', 'gamma.json'), path.join(A.brain, 'computers', 'gamma.json'));
  A.use();
  assert.throws(() => K.peerKeys({ label: 'gamma', dir: A.ws }), (e) => e.status === 409 && e.code === 'key-changed' && /Trust/.test(e.message));
  assert.throws(() => sealFrom(A, C), (e) => e.code === 'key-changed');
  K.trustPeer({ label: 'gamma', dir: A.ws });
  assert.equal(K.peerKeys({ label: 'gamma', dir: A.ws }).state, 'ok');
  // a computer with no key in the brain is unknown, and says how to go on
  assert.throws(() => K.peerKeys({ label: 'nobody', dir: A.ws }), (e) => e.status === 409 && e.code === 'key-unknown');
});

test('Trust takes only the key the brain shows, never one that came over the link', () => {
  A.use();
  const mine = K.publicKeys();
  // a computer the brain does not know: nothing to trust, whatever is offered
  assert.throws(() => K.trustPeer({ label: 'newone', dir: A.ws, offered: { id: '0'.repeat(32), ...mine } }), (e) => e.status === 409 && e.code === 'key-unknown');
  assert.throws(() => K.peerKeys({ label: 'newone', dir: A.ws }), (e) => e.code === 'key-unknown');
  // the brain says another key for gamma: an offered key does not override it
  K.trustPeer({ label: 'gamma', dir: A.ws, offered: { id: idOf(C), ...mine } });
  assert.notEqual(K.peerKeys({ label: 'gamma', dir: A.ws }).raw.x25519, mine.x25519);
});
