// "Allow everything" in the App chat (src/chat/asks.mjs allAllows): in a chat of the owner whose permission mode is
// Allow everything (Claude Code runs in bypassPermissions) every permission is answered Allow at once, with one quiet
// line "allowed" marked by all; the coding tool's own questions and plans still come to him; the one removal of a whole
// home, workspace, projects folder or disk still shows a card with the floor line. Nothing else is held, also not what
// Hands-off holds in a session that is not in the mode: it runs and leaves one quiet line. Against the stand-in Claude Code (fixtures/fake-claude.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('allasks');
test.after(() => box.cleanup());
const POSIX = process.platform === 'win32' ? 'the stand-in is POSIX' : false;

const { Chat } = await import('../../src/chat/chat.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { FLOOR_WORDS } = await import('../../src/wall.mjs');

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function newChat(o = {}, env = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({
    id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, hookWaitMs: 400,
    permissionMode: 'allowEverything', allEverything: () => true, allowBypass: () => true, handsOffConfig: () => ({}),
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, ...env }), ...o,
  });
  c.argsFile = argsFile;
  return c;
}
const turnEnd = (c) => new Promise((r) => c.once('turn', r));
const logged = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const answers = (c) => logged(c).filter((x) => x.answer).map((x) => x.answer);
const asks = (c) => c.events.filter((e) => e.kind === 'ask');
const allowed = (c) => c.events.filter((e) => e.kind === 'allowed');
const lastResult = (c) => c.events.filter((e) => e.kind === 'tool-result').at(-1);
const card = async (c, n = 1) => (await until(`card ${n}`, () => asks(c).length >= n && c.pending.size > 0 && asks(c))).at(-1);
async function turn(c, text) {
  const done = turnEnd(c);
  await c.send(text);
  return done;
}

test('Claude Code gets bypassPermissions for it, and the chat knows the process runs in it', { skip: POSIX }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await turn(c, 'hello');
  const argv = logged(c).find(Array.isArray);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(!argv.includes('allowEverything'));
  assert.equal(c.bypass, true);
  assert.equal(c.permissionMode, 'allowEverything', 'the chat keeps its own mode');
});

test('what Claude Code still asks in bypass (its own stop before a delete, an ask rule, a hook that asks) is answered at once, with one quiet line and no card', { skip: POSIX }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await turn(c, 'rm DIR');
  assert.equal(lastResult(c).text, 'ran: rm -rf $DIR/*');
  await turn(c, 'askrule npm test');
  assert.match(lastResult(c).text, /^ran: /);
  await turn(c, `hook ${c.cwd}/x.txt`);
  assert.equal(asks(c).length, 0, 'no card');
  assert.equal(c.pending.size, 0);
  assert.equal(allowed(c).length, 3, 'one quiet line each');
  assert.ok(allowed(c).every((e) => e.by === 'all'));
  assert.equal(allowed(c)[0].what, 'rm -rf $DIR/*');
  assert.equal(answers(c).length, 3);
  assert.ok(!c.events.some((e) => e.kind === 'status' && e.status === 'attention'));
});

test('a question and a plan come to him', { skip: POSIX }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('question');
  const q = await card(c);
  assert.equal(q.type, 'question');
  c.answer(q.request, { allow: true, answers: {} });
  await done;
});

test('the floor: a removal of the whole disk shows a card with the floor line, and Do not allow works', { skip: POSIX }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('rmpath /');
  const up = await card(c);
  assert.equal(up.input.command, 'rm -rf /');
  assert.match(up.why, /^Held even in Allow everything: this would delete your whole disk, which cannot be undone\.$/);
  assert.ok(FLOOR_WORDS);
  c.answer(up.request, { allow: false });
  await done;
  assert.equal(allowed(c).length, 0);
});

test('not in Bypass alone, not before the acknowledgement, not in a chat of Tia: cards as before', { skip: POSIX }, async (t) => {
  for (const o of [{ permissionMode: 'bypassPermissions' }, { allEverything: () => false }, { byTia: true }, { hers: true }]) {
    const c = newChat(o);
    t.after(() => c.stopAndWait());
    const done = turnEnd(c);
    await c.send('rm DIR');
    const up = await card(c);
    assert.equal(up.input.command, 'rm -rf $DIR/*', JSON.stringify(Object.keys(o)));
    c.answer(up.request, { allow: false });
    await done;
    assert.equal(allowed(c).length, 0);
  }
});

test('Hands-off ON lifts nothing of the wall away in this mode: a release command that asks is allowed at once with one quiet line, and one that runs unasked leaves its line too', { skip: POSIX }, async (t) => {
  const c = newChat({ handsOff: { on: true, version: hoprigVersion(), at: Date.now() } });
  t.after(() => c.stopAndWait());
  await turn(c, 'askrule npm publish');
  assert.equal(asks(c).length, 0, 'no card');
  assert.equal(lastResult(c).text, 'ran: npm publish');
  assert.equal(allowed(c).length, 1);
  assert.equal(allowed(c)[0].by, 'all');
  await turn(c, 'run git push origin main');
  await turn(c, 'run sudo true');
  assert.equal(asks(c).length, 0);
  assert.deepEqual(allowed(c).map((e) => e.what), ['npm publish', 'git push origin main', 'sudo true']);
  await turn(c, 'run npm test');
  assert.equal(allowed(c).length, 3, 'an ordinary command leaves no line: nothing was held');
});

test('Hands-off OFF: a command that runs unasked leaves no line (nothing would have held it)', { skip: POSIX }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await turn(c, 'run npm publish');
  assert.equal(allowed(c).length, 0);
});

test('Bypass alone with Hands-off ON still holds: the release command shows a card (as before)', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', handsOff: { on: true, version: hoprigVersion(), at: Date.now() } });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('askrule npm publish');
  const up = await card(c);
  assert.equal(up.input.command, 'npm publish');
  assert.ok(up.card.held, 'the wall\'s hold');
  c.answer(up.request, { allow: false });
  await done;
});

test('the floor with Hands-off ON: the whole disk still shows a card with the floor line', { skip: POSIX }, async (t) => {
  const c = newChat({ handsOff: { on: true, version: hoprigVersion(), at: Date.now() } });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('rmpath /');
  const up = await card(c);
  assert.match(up.why, /^Held even in Allow everything: this would delete your whole disk/);
  assert.equal(up.card.held, undefined, 'the floor card does not carry Hands-off\'s wall card');
  c.answer(up.request, { allow: false });
  await done;
});

test('the mark the floor pre-check reads: there while the chat is in the mode, gone when it leaves it, never for a chat of Tia', { skip: POSIX }, async (t) => {
  const { allMarkFile } = await import('../../src/allmark.mjs');
  const { runsDir } = await import('../../src/paths.mjs');
  const c = newChat();
  t.after(() => c.stopAndWait());
  await turn(c, 'hello');
  const file = c.session.hold;
  assert.ok(file && file.startsWith(runsDir()), 'the chat has its record');
  assert.equal(fs.existsSync(allMarkFile(file)), true, 'in the mode: marked');
  await c.setSettings({ mode: 'bypassPermissions' });
  assert.equal(fs.existsSync(allMarkFile(file)), false, 'back in Bypass: not marked');
  await c.setSettings({ mode: 'allowEverything' });
  assert.equal(fs.existsSync(allMarkFile(file)), true, 'in the mode again');
  const h = newChat({ hers: true });
  t.after(() => h.stopAndWait());
  await turn(h, 'hello');
  assert.equal(fs.existsSync(allMarkFile(h.session.hold)), false, 'hers: never');
});

test('a mode the process left (plan) answers nothing', { skip: POSIX }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await turn(c, 'hello');
  await c.setSettings({ mode: 'plan' });
  c.permissionMode = 'allowEverything'; // saved as chosen, while the process runs in plan
  assert.equal(c.liveMode, 'plan');
  const done = turnEnd(c);
  await c.send('rm DIR');
  const up = await card(c);
  c.answer(up.request, { allow: false });
  await done;
  assert.equal(allowed(c).length, 0);
});

test('switching to it releases what waits', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'manual' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('run echo hi');
  await card(c);
  await c.setSettings({ mode: 'allowEverything' });
  await done;
  assert.equal(c.pending.size, 0);
  assert.equal(lastResult(c).text, 'ran: echo hi');
  assert.equal(allowed(c).length, 1);
  assert.equal(allowed(c)[0].by, 'all');
  assert.equal(c.events.filter((e) => e.kind === 'ask-closed').at(-1).outcome, 'allowed-all', 'the card that folded says who allowed it');
});
