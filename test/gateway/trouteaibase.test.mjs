// The base of TRouteAI's management: the data folder by the gateway's rule, the command token only when it is safe,
// and who listens on a port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandToken, dataFolder, listenerUids, sameUserListener } from '../../src/gateway/trouteaibase.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tbase-'));
const TOKEN = 'ab'.repeat(32);

test('dataFolder follows the gateways rule', () => {
  const home = tmp();
  assert.equal(dataFolder({ DATA_DIR: '/x/y' }, home, 'linux'), '/x/y');
  assert.equal(dataFolder({}, home, 'linux'), path.join(home, '.trouteai'));
  assert.equal(dataFolder({ XDG_CONFIG_HOME: '/cfg' }, home, 'linux'), '/cfg/trouteai');
  fs.mkdirSync(path.join(home, '.trouteai'));
  assert.equal(dataFolder({ XDG_CONFIG_HOME: '/cfg' }, home, 'linux'), path.join(home, '.trouteai'), 'an existing ~/.trouteai wins');
  assert.equal(dataFolder({ DATA_DIR: '  ', XDG_CONFIG_HOME: '/cfg' }, home, 'linux'), path.join(home, '.trouteai'));
  const h2 = tmp();
  assert.equal(dataFolder({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, h2, 'win32'), 'C:\\Users\\a\\AppData\\Roaming\\trouteai');
});

test('commandToken is read only from a safe file', () => {
  const d = tmp();
  assert.equal(commandToken(d), null, 'missing');
  const f = path.join(d, 'cli-token');
  fs.writeFileSync(f, `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(commandToken(d), TOKEN);
  fs.chmodSync(f, 0o644);
  assert.equal(commandToken(d), null, 'readable by others');
  fs.chmodSync(f, 0o600);
  fs.writeFileSync(f, 'not a token');
  assert.equal(commandToken(d), null, 'not a token');
  fs.writeFileSync(f, TOKEN);
  assert.equal(commandToken(d, { uid: (process.getuid?.() ?? 0) + 1 }), process.platform === 'win32' ? TOKEN : null, 'another user');
  fs.rmSync(f);
  fs.symlinkSync(path.join(d, 'elsewhere'), f);
  assert.equal(commandToken(d), null, 'a link');
});

const row = (port, uid, st = '0A', addr = '0100007F') => `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0`;
const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

test('listenerUids reads the uid column of the listeners on the port', () => {
  assert.deepEqual(listenerUids(`${HEAD}\n${row(20017, 1000)}\n${row(20017, 0, '01')}\n${row(80, 5)}`, 20017), [1000]);
});

test('sameUserListener: own, foreign, none, and an owner that cannot be told', async () => {
  const net = (a, b = '') => (f) => (f === '/proc/net/tcp' ? `${HEAD}\n${a}` : `${HEAD}\n${b}`);
  const base = { platform: 'linux', uid: 1000, answers: async () => false };
  assert.equal(await sameUserListener(20017, { ...base, readNet: net(row(20017, 1000)) }), 'own');
  assert.equal(await sameUserListener(20017, { ...base, readNet: net(row(20017, 1000), row(20017, 0, '0A', '00000000000000000000000001000000')) }), 'foreign', 'the IPv6 table counts too');
  assert.equal(await sameUserListener(20017, { ...base, readNet: net(row(20017, 33)) }), 'foreign');
  assert.equal(await sameUserListener(20017, { ...base, readNet: net(row(80, 1000)) }), 'none');
  assert.equal(await sameUserListener(20017, { ...base, readNet: net(row(80, 1000)), answers: async () => true }), 'foreign', 'something answers whose owner is not shown');
  assert.equal(await sameUserListener(0, base), 'foreign');
  assert.equal(await sameUserListener(20017, { ...base, uid: null, readNet: net(row(20017, 1000)) }), 'foreign');
});

test('sameUserListener on macOS reads lsof, and silence while something answers is foreign', async () => {
  const mac = { platform: 'darwin', uid: 501, answers: async () => false };
  assert.equal(await sameUserListener(20017, { ...mac, run: async () => ({ stdout: 'p12\nu501\n' }) }), 'own');
  assert.equal(await sameUserListener(20017, { ...mac, run: async () => ({ stdout: 'p12\nu0\n' }) }), 'foreign');
  assert.equal(await sameUserListener(20017, { ...mac, run: async () => ({ stdout: '' }) }), 'none');
  assert.equal(await sameUserListener(20017, { ...mac, answers: async () => true, run: async () => ({ stdout: '' }) }), 'foreign');
  assert.equal(await sameUserListener(20017, { ...mac, run: async () => { throw new Error('no lsof'); } }), 'foreign');
});
