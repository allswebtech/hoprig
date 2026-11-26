// Hands-off in a session of the App (src/chat/handsoff.mjs), against the stand-in Claude Code (fixtures/fake-claude.mjs):
// the card is the tool's own data; with the switch off the owner answers; on, the marked option goes through the
// owner's own answer function and is shown and logged; a sign waits; the card's key is checked at the answer; the
// same answer twice is given once; the stop holds at once; three answers in a row stop it (a loop).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chathandsoff');
test.after(() => box.cleanup());

const { Chat } = await import('../../src/chat/chat.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { stateDir } = await import('../../src/paths.mjs');
const HO = await import('../../src/chat/handsoff.mjs');
const V = hoprigVersion();
// Hands-off is offered on this computer; the switch below decides a session (a direct-chat test passes this as o.cfg).
const OFFER = { handsOff: { offered: true } };

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function newChat(cfg = {}, o = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const config = typeof cfg === 'function' ? cfg : () => (cfg.on === undefined ? {} : { handsOff: { offered: true, projects: { [cwd]: { on: cfg.on, version: cfg.version || V, note: cfg.note || '' } } } });
  return new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), handsOffConfig: config, ...o });
}
// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered): a test that switches it on and waits for its
// answer would wait its whole time limit there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };
const call = (name, input) => `call ${Buffer.from(JSON.stringify({ name, input })).toString('base64')}`;
const question = (q, labels) => call('AskUserQuestion', { questions: [{ question: q, header: 'Choice', multiSelect: false, options: labels.map((label) => ({ label, description: `About ${label}` })) }] });
const REC = question('Which test runner should this project use?', ['node:test (Recommended)', 'vitest']);
const turnEnd = (c) => new Promise((r) => c.once('turn', r));
const of = (c, kind) => c.events.filter((e) => e.kind === kind);
const activity = () => {
  try {
    return fs.readFileSync(path.join(stateDir(), 'automation.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test('off (the default): the card is exact, nothing answers for the owner, his answer arrives', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  const before = activity().length;
  const done = turnEnd(c);
  await c.send(REC);
  const ask = await until('card', () => c.pending.size && [...c.pending.values()][0]);
  assert.equal(ask.card.kind, 'question');
  assert.equal(ask.card.source, 'channel');
  assert.deepEqual(ask.card.questions[0].options.map((o) => o.label), ['node:test (Recommended)', 'vitest']);
  assert.equal(ask.card.questions[0].recommended, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.pending.size, 1, 'still his');
  assert.equal(of(c, 'handsoff').length, 0);
  // A stale key (the question changed under the card) is refused; the right one goes.
  assert.throws(() => c.answer(ask.request, { allow: true, answers: { 'Which test runner should this project use?': 'vitest' }, key: 'not-this-one' }), /question changed/);
  c.answer(ask.request, { allow: true, answers: { 'Which test runner should this project use?': 'vitest' }, key: ask.card.key });
  assert.throws(() => c.answer(ask.request, { allow: true, answers: {} }), /already answered/, 'the same answer twice is given once');
  await done;
  assert.equal(of(c, 'ask-closed').at(-1).outcome, 'allowed');
  assert.equal(activity().length, before, 'nothing written to Activity');
});

test('offered:false (the owner hid the feature): a project and a session switch are on but nothing is answered', () => {
  const given = [];
  const chat = { id: 'g1', cwd: '/w/shop', engine: { id: 'claude' }, permissionMode: null, handsOff: { on: true, version: V }, handsOffStop: null, handsOffRow: 0, handsOffTimes: [], push: () => {}, emit: () => {} };
  const ev = { type: 'question', request: 'r', card: { kind: 'question', questions: [{ question: 'Which runner?', header: '', options: [{ label: 'a (Recommended)', description: '' }, { label: 'b', description: '' }], recommended: 0, freeText: true }] } };
  const cfg = { handsOff: { offered: false, projects: { '/w/shop': { on: true, version: V } } } }; // switches on, but the owner hid the feature
  assert.equal(HO.handsOffAsk(chat, ev, () => given.push(1), { cfg, version: V, log: path.join(box.root, 'gate.log') }), false);
  assert.equal(given.length, 0, 'no answer given');
  // chatSwitch reads as off when Hands-off is not offered, even with the session switch on; on again once offered.
  assert.equal(HO.chatSwitch(chat, cfg, V).on, false);
  // Hands-off is not offered on Windows at all (handsOffOffered), so there it reads off even when offered.
  if (process.platform !== 'win32') assert.equal(HO.chatSwitch(chat, { handsOff: { offered: true, projects: cfg.handsOff.projects } }, V).on, true);
});

test('on: the recommended option is given for the owner, shown in the chat and one line in Activity', OFFERED, async (t) => {
  const c = newChat({ on: true });
  t.after(() => c.stopAndWait());
  const before = activity().length;
  const done = turnEnd(c);
  await c.send(REC);
  await done;
  const said = of(c, 'handsoff');
  assert.equal(said.length, 1);
  assert.deepEqual([said[0].text, said[0].because], ['node:test (Recommended)', 'recommended']);
  assert.equal(of(c, 'ask-closed').at(-1).outcome, 'handsoff');
  const log = activity().slice(before);
  assert.equal(log.length, 1);
  assert.match(log[0].did, /answered "Which test runner should this project use\?" with "node:test \(Recommended\)" for you, because the tool recommended it/);
});

test('on: a question about a push waits for the owner even with a recommended option, and says why', OFFERED, async (t) => {
  const c = newChat({ on: true });
  t.after(() => c.stopAndWait());
  await c.send(question('Should I push the branch to origin now?', ['Yes (Recommended)', 'No']));
  await until('card', () => c.pending.size);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(c.pending.size, 1);
  assert.equal(of(c, 'handsoff').at(-1).waits, 'owner:push or merge');
});

test('on: no mark and no note waits; the note is given as the free-text answer', OFFERED, async (t) => {
  const c = newChat({ on: true, note: 'Take the smaller one.' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send(question('Which name do you prefer?', ['alpha', 'beta']));
  await done;
  assert.deepEqual([of(c, 'handsoff').at(-1).text, of(c, 'handsoff').at(-1).because], ['Take the smaller one.', 'note']);
  assert.equal(of(c, 'text').at(-1).text, 'Done.');
});

test('the stop: the session\'s own switch off wins at once; under another version it is off', OFFERED, async (t) => {
  const c = newChat({ on: true });
  t.after(() => c.stopAndWait());
  c.handsOff = { on: false, version: V };
  await c.send(REC);
  await until('card', () => c.pending.size);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(c.pending.size, 1);
  assert.equal(of(c, 'handsoff').length, 0);
  const d = newChat({ on: true, version: '0.0.1' });
  t.after(() => d.stopAndWait());
  await d.send(REC);
  await until('card', () => d.pending.size);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(d.pending.size, 1, 'turned off by the update');
});

test('three answers in a row with no work between them: a loop, the fourth waits and the chat says so', OFFERED, () => {
  const { handsOffAsk, workSeen } = HO;
  const pushed = [];
  const chat = { id: 'c1', cwd: '/w/shop', engine: { id: 'claude' }, permissionMode: null, handsOff: { on: true, version: V }, handsOffStop: null, handsOffRow: 0, push: (e) => pushed.push(e), emit: () => {} };
  const ev = (n) => ({ type: 'question', request: `r${n}`, tool: 'AskUserQuestion', full: { questions: [{ question: 'Which runner?', options: [{ label: 'a (Recommended)' }, { label: 'b' }] }] } });
  const given = [];
  const answer = (c, request, a) => given.push([request, a.answers]);
  const log = path.join(box.root, 'loop.log');
  for (let n = 1; n <= 3; n++) assert.equal(handsOffAsk(chat, ev(n), answer, { cfg: OFFER, log }), true, `answer ${n}`);
  assert.equal(handsOffAsk(chat, ev(4), answer, { cfg: OFFER, log }), false, 'the fourth waits');
  assert.deepEqual(given.map((g) => g[0]), ['r1', 'r2', 'r3']);
  assert.equal(chat.handsOffStop, 'loop');
  assert.equal(pushed.at(-1).stopped, 'loop');
  // Work does not end the stop: only the owner turning it on again does.
  workSeen(chat, { kind: 'tool', name: 'Bash' });
  assert.equal(handsOffAsk(chat, ev(5), answer, { cfg: OFFER, log }), false);
  // A question or plan between answers is no work; a tool call is.
  const fresh = { ...chat, handsOffStop: null, handsOffRow: 2 };
  workSeen(fresh, { kind: 'tool', name: 'AskUserQuestion' });
  assert.equal(fresh.handsOffRow, 2);
  workSeen(fresh, { kind: 'tool', name: 'Write' });
  assert.equal(fresh.handsOffRow, 0);
});

test('a plan in the App is approved in the mode the chat had, never a wider one', OFFERED, () => {
  const { handsOffAsk } = HO;
  const given = [];
  const chat = { id: 'c2', cwd: '/w/shop', engine: { id: 'claude' }, permissionMode: 'acceptEdits', handsOff: { on: true, version: V }, handsOffStop: null, handsOffRow: 0, push: () => {}, emit: () => {} };
  assert.equal(handsOffAsk(chat, { type: 'plan', request: 'p1', tool: 'ExitPlanMode', plan: 'Plan: rename a helper.' }, (c, r, a) => given.push(a), { cfg: OFFER, log: path.join(box.root, 'plan.log') }), true);
  assert.deepEqual(given[0], { allow: true, mode: 'acceptEdits', by: 'handsoff' });
  chat.permissionMode = null;
  handsOffAsk(chat, { type: 'plan', request: 'p2', tool: 'ExitPlanMode', plan: 'Plan: rename a helper.' }, (c, r, a) => given.push(a), { cfg: OFFER, log: path.join(box.root, 'plan.log') });
  assert.equal(given[1].mode, 'manual');
  // A permission is never Hands-off's.
  assert.equal(handsOffAsk(chat, { type: 'permission', request: 'x', tool: 'Bash', full: { command: 'ls' } }, () => assert.fail('answered')), false);
});

test('the chat\'s count: a read is no work, a write is; ten answers within an hour stop it', OFFERED, () => {
  const chat = { handsOffRow: 2 };
  HO.workSeen(chat, { kind: 'tool', name: 'Read' });
  HO.workSeen(chat, { kind: 'tool', name: 'Grep' });
  assert.equal(chat.handsOffRow, 2);
  HO.workSeen(chat, { kind: 'tool', name: 'Write' });
  assert.equal(chat.handsOffRow, 0);
  const pushed = [];
  const c = { id: 'x', cwd: '/w/shop', handsOff: { on: true, version: V, at: 1 }, handsOffRow: 0, permissionMode: 'manual', handsOffTimes: [], emit() {}, push: (e) => pushed.push(e) };
  const ev = { type: 'question', request: 'r', card: { kind: 'question', questions: [{ question: 'Which?', header: '', options: [{ label: 'a (Recommended)', description: '' }, { label: 'b', description: '' }], recommended: 0, freeText: true }] } };
  const log = path.join(box.root, 'hour.log');
  let n = 0;
  for (let i = 0; i < 12; i++) {
    if (HO.handsOffAsk(c, ev, () => {}, { cfg: OFFER, version: V, log, now: 1_000_000 + i * 1000 })) n++;
    c.handsOffRow = 0; // work between every answer
  }
  assert.equal(n, 10);
  assert.equal(c.handsOffStop, 'hour');
  assert.equal(pushed.at(-1).stopped, 'hour');
});

test('after the hour\'s stop the owner\'s Turn on in the App starts the hour again: the next ask is answered', OFFERED, () => {
  const pushed = [];
  const now = 50_000_000;
  const c = { id: 'h', cwd: '/w/shop', engine: { id: 'claude' }, handsOff: { on: true, version: V, at: now - 120_000 }, handsOffStop: null, handsOffRow: 0, permissionMode: 'manual',
    handsOffTimes: Array.from({ length: 10 }, (_, i) => now - 60_000 + i), emit() {}, push: (e) => pushed.push(e) };
  const ev = (r) => ({ type: 'question', request: r, card: { kind: 'question', questions: [{ question: 'Which?', header: '', options: [{ label: 'a (Recommended)', description: '' }, { label: 'b', description: '' }], recommended: 0, freeText: true }] } });
  const o = { cfg: OFFER, version: V, log: path.join(box.root, 'again.log'), now };
  assert.equal(HO.handsOffAsk(c, ev('r1'), () => {}, o), false);
  assert.equal(c.handsOffStop, 'hour');
  // What the chat's route does on Turn on (feature.mjs): its own switch with the time of the press, the stop and count gone.
  Object.assign(c, { handsOff: { on: true, version: V, at: now + 1000 }, handsOffStop: null, handsOffRow: 0 });
  assert.equal(HO.handsOffAsk(c, ev('r2'), () => {}, { ...o, now: now + 2000 }), true, 'answered after Turn on');
  assert.equal(c.handsOffStop, null);
  assert.equal(c.handsOffTimes.length, 10);
});

test('the chat\'s count of answers in a row and their times are kept with its record: a restart does not start them again', OFFERED, async () => {
  const c = newChat({ on: true });
  c.handsOffRow = 2;
  c.handsOffTimes = [1000, 2000];
  const rec = c.record();
  assert.deepEqual([rec.handsOffRow, rec.handsOffTimes], [2, [1000, 2000]]);
  const again = new Chat({ ...rec, command: c.o.command, resolveEnv: c.o.resolveEnv, handsOffConfig: c.o.handsOffConfig });
  assert.deepEqual([again.handsOffRow, again.handsOffTimes], [2, [1000, 2000]]);
  await c.stopAndWait();
});

test('a plan\'s answer names the mode in the page\'s words, once, on the chat and in Activity', OFFERED, () => {
  const pushed = [];
  const log = path.join(box.root, 'planwords.log');
  const chat = { id: 'c3', cwd: '/w/shop', engine: { id: 'claude' }, permissionMode: 'acceptEdits', handsOff: { on: true, version: V, at: 1 }, handsOffStop: null, handsOffRow: 0, handsOffTimes: [], push: (e) => pushed.push(e), emit: () => {} };
  HO.handsOffAsk(chat, { type: 'plan', request: 'p1', tool: 'ExitPlanMode', plan: 'Plan: rename a helper.' }, () => {}, { cfg: OFFER, log });
  const line = pushed.find((e) => e.kind === 'handsoff');
  assert.equal(line.text, 'approved the plan; it goes on in Accept edits, the mode it had');
  const did = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).did;
  assert.equal(did, 'approved the plan; it goes on in Accept edits, the mode it had (for you)');
  for (const t of [line.text, did]) assert.doesNotMatch(t, /acceptEdits|bypassPermissions|dontAsk/);
});

test('a held act in a chat carries the same held as a terminal, so the page draws the same card', OFFERED, () => {
  const c = newChat({}, { handsOffConfig: () => OFFER });
  const ev = { type: 'permission', tool: 'Bash', full: { command: 'npm test && sudo apt-get install -y shop-tools' }, subject: 'sudo apt-get install -y shop-tools', request: 'r' };
  const card = HO.chatCard(c, ev);
  assert.ok(card.held, 'the card carries the wall\'s held');
  assert.equal(card.held.title, 'Administrator rights');
  assert.match(card.held.reason, /administrator rights/i);
  assert.equal(card.held.partOf, true, 'shown as part of a longer command');
  // An ordinary permission carries no held.
  assert.equal(HO.chatCard(c, { type: 'permission', tool: 'Bash', full: { command: 'npm test' }, subject: 'npm test', request: 'r2' }).held, undefined);
  // The owner hid Hands-off (offered:false): the wall does not run, so no held.
  assert.equal(HO.chatCard(newChat({}, { handsOffConfig: () => ({ handsOff: { offered: false } }) }), ev).held, undefined);
});

test('a chat of hers at Full: the card names the act the hook held, not administrator rights', () => {
  // Full lifts the administrator act (hook.mjs sessionHold); what is left is what the hook holds and the card shows.
  const full = () => ({ server: { herRights: { level: 'full', version: V } } });
  const c = newChat(full, { byTia: true });
  const ask = (command) => HO.chatCard(c, { type: 'permission', tool: 'Bash', full: { command }, subject: command, request: 'r' }).held;
  const del = ask('sudo rm -rf ../other/dist');
  assert.ok(del, 'held');
  assert.equal(del.title, 'A delete outside the session\'s folder');
  assert.match(del.reason, /delete outside the session's own folder/);
  assert.equal(del.acts, undefined, 'one act: the administrator act is lifted at Full');
  // A push to the main branch behind sudo stays a push (the folder is no repository here: Hoprig cannot check it).
  const push = ask('sudo git push origin main');
  assert.ok(push, 'held');
  assert.match(push.title, /^A push/);
  assert.equal(ask('sudo apt-get install -y shop-tools'), undefined, 'an ordinary administrator command runs at Full: no card');
  // Below Full the administrator act comes first, as the hook holds it.
  const asked = newChat(() => ({ server: { herRights: { level: 'ask', version: V } } }), { byTia: true });
  assert.equal(HO.chatCard(asked, { type: 'permission', tool: 'Bash', full: { command: 'sudo rm -rf ../other/dist' }, subject: 'x', request: 'r' }).held.title, 'Administrator rights');
});
