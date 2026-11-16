// The desktop's system apps for another computer: a real dashboard (its system programs are stand-ins) reached
// through a hub with a machine token over plain http, the way a page opened for that computer calls it
// (/m/<computer>/api/…). The token reaches the routes; the computer's password is refused on this plain leg by the
// hub and by the computer itself, so sudo never sees it; a change the hub makes is written in the computer's
// Activity log, with no name of a service or process in it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { saveConfig } from '../../src/config.mjs';
import { asBrowser, miniDashboard } from '../machines/harness.mjs';
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
saveConfig({ server: { passwordHash: await hashPassword('owner-login'), host: '127.0.0.1', port: 1 } });
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
