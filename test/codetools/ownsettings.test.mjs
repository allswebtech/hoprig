// An address in Claude Code's own settings file wins over every profile: doctor names it, the Providers page shows
// the exact lines and takes them out on the owner's press (a backup first), or makes that gateway a provider; the
// chat's "did not answer" names the cause. A made-up home: CLAUDE_CONFIG_DIR is a temporary folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('ownsettings');
test.after(() => box.cleanup());
const O = await import('../../src/codetools/ownsettings.mjs');
const { ownEndpointCheck } = await import('../../src/setup/checks.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { readProfile, listProfiles } = await import('../../src/profiles.mjs');
const { accountsFeature } = await import('../../src/server/accounts.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const KEY = 'sk-gw-' + 'k'.repeat(40);
const FILE = path.join(box.claude, 'settings.json');
const settings = (env, indent = 4) => `${JSON.stringify({ model: 'opus', env, permissions: { allow: ['Bash(ls)'] } }, null, indent)}\n`;
const backups = () => fs.readdirSync(box.claude).filter((n) => n.startsWith('settings.json.hoprig-backup-'));
const clearBackups = () => backups().forEach((n) => fs.rmSync(path.join(box.claude, n)));

test('read: host and port and the variable names only, never the key; nothing when no address', () => {
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271/v1', ANTHROPIC_AUTH_TOKEN: KEY, KEEP: 'x' }));
  const o = O.ownEndpoint(box.claude);
  assert.equal(o.where, '127.0.0.1:8271');
  assert.equal(o.local, true);
  assert.deepEqual(o.vars, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
  assert.deepEqual(o.lines, ['"ANTHROPIC_BASE_URL": "http://127.0.0.1:8271/(path, not shown)"', '"ANTHROPIC_AUTH_TOKEN": "(a key, not shown)"']);
  assert.doesNotMatch(JSON.stringify(o), new RegExp(KEY));
  assert.equal(O.ownEndpointWords(o), "Claude Code's own settings send every session to a gateway on this computer (127.0.0.1:8271); your providers cannot change that");
  assert.equal(O.hostPort('https://user:pw@gw.example.com/path'), 'gw.example.com:443', 'no sign-in part, no path');
  fs.writeFileSync(FILE, settings({ KEEP: 'x' }));
  assert.equal(O.ownEndpoint(box.claude), null);
  fs.writeFileSync(FILE, '{ "env": { "ANTHROPIC_BASE_URL": "http://x" }, }');
  assert.equal(O.ownEndpoint(box.claude), null, 'not JSON: not read');
});

test('the shown line never holds a user, a password, a path or a query of the address', async () => {
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://gw-user:gw-pass@127.0.0.1:8271/k/SECRETPATH?t=QSECRET', ANTHROPIC_AUTH_TOKEN: KEY }));
  const o = O.ownEndpoint(box.claude);
  assert.equal(o.lines[0], '"ANTHROPIC_BASE_URL": "http://(user and password, not shown)@127.0.0.1:8271/(path, not shown)"');
  for (const secret of ['gw-user', 'gw-pass', 'SECRETPATH', 'QSECRET', KEY]) assert.doesNotMatch(JSON.stringify(o), new RegExp(secret));
  assert.equal(O.shownAddress('https://gw.example.com'), 'https://gw.example.com');
  assert.equal(O.shownAddress('not a url'), '(an address that is not a web address, not shown)');
  fs.writeFileSync(FILE, settings({}));
});

test('the gateway\'s models and headers go out with the address, shown (headers hidden); a key of another type too', () => {
  clearBackups();
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: 5, ANTHROPIC_MODEL: 'gw-big', ANTHROPIC_SMALL_FAST_MODEL: 'gw-small', ANTHROPIC_CUSTOM_HEADERS: 'x-key: HSECRET', KEEP: 'x' }));
  const o = O.ownEndpoint(box.claude);
  assert.deepEqual(o.vars, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS']);
  assert.ok(o.lines.includes('"ANTHROPIC_MODEL": "gw-big"'));
  assert.ok(o.lines.includes('"ANTHROPIC_CUSTOM_HEADERS": "(headers, not shown)"'));
  assert.doesNotMatch(JSON.stringify(o), /HSECRET/);
  assert.equal(o.hasKey, true);
  const r = O.removeOwnEndpoint({ dir: box.claude, stamp: o.stamp });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).env, { KEEP: 'x' });
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'gw-big', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw-small' }));
  const sec = O.ownGatewaySecret(box.claude);
  assert.equal(sec.model, 'gw-big');
  assert.equal(sec.smallModel, 'gw-small');
  fs.writeFileSync(FILE, settings({}));
});

test('a settings file bigger than the limit is not read at all', () => {
  const big = settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY, PAD: 'x'.repeat(O.MAX_BYTES) });
  fs.writeFileSync(FILE, big);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...a) => (String(a[0]) === FILE && reads++, read(...a));
  try {
    assert.equal(O.ownEndpoint(box.claude), null);
    assert.equal(O.ownGatewaySecret(box.claude), null);
  } finally {
    fs.readFileSync = read;
  }
  assert.equal(reads, 0, 'not read');
  fs.writeFileSync(FILE, settings({}));
});

test('a BOM in front is read through; a file that does not parse but names the address gets a doctor line', () => {
  clearBackups();
  const text = '\ufeff' + settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY, KEEP: 'x' });
  fs.writeFileSync(FILE, text);
  const o = O.ownEndpoint(box.claude);
  assert.equal(o?.where, '127.0.0.1:8271');
  assert.equal(O.ownGatewaySecret(box.claude)?.key, KEY);
  const r = O.removeOwnEndpoint({ dir: box.claude, stamp: o.stamp });
  assert.equal(r.ok, true, r.why);
  assert.equal(fs.readFileSync(FILE, 'utf8'), '\ufeff' + settings({ KEEP: 'x' }), 'the BOM stays, the rest as it was');
  fs.writeFileSync(FILE, '{\n  // mine\n  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8271", },\n}\n');
  assert.equal(O.ownEndpoint(box.claude), null);
  const c = ownEndpointCheck(box.claude);
  assert.equal(c?.status, 'warn');
  assert.match(c.detail, /names ANTHROPIC_BASE_URL but could not be read as JSON/);
  fs.writeFileSync(FILE, '{ "note": "no address", }');
  assert.equal(ownEndpointCheck(box.claude), null, 'not JSON, but no address named: nothing to say');
  fs.writeFileSync(FILE, settings({}));
});

test('doctor names it with where to change it, host and port only', async () => {
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY }));
  const c = ownEndpointCheck(box.claude);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /send every session to a gateway on this computer \(127\.0\.0\.1:8271\); your providers cannot change that/);
  assert.match(c.fix, /^On the dashboard's Providers page, press "Take the address out"/, 'the page press first');
  const { shownPath } = await import('../../src/setup/checks.mjs');
  assert.equal(shownPath('C:\\Users\\alex\\.claude\\settings.json', 'win32', 'C:\\Users\\alex'), '%USERPROFILE%\\.claude\\settings.json', 'a path Explorer opens, not ~\\');
  assert.equal(shownPath('D:\\other\\settings.json', 'win32', 'C:\\Users\\alex'), 'D:\\other\\settings.json');
  assert.doesNotMatch(JSON.stringify(c), new RegExp(KEY));
  fs.writeFileSync(FILE, settings({}));
  assert.equal(ownEndpointCheck(box.claude), null);
});

test('remove: what was shown and nothing else, the backup first and whole, the indentation kept', () => {
  clearBackups();
  const before = settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_API_KEY: KEY, KEEP: 'x' });
  fs.writeFileSync(FILE, before);
  fs.chmodSync(FILE, 0o600);
  const { stamp } = O.ownEndpoint(box.claude);
  const r = O.removeOwnEndpoint({ dir: box.claude, stamp });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.removed, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']);
  assert.equal(fs.readFileSync(r.backup, 'utf8'), before, 'the whole file, as it was');
  assert.equal(fs.statSync(r.backup).mode & 0o777, 0o600);
  assert.doesNotMatch(path.basename(r.backup), new RegExp(KEY));
  assert.equal(fs.readFileSync(FILE, 'utf8'), settings({ KEEP: 'x' }), 'the rest as it was, four spaces');
});

test('remove refuses, changing nothing: a file changed since it was shown, not JSON, a link', () => {
  clearBackups();
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271' }));
  const { stamp } = O.ownEndpoint(box.claude);
  const changed = settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8272' });
  fs.writeFileSync(FILE, changed);
  assert.match(O.removeOwnEndpoint({ dir: box.claude, stamp }).why, /changed since it was shown/);
  assert.equal(fs.readFileSync(FILE, 'utf8'), changed);
  const bad = '{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8271" }, // mine\n}';
  fs.writeFileSync(FILE, bad);
  assert.equal(O.removeOwnEndpoint({ dir: box.claude, stamp: 'x' }).ok, false);
  assert.equal(fs.readFileSync(FILE, 'utf8'), bad);
  fs.rmSync(FILE);
  const real = path.join(box.root, 'real-settings.json');
  fs.writeFileSync(real, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271' }));
  fs.symlinkSync(real, FILE);
  const o = O.ownEndpoint(box.claude);
  assert.match(O.removeOwnEndpoint({ dir: box.claude, stamp: o.stamp }).why, /is a link/);
  fs.rmSync(FILE);
  assert.deepEqual(backups(), [], 'no backup of a refused press');
});

test('remove keeps every other byte: big numbers, escapes, duplicate keys and the layout; the backup is the very file', () => {
  clearBackups();
  const before = '{\n  "big": 12345678901234567890,\n  "name": "\\u00e9",\n  "dup": 1,\n  "dup": 2,\n  "env": {\n    "KEEP": "x",\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8271",\n    "ANTHROPIC_AUTH_TOKEN": "' + KEY + '"\n  },\n  "after": [1, 2]\n}\n';
  fs.writeFileSync(FILE, before);
  const r = O.removeOwnEndpoint({ dir: box.claude, stamp: O.ownEndpoint(box.claude).stamp });
  assert.equal(r.ok, true, r.why);
  assert.equal(fs.readFileSync(FILE, 'utf8'), '{\n  "big": 12345678901234567890,\n  "name": "\\u00e9",\n  "dup": 1,\n  "dup": 2,\n  "env": {\n    "KEEP": "x"\n  },\n  "after": [1, 2]\n}\n');
  assert.ok(fs.readFileSync(r.backup).equals(Buffer.from(before)), 'the backup is byte for byte the file');
  // A byte that is not UTF-8: refused, nothing written.
  clearBackups();
  const odd = Buffer.concat([Buffer.from('{"note": "'), Buffer.from([0xff]), Buffer.from('", "env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:8271"}}')]);
  fs.writeFileSync(FILE, odd);
  const o = O.ownEndpoint(box.claude);
  assert.match(O.removeOwnEndpoint({ dir: box.claude, stamp: o.stamp }).why, /not plain UTF-8/);
  assert.ok(fs.readFileSync(FILE).equals(odd));
  // A second name of the file (a hard link): the other name would keep the address. Refused.
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271' }));
  const other = path.join(box.root, 'other-name.json');
  fs.linkSync(FILE, other);
  try {
    assert.match(O.removeOwnEndpoint({ dir: box.claude, stamp: O.ownEndpoint(box.claude).stamp }).why, /hard link/);
  } finally {
    fs.rmSync(other);
  }
  assert.deepEqual(backups(), [], 'no backup of a refused press');
});

test('remove refuses a Claude folder that is a link, and a read-only file; nothing written, no backup', () => {
  // The folder is a link to another one (a dotfiles repository): neither the file nor a backup is written there.
  const realDir = path.join(box.root, 'dotfiles-claude');
  const linked = path.join(box.root, 'linked-claude');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linked);
  const text = settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY });
  fs.writeFileSync(path.join(realDir, 'settings.json'), text);
  const o = O.ownEndpoint(linked);
  assert.match(O.removeOwnEndpoint({ dir: linked, stamp: o.stamp }).why, /is a link to another folder/);
  assert.equal(fs.readFileSync(path.join(realDir, 'settings.json'), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(realDir), ['settings.json'], 'no backup in the link\'s target');
  // Read-only: refused.
  clearBackups();
  fs.writeFileSync(FILE, text);
  fs.chmodSync(FILE, 0o400);
  try {
    assert.match(O.removeOwnEndpoint({ dir: box.claude, stamp: O.ownEndpoint(box.claude).stamp }).why, /is read-only: nothing was changed/);
    assert.equal(fs.readFileSync(FILE, 'utf8'), text);
    assert.deepEqual(backups(), []);
  } finally {
    fs.chmodSync(FILE, 0o600);
  }
});

test('the chat: "did not answer" becomes the cause when nothing answers at the settings file\'s address', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }));
  assert.equal(await O.retryCause(box.claude), `Claude Code's own settings send it to 127.0.0.1:${port}, and nothing answers there. Start that gateway, or take the address out on the Providers page.`);
  const { Chat } = await import('../../src/chat/chat.mjs');
  const { hear } = await import('../../src/chat/hear.mjs');
  const c = new Chat({ id: '6f1d2c3b-4a5e-4f6a-8b7c-9d0e1f2a3b40', engine: 'claude', cwd: box.home, profile: 'sub' });
  const said = [];
  c.push = (x) => said.push(x);
  hear(c, { kind: 'status', state: 'retrying', retry: { attempt: 1, error: 'unknown' } });
  for (let i = 0; i < 50 && !said.length; i++) await new Promise((r) => setTimeout(r, 40));
  assert.match(said[0]?.text || '', new RegExp(`send it to 127\\.0\\.0\\.1:${port}, and nothing answers there`));
  assert.doesNotMatch(said[0].text, /\(unknown\)/);
  fs.writeFileSync(FILE, settings({}));
});

test('Providers: the page is told, the owner\'s press takes it out or takes it over; the key is never in an answer', async () => {
  clearBackups();
  saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8273', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'gw-big' }, 2));
  const app = createServer({ backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const texts = [];
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (p, body, headers = {}) => {
      const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      texts.push(text);
      return { status: r.status, json: JSON.parse(text || '{}') };
    };
    let r = await call('/api/accounts');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const o = r.json.ownEndpoint;
    assert.equal(o.where, '127.0.0.1:8273');
    assert.equal(o.hasKey, true);
    assert.match(o.words, /your providers cannot change that/);
    assert.equal((await call('/api/accounts/own-endpoint/remove', { stamp: o.stamp }, { Origin: 'https://other.example' })).status, 403, 'another site');
    assert.equal((await call('/api/accounts/own-endpoint/remove', { stamp: 'old' })).status, 409);
    r = await call('/api/accounts/own-endpoint/takeover', { stamp: o.stamp });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = readProfile(r.json.name);
    assert.equal(p.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8273');
    assert.equal(p.env.ANTHROPIC_AUTH_TOKEN, KEY, 'kept where profiles keep keys');
    assert.equal(p.env.ANTHROPIC_MODEL, 'gw-big', 'the model it worked with');
    assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).env.ANTHROPIC_MODEL, undefined, 'out of the file with the address');
    assert.equal(fs.statSync(path.join(box.profiles, `${r.json.name}.env`)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).env.ANTHROPIC_BASE_URL, undefined);
    const backupOf = r.json.backup;
    assert.equal(fs.readFileSync(r.json.backup, 'utf8'), settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8273', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: 'gw-big' }, 2));
    r = await call('/api/accounts');
    assert.equal(r.json.ownEndpoint, null);
    assert.equal(r.json.ownBackup.name, path.basename(backupOf), 'the page is told where the copy is');
    r = await call('/api/accounts/own-endpoint/restore', { name: r.json.ownBackup.name, stamp: r.json.ownBackup.stamp });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await call('/api/accounts')).json.ownEndpoint.where, '127.0.0.1:8273', 'put back');
    for (const t of texts) assert.doesNotMatch(t, new RegExp(KEY), 'the key in an answer');
  } finally {
    await app.close();
  }
});

test('after a press the copy is named (never its content) and put back on one press; the file as it was then is kept', () => {
  clearBackups();
  const before = settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8271', ANTHROPIC_AUTH_TOKEN: KEY, KEEP: 'x' });
  fs.writeFileSync(FILE, before);
  assert.equal(O.lastBackup(box.claude), null, 'nothing pressed yet');
  const r = O.removeOwnEndpoint({ dir: box.claude, stamp: O.ownEndpoint(box.claude).stamp });
  assert.equal(r.ok, true, r.why);
  const b = O.lastBackup(box.claude);
  assert.equal(b.name, path.basename(r.backup));
  assert.equal(b.folder, path.resolve(box.claude));
  assert.doesNotMatch(JSON.stringify(b), new RegExp(KEY), 'the key is never in it');
  assert.equal(O.lastBackup(box.claude, Date.now() + O.BACKUP_SHOWN_MS + 60_000), null, 'shown for two weeks');
  assert.match(O.restoreBackup({ dir: box.claude, name: '../settings.json', stamp: b.stamp }).why, /not a backup Hoprig made/);
  assert.match(O.restoreBackup({ dir: box.claude, name: b.name, stamp: 'old' }).why, /changed since it was shown/);
  const after = fs.readFileSync(FILE, 'utf8');
  const back = O.restoreBackup({ dir: box.claude, name: b.name, stamp: b.stamp });
  assert.equal(back.ok, true, back.why);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before, 'the file as it was before the press');
  assert.equal(fs.readFileSync(back.kept, 'utf8'), after, 'the file as it was just now, kept beside it');
  assert.equal(O.lastBackup(box.claude), null, 'the address decides again: no way back to show');
  for (const n of fs.readdirSync(box.claude)) if (n.includes('hoprig-')) fs.rmSync(path.join(box.claude, n));
  fs.writeFileSync(FILE, settings({}));
});

test('only the owner\'s own page may press: another computer\'s token and Tia are refused, nothing changes', async () => {
  fs.writeFileSync(FILE, settings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8274', ANTHROPIC_AUTH_TOKEN: KEY }));
  const { stamp } = O.ownEndpoint(box.claude);
  const before = listProfiles().map((p) => p.name);
  for (const who of ['computer', 'self']) {
    const f = accountsFeature({ caller: () => who, readJson: async () => ({ stamp }), clientIp: () => '127.0.0.1' }, { gateways: [] });
    for (const way of ['remove', 'takeover', 'restore']) {
      const route = f.routes.find(([m, re]) => m === 'POST' && re.test(`/api/accounts/own-endpoint/${way}`));
      await assert.rejects(route[2]({}, []), (e) => e.status === 403 || /Only you/.test(e.message));
    }
  }
  assert.ok(O.ownEndpoint(box.claude), 'the file is as it was');
  assert.deepEqual(listProfiles().map((p) => p.name), before);
});
