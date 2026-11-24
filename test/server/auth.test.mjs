import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import {
  COOKIE, RateLimiter, SessionStore, visitorKey, clearCookie, generatePassword, hashPassword, parseCookies, sessionCookie, verifyPassword,
} from '../../src/server/auth.mjs';

const box = sandbox();
test.after(() => box.cleanup());

test('password hash round trip, wrong password, malformed hashes', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('correct horse batterY', h), false);
  assert.equal(await verifyPassword('', h), false);
  for (const bad of [undefined, '', 'plain', 'scrypt$1$2$3', 'bcrypt$1$1$1$a$b', 'scrypt$x$8$1$aa$bb', 'scrypt$1048577000$8$1$aa$bb']) {
    assert.equal(await verifyPassword('x', bad), false, String(bad));
  }
  assert.notEqual(await hashPassword('same'), await hashPassword('same'), 'salted');
  await assert.rejects(hashPassword(''));
});

test('generated passwords are long and random', () => {
  const a = generatePassword();
  assert.equal(a.length, 32);
  assert.notEqual(a, generatePassword());
});

test('session store: create, validate, persist, expire, tag, destroy', () => {
  let now = 1_000_000;
  const file = path.join(box.state, 'sessions.json');
  const s = new SessionStore(file, { now: () => now, days: 30 });
  const t = s.create('tagA');
  assert.equal(s.valid(t, 'tagA'), true);
  assert.equal(s.valid(t, 'tagB'), false, 'a new password (tag) invalidates');
  assert.equal(s.valid('x'.repeat(43), 'tagA'), false);
  assert.equal(s.valid(undefined, 'tagA'), false);
  // the file holds hashes, never the token
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(t), false);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  // survives a restart
  const s2 = new SessionStore(file, { now: () => now });
  assert.equal(s2.valid(t, 'tagA'), true);
  // expires after 30 days
  now += 30 * 24 * 3600 * 1000 + 1;
  assert.equal(s2.valid(t, 'tagA'), false);
  // destroy
  now = 1_000_000;
  const s3 = new SessionStore(file, { now: () => now });
  const t3 = s3.create('');
  s3.destroy(t3);
  assert.equal(s3.valid(t3, ''), false);
});

test('rate limiter: per IP, global, window, success resets the IP', () => {
  let now = 0;
  const r = new RateLimiter({ perIp: 5, global: 8, windowMs: 1000, now: () => now });
  for (let i = 0; i < 5; i++) {
    assert.equal(r.retryAfter('a'), 0);
    r.fail('a');
  }
  assert.ok(r.retryAfter('a') > 0, 'sixth try from a is blocked');
  assert.equal(r.retryAfter('b'), 0, 'b is not blocked yet');
  r.fail('b'); r.fail('b'); r.fail('c');
  assert.ok(r.retryAfter('d') > 0, 'global cap reached');
  now = 1001;
  assert.equal(r.retryAfter('a'), 0, 'window passed');
  r.fail('e');
  r.succeed('e');
  assert.equal(r.retryAfter('e'), 0);
  // A good login gives back the try that was counted for it, for the address and for the overall count.
  const g = new RateLimiter({ perIp: 2, global: 3, now: () => 0 });
  g.fail('x'); g.fail('y');
  g.fail('z'); g.succeed('z');
  assert.equal(g.retryAfter('w'), 0, 'two failures and one good login do not reach the overall cap of 3');
  g.fail('w');
  assert.ok(g.retryAfter('v') > 0, 'the third failure does');
  // A try that leaves the overall cap out: it is neither stopped by it nor counted in it; its address still counts.
  assert.equal(g.retryAfter('owner', { overall: false }), 0, 'the overall cap does not lock this try out');
  const o = new RateLimiter({ perIp: 2, global: 2, now: () => 0 });
  o.fail('p', { overall: false }); o.fail('q', { overall: false });
  assert.equal(o.retryAfter('r'), 0, 'not counted overall');
  assert.ok(o.retryAfter('p', { overall: false }) === 0 && (o.fail('p', { overall: false }), o.retryAfter('p', { overall: false }) > 0), 'its own address is limited');
  o.fail('s'); o.fail('t');
  o.succeed('u', { overall: false });
  assert.ok(o.retryAfter('v') > 0, 'a success that was not counted overall takes nothing back from it');
});

test('a visitor is counted by its IPv4 address, or by the /64 of its IPv6 one', () => {
  assert.equal(visitorKey('198.51.100.7'), '198.51.100.7');
  assert.equal(visitorKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(visitorKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(visitorKey('2001:DB8:0001:0002::9'), '2001:db8:1:2::/64');
  assert.equal(visitorKey('[2001:db8:1:2:ffff::1]'), '2001:db8:1:2::/64');
  assert.notEqual(visitorKey('2001:db8:1:3::1'), visitorKey('2001:db8:1:2::1'));
  assert.equal(visitorKey('unknown'), 'unknown');
  const r = new RateLimiter({ perIp: 2, global: 100, now: () => 0 });
  r.fail('2001:db8:1:2::1'); r.fail('2001:db8:1:2::2');
  assert.ok(r.retryAfter('2001:db8:1:2:9::9') > 0, 'one /64 is one visitor');
  assert.equal(r.retryAfter('2001:db8:1:3::1'), 0);
});

test('cookies', () => {
  assert.deepEqual(parseCookies('a=1; sid=xyz; a=2'), { a: '1', sid: 'xyz' });
  assert.deepEqual(parseCookies(undefined), {});
  const c = sessionCookie('tok', { secure: false });
  assert.match(c, new RegExp(`^${COOKIE}=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000$`));
  assert.match(sessionCookie('tok', { secure: true }), /; Secure$/);
  assert.match(clearCookie(false), /Max-Age=0/);
});

test('session store: the host names a session is used on are kept (no port), for a plain link that avoids them', () => {
  const file = path.join(box.state, 'sessions-hosts.json');
  const s = new SessionStore(file);
  const t = s.create('tag');
  assert.deepEqual(s.hosts('tag'), [], 'none until it is used');
  assert.equal(s.valid(t, 'tag', '127.0.0.1:7433'), true);
  assert.equal(s.valid(t, 'tag', '127.0.0.1:8190'), true);
  assert.equal(s.valid(t, 'tag', 'LOCALHOST:7433'), true);
  assert.deepEqual(s.hosts('tag'), ['127.0.0.1', 'localhost']);
  assert.deepEqual(s.hosts('other'), [], 'only sessions of the current password');
  assert.deepEqual(new SessionStore(file).hosts('tag'), ['127.0.0.1', 'localhost'], 'kept across a restart');
  assert.equal(fs.readFileSync(file, 'utf8').includes(t), false, 'still only hashes in the file');
  assert.equal(s.valid('x'.repeat(43), 'tag', 'evil.example'), false);
  assert.ok(!s.hosts('tag').includes('evil.example'), 'a wrong token adds nothing');
});
