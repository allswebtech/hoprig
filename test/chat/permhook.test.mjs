// A coding chat's Claude Code gets the PermissionRequest hook of a terminal session (src/chat/engines/claude.mjs), so
// that in bypass mode one rule, read with the folder the shell is really in, answers a plain delete for the App and the
// Terminal alike (src/hook.mjs, src/asking.mjs). Against the stand-in Claude Code (fixtures/fake-claude.mjs), which runs
// the hook as Claude Code 2.1.326 does in this mode: at the same moment as its can_use_tool request, taken back when the
// hook allows. What is checked:
//   - the start line carries the hook (a settings file) for a Claude Code that knows the event, and not for an older one
//   - the chat answers nothing by itself for Claude Code with the hook: the hook does, and a relative target is read in
//     the shell's folder (also after a cd); no card and no "needs your OK" for it; what it allowed is in the chat
//   - what the hook does not answer is the owner's card, Allow and Do not allow work
//   - an older Claude Code: the chat answers as before (absolute targets only)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chathook');
test.after(() => box.cleanup());
const POSIX = process.platform === 'win32' ? 'the hook command is written for a POSIX shell here' : false;

const { Chat } = await import('../../src/chat/chat.mjs');
const P = await import('./protocol.mjs');
const A = await import('../../src/chat/asks.mjs');
const { hookSettingsDir } = await import('../../src/paths.mjs');
const R = await import('../../src/runs.mjs');
const { applyHook } = await import('../../src/hook.mjs');

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
  const cwd = o.cwd || fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({
    id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, hookWaitMs: 400,
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, ...env }), ...o,
  });
  c.argsFile = argsFile;
  c.seen = [];
  c.on('status', () => c.seen.at(-1) !== c.status() && c.seen.push(c.status()));
  return c;
}
const turnEnd = (c) => new Promise((r) => c.once('turn', r));
const logged = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const answers = (c) => logged(c).filter((x) => x.answer).map((x) => x.answer);
const asks = (c) => c.events.filter((e) => e.kind === 'ask');
const allowed = (c) => c.events.filter((e) => e.kind === 'allowed').map((e) => `${e.tool}: ${e.what}`);
const lastResult = (c) => c.events.filter((e) => e.kind === 'tool-result').at(-1);
const card = async (c, n = 1) => (await until(`card ${n}`, () => asks(c).length >= n && c.pending.size > 0 && asks(c))).at(-1);
async function turn(c, text) {
  const done = turnEnd(c);
  await c.send(text);
  return done;
}
const hooked = (version) => ({ engineOpts: { version } });

test('the start line: the hook in a settings file for a Claude Code that knows the event, nothing new for an older or unknown one', { skip: POSIX }, async (t) => {
  for (const [version, wants] of [['2.1.326', true], ['2.1.319', true], ['2.1.318', false], [null, false]]) {
    const c = newChat({ permissionMode: 'bypassPermissions', grants: ['rule:Bash:npm view *'], ...hooked(version) });
    t.after(() => c.stopAndWait());
    await turn(c, 'hello');
    const argv = logged(c).find(Array.isArray);
    const given = argv[argv.indexOf('--settings') + 1];
    if (wants) {
      // A file beside the run records, as a terminal's (the hook reads its "ask" rules there), holding the chat's
      // remembered rules too, and the hook program of a terminal session.
      assert.equal(path.dirname(given), hookSettingsDir(), version);
      const s = JSON.parse(fs.readFileSync(given, 'utf8'));
      // PermissionRequest answers; the four stop events only write how a provider stopped it (hook.mjs CHAT_KEEPS).
      // Hands-off is offered by default now, so a versioned chat also carries the wall's gated PreToolUse hold.
      assert.deepEqual(Object.keys(s.hooks), ['PermissionRequest', 'SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse']);
      // Every hook but the gated wall is exactly the hook program and ends there: the end-anchor keeps a stray tail
      // out. PreToolUse is the wall's gated form (handsoff-active marker ... then the hook ... ; fi), checked on its
      // own just below, so it is the one key the anchored match leaves out.
      for (const [name, e] of Object.entries(s.hooks)) if (name !== 'PreToolUse') assert.match(e[0].hooks[0].command, /hoprig-hook\.mjs'$/, name);
      assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /hoprig-hook\.mjs'$/);
      assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes('handsoff-active') && s.hooks.PreToolUse[0].hooks[0].command.includes('hoprig-hook.mjs'), 'the wall hold is gated by the cheap marker and calls the hook');
      assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
      assert.deepEqual(s.permissions.allow, ['Bash(npm view *)']);
      assert.equal(path.basename(given), path.basename(c.session.hold), 'named after the chat\'s run record');
      assert.equal(c.session.hooked, true);
    } else {
      assert.deepEqual(JSON.parse(given), { permissions: { allow: ['Bash(npm view *)'] } }, String(version));
      assert.equal(c.session.hooked, false);
    }
    const file = given;
    await c.stopAndWait();
    if (wants) assert.ok(!fs.existsSync(file), 'the settings file goes with the process');
  }
});

test('bypass with the hook: a plain delete runs unasked, read in the shell\'s folder, and shows in the chat as allowed by Hoprig; the chat answers nothing itself', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', ...hooked('2.1.326') });
  t.after(() => c.stopAndWait());
  await turn(c, 'rmrel t1/*/*');
  assert.equal(lastResult(c).text, 'ran: rm -rf t1/*/*');
  // An absolute target inside the folder: the hook too, not the chat.
  await turn(c, `rmpath ${c.cwd}/build/*`);
  assert.equal(lastResult(c).text, `ran: rm -rf ${c.cwd}/build/*`);
  // After a cd the hook's event names the new folder, and a relative target is read there.
  fs.mkdirSync(path.join(c.cwd, 'sub'));
  await turn(c, 'cd sub');
  await turn(c, 'rmrel t1/*/*');
  assert.equal(lastResult(c).text, 'ran: rm -rf t1/*/*');
  assert.deepEqual(logged(c).filter((x) => x.hook).map((x) => x.hook.cwd), [c.cwd, c.cwd, path.join(c.cwd, 'sub')]);
  await until('the allowed lines', () => allowed(c).length === 3);
  assert.deepEqual(allowed(c), ['Bash: rm -rf t1/*/*', `Bash: rm -rf ${c.cwd}/build/*`, 'Bash: rm -rf t1/*/*']);
  assert.deepEqual(answers(c), [], 'the chat answered nothing by itself');
  assert.equal(asks(c).length, 0, 'no card');
  assert.ok(!c.seen.includes('attention'), 'never "needs your OK"');
});

test('bypass with the hook: what the hook does not answer is the owner\'s card, and Allow and Do not allow reach Claude Code', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', ...hooked('2.1.326') });
  t.after(() => c.stopAndWait());
  let done = turnEnd(c);
  await c.send('rmrel ..');
  const up = await card(c);
  assert.equal(up.input.command, 'rm -rf ..');
  c.answer(up.request, { allow: false });
  await done;
  assert.equal(lastResult(c).ok, false);
  done = turnEnd(c);
  await c.send('rm DIR');
  const v = await card(c, 2);
  assert.equal(v.input.command, 'rm -rf $DIR/*');
  c.answer(v.request, { allow: true });
  await done;
  assert.equal(lastResult(c).text, 'ran: rm -rf $DIR/*');
  done = turnEnd(c);
  await c.send('rmpath ~');
  const home = await card(c, 3);
  c.answer(home.request, { allow: false });
  await done;
  assert.deepEqual(answers(c).map((a) => a.behavior), ['deny', 'allow', 'deny']);
  assert.deepEqual(allowed(c), []);
  // A question is shown as before (the hook never answers one).
  done = turnEnd(c);
  await c.send('question');
  const q = await card(c, 4);
  assert.equal(q.tool, 'AskUserQuestion');
  c.answer(q.request, { allow: true, answers: { 'Which color?': 'Blue' } });
  await done;
});

test('the same chat in the default mode asks as before: the hook answers nothing there', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'manual', ...hooked('2.1.326') });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('rmrel t1/*/*');
  const ask = await card(c);
  assert.equal(ask.input.command, 'rm -rf t1/*/*');
  c.answer(ask.request, { allow: false });
  await done;
  assert.deepEqual(allowed(c), []);
});

test('an older Claude Code (no hook): the chat answers the rule itself, absolute targets only', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', ...hooked('2.1.300') });
  t.after(() => c.stopAndWait());
  await turn(c, `rmpath ${c.cwd}/build/*`);
  assert.equal(lastResult(c).text, `ran: rm -rf ${c.cwd}/build/*`);
  assert.deepEqual(answers(c).map((a) => a.behavior), ['allow']);
  const done = turnEnd(c);
  await c.send('rmrel t1/*/*');
  const rel = await card(c);
  c.answer(rel.request, { allow: false });
  await done;
  assert.deepEqual(logged(c).filter((x) => x.hook), []);
});

test('switching to bypass with the hook: the chat allows nothing that waits; the hook answers new asks', () => {
  const answered = [];
  const chat = { cwd: path.join(box.root, 'w'), engine: { id: 'claude' }, pending: new Map(), held: new Map(), allowedShown: new Set(), push() {}, changed() {}, session: { hooked: true, answer: (r) => answered.push(r) } };
  const rm = (request, command) => P.parseLine({ type: 'control_request', request_id: request, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, tool_use_id: request, decision_reason_type: 'safetyCheck', classifier_approvable: false } })[0];
  chat.pending.set('inside', rm('inside', `rm -rf ${chat.cwd}/build/*/*`));
  A.allowPending(chat);
  assert.deepEqual(answered, []);
  // An ask that arrives in bypass waits for the hook (no card yet), then shows when the hook said nothing.
  Object.assign(chat, { bypass: true, liveMode: 'bypassPermissions', grants: new Set(), o: { hookWaitMs: 50 } });
  A.askArrived(chat, rm('later', `rm -rf ${chat.cwd}/x`));
  assert.deepEqual([[...chat.held.keys()], chat.pending.size], [['later'], 1]);
  return until('the card after the wait', () => chat.pending.has('later'));
});

test('an allow of the hook that came after the owner\'s own answer is not shown: Claude Code honoured his answer', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', hookWaitMs: 200, ...hooked('2.1.326') }, { FAKE_CLAUDE_HOOK_DELAY_MS: '1500' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('rmrel t1/*/*');
  const ask = await card(c);
  c.answer(ask.request, { allow: false });
  await done;
  assert.equal(lastResult(c).ok, false, 'his Deny held');
  // The hook allowed later and wrote it down; the chat shows no line for a command that never ran.
  await until('the hook\'s late entry', () => (R.readRun(c.session.hold)?.allowed || []).length === 1, 5000);
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(allowed(c), []);
  // The next allow that is taken back shows only itself, not the late one before it.
  await turn(c, `rmpath ${c.cwd}/build/*`);
  await until('the allowed line', () => allowed(c).length >= 1, 5000);
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(allowed(c), [`Bash: rm -rf ${c.cwd}/build/*`]);
});

test('two allows of the same moment are each shown once, each for the request taken back with its command', () => {
  const { file } = R.createChatRun({ chat: 'c2', conversation: crypto.randomUUID(), cwd: '/w/p', profile: 'p' });
  const pushed = [];
  const chat = { engine: { id: 'claude' }, held: new Map(), pending: new Map(), allowedShown: new Set(), push: (e) => pushed.push(e), changed() {}, session: { hooked: true, hold: file } };
  const ev = (request, command) => P.parseLine({ type: 'control_request', request_id: request, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, tool_use_id: request, decision_reason_type: 'safetyCheck' } })[0];
  const pe = (command) => ({ hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command } });
  const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  for (const cmd of ['rm -rf a/*', 'rm -rf a/*', 'rm -rf b']) applyHook(file, pe(cmd), 100, allow);
  for (const [r, cmd] of [['r1', 'rm -rf a/*'], ['r2', 'rm -rf a/*'], ['r3', 'rm -rf b']]) chat.held.set(r, { timer: null, ev: ev(r, cmd) });
  chat.pending.set('r4', ev('r4', 'rm -rf never-allowed'));
  for (const r of ['r3', 'r1', 'r2', 'r4']) A.askCancelled(chat, r);
  assert.deepEqual(pushed.filter((e) => e.kind === 'allowed').map((e) => e.what), ['rm -rf b', 'rm -rf a/*', 'rm -rf a/*']);
  // A request taken back that the hook did not allow (a stop) gets no line.
  assert.ok(!pushed.some((e) => e.kind === 'allowed' && e.what === 'rm -rf never-allowed'));
  R.removeRun(file);
});

test('a chat\'s settings file goes with its run record, and one left by a dashboard stopped by a signal goes at the next start', async () => {
  const keep = R.createChatRun({ chat: 'c3', conversation: crypto.randomUUID(), cwd: '/w/p', profile: 'p' });
  const gone = R.createChatRun({ chat: 'c4', conversation: crypto.randomUUID(), cwd: '/w/p', profile: 'p' });
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  const settingsOf = (f) => path.join(hookSettingsDir(), path.basename(f));
  for (const f of [keep.file, gone.file]) fs.writeFileSync(settingsOf(f), '{}');
  fs.writeFileSync(path.join(hookSettingsDir(), 'notes.txt'), 'not ours');
  R.removeRun(gone.file);
  assert.ok(!fs.existsSync(settingsOf(gone.file)), 'removed with its record');
  // A record removed without its settings file (the process was killed): the next start removes the file.
  fs.writeFileSync(settingsOf(gone.file), '{}');
  const { chatFeature } = await import('../../src/chat/feature.mjs');
  const f = chatFeature({ HttpError: Error, config: () => ({ server: { roots: [] } }), readJson: async () => ({}) }, { file: path.join(box.root, 'chats-x.json') });
  assert.ok(fs.existsSync(settingsOf(gone.file)), 'nothing removed while the feature is only built');
  f.start(); // the dashboard listens
  assert.deepEqual([fs.existsSync(settingsOf(gone.file)), fs.existsSync(settingsOf(keep.file)), fs.existsSync(path.join(hookSettingsDir(), 'notes.txt'))], [false, true, true]);
  R.removeRun(keep.file);
});

test('a hook slower than the hold: the card that showed closes as allowed by Hoprig, and the allowed line comes', { skip: POSIX }, async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', hookWaitMs: 150, ...hooked('2.1.326') }, { FAKE_CLAUDE_HOOK_DELAY_MS: '900' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('rmrel t1/*/*');
  const ask = await card(c);
  assert.equal(c.status(), 'attention');
  await done;
  assert.equal(lastResult(c).text, 'ran: rm -rf t1/*/*');
  assert.equal(c.events.find((e) => e.kind === 'ask-closed' && e.request === ask.request).outcome, 'hoprig');
  await until('the allowed line', () => allowed(c).length === 1, 3000);
  assert.deepEqual(answers(c), [], 'the chat answered nothing itself');
});

test('the allowed line names the folder it ran in when not the chat\'s, and is there again after a restart', { skip: POSIX }, async (t) => {
  const turnsDir = path.join(box.root, `turns-${crypto.randomUUID()}`);
  const c = newChat({ permissionMode: 'bypassPermissions', turnsDir, ...hooked('2.1.326') });
  t.after(() => c.stopAndWait());
  fs.mkdirSync(path.join(c.cwd, 'sub'));
  await turn(c, 'cd sub');
  await turn(c, 'rmrel t1/*/*');
  await until('the allowed line', () => c.events.some((e) => e.kind === 'allowed'), 3000);
  const line = c.events.find((e) => e.kind === 'allowed');
  assert.deepEqual([line.tool, line.what, line.folder], ['Bash', 'rm -rf t1/*/*', 'sub']);
  await c.stopAndWait();
  // The same conversation opened again (a dashboard restart): the line is back, after its tool call.
  const again = newChat({ cwd: c.cwd, id: c.id, conversationId: c.conversationId, turnsDir, permissionMode: 'bypassPermissions', ...hooked('2.1.326') });
  t.after(() => again.stopAndWait());
  const i = again.events.findIndex((e) => e.kind === 'allowed');
  assert.ok(i > 0, 'kept');
  assert.equal(again.events[i - 1].kind, 'tool');
  assert.deepEqual([again.events[i].what, again.events[i].folder], ['rm -rf t1/*/*', 'sub']);
});

test('after the process starts again (a new record, numbered from 1), the next allow is shown too', () => {
  const pushed = [];
  const chat = { engine: { id: 'claude' }, held: new Map(), pending: new Map(), allowedShown: new Set(), push: (e) => pushed.push(e), changed() {}, session: null };
  const ev = (request, command) => P.parseLine({ type: 'control_request', request_id: request, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, tool_use_id: request, decision_reason_type: 'safetyCheck' } })[0];
  const pe = { hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'rm -rf a/*' } };
  const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  for (const r of ['first', 'second']) {
    const { file } = R.createChatRun({ chat: 'c5', conversation: crypto.randomUUID(), cwd: '/w/p', profile: 'p' });
    applyHook(file, pe, 100, allow); // each new record's first entry is number 1
    chat.session = { hooked: true, hold: file };
    chat.held.set(r, { timer: null, ev: ev(r, 'rm -rf a/*') });
    A.askCancelled(chat, r);
    R.removeRun(file);
  }
  assert.equal(pushed.filter((e) => e.kind === 'allowed').length, 2);
});
