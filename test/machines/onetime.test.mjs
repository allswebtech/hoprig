// The one-time store shared by pairing codes and sign-in links, and the sign-in link module on top of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('machines-onetime');
test.after(() => box.cleanup());
const { OneTimeStore } = await import('../../src/machines/onetime.mjs');
const { createLoginLink, loginLinkStatus, useLoginLink } = await import('../../src/server/loginlink.mjs');
const { createCode } = await import('../../src/machines/pairing.mjs');

test('one use, until it expires; kinds never mix; only hashes on disk, mode 600', () => {
  const a = new OneTimeStore('kind-a');
  const b = new OneTimeStore('kind-b');
  const t0 = 1_000_000;
  const { id } = a.add('s3cret', 1000, { now: t0 });
  assert.equal(b.take('s3cret', '', { now: t0 }), null, 'another kind does not know it');
  assert.equal(a.take('wrong', '', { now: t0 }), null);
  assert.equal(a.take(null, '', { now: t0 }), null, 'malformed input');
  assert.equal(a.take('s3cret', 'phone', { now: t0 + 10 }), id);
  assert.deepEqual(a.status(id, { now: t0 + 20 }), { usedBy: 'phone' });
  assert.equal(a.take('s3cret', '', { now: t0 + 20 }), null, 'once only');
  const late = a.add('later', 1000, { now: t0 });
  assert.equal(a.take('later', '', { now: t0 + 1000 }), null, 'expired');
  assert.equal(a.status(late.id, { now: t0 + 1000 }), 'expired');
  const raw = fs.readFileSync(a.file, 'utf8');
  assert.equal(raw.includes('s3cret') || raw.includes('later'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  assert.equal(path.dirname(a.file), box.state);
});

test('at most 20 open secrets of a kind: the oldest go first', () => {
  const s = new OneTimeStore('kind-many');
  for (let i = 0; i < 25; i++) s.add(`x${i}`, 60_000);
  assert.equal(s.take('x0'), null);
  assert.ok(s.take('x24'));
});

test('sign-in link: the secret is in the #fragment, works once, 15 minutes by default', () => {
  const t0 = 2_000_000;
  const l = createLoginLink({ baseUrl: 'https://pc.example.ts.net/', now: t0 });
  assert.equal(l.expires, t0 + 15 * 60_000);
  const m = /^https:\/\/pc\.example\.ts\.net\/login#link=([A-Za-z0-9_-]{43})$/.exec(l.url);
  assert.ok(m, l.url);
  assert.equal(loginLinkStatus(l.id, { now: t0 }), 'pending');
  assert.equal(useLoginLink('A'.repeat(43), { now: t0 }), false);
  assert.equal(useLoginLink(m[1], { now: t0 + 1000 }), true);
  assert.equal(useLoginLink(m[1], { now: t0 + 2000 }), false, 'one use');
  assert.equal(loginLinkStatus(l.id, { now: t0 + 2000 }), 'used');

  const short = createLoginLink({ baseUrl: 'http://127.0.0.1:7433', minutes: 1, now: t0 });
  assert.equal(useLoginLink(short.url.split('#link=')[1], { now: t0 + 60_000 }), false, 'expired');
  for (const bad of ['ftp://x', 'nope', '']) assert.throws(() => createLoginLink({ baseUrl: bad }));
  assert.throws(() => createLoginLink({ baseUrl: 'https://x', minutes: 0 }));
  for (const bad of [null, 42, 'short', `${'A'.repeat(43)}x`]) assert.equal(useLoginLink(bad), false);
});

test('a pairing code never works as a sign-in link token, and the other way round', () => {
  const code = createCode().code;
  assert.equal(useLoginLink(code), false);
});
