// The rooms over a real link: a hub and a made-up second computer (box2, a stand-in dashboard with made-up figures),
// the hub's own token, and box2's requests counted. Then a real dashboard start with three ticks and three Operator
// looks with every switch absent: no request to box2, no new file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { miniDashboard } from '../machines/harness.mjs';

const box = sandbox('operator-rooms-link');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { putMachine, loadMachines } = await import('../../src/machines/store.mjs');
const { roomKeeper, ASK_TIMEOUT_MS } = await import('../../src/operator/rooms.mjs');

const GiB = 1024 ** 3;
const figures = { hoprig: 'health', at: 1, checks: [], versions: {}, load: [14, 12, 10], cpus: 8, memory: { total: 16 * GiB, available: 1 * GiB }, disks: [{ mount: '/', size: 100 * GiB, used: 50 * GiB, avail: 50 * GiB }], own: { working: 3, runs: { running: 1, atOnce: 2 }, holdLeftMs: null } };
let asked = 0;
const box2 = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null }, answers: { '/api/health': figures }, onRequest: (req) => req.url === '/api/health' && asked++ }).listen();
const hub = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null, hub: { probeTimeoutMs: 500, tunnelWaitMs: 1000 } } }).listen();
const { token } = createToken('hub');
putMachine({ name: 'box2', label: 'Box 2', via: 'url', url: box2.base, token, tokenId: null, added: 1 });
let box2Open = true;
test.after(async () => {
  await hub.close();
  if (box2Open) await box2.close();
  box.cleanup();
});

const ask = (name) => hub.machines.hub.health(name, { timeoutMs: ASK_TIMEOUT_MS, waitMs: ASK_TIMEOUT_MS, keep: false });

test('his look reads box2 through the hub\'s own link with its token, and writes nothing on the hub', async () => {
  const before = fs.readFileSync(path.join(box.config, 'machines.json'), 'utf8');
  const k = roomKeeper({ ask });
  const v = await k.look();
  assert.equal(asked, 1);
  const b = v.computers.find((c) => c.name === 'box2');
  assert.equal(b.reached, true);
  assert.equal(b.room, 'full');
  assert.equal(b.why, 'It is full: its load is 1.8 per CPU.');
  assert.ok(b.facts.includes('3 sessions working'));
  assert.equal(fs.readFileSync(path.join(box.config, 'machines.json'), 'utf8'), before, 'no seenAt written by a look of the rooms');
  assert.equal(loadMachines()[0].seenAt, undefined);
});

test('switch on, ten minutes of the test\'s own clock, box2 counted: while it answers, then while it does not', async () => {
  let t = Date.parse('2026-03-02T10:00:00Z');
  const now = () => t;
  const k = roomKeeper({ ask, now, on: () => true });
  asked = 0;
  for (let s = 0; s < 600; s += 5) {
    await k.tick();
    t += 5000;
  }
  const answering = asked;
  assert.equal(answering, 10, 'once a minute while it answers');
  await box2.close();
  box2Open = false;
  let tries = 0;
  const k2 = roomKeeper({ ask: async (n) => { tries++; return ask(n); }, now, on: () => true });
  // Counted from his look, which is the first request it does not answer: then 2 and 4 minutes later (the next is 5
  // minutes after that, past the ten).
  await k2.look();
  for (let s = 5; s < 600; s += 5) {
    t += 5000;
    await k2.tick();
  }
  console.log(`# box2 asked in ten minutes: ${answering} while it answers, ${tries} while it does not`);
  assert.equal(tries, 3, 'asked less often while it does not answer: 2, 4, then 5 minutes apart');
  const v = k2.view().computers.find((c) => c.name === 'box2');
  assert.equal(v.reached, false);
  assert.equal(v.room, 'unknown');
});

/** Every file under `root` → a hash of its content. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

test('a real dashboard start, three ticks and three Operator looks with every switch absent: no request to another computer, no new file of the rooms', { timeout: 60_000 }, async (t) => {
  let other = 0;
  const box3 = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null }, answers: { '/api/health': figures }, onRequest: () => other++ }).listen();
  t.after(() => box3.close());
  const { token: t3 } = createToken('hub3');
  putMachine({ name: 'box3', label: 'Box 3', via: 'url', url: box3.base, token: t3, tokenId: null, added: 1 });
  const { saveConfig } = await import('../../src/config.mjs');
  saveConfig({ claudeBin: path.join(box.root, 'no-claude'), usage: false, server: { backend: 'pty', roots: [box.home] } });
  const { createServer } = await import('../../src/server/server.mjs');
  let offset = 0;
  const app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `rooms-link-${process.pid}`, operator: { now: () => Date.now() + offset }, rooms: { now: () => Date.now() + offset } });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close().catch(() => {}));
  await new Promise((r) => setTimeout(r, 800));
  const before = snapshot(box.root);
  for (let i = 0; i < 3; i++) {
    await app.watcher.tick();
    offset += 5 * 60_000 + 1000;
  }
  const op = app.features.find((f) => f.name === 'operator');
  const [, , listRoute] = op.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/attention'));
  const req = (url) => ({ url, socket: { localPort: app.server.address().port, localAddress: '127.0.0.1' } });
  for (const url of ['/api/operator/attention', '/api/operator/attention', '/api/operator/attention']) {
    const r = await listRoute(req(url));
    const c = r.watched.find((w) => w.source === 'computers');
    assert.ok(c, 'the computers source is watched');
    offset += 15_000;
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(other, 0, 'no request to another computer with every switch absent');
  const after = snapshot(box.root);
  const added = Object.keys(after).filter((k) => !(k in before));
  assert.deepEqual(added.filter((f) => !/^state\/operator\/(looks|dismissed)\.json$/.test(f)), [], `no new file: ${added}`);
  const rooms = app.features.find((f) => f.name === 'rooms');
  assert.equal(rooms.keeper.asked(), 0, 'the keeper asked nobody');
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.config, 'config.json'), 'utf8')).operator?.lookOthers, undefined, 'the switch is absent');
});

test('a linked computer that answers nulls or text for its numbers is "could not be read" over the real link, and is never offered for new work', async (t) => {
  const { elsewhereOf } = await import('../../src/operator/where-hold.mjs');
  const answers = [
    ['load of nulls', { load: [null, null, null] }],
    ['load of empty strings', { load: ['', '', ''] }],
    ['processors as text', { cpus: '64' }],
    ['memory available null', { memory: { total: 16 * GiB, available: null } }],
    ['a disk used empty', { disks: [{ mount: '/', size: 100 * GiB, used: '', avail: 0 }] }],
  ];
  const calm = { ...figures, load: [1, 1, 1], memory: { total: 16 * GiB, available: 8 * GiB }, own: null };
  for (const [name, bad] of answers) {
    const other = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null }, answers: { '/api/health': { ...calm, ...bad } } }).listen();
    t.after(() => other.close());
    const { token: tk } = createToken(`hostile-${answers.findIndex((a) => a[0] === name)}`);
    putMachine({ name: 'boxh', label: 'Box H', via: 'url', url: other.base, token: tk, tokenId: null, added: 1 });
    const k = roomKeeper({ ask, machines: () => [{ name: 'boxh', label: 'Box H' }] });
    const v = (await k.look()).computers.find((c) => c.name === 'boxh');
    assert.equal(v.room, 'unknown', name);
    assert.equal(v.reached, false, `${name}: an answer that cannot be read counts as not reached`);
    assert.equal(v.load1, null, name);
    assert.equal(elsewhereOf({ view: k.view(), computers: ['this', 'boxh'] }).elsewhere, null, `${name}: never offered for new work`);
  }
  // the same answer with numbers: has room, so the test above would see it
  const honest = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null }, answers: { '/api/health': calm } }).listen();
  t.after(() => honest.close());
  const { token: th } = createToken('honest');
  putMachine({ name: 'boxh', label: 'Box H', via: 'url', url: honest.base, token: th, tokenId: null, added: 1 });
  const k = roomKeeper({ ask, machines: () => [{ name: 'boxh', label: 'Box H' }] });
  assert.equal((await k.look()).computers.find((c) => c.name === 'boxh').room, 'free');
});
