// The first start with the one switch (linkswitch.mjs migrate): an older version could run a detached Temporary
// tunnel and the Custom address at once. Read once: Custom set up and running wins, else a running Temporary one,
// else off; the old settings are put back exactly, the old tunnel ends, and a token that opened it still owns it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-linkmigrate-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
const S = await import('../../src/addons/linkswitch.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const raw = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'config.json'), 'utf8'));
const addons = path.join(tmp, 'state', 'addons');
const QUICK = 'https://stem-wonder-lucky-hung.trycloudflare.com';
const FIXED = 'https://office.example.com';
const kids = [];
// A stand-in for the old detached tunnel, with its command line (only a process that is one of ours is ended).
const sleeper = (argv = ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7433']) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...argv], { stdio: 'ignore' });
  kids.push(c);
  return c;
};
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
test.after(() => {
  for (const c of kids) c.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fresh(server) {
  fs.rmSync(path.join(tmp, 'config'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'state'), { recursive: true, force: true });
  fs.mkdirSync(path.join(addons, 'fixed-link'), { recursive: true });
  saveConfig({ server });
}
const writeQuick = (o) => fs.writeFileSync(path.join(addons, 'public-link.json'), JSON.stringify(o));
const writeFixed = (o) => fs.writeFileSync(path.join(addons, 'fixed-link', 'fixed.json'), JSON.stringify(o));
const readFixed = () => JSON.parse(fs.readFileSync(path.join(addons, 'fixed-link', 'fixed.json'), 'utf8'));

test('both ran at once: Custom wins, the Temporary tunnel ends, the settings are exactly the owner\'s again', async () => {
  // The owner had no trustProxy and one origin; the Temporary link started first, then the Custom one inherited.
  fresh({ passwordHash: 'scrypt$x', trustProxy: true, allowedOrigins: ['https://deck.example.net', QUICK, FIXED] });
  const q = sleeper();
  writeQuick({ pid: q.pid, url: QUICK, restored: false, restore: { hadTrustProxy: false, hadOrigin: false, origin: QUICK }, openedBy: null });
  writeFixed({ mode: 'named', hostname: 'office.example.com', tunnelId: 'id', extra: [], enabled: true, restored: false, pid: 4242, openedBy: 'tok1', restore: { hadTrustProxy: false, hadOrigin: false, origin: FIXED } });
  assert.deepEqual(S.migrate(), { on: true, kind: 'custom' });
  assert.deepEqual(loadConfig().publicLink, { on: true, kind: 'custom' });
  assert.deepEqual(raw().server, { passwordHash: 'scrypt$x', allowedOrigins: ['https://deck.example.net'] });
  assert.equal(fs.existsSync(path.join(addons, 'public-link.json')), false);
  assert.deepEqual(readFixed(), { mode: 'named', hostname: 'office.example.com', tunnelId: 'id', extra: [] }, 'the set-up stays; its old on/off record goes');
  assert.equal(S.readRecord().openedBy, 'tok1', 'a token that turned it on still owns it');
  for (let i = 0; i < 40 && !gone(q.pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gone(q.pid) || q.signalCode, 'the old detached tunnel was ended');
  assert.equal(S.migrate(), null, 'read once');
});

test('only a Temporary one ran: it stays on as Temporary; nothing ran: off, and Custom stays chosen when it is set up', () => {
  fresh({ trustProxy: false, allowedOrigins: [QUICK] });
  writeQuick({ pid: sleeper().pid, url: QUICK, restored: false, restore: { hadTrustProxy: true, trustProxy: false, hadOrigin: false, origin: QUICK } });
  assert.deepEqual(S.migrate(), { on: true, kind: 'temporary' });
  assert.deepEqual(raw().server, { trustProxy: false }, 'trustProxy as the owner had it, false stays false');

  fresh({});
  writeFixed({ mode: 'token', hostname: 'pc.example.com', tunnelId: 'id', extra: [], enabled: false, restored: true });
  writeQuick({ pid: 999999, url: QUICK, restored: true });
  assert.deepEqual(S.migrate(), { on: false, kind: 'custom' });
  assert.deepEqual(raw().server, {});

});

test('the old tunnel is ended only when its record says it runs AND that number is provably ours', async () => {
  // After a restart of the computer the old number may belong to another program: it is neither on nor ended.
  fresh({});
  const stranger = sleeper(['not', 'cloudflared']);
  writeQuick({ pid: stranger.pid, url: QUICK, restored: false, restore: { hadTrustProxy: false, hadOrigin: false, origin: QUICK } });
  assert.deepEqual(S.migrate(), { on: false, kind: 'temporary' });
  // A signal takes a moment to arrive: look again after it would have.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(gone(stranger.pid), false, 'another program is never ended');
  assert.equal(stranger.exitCode === null && stranger.signalCode === null, true);

  // A record that says the tunnel was stopped (the older version kept it, with the old number): never ended, never on,
  // even when the number now belongs to something that looks like a tunnel.
  fresh({});
  const lookalike = sleeper();
  writeQuick({ pid: lookalike.pid, url: QUICK, restored: true });
  assert.deepEqual(S.migrate(), { on: false, kind: 'temporary' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(gone(lookalike.pid), false, 'a stopped record\'s number is never ended');
  assert.equal(lookalike.signalCode, null);
  assert.equal(S.ours(stranger.pid), false);
  assert.equal(S.ours(lookalike.pid), process.platform === 'linux' || process.platform === 'darwin');
  assert.equal(S.ours(process.pid), false);
  assert.equal(S.ours('12'), false, 'only a number');
});

test('a computer that never used the public link: nothing is written', () => {
  fresh({ port: 7433 });
  assert.equal(S.migrate(), null);
  assert.equal(raw().publicLink, undefined);
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
  writeFixed({ mode: 'named', hostname: 'x.example.com', enabled: true });
  assert.equal(S.migrate(), null, 'a choice made already is never read over');
});
