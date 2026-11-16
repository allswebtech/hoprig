// The desktop's system apps for another computer: a real dashboard (its system programs are stand-ins) reached
// through a hub with a machine token over plain http, the way a page opened for that computer calls it
// (/m/<computer>/api/…). The token reaches the routes; the computer's password is refused on this plain leg by the
// hub and by the computer itself, so sudo never sees it; a change the hub makes is written in the computer's
// Activity log, with no name of a service or process in it. Files works the same way: its upload crosses the hub as
// raw bytes (the hub's one rule for raw bodies), and its changes are logged without a name of a file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { saveConfig } from '../../src/config.mjs';
import { COOKIE, asBrowser, miniDashboard } from '../machines/harness.mjs';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('desktop-relay');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const PASSWORD = 'Sudo pw 7#relay';
const sudoSaw = [];
const ran = [];
const desktop = {
  platform: 'linux',
  root: false,
  adminNeeded: async () => true,
  readFile: () => null,
  run: async (cmd, args) => {
    ran.push([cmd, ...args]);
    if (cmd === 'ps') return { ok: true, stdout: '  4242     1  1000 dev   2048   60 node build.js\n' };
    if (cmd === 'systemctl' && args.includes('list-units')) return { ok: true, stdout: 'cron.service loaded active running Cron\n' };
    if (cmd === 'systemctl') return { ok: true, stdout: '' };
    return { ok: false, stdout: '', stderr: 'not here' };
  },
  stream: async (argv, o = {}) => {
    sudoSaw.push(String(o.input || ''));
    return { ok: true, code: 0, output: '' };
  },
};
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
const home = fs.realpathSync(box.home);
fs.mkdirSync(path.join(home, 'notes'));
fs.writeFileSync(path.join(home, 'notes', 'todo.txt'), 'buy milk\n');
saveConfig({ server: { passwordHash: await hashPassword('owner-login'), host: '127.0.0.1', port: 1, roots: [home] } });
const app = createServer({ backend, watch: false, machines: { claudeVersion: async () => null }, desktop });
const me = await app.listen(0, '127.0.0.1');
const hub = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null, relayIdleMs: 5000, hub: { probeTimeoutMs: 1500, hubName: 'the-hub' } } }).listen();
const browser = asBrowser(hub.base);
const tok = createToken('the-hub');
putMachine({ name: 'pc', label: 'PC', via: 'url', url: `http://127.0.0.1:${me.port}`, token: tok.token, tokenId: tok.id });

test.after(async () => {
  await hub.close();
  await app.close();
  box.cleanup();
});

const activity = () => {
  try {
    return fs.readFileSync(path.join(box.state, 'automation.log'), 'utf8');
  } catch {
    return '';
  }
};

test('the Task manager and Services of another computer answer through the hub', async () => {
  const p = await browser('/m/pc/api/system/processes');
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.processes.map((x) => [x.pid, x.name]), [[4242, 'node']]);
  const s = await browser('/m/pc/api/services?scope=system');
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.json.services.map((x) => x.name), ['cron.service']);
  const bad = await browser('/m/pc/api/logs?unit=--all');
  assert.equal(bad.status, 400, 'checked on the computer, also for a hub');
});

test('a user service changed by the hub: done, and written in that computer\'s Activity log without its name', async () => {
  const r = await browser('/m/pc/api/services/action', { body: { scope: 'user', name: 'cron.service', action: 'restart' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ran.at(-1), ['systemctl', '--user', 'restart', '--', 'cron.service']);
  const log = activity();
  assert.match(log, /The hub the-hub started, stopped or restarted a service/);
  assert.doesNotMatch(log, /cron/);
});

test('the computer\'s password never crosses a plain leg: the question says so, the hub refuses it, sudo never sees it', async () => {
  const before = activity();
  const body = { scope: 'system', name: 'cron.service', action: 'restart' };
  const ask = await browser('/m/pc/api/services/action', { body });
  assert.deepEqual(ask.json, { needsPassword: true, plainLeg: true });
  const sent = await browser('/m/pc/api/services/action', { body: { ...body, password: PASSWORD } });
  assert.equal(sent.status, 403, sent.text);
  assert.equal(sent.json.code, 'plain-leg');
  assert.deepEqual(sudoSaw, [], 'sudo got nothing');
  assert.equal(activity(), before, 'a question is not a change');
  // The computer refuses on its own too, for a hub that does not check (straight to it with the token).
  const direct = await fetch(`http://127.0.0.1:${me.port}/api/services/action`, { method: 'POST', headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, password: PASSWORD }) });
  assert.deepEqual(await direct.json(), { needsPassword: true, plainLeg: true });
  assert.deepEqual(sudoSaw, []);
});

test('Files of another computer through the hub: list, upload as raw bytes, download as a download, a refusal, and changes logged without names', async () => {
  const q = (o) => new URLSearchParams(o).toString();
  const list = await browser(`/m/pc/api/files/list?${q({ path: path.join(home, 'notes') })}`);
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.entries.map((e) => e.name), ['todo.txt']);
  // Bytes that are not JSON and not text reach the computer unchanged.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7b, 0x22]);
  const up = await browser(`/m/pc/api/files/upload?${q({ dir: path.join(home, 'notes'), name: 'pic.bin' })}`, { raw: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(fs.readFileSync(path.join(home, 'notes', 'pic.bin')), bytes);
  const down = await fetch(`${hub.base}/m/pc/api/files/raw?${q({ path: path.join(home, 'notes', 'pic.bin'), download: '1' })}`, { headers: { Origin: hub.base, Cookie: COOKIE } });
  assert.equal(down.status, 200);
  assert.match(down.headers.get('content-disposition') || '', /^attachment/);
  assert.equal(down.headers.get('content-security-policy'), "sandbox; default-src 'none'", 'the hub keeps the sandbox on a file it relays');
  assert.equal(down.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await down.arrayBuffer()), bytes);
  // The reach holds on the computer: a folder outside it is refused through the hub too.
  assert.equal((await browser(`/m/pc/api/files/list?${q({ path: '/etc' })}`)).status, 403);
  const moved = await browser('/m/pc/api/files/rename', { body: { path: path.join(home, 'notes', 'todo.txt'), name: 'groceries.txt' } });
  assert.equal(moved.status, 200, moved.text);
  assert.ok(fs.existsSync(path.join(home, 'notes', 'groceries.txt')));
  const log = activity();
  assert.match(log, /The hub the-hub uploaded a file in Files/);
  assert.match(log, /The hub the-hub renamed a file or folder in Files/);
  assert.doesNotMatch(log, /pic\.bin|todo|groceries|notes/);
});
