// Work tokens, webhooks and their limits as kept (src/work/access.mjs), and where a delivery may go
// (src/work/hookaddr.mjs): a token kept as its hash only, in a file of mode 0600 in the config folder; a Work token is
// never a machine token and back; a revoke takes its webhooks along; addresses on this computer or a private network
// only when marked "on my own network", every address a name resolves to checked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-access');
test.after(() => t.cleanup());
const a = await import('../../src/work/access.mjs');
const { addressKind, checkHookUrl, resolveHook } = await import('../../src/work/hookaddr.mjs');
const machine = await import('../../src/machines/tokens.mjs');

test('a Work token is shown once, kept as its hash only in a 0600 file of the config folder, listed without it', () => {
  const made = a.createWorkToken('Shop script');
  assert.match(made.token, /^hwt_[A-Za-z0-9_-]{43}$/);
  const file = a.accessFile();
  assert.ok(file.startsWith(process.env.HOPRIG_CONFIG_DIR));
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(made.token), false, 'the token itself is never written');
  assert.equal(text.includes(made.token.slice(4)), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const listed = a.listWorkTokens();
  assert.deepEqual(listed.map((x) => x.name), ['Shop script']);
  assert.equal(JSON.stringify(listed).includes('hash'), false);
  assert.equal(a.verifyWorkToken(made.token).id, made.id);
  assert.equal(a.verifyWorkToken(made.token.slice(0, -1) + (made.token.endsWith('A') ? 'B' : 'A')), null);
  assert.throws(() => a.createWorkToken('Shop script'), /named "Shop script" already/);
  assert.throws(() => a.createWorkToken('bad\nname'), /1 to 60/);
  a.revokeWorkToken(made.id);
});

test('a Work token is never a machine token, and a machine token never a Work token', () => {
  const w = a.createWorkToken('Prefix check');
  const m = machine.createToken('box2');
  assert.equal(machine.verifyToken(w.token), null, 'a Work token does not pass as a machine token');
  assert.equal(a.verifyWorkToken(m.token), null, 'a machine token does not pass as a Work token');
  assert.equal(a.verifyWorkToken(`hwt_${m.token.slice(4)}`), null, 'nor with the prefix changed');
  machine.revokeToken(m.id, { log: false });
  a.revokeWorkToken(w.id);
});

test('revoking a token ends it at once, takes its webhooks along, and is said in Activity by its name only', () => {
  const w = a.createWorkToken('Gone soon');
  const { webhook, secret } = a.addWebhook({ token: w.id, url: 'https://hooks.example.com/in', events: ['result'] });
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(a.listWebhooks()).includes(secret), false, 'the list never has the secret');
  assert.equal(webhook.tokenName, 'Gone soon');
  assert.equal(a.workTokenLive(w.id), true);
  assert.deepEqual(a.revokeWorkToken('Gone soon').map((x) => x.id), [w.id]);
  assert.equal(a.workTokenLive(w.id), false);
  assert.equal(a.verifyWorkToken(w.token), null);
  assert.deepEqual(a.listWebhooks(), []);
  const log = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'automation.log'), 'utf8');
  assert.match(log, /The Work token Gone soon was revoked/);
  assert.equal(log.includes(secret) || log.includes(w.token), false);
});

test('a webhook belongs to a token of this computer and names known events; limits are plain whole numbers', () => {
  assert.throws(() => a.addWebhook({ token: 'abcdefabcdef', url: 'https://hooks.example.com/', events: ['done'] }), /choose the Work token/);
  const w = a.createWorkToken('Hooks');
  assert.throws(() => a.addWebhook({ token: w.id, url: 'https://hooks.example.com/', events: ['everything'] }), /choose one or more events/);
  assert.throws(() => a.addWebhook({ token: w.id, url: 'https://hooks.example.com/', events: [] }), /choose one or more events/);
  assert.deepEqual(a.workLimits(), { perMinute: 60, perDay: 100 });
  assert.deepEqual(a.setWorkLimits({ perMinute: 5 }), { perMinute: 5, perDay: 100 });
  assert.throws(() => a.setWorkLimits({ perMinute: 0 }), /whole number/);
  assert.throws(() => a.setWorkLimits({ perHour: 3 }), /not a limit/);
  a.setWorkLimits({ perMinute: 60 });
  a.revokeWorkToken(w.id);
});

test('a config file that does not read is never overwritten', () => {
  fs.writeFileSync(a.accessFile(), '{ not json', { mode: 0o600 });
  assert.equal(a.verifyWorkToken(`hwt_${'A'.repeat(43)}`), null);
  assert.throws(() => a.createWorkToken('After a bad file'), /does not read/);
  assert.equal(fs.readFileSync(a.accessFile(), 'utf8'), '{ not json');
  fs.rmSync(a.accessFile());
});

test('the kind of an address: this computer, a private network, never, or public, also written as IPv6', () => {
  const kinds = {
    '127.0.0.1': 'local', '::1': 'local', '::ffff:127.0.0.1': 'local', '::ffff:7f00:1': 'local',
    '10.1.2.3': 'private', '172.16.0.1': 'private', '172.31.255.1': 'private', '192.168.1.20': 'private', '100.64.0.1': 'private',
    'fc00::1': 'private', 'fd12:3456::1': 'private', '::ffff:10.0.0.1': 'private', '::ffff:192.168.1.1': 'private',
    '0.0.0.0': 'never', '::': 'never', '169.254.169.254': 'never', '::ffff:169.254.169.254': 'never', 'fe80::1': 'never',
    '224.0.0.1': 'never', 'ff02::1': 'never', '255.255.255.255': 'never', '64:ff9b::a00:1': 'private',
    '93.184.216.34': 'public', '2606:2800:220:1::1': 'public', '172.32.0.1': 'public',
    // IPv4-translated, the local NAT64 prefix, documentation and reserved ranges
    '::ffff:0:127.0.0.1': 'local', '::ffff:0:10.1.2.3': 'private', '64:ff9b:1::7f00:1': 'private', '64:ff9b:1:a01:203::': 'private',
    '2001:db8::1': 'never', '3fff::1': 'never', '3fff:fff:ffff::1': 'never', '3fff:1000::1': 'public', '192.0.0.8': 'never', '192.0.2.1': 'never', '198.51.100.1': 'never', '203.0.113.9': 'never', '::ffff:192.0.2.1': 'never',
    '192.0.1.1': 'public', '198.51.101.1': 'public', '203.0.114.1': 'public', '2001:db9::1': 'public',
  };
  for (const [ip, kind] of Object.entries(kinds)) assert.equal(addressKind(ip), kind, ip);
  assert.equal(addressKind('example.com'), null);
});

test('an address as written: https, plain http only to this computer, no credentials, never 0.0.0.0', () => {
  assert.equal(checkHookUrl('https://hooks.example.com/in#x').href, 'https://hooks.example.com/in');
  assert.ok(checkHookUrl('http://127.0.0.1:8075/in'));
  assert.ok(checkHookUrl('http://localhost:8075/in'));
  for (const bad of ['http://hooks.example.com/in', 'ftp://example.com/', 'https://user:pw@hooks.example.com/', 'https://0.0.0.0/', 'http://0.0.0.0:80/', 'https://[fe80::1]/', 'not an address', '']) {
    assert.throws(() => checkHookUrl(bad), (e) => e.status === 400, bad);
  }
});

test('every address a name resolves to is checked; a private one only with "on my own network"', async () => {
  const lookup = (answers) => async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const pub = await resolveHook('https://hooks.example.com/in', { lookup: lookup(['93.184.216.34']) });
  assert.equal(pub.address, '93.184.216.34');
  assert.equal(pub.host, 'hooks.example.com');
  await assert.rejects(resolveHook('https://hooks.example.com/in', { lookup: lookup(['93.184.216.34', '10.0.0.5']) }), /private network/);
  await assert.rejects(resolveHook('https://hooks.example.com/in', { lookup: lookup(['::ffff:127.0.0.1']) }), /private network/);
  await assert.rejects(resolveHook('https://hooks.example.com/in', { ownNetwork: true, lookup: lookup(['169.254.169.254']) }), /never goes/);
  await assert.rejects(resolveHook('https://hooks.example.com/in', { ownNetwork: true, lookup: lookup(['0.0.0.0']) }), /never goes/);
  const own = await resolveHook('https://nas.example.com/in', { ownNetwork: true, lookup: lookup(['192.168.1.20']) });
  assert.equal(own.address, '192.168.1.20');
  await assert.rejects(resolveHook('http://127.0.0.1:8075/in'), /own network/);
  assert.equal((await resolveHook('http://127.0.0.1:8075/in', { ownNetwork: true })).address, '127.0.0.1');
  await assert.rejects(resolveHook('https://nowhere.example.com/', { lookup: async () => { throw new Error('ENOTFOUND'); } }), /could not be found/);
});
