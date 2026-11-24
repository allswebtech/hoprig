// "Start new work on <name> until this computer is calm" (src/operator/where-hold.mjs): the act on the overload item,
// its rule (off when absent), the hold that ends by itself once this computer has been calm, and Undo. Made-up
// computers box2 and box3; this computer's own load is never read here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-where-hold');
test.after(() => box.cleanup());
const { CALM_MS, HOLD_MAX_MS, elsewhereOf, endElsewhere, noteCalm, readElsewhere, setElsewhere, stepElsewhere } = await import('../../src/operator/where-hold.mjs');
const { detectMachine } = await import('../../src/operator/detect/machine.mjs');
const { readOperator, ruleFor, RULES } = await import('../../src/operator/rules.mjs');

const GiB = 1024 ** 3;
const over = { cpus: 4, load1: 8, memTotal: 16 * GiB, memAvailable: 8 * GiB, disks: [], tmp: null };
const T = Date.parse('2026-03-02T10:00:00Z');
const file = path.join(box.state, 'operator', 'elsewhere.json');

test('no computers chosen for Tia, or none with room: the overload item has its one act, as before', () => {
  const plain = detectMachine({ machine: over });
  assert.deepEqual(plain[0].acts.map((a) => a.id), ['open']);
  assert.deepEqual(elsewhereOf({ view: { computers: [{ name: 'box2', room: 'free' }] }, computers: null }), { elsewhere: null, elsewhereHeld: null });
  assert.deepEqual(elsewhereOf({ view: { computers: [{ name: 'box2', room: 'busy' }] }, computers: ['this', 'box2'] }).elsewhere, null);
  assert.deepEqual(elsewhereOf({ view: { computers: [{ name: 'box3', room: 'free' }] }, computers: ['this', 'box2'] }).elsewhere, null, 'box3 is not one he chose');
});

test('overloaded and an allowed computer has room: one more prepared act, "Start new work on Box 2"', () => {
  const extra = elsewhereOf({ view: { computers: [{ name: 'box2', label: 'Box 2', room: 'free', cpus: 8, load1: 1 }, { name: 'box3', label: 'Box 3', room: 'free', cpus: 8, load1: 4 }] }, computers: ['this', 'box2', 'box3'] });
  assert.deepEqual(extra.elsewhere, { name: 'box2', label: 'Box 2' });
  const [it] = detectMachine({ machine: over, ...extra });
  assert.deepEqual(it.acts.map((a) => [a.id, a.label]), [['elsewhere', 'Start new work on Box 2'], ['open', 'Open Tasks']]);
  assert.equal(it.recommended, 'elsewhere');
  assert.deepEqual(it.target, { to: 'box2', label: 'Box 2' });
  assert.ok(it.facts.includes('Box 2 has room for Tia\'s new work; nothing that runs moves'), it.facts.join('\n'));
});

test('the rule: off when absent, in the form of the others; it acts only on such an item', () => {
  const r = RULES.find((x) => x.id === 'elsewhere');
  assert.equal(r.sentence, 'When this computer is overloaded, start new work where there is room.');
  assert.equal(readOperator({}).rules.elsewhere, false);
  const extra = elsewhereOf({ view: { computers: [{ name: 'box2', label: 'Box 2', room: 'free' }] }, computers: ['this', 'box2'] });
  assert.equal(ruleFor(detectMachine({ machine: over, ...extra })[0]).id, 'elsewhere');
  assert.equal(ruleFor(detectMachine({ machine: over })[0]), null);
});

test('the hold: kept in the state folder, ends once calm for its stretch, at most two hours, and by Undo', () => {
  setElsewhere('box2', 'Box 2', T);
  assert.ok(fs.existsSync(file));
  assert.equal(readElsewhere(T + 1000).to, 'box2');
  assert.equal(noteCalm(false, T + 60_000).calmSince, null);
  assert.equal(noteCalm(true, T + 2 * 60_000).calmSince, T + 2 * 60_000);
  assert.equal(noteCalm(false, T + 5 * 60_000).calmSince, null, 'busy again: the stretch starts over');
  noteCalm(true, T + 6 * 60_000);
  assert.ok(noteCalm(true, T + 6 * 60_000 + CALM_MS - 1));
  assert.equal(noteCalm(true, T + 6 * 60_000 + CALM_MS), null, 'calm for ten minutes: it ends');
  assert.equal(fs.existsSync(file), false);
  setElsewhere('box2', 'Box 2', T);
  assert.equal(readElsewhere(T + HOLD_MAX_MS), null, 'two hours at most, also never calm');
  setElsewhere('box2', 'Box 2', T);
  assert.equal(readElsewhere(T - 3600_000), null, 'a start in the future (the clock was set back) ends it');
  setElsewhere('box2', 'Box 2', T);
  endElsewhere();
  assert.equal(readElsewhere(T + 1), null, 'Undo ends it at once');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"to":"../../etc","since":1}');
  assert.equal(readElsewhere(T), null, 'a file that is not one of ours ends it');
  assert.equal(stepElsewhere(null, { calm: true, now: T }), null);
  assert.throws(() => setElsewhere('Box 2!', 'x', T));
});

test('a hold that stands is said on the item, with since when', () => {
  const held = setElsewhere('box2', 'Box 2', T);
  const extra = elsewhereOf({ view: { computers: [{ name: 'box2', room: 'free' }] }, computers: ['this', 'box2'], held });
  const [it] = detectMachine({ machine: over, ...extra });
  assert.deepEqual(it.acts.map((a) => a.id), ['open'], 'no second act while it stands');
  assert.ok(it.facts.includes('Tia\'s new work starts on Box 2 since 10:00 UTC'), it.facts.join('\n'));
  assert.ok(it.facts.includes('It ends once this computer has been calm for 10 minutes (2 hours at most)'), it.facts.join('\n'));
  endElsewhere();
});

test('the calm check reads the disk the workspace is on: a nearly full backup disk does not keep the hold standing', async () => {
  const { roomsFeature } = await import('../../src/operator/rooms.mjs');
  let t = T;
  let tick = null;
  const ctx = { HttpError: Error, config: () => ({}), state: async () => ({ sessions: [] }), caller: () => 'page', readJson: async () => ({}), saveConfig: () => {}, onTick: (fn) => { tick = fn; return () => {}; } };
  // this computer calm in load and memory; its workspace on '/' at 30 %, a backup disk at 90 %
  const m = { cpus: 8, load1: 1, memTotal: 16 * GiB, memAvailable: 8 * GiB, disks: [{ mount: '/', usedPct: 30 }, { mount: '/mnt/backup', usedPct: 90 }], tmp: null };
  const f = roomsFeature(ctx, { ask: () => ({ reached: false }), local: async () => null, now: () => t, machine: () => m, workspace: () => '/home/alex/Workspace' });
  setElsewhere('box2', 'Box 2', T);
  tick();
  t += CALM_MS;
  tick();
  assert.equal(readElsewhere(t), null, 'calm for ten minutes on the workspace\'s disk: the hold ended');
  f.close();
  endElsewhere();
});

/** The real Operator feature with an overloaded machine source and box2 with room; his rule as given. */
async function operatorRig({ rules = { elsewhere: true }, computers = ['this', 'box2'] } = {}) {
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { operatorFeature } = await import('../../src/operator/feature.mjs');
  fs.rmSync(path.join(box.state, 'operator'), { recursive: true, force: true });
  saveConfig({ assistant: { enabled: true, computers }, operator: { acts: true, rules } });
  const clock = { t: T };
  const ctx = { HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: () => () => {} };
  const view = { computers: [{ name: 'box2', label: 'Box 2', room: 'free', cpus: 8, load1: 1 }] };
  const f = operatorFeature(ctx, { sources: { machine: () => over }, now: () => clock.t, cacheMs: 0, rooms: () => view });
  const call = (method, p, body = {}) => f.routes.find(([m, re]) => m === method && re.test(p))[2]({ url: p, body, socket: {} });
  return { f, clock, call, saveConfig, loadConfig };
}

test('Tia OFF ends the hold his rule set, as it lifts her other hold; one he set by his own tap stays', async () => {
  const r = await operatorRig();
  assert.deepEqual(await r.f.reflex.round(), { acted: 1 });
  assert.equal(readElsewhere(T).to, 'box2');
  assert.equal(readElsewhere(T).by, 'tia');
  await r.call('POST', '/api/operator/off');
  assert.equal(readElsewhere(T), null, 'Tia OFF ended it');
  const lines = fs.readFileSync(path.join(box.state, 'operator', 'timeline.jsonl'), 'utf8');
  assert.match(lines, /Tia OFF ended it/);
  setElsewhere('box2', 'Box 2', T);
  await r.call('POST', '/api/operator/off');
  assert.equal(readElsewhere(T).to, 'box2', 'his own stays');
  endElsewhere();
  r.f.close();
});

test('a hold on a computer he took out of Settings → Tia has lost its reason: it ends, and nothing says it stands', async () => {
  setElsewhere('box2', 'Box 2', T);
  assert.equal(readElsewhere(T, { computers: ['this', 'box2'] }).to, 'box2');
  assert.equal(readElsewhere(T, { computers: ['this', 'box3'] }), null);
  assert.equal(fs.existsSync(file), false);
  setElsewhere('box2', 'Box 2', T);
  assert.equal(readElsewhere(T, { computers: null }), null, 'no computers chosen at all');
  // the Operator's board: the overload item no longer says it stands
  setElsewhere('box2', 'Box 2', T);
  const r = await operatorRig({ rules: {}, computers: ['this', 'box3'] });
  const l = await r.call('GET', '/api/operator/attention');
  const it = l.items.find((x) => x.kind === 'machine');
  assert.ok(it && !it.facts.some((x) => /starts on Box 2/.test(x)), JSON.stringify(it && it.facts));
  assert.equal(readElsewhere(T), null);
  r.f.close();
});

test('with his rule on, his Undo of the hold is his answer: a round eleven minutes later sets no new hold', async () => {
  const { roomsFeature } = await import('../../src/operator/rooms.mjs');
  const r = await operatorRig();
  const ctx = { HttpError: Error, config: () => r.loadConfig(), state: async () => ({ sessions: [] }), caller: () => 'page', readJson: async () => ({}), saveConfig: () => {} };
  const rooms = roomsFeature(ctx, { ask: () => ({ reached: false }), local: async () => null, now: () => r.clock.t, undone: () => r.f.elsewhereUndone() });
  assert.deepEqual(await r.f.reflex.round(), { acted: 1 });
  assert.equal(readElsewhere(r.clock.t).to, 'box2');
  r.clock.t += 60_000;
  const [, , undo] = rooms.routes.find(([m, re]) => m === 'POST' && re.test('/api/operator/rooms/elsewhere/end'));
  await undo({ url: '/api/operator/rooms/elsewhere/end' });
  assert.equal(readElsewhere(r.clock.t), null);
  r.clock.t += 11 * 60_000;
  await r.f.reflex.round();
  assert.equal(readElsewhere(r.clock.t), null, 'the rule left it to him');
  const words = r.f.reflex.view().his;
  assert.ok(Object.values(words).some((w) => /You ended "Start new work elsewhere" with Undo/.test(w.words)), JSON.stringify(words));
  rooms.close();
  r.f.close();
});

test('with his rule off, his Undo writes nothing about a rule: the card says nothing of it', async () => {
  const r = await operatorRig({ rules: {} });
  setElsewhere('box2', 'Box 2', T);
  assert.equal(await r.f.elsewhereUndone(), false);
  assert.deepEqual(r.f.reflex.view().his, {});
  endElsewhere();
  r.f.close();
});
