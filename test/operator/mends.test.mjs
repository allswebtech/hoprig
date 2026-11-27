// The mends: what Hoprig does for itself with no model and no usage. Made-up sources and stand-in acts; nothing here
// restarts, ends or reopens anything real. Each test fails without the lane: the defaults, the rules of cost 'none'
// that do not need Tia, the second try after two minutes, the act functions of mends.mjs and every refusal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

const box = sandbox('operator-mends');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');
const { RULES, RULE_IDS, applyOperatorPatch, readOperator, ruleFor, ruleOn } = await import('../../src/operator/rules.mjs');
const mends = await import('../../src/operator/mends.mjs');
const { detectEnded } = await import('../../src/operator/detect/ended.mjs');
const { detectMachine } = await import('../../src/operator/detect/machine.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const projects = path.join(box.workspace, 'projects');
fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true });
const opDir = path.join(box.state, 'operator');
const lines = () => {
  try {
    return fs.readFileSync(path.join(opDir, 'timeline.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const MIN = 60_000;
const HOUR = 60 * MIN;
const SID = '66666666-6666-4666-8666-666666666666';

// ---- the defaults ----

test('a fresh config: the mends switch is on, every rule that costs nothing is on, every rule that spends usage is off, Tia is off', () => {
  const s = readOperator({});
  assert.equal(s.mends, true);
  assert.equal(s.tia, false);
  assert.equal(s.active, false);
  for (const r of RULES) assert.equal(s.rules[r.id], r.cost === 'none', `${r.id} (${r.cost})`);
  assert.deepEqual(RULES.filter((r) => r.cost === 'none').map((r) => r.id).sort(), ['clean', 'gateway', 'leftover', 'link', 'reopen']);
  assert.deepEqual(RULES.filter((r) => r.cost === 'usage').map((r) => r.id).sort(), ['elsewhere', 'limit']);
  // A rule of cost none tries again after 2 minutes; one that spends usage keeps its 10.
  assert.equal(s.budgets.gateway.waitMinutes, 2);
  assert.equal(s.budgets.limit.waitMinutes, 10);
  assert.deepEqual(s.budgets.clean, { perHour: 1, perDay: 1, waitMinutes: 60 });
  // ruleOn: the mends switch for the first kind, Tia's two switches for the second.
  assert.equal(ruleOn(s, 'gateway'), true);
  assert.equal(ruleOn(s, 'limit'), false);
  const tiaOn = readOperator({ operator: { acts: true, rules: { limit: true } }, assistant: { enabled: true } });
  assert.equal(ruleOn(tiaOn, 'limit'), true);
  assert.equal(ruleOn(readOperator({ operator: { mends: false } }), 'gateway'), false, 'the owner turned the mends off');
  assert.equal(ruleOn(readOperator({ operator: { rules: { gateway: false } } }), 'gateway'), false, 'one rule turned off');
  // Broken settings are the defaults, as before.
  assert.equal(readOperator({ operator: { mends: 'no' } }).mends, true);
  assert.equal(readOperator({ operator: { rules: 'all' } }).rules.gateway, true);
});

test('the mends switch is the owner\'s change, a boolean, kept beside the rest', () => {
  const next = applyOperatorPatch({ operator: { acts: true } }, { mends: false });
  assert.equal(next.mends, false);
  assert.equal(next.acts, true, 'Tia\'s switch is not touched');
  assert.equal(applyOperatorPatch({ operator: { mends: false } }, { acts: true }).mends, false, 'kept when another key changes');
  assert.throws(() => applyOperatorPatch({}, { mends: 'off' }), /mends must be true or false/);
  assert.throws(() => applyOperatorPatch({}, { rules: { nothing: true } }), /there is no rule/);
});

// ---- ruleFor: what each rule may act on ----

const item = (over) => ({ kind: 'provider', class: 'stopped', acts: [{ id: 'restart-gateway' }], recommended: 'restart-gateway', target: { addon: 'gate' }, ...over });

test('ruleFor: a port held by another program, a gateway the owner stopped and one with no restart act are never restarted', () => {
  assert.equal(ruleFor(item({}))?.id, 'gateway');
  assert.equal(ruleFor(item({ acts: [{ id: 'open' }], recommended: 'open', target: { addon: 'gate', foreign: true } })), null, 'no restart act on a taken port');
  assert.equal(ruleFor(item({ target: { addon: 'gate', ownerStopped: true } })), null);
  assert.equal(ruleFor(item({ class: 'info' })), null, 'not started yet');
});

test('ruleFor: reopen only for a session whose tool died with no end of its own; clean only where the item says Hoprig has old files', () => {
  const ended = (over = {}) => ({ kind: 'ended', class: 'info', acts: [{ id: 'reopen' }, { id: 'open' }], recommended: 'reopen', target: { session: 'orders', reopen: true }, ...over });
  assert.equal(ruleFor(ended())?.id, 'reopen');
  assert.equal(ruleFor(ended({ target: { session: 'orders' } })), null, 'no mark: the person ended it');
  assert.equal(ruleFor(ended({ acts: [{ id: 'open' }], recommended: 'open' })), null);
  const full = (over = {}) => ({ kind: 'machine', class: 'machine', acts: [{ id: 'clean' }, { id: 'open' }], recommended: 'clean', target: { clean: true }, ...over });
  assert.equal(ruleFor(full())?.id, 'clean');
  assert.equal(ruleFor(full({ target: {} })), null);
});

// ---- the act functions ----

test('defaultNext: with no order set the limit names the next subscription provider of his list, never a paid or a signed-out one', () => {
  const list = [
    { name: 'plan-a', kind: 'subscription' },
    { name: 'key-x', kind: 'api' },
    { name: 'plan-b', kind: 'subscription', signedIn: false },
    { name: 'plan-c', kind: 'subscription', tools: ['claude'] },
    { name: 'plan-d', kind: 'subscription', limited: { until: NOW + HOUR } },
    { name: 'auto', virtual: true },
    { name: 'plan-e', kind: 'subscription', paid: true },
  ];
  assert.equal(mends.defaultNext('plan-a', list, NOW), 'plan-c');
  assert.equal(mends.defaultNext('plan-c', list, NOW), 'plan-a', 'going round, past the one at its limit');
  assert.equal(mends.defaultNext('plan-a', list.filter((p) => p.name === 'plan-a' || p.kind === 'api'), NOW), null, 'only a paid one left: none is named');
  assert.equal(mends.defaultNext('plan-a', [{ name: 'plan-a' }], NOW), null);
  assert.equal(mends.defaultNext('plan-a', null, NOW), null);
  // A limit that has ended no longer holds a provider back.
  assert.equal(mends.defaultNext('plan-c', [{ name: 'plan-c' }, { name: 'plan-d', limited: { until: NOW - 1 } }], NOW), 'plan-d');
});

test('probeAddress: only an address on this computer is knocked, with no request; any other address, a name, a password or a query is never asked', async () => {
  const knocks = [];
  const knockOf = (v) => async (t, ms) => { knocks.push([t.host, t.port, ms]); return v; };
  const look = async () => assert.fail('no request is ever sent');
  assert.deepEqual(await mends.probeAddress('127.0.0.1:8080', { knockFn: knockOf('closed'), look }), { state: 'closed', status: 0 });
  assert.deepEqual(await mends.probeAddress('http://localhost:8080', { knockFn: knockOf('silent'), look }), { state: 'silent', status: 0 });
  assert.deepEqual(await mends.probeAddress('http://[::1]:9/v1', { knockFn: knockOf('open'), look }), { state: 'answers', status: 0 });
  assert.deepEqual(knocks, [['127.0.0.1', 8080, 1500], ['localhost', 8080, 1500], ['::1', 9, 1500]], 'a short knock, nothing more');
  for (const out of ['gw1.example:8080', 'https://gw1.example/v1', 'http://10.0.0.5:80', 'https://127.0.0.1.example']) {
    assert.deepEqual(await mends.probeAddress(out, { knockFn: () => assert.fail('no knock outside this computer'), look }), { state: 'skipped', status: 0 }, out);
  }
  for (const bad of ['http://user:pw@gw1.example', 'http://gw1.example/?key=abc', 'ftp://gw1.example', 'not an address at all']) {
    assert.deepEqual(await mends.probeAddress(bad, { knockFn: () => assert.fail('no knock'), look: () => assert.fail('no request') }), { state: 'skipped', status: 0 }, bad);
  }
});

test('httpLook: no header of ours, no redirect followed; nothing answering is 0', async () => {
  const seen = [];
  const f = async (url, o) => { seen.push([url, o.redirect, o.headers]); return { status: 503, body: { cancel: async () => {} } }; };
  assert.equal(await mends.httpLook('http://127.0.0.1:1/health', { fetchFn: f }), 503);
  assert.deepEqual(seen, [['http://127.0.0.1:1/health', 'manual', undefined]]);
  assert.equal(await mends.httpLook('http://127.0.0.1:1/health', { fetchFn: async () => { throw new Error('refused'); } }), 0);
});

test('portHolder: the program that listens, by the system\'s own tables; nothing when none', { skip: process.platform === 'win32' && 'no /proc' }, () => {
  const proc = fs.mkdtempSync(path.join(box.root, 'proc-'));
  fs.mkdirSync(path.join(proc, 'net'));
  // Port 20117 = 0x4E95, listening (0A), inode 7777; another socket on 8080 is not it.
  fs.writeFileSync(path.join(proc, 'net', 'tcp'), [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:4E95 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0 0 0 0',
    '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8888 1 0 0 0 0',
  ].join('\n'));
  fs.mkdirSync(path.join(proc, '4411', 'fd'), { recursive: true });
  fs.symlinkSync('socket:[7777]', path.join(proc, '4411', 'fd', '5'));
  fs.writeFileSync(path.join(proc, '4411', 'comm'), 'python3\n');
  fs.mkdirSync(path.join(proc, '55', 'fd'), { recursive: true });
  fs.symlinkSync('socket:[1]', path.join(proc, '55', 'fd', '3'));
  assert.deepEqual(mends.portHolder(20117, { proc }), { pid: 4411, name: 'python3' });
  assert.equal(mends.portHolder(8080, { proc }), null, 'its program is not one this user can see');
  assert.equal(mends.portHolder(9, { proc }), null);
  assert.equal(mends.portHolder('x', { proc }), null);
});

test('own temp: only Hoprig\'s own old logs and prefixed temporary folders go; a new file, a link and any other name stay', { skip: process.platform === 'win32' && 'symlinks need rights' }, () => {
  const state = fs.mkdtempSync(path.join(box.root, 'state-'));
  const tmp = fs.mkdtempSync(path.join(box.root, 'tmp-'));
  const old = (p, days) => { const t = new Date(NOW - days * 24 * HOUR); fs.utimesSync(p, t, t); };
  const file = (p, bytes, days) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); old(p, days); };
  file(path.join(state, 'logs', 'old.log'), 1000, 20);
  file(path.join(state, 'logs', 'new.log'), 500, 1);
  file(path.join(state, 'server.log.1'), 300, 30);
  file(path.join(state, 'config.json'), 100, 90); // not a log: never named
  file(path.join(tmp, 'hoprig-claude-abc', 'x'), 2000, 3);
  fs.utimesSync(path.join(tmp, 'hoprig-claude-abc'), new Date(NOW - 3 * 24 * HOUR), new Date(NOW - 3 * 24 * HOUR));
  file(path.join(tmp, 'hop-test-fresh', 'x'), 400, 0);
  file(path.join(tmp, 'owner-notes', 'x'), 400, 40); // another name: never named
  const outside = path.join(box.root, 'outside');
  file(path.join(outside, 'keep'), 10, 40);
  fs.symlinkSync(outside, path.join(tmp, 'hoprig-link'));
  old(path.join(tmp, 'hoprig-link'), 5);
  const o = { state, tmp, now: NOW };
  const names = mends.ownTemp(o).map((f) => path.relative(box.root, f.path)).sort();
  assert.deepEqual(names, [path.join(path.basename(state), 'logs', 'old.log'), path.join(path.basename(state), 'server.log.1'), path.join(path.basename(tmp), 'hoprig-claude-abc')].sort());
  assert.equal(mends.ownTempBytes(o), 1000 + 300 + 2000);
  assert.deepEqual(mends.cleanOwnTemp(o), { freed: 3300, files: 3 });
  assert.ok(fs.existsSync(path.join(state, 'logs', 'new.log')) && fs.existsSync(path.join(state, 'config.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'hop-test-fresh')) && fs.existsSync(path.join(tmp, 'owner-notes')));
  assert.ok(fs.existsSync(path.join(outside, 'keep')), 'a link is never followed');
  assert.deepEqual(mends.cleanOwnTemp(o), { freed: 0, files: 0 }, 'nothing left to clean');
  assert.equal(mends.bytesWords(1.2 * 1024 ** 3), '1.2 GB');
  assert.equal(mends.bytesWords(340 * 1024 ** 2), '340 MB');
  assert.equal(mends.bytesWords(5), '1 KB');
});

test('reopenSession: the same conversation with resume, under its name, with nothing sent; a missing conversation or one that runs is refused', async () => {
  const started = [];
  const t = { session: 'orders', cwd: '/w/alpha', profile: 'plan-a', sessionId: SID, carryArgs: ['--model', 'opus'], tool: 'claude' };
  const r = await mends.reopenSession(t, { start: async (o) => { started.push(o); return 'orders-2'; } });
  assert.deepEqual(started, [{ dir: '/w/alpha', profile: 'plan-a', mode: 'move', sessionId: SID, carryArgs: ['--model', 'opus'], name: 'orders' }]);
  assert.equal(r.did, 'reopened session orders-2 where it stopped; nothing was sent to it');
  await assert.rejects(mends.reopenSession({ session: 'orders', cwd: '/w', profile: 'plan-a' }, { start: () => assert.fail('not started') }), (e) => e.status === 409 && /conversation is not known/.test(e.message));
  await assert.rejects(mends.reopenSession(t, { start: async () => { throw Object.assign(new Error('x'), { existing: { chat: true } }); } }), (e) => e.status === 409 && /runs already/.test(e.message));
  await assert.rejects(mends.reopenSession(t, { start: async () => { throw new Error('the provider is gone'); } }), /the provider is gone/);
});

// ---- the detectors that offer the acts ----

test('ended: a session whose tool died offers Reopen first; one the person ended (no reopen) does not; its target names the conversation', () => {
  const board = { sessions: [
    { name: 'orders', state: 'ended', provider: 'plan-a', statusAt: new Date(NOW - 2 * MIN).toISOString(), asks: [], agents: [], reopen: { cwd: '/w/alpha', sessionId: SID, profile: 'plan-a', carryArgs: [], tool: 'claude' } },
    { name: 'notes', state: 'ended', provider: 'plan-a', statusAt: new Date(NOW - 2 * MIN).toISOString(), asks: [], agents: [] },
  ], work: { runs: [] } };
  const [a, b] = detectEnded(board, { now: NOW });
  assert.equal(a.recommended, 'reopen');
  assert.deepEqual(a.acts.map((x) => x.id), ['reopen', 'open']);
  assert.match(a.facts[0], /stopped without ending/);
  assert.deepEqual(a.target, { session: 'orders', reopen: true, cwd: '/w/alpha', sessionId: SID, profile: 'plan-a', carryArgs: [], tool: 'claude' });
  assert.equal(b.recommended, 'open');
  assert.equal(b.target.reopen, undefined);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(a))).includes(SID), false, 'the conversation id stays on the server');
});

test('machine: a disk over 90 percent with old files of Hoprig\'s own offers Clean first; at 88 percent, or with none of its own, only Tasks', () => {
  const m = (pct, ownTemp) => ({ machine: { cpus: 4, load1: 1, memTotal: 8e9, memAvailable: 4e9, ownTemp, disks: [{ mount: '/', usedPct: pct }], tmp: null } });
  const [hot] = detectMachine(m(93, 1.2 * 1024 ** 3));
  assert.equal(hot.recommended, 'clean');
  assert.deepEqual(hot.acts.map((x) => x.id), ['clean', 'open']);
  assert.match(hot.facts.join(' | '), /1\.2 GB of it is Hoprig's own old files/);
  assert.deepEqual(hot.target, { clean: true });
  for (const board of [m(88, 1e9), m(93, 0), m(93, undefined)]) {
    const [it] = detectMachine(board);
    assert.deepEqual(it.acts.map((x) => x.id), ['open']);
    assert.equal(it.target, undefined);
  }
});

// ---- the rules through the owner's own door, with a made-up world ----

function rig({ operator = undefined, tia = false, world: w = {}, acts: over = {}, clock: t0 = NOW } = {}) {
  fs.rmSync(opDir, { recursive: true, force: true });
  saveConfig({ projectsDir: projects, assistant: { enabled: tia }, ...(operator ? { operator } : { operator: undefined }) });
  const world = { sessions: [], gateways: [], live: null, leftovers: [], machine: null, ...w };
  const calls = [];
  const clock = { t: t0 };
  let models = 0;
  const ctx = { HttpError, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: () => () => {} };
  const f = operatorFeature(ctx, {
    sources: { sessions: () => world.sessions, gateways: () => world.gateways, live: () => world.live, leftovers: () => world.leftovers, machine: () => world.machine },
    now: () => clock.t,
    cacheMs: 0,
    accounts: async () => ({ profiles: [{ name: 'plan-a', kind: 'subscription' }, { name: 'plan-b', kind: 'subscription' }], autoSwitch: { enabled: false } }),
    turn: async () => { models++; throw new Error('no model may be asked'); },
    session: { move: async (name, to) => calls.push(['move', name, to]), stop: async (name) => calls.push(['stop', name]) },
    acts: {
      restartGateway: async (t) => {
        calls.push(['restart-gateway', t.addon]);
        if (world.heals !== false) world.gateways = world.gateways.map((g) => (g.name === t.addon ? { ...g, answers: true, running: true, status: 200 } : g));
        return { did: `restarted ${t.addon}` };
      },
      reopen: async (t) => {
        calls.push(['reopen', t.session, t.sessionId]);
        world.sessions = world.sessions.filter((s) => s.name !== t.session);
        return { did: `reopened session ${t.session} where it stopped; nothing was sent to it` };
      },
      clean: async () => {
        calls.push(['clean']);
        world.machine = { ...world.machine, ownTemp: 0, disks: world.machine.disks.map((d) => ({ ...d, usedPct: 60 })) };
        return { did: 'freed 1.2 GB of Hoprig\'s own old files' };
      },
      restartLink: async () => calls.push(['restart-link']),
      ...over,
    },
  });
  return { f, world, calls, clock, round: () => f.reflex.round(), view: () => f.reflex.view(), models: () => models, ctx, attention: () => f.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/attention'))[2]({ url: '/api/operator/attention', socket: {} }) };
}
const dead = { name: 'gate', port: 8111, running: true, installed: true, usedBy: 1, live: 2, answers: false, since: ago(5) };

test('a dead gateway is restarted on a fresh config, with Tia off and 0 model calls; the line says what and that Stop ends it', async () => {
  const r = rig({ world: { gateways: [{ ...dead }] } });
  assert.equal(readOperator(loadConfig()).tia, false);
  assert.deepEqual(await r.round(), { acted: 1 });
  assert.deepEqual(r.calls, [['restart-gateway', 'gate']]);
  const [l] = lines();
  assert.equal(l.by, 'gateway');
  assert.equal(l.ok, true);
  assert.equal(l.result, 'restarted gate');
  assert.match(l.noUndo, /Stop on its page ends it/);
  assert.equal(r.models(), 0);
  assert.deepEqual(await r.round(), { acted: 0 }, 'it answers now: nothing more');
  assert.equal(r.view().mends, true);
  assert.match(r.view().mendsSaid, /mends by itself what costs nothing/);
});

test('a gateway that answers with server errors is restarted; one that answers 404 is up', async () => {
  const r = rig({ world: { gateways: [{ name: 'gate', port: 8111, running: true, installed: true, usedBy: 1, live: 1, answers: true, status: 503, since: ago(2) }] } });
  const it = (await r.attention()).items.find((i) => i.kind === 'provider');
  assert.equal(it.class, 'stopped');
  assert.match(it.facts[0], /answers with server errors \(HTTP 503\) on port 8111/);
  assert.equal(it.recommended, 'restart-gateway');
  assert.deepEqual(await r.round(), { acted: 1 });
  assert.deepEqual(r.calls, [['restart-gateway', 'gate']]);
  const up = rig({ world: { gateways: [{ name: 'gate', port: 8111, running: true, installed: true, usedBy: 1, live: 1, answers: true, status: 404, since: ago(2) }] } });
  assert.deepEqual((await up.attention()).items.filter((i) => i.kind === 'provider'), []);
  assert.deepEqual(await up.round(), { acted: 0 });
});

test('a port held by another program is said with its name and pid, never restarted, never ended: no act, no call', async () => {
  const r = rig({ world: { gateways: [{ name: 'gate', port: 20117, running: false, installed: true, usedBy: 1, live: 1, answers: true, status: null, foreign: true, heldBy: { pid: 4411, name: 'python3' }, since: ago(3) }] } });
  const [it] = (await r.attention()).items.filter((i) => i.kind === 'provider');
  assert.equal(it.class, 'stopped');
  assert.equal(it.facts[0], 'port 20117 is held by python3, pid 4411');
  assert.deepEqual(it.acts.map((a) => a.id), ['open'], 'no restart, no end');
  assert.deepEqual(await r.round(), { acted: 0 });
  assert.deepEqual(r.calls, []);
  const taken = rig({ world: { gateways: [{ name: 'gate', port: 20117, running: false, installed: true, usedBy: 0, live: 0, answers: true, foreign: true, heldBy: null }] } });
  const [info] = (await taken.attention()).items.filter((i) => i.kind === 'provider');
  assert.equal(info.class, 'info');
  assert.match(info.facts[0], /port 20117 is held by another program/);
});

test('a gateway that does not come back: the second try after 2 minutes, then it is his for a day with one line saying what was tried', async () => {
  const r = rig({ world: { gateways: [{ ...dead }], heals: false } });
  assert.deepEqual(await r.round(), { acted: 1 });
  r.clock.t += 90_000;
  assert.deepEqual(await r.round(), { acted: 0 }, 'not before 2 minutes');
  assert.match(lines().at(-1).result, /Hoprig acted on it .* ago; it waits 2 min before it tries again/, JSON.stringify(lines()));
  assert.doesNotMatch(lines().at(-1).result, /Tia|she\b/i, 'no model acted: the words do not say Tia');
  r.clock.t += 40_000;
  assert.deepEqual(await r.round(), { acted: 1 }, 'the second try');
  r.clock.t += 3 * MIN;
  assert.deepEqual(await r.round(), { acted: 0 });
  assert.equal(r.calls.length, 2);
  const it = (await r.attention()).items.find((i) => i.kind === 'provider');
  assert.match(r.view().his[it.id].words, /^Hoprig tried twice \(the gateway rule\) and it came back: it is yours now/);
  // A day on, the rule may try again.
  r.clock.t += 25 * HOUR;
  assert.deepEqual(await r.round(), { acted: 1 });
});

test('the mends switch off: nothing is mended; the owner\'s own tap still works; one rule off leaves the others', async () => {
  const off = rig({ operator: { mends: false }, world: { gateways: [{ ...dead }] } });
  assert.deepEqual(await off.round(), { acted: 0 });
  assert.deepEqual(off.calls, []);
  const one = rig({ operator: { rules: { gateway: false } }, world: { gateways: [{ ...dead }], leftovers: [] } });
  assert.deepEqual(await one.round(), { acted: 0 });
  const it = (await one.attention()).items.find((i) => i.kind === 'provider');
  const tap = await one.f.routes.find(([m, re]) => m === 'POST' && re.test('/api/operator/act'))[2]({ url: '/api/operator/act', body: { item: it.id, act: 'restart-gateway', seen: it.rev }, socket: {} });
  assert.equal(tap.ok, true, 'his tap is his');
  assert.deepEqual(one.calls, [['restart-gateway', 'gate']]);
});

test('what spends usage stays Tia\'s: the limit rule does nothing on a fresh config, with Tia on or off', async () => {
  const limited = session({ name: 'alpha', folder: path.join(projects, 'alpha'), limit: { at: ago(3), text: 'Usage limit reached', source: 'hook' }, provider: 'plan-a', nextProvider: 'plan-b', canSwitch: true });
  for (const tia of [false, true]) {
    const r = rig({ tia, world: { sessions: [limited] } });
    assert.deepEqual(await r.round(), { acted: 0 }, `Tia ${tia}`);
    assert.deepEqual(r.calls, []);
    const it = (await r.attention()).items.find((i) => i.kind === 'limit');
    assert.equal(it.recommended, 'switch', 'the row names the move, he taps it');
  }
});

const ended = (over = {}) => ({ name: 'orders', state: 'ended', provider: 'plan-a', statusAt: new Date(NOW - 2 * MIN).toISOString(), folder: path.join(projects, 'alpha'), asks: [], agents: [], ...over });
const reopen = { cwd: path.join(projects, 'alpha'), sessionId: SID, profile: 'plan-a', carryArgs: [], tool: 'claude' };

test('a tool that died with no end hook is reopened with resume, nothing typed; one the person ended is left', async () => {
  const r = rig({ world: { sessions: [ended({ reopen })] } });
  assert.deepEqual(await r.round(), { acted: 1 });
  assert.deepEqual(r.calls, [['reopen', 'orders', SID]]);
  const [l] = lines();
  assert.equal(l.by, 'reopen');
  assert.equal(l.result, 'reopened session orders where it stopped; nothing was sent to it');
  assert.equal(l.noUndo, 'Close it on its page.');
  assert.equal(r.models(), 0);
  const his = rig({ world: { sessions: [ended()] } });
  assert.deepEqual(await his.round(), { acted: 0 });
  assert.deepEqual(his.calls, []);
  // A project taken out is left alone, as for every rule.
  const out = rig({ operator: { projectsOut: ['alpha'] }, world: { sessions: [ended({ reopen })] } });
  assert.deepEqual(await out.round(), { acted: 0 });
  assert.deepEqual(out.calls, []);
});

test('a disk over 90 percent: Hoprig cleans its own old files once, says how much, and does not repeat within the hour', async () => {
  const machine = () => ({ cpus: 4, load1: 1, memTotal: 8e9, memAvailable: 4e9, ownTemp: 1.2 * 1024 ** 3, disks: [{ mount: '/', usedPct: 93 }], tmp: null });
  const r = rig({ world: { machine: machine() } });
  assert.deepEqual(await r.round(), { acted: 1 });
  assert.deepEqual(r.calls, [['clean']]);
  assert.equal(lines()[0].by, 'clean');
  assert.match(lines()[0].result, /freed 1\.2 GB/);
  // It filled again at once: a second clean is held back (once a day, 60 minutes between).
  r.world.machine = machine();
  r.clock.t += 5 * MIN;
  assert.deepEqual(await r.round(), { acted: 0 });
  assert.deepEqual(r.calls, [['clean']]);
  // No own files: nothing is offered, so nothing is done.
  const none = rig({ world: { machine: { ...machine(), ownTemp: 0 } } });
  assert.deepEqual(await none.round(), { acted: 0 });
});

// ---- every refusal of the door: the owner's own writes stay the owner's ----

test('the mends switch and every rule are changed from the owner\'s own page only: not from a linked computer or Tia\'s own door', async () => {
  const r = rig({});
  const post = r.f.routes.find(([m, re]) => m === 'POST' && re.test('/api/operator/settings'))[2];
  for (const who of ['self', 'computer']) {
    r.ctx.caller = () => who;
    await assert.rejects(post({ url: '/api/operator/settings', body: { mends: false }, socket: {} }), (e) => e.status === 403, who);
  }
  assert.equal(readOperator(loadConfig()).mends, true, 'unchanged');
  r.ctx.caller = () => 'page';
  const v = await post({ url: '/api/operator/settings', body: { mends: false }, socket: {} });
  assert.equal(v.mends, false);
  assert.equal(readOperator(loadConfig()).mends, false);
  assert.ok(RULE_IDS.includes('reopen') && RULE_IDS.includes('clean'));
});

test('Tia\'s door refuses every route under the Operator that writes, the new rules\' settings too', async () => {
  const { checkRoute } = await import('../../src/assistant/door.mjs');
  assert.throws(() => checkRoute('POST', '/api/operator/settings', { mends: false }), (e) => e.status === 403);
  assert.throws(() => checkRoute('POST', '/api/operator/settings', { rules: { gateway: false } }), (e) => e.status === 403);
  assert.throws(() => checkRoute('POST', '/api/operator/act', { item: 'x', act: 'reopen', seen: 'y' }), (e) => e.status === 403);
});
