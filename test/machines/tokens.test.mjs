// Tokens (only their hash is stored; revoke works at once) and pairing codes (10 minutes, one use, constant-time
// compare, rate-limited claims).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('machines-tokens');
test.after(() => box.cleanup());

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const tok = await import('../../src/machines/tokens.mjs');
const pairing = await import('../../src/machines/pairing.mjs');

test('a token is shown once; config.json keeps only its SHA-256', () => {
  const { id, token } = tok.createToken('mac');
  assert.match(token, /^hop_[A-Za-z0-9_-]{43}$/);
  assert.match(id, /^[0-9a-f]{12}$/);
  const raw = fs.readFileSync(path.join(box.config, 'config.json'), 'utf8');
  assert.equal(raw.includes(token), false, 'the token itself is not stored');
  assert.ok(raw.includes(crypto.createHash('sha256').update(token).digest('hex')));
  assert.equal(tok.verifyToken(token).id, id);
  assert.equal(tok.verifyToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(tok.verifyToken('hop_short'), null);
  assert.equal(tok.verifyToken(null), null);
  assert.equal(JSON.stringify(tok.listTokens()).includes('hash'), false, 'the list never shows the hash');
  assert.throws(() => tok.createToken('bad;name'), /name/);
});

test('revoking works at once, by id or by name, and leaves other tokens and settings alone', () => {
  saveConfig({ server: { tokens: [], port: 7999 } });
  const a = tok.createToken('hub-a');
  const b = tok.createToken('hub-b');
  const b2 = tok.createToken('hub-b');
  assert.equal(tok.revokeToken(a.id).length, 1);
  assert.equal(tok.verifyToken(a.token), null);
  assert.ok(tok.verifyToken(b.token));
  assert.deepEqual(tok.revokeToken('hub-b').map((t) => t.id).sort(), [b.id, b2.id].sort());
  assert.equal(tok.verifyToken(b2.token), null);
  assert.deepEqual(tok.revokeToken('nobody'), []);
  assert.equal(loadConfig().server.port, 7999);
});

test('a malformed stored entry is ignored', () => {
  saveConfig({ server: { tokens: [{ id: 'x', name: 'n', hash: 'zz' }, null, 'junk'] } });
  assert.deepEqual(tok.storedTokens(), []);
});

test('last use is written to the state folder, at most every few minutes', () => {
  const { id } = tok.createToken('toucher');
  tok.touchToken(id, { now: 1_000_000 });
  const file = path.join(box.state, 'token-use.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[id], 1_000_000);
  tok.touchToken(id, { now: 1_000_000 + 60_000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[id], 1_000_000, 'not written again within 5 min');
  tok.touchToken(id, { now: 1_000_000 + 6 * 60_000 });
  assert.equal(tok.listTokens().find((t) => t.id === id).lastUsed, 1_000_000 + 6 * 60_000);
});

test('bearer header parsing', () => {
  assert.equal(tok.bearerOf({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(tok.bearerOf({ headers: { authorization: 'bearer abc ' } }), 'abc');
  assert.equal(tok.bearerOf({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(tok.bearerOf({ headers: {} }), null);
});

test('a pairing code works once, for 10 minutes, whatever way it is typed', () => {
  const t0 = 5_000_000;
  const a = pairing.createCode({ now: t0 });
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(a.expires, t0 + 10 * 60_000);
  assert.equal(fs.readFileSync(path.join(box.state, 'pair-codes.json'), 'utf8').includes(a.code.replace('-', '')), false, 'only a hash is stored');
  assert.equal(pairing.claimCode('WRONG234', 'x', { now: t0 }), null);
  assert.equal(pairing.claimCode(` ${a.code.toLowerCase().replace('-', ' ')} `, 'mac', { now: t0 + 1000 }), a.id);
  assert.deepEqual(pairing.codeStatus(a.id, { now: t0 + 2000 }), { claimedBy: 'mac' });
  assert.equal(pairing.claimCode(a.code, 'again', { now: t0 + 2000 }), null, 'one use only');

  const b = pairing.createCode({ now: t0 });
  assert.equal(pairing.codeStatus(b.id, { now: t0 + 1 }), 'pending');
  assert.equal(pairing.claimCode(b.code, 'late', { now: t0 + 10 * 60_000 + 1 }), null, 'expired');
  assert.equal(pairing.codeStatus(b.id, { now: t0 + 10 * 60_000 + 1 }), 'expired');

  const c = pairing.createCode({ now: t0 });
  pairing.cancelCode(c.id);
  assert.equal(pairing.claimCode(c.code, 'x', { now: t0 + 1 }), null, 'cancelled');
  for (const bad of ['', 'ABC', 'IIIIOOOO', '0000-1111', 'x'.repeat(100), null]) assert.equal(pairing.normalizeCode(bad), null, String(bad));
});

test('pairInfo: a token plus where the dashboard listens; a wildcard address is reached on 127.0.0.1', async () => {
  saveConfig({ server: { host: '0.0.0.0', port: 1 } });
  const info = await pairing.pairInfo('the-hub', { createToken: tok.createToken });
  assert.equal(info.hoprig, 'pair');
  assert.equal(info.api, pairing.API_VERSION);
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.port, 1);
  assert.equal(info.running, false);
  assert.ok(tok.verifyToken(info.token));
  assert.equal(tok.listTokens().find((t) => t.id === info.tokenId).name, 'the-hub');
  saveConfig({ server: { host: '100.64.0.5', port: 7433 } });
  assert.deepEqual(pairing.dashboardAddress(), { host: '100.64.0.5', port: 7433 });
  saveConfig({ server: { host: undefined, port: undefined } });
  assert.deepEqual(pairing.dashboardAddress(), { host: '127.0.0.1', port: 7433 });
});
