// Who answers when Claude Code asks for an OK in a coding chat (src/chat/chat.mjs), against the stand-in Claude Code
// (fixtures/fake-claude.mjs), which asks where Claude Code 2.1.325 was seen to ask:
//   - bypassPermissions: the chat allows by itself, with no card and no "needs your OK", also after Claude entered
//     plan mode on its own. Still the owner's: a question, a plan, an "ask" rule or hook of his setup, and the stop
//     before a delete that could empty the disk. A deny rule stays denied.
//   - the other modes: "Allow in this chat" stops the next ask of the same kind (a command too, whose suggestion
//     names a settings file), holds when the process starts again, and writes no settings file.
//     Claude Code's check of a sensitive file, and an ask no rule is known to settle, are shown every time.
//   - Stop while a card is open, two cards at once.
//   - Home and the notifications hear of a new state at once, also when it comes while the sessions are being read.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chatperm');
test.after(() => box.cleanup());

const { Chat } = await import('../../src/chat/chat.mjs');
const P = await import('../../src/chat/protocol.mjs');

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
    id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] },
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, ...env }), ...o,
  });
  c.argsFile = argsFile;
  // Every state the owner would have seen, in order.
  c.seen = [];
  c.on('status', () => c.seen.at(-1) !== c.status() && c.seen.push(c.status()));
  return c;
}
const turnEnd = (c) => new Promise((r) => c.once('turn', r));
const logged = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const answers = (c) => logged(c).filter((x) => !Array.isArray(x)).map((x) => x.answer);
const asks = (c) => c.events.filter((e) => e.kind === 'ask');
const card = async (c, n = 1) => (await until(`card ${n}`, () => asks(c).length >= n && c.pending.size > 0 && asks(c))).at(-1);
/** One message that ends without the owner. */
async function turn(c, text) {
  const done = turnEnd(c);
  await c.send(text);
  return done;
}

// ---------- bypassPermissions ----------

test('bypassPermissions: what Claude Code still asks about is allowed at once, with no card and no "needs your OK"', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  // Claude enters plan mode by itself: from then on Claude Code asks before every change, in this mode too.
  const done = turnEnd(c);
  await c.send('plan inplan.txt');
  const plan = await card(c);
  assert.equal(plan.tool, 'ExitPlanMode', 'the only card is the plan');
  assert.match(plan.input.plan, /Add the thing/, 'with its text');
  assert.equal(plan.canAlways, false);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'inplan.txt'), 'utf8'), 'written in plan mode\n', 'the change in plan mode ran');
  assert.equal(c.liveMode, 'plan');
  assert.deepEqual(c.seen, ['working', 'attention'], 'never "needs your OK" before the plan itself');
  assert.deepEqual(answers(c), [{ behavior: 'allow', updatedInput: { file_path: path.join(c.cwd, 'inplan.txt'), content: 'written in plan mode\n' } }], 'allowed as asked, no rule added');
  c.answer(plan.request, { allow: true });
  await done;
  assert.equal(c.liveMode, 'bypassPermissions', 'the plan approved: back in its mode');
  assert.equal(c.status(), 'waiting');
  assert.equal(asks(c).length, 1);

  // A command asks nothing in this mode, and no card was ever pending for it. Nor does a file in .git/.
  await turn(c, 'run npm view left-pad');
  assert.equal(asks(c).length, 1);
  assert.equal(c.events.filter((e) => e.kind === 'result').at(-1).text, 'ran: npm view left-pad');
  await turn(c, 'protect .git/hooks/pre-commit');
  assert.equal(asks(c).length, 1);
  assert.ok(fs.existsSync(path.join(c.cwd, '.git', 'hooks', 'pre-commit')));
  assert.deepEqual(c.seen.slice(2), ['working', 'waiting', 'working', 'waiting', 'working', 'waiting'], 'after the plan: never "needs your OK" again');
});

test('bypassPermissions: a question to the owner is shown and its answer reaches Claude', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('question');
  const q = await card(c);
  assert.equal(q.tool, 'AskUserQuestion');
  assert.equal(c.status(), 'attention');
  c.answer(q.request, { allow: true, answers: { 'Which color?': 'Blue' } });
  await done;
  assert.equal(c.events.filter((e) => e.kind === 'text').at(-1).text, 'You chose Blue.');
});

test('bypassPermissions: the owner\'s own settings win: a deny rule stays denied, an ask rule and a hook still ask', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  // Deny: Claude Code refuses it itself; nothing asks, nothing is allowed.
  await turn(c, 'denied secret/a.txt');
  assert.equal(asks(c).length, 0);
  assert.equal(c.events.filter((e) => e.kind === 'result').at(-1).isError, true);
  assert.ok(!fs.existsSync(path.join(c.cwd, 'secret', 'a.txt')));
  assert.ok(!c.seen.includes('attention'));

  // An "ask" rule: the card, with the reason, and no "in this chat" (the rule is the owner's word each time).
  let done = turnEnd(c);
  await c.send('askrule git push origin main');
  const rule = await card(c, 1);
  assert.equal(rule.why, 'Your permission settings say to ask for this.');
  assert.equal(rule.canAlways, false);
  assert.equal(c.status(), 'attention');
  c.answer(rule.request, { allow: true, always: true });
  await done;
  assert.equal(answers(c).at(-1).updatedPermissions, undefined, '"always" adds nothing where it was not offered');
  assert.equal(c.events.filter((e) => e.kind === 'answer').at(-1).always, false);
  assert.equal(c.grants.size, 0);

  // A hook that says "ask": the card with the hook's reason; denied stays undone.
  done = turnEnd(c);
  await c.send('hook hooked.txt');
  const hook = await card(c, 2);
  assert.equal(hook.why, 'A hook asks for your OK: the hook wants a person to look');
  c.answer(hook.request, { allow: false });
  await done;
  assert.ok(!fs.existsSync(path.join(c.cwd, 'hooked.txt')));
});

test('bypassPermissions: Claude Code\'s stop before a delete that could empty the disk is the owner\'s to answer', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('rm BUILD_DIR');
  const rm = await card(c);
  assert.equal(rm.input.command, 'rm -rf $BUILD_DIR/*');
  assert.match(rm.why, /^Dangerous rm operation on possibly-empty variable path/);
  assert.equal(rm.canAlways, false);
  c.answer(rm.request, { allow: false });
  await done;
  assert.equal(c.events.filter((e) => e.kind === 'result').at(-1).isError, true);
});

test('bypassPermissions turned off by the settings: Claude Code runs in its default mode, so the cards show', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' }, { FAKE_CLAUDE_NO_BYPASS: '1' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('write a.txt');
  const ask = await card(c);
  assert.equal(c.liveMode, 'default');
  assert.equal(c.bypass, false, 'the chat allows by itself only in the mode Claude Code itself reports');
  assert.ok(!fs.existsSync(path.join(c.cwd, 'a.txt')));
  c.answer(ask.request, { allow: true });
  await done;
});

// ---------- the modes that ask ----------

test('"Allow in this chat" for a command: the same kind is not asked again, for this chat only', async (t) => {
  const c = newChat({ permissionMode: 'manual' });
  t.after(() => c.stopAndWait());
  let done = turnEnd(c);
  await c.send('run npm view left-pad');
  const ask = await card(c);
  assert.equal(ask.canAlways, true, 'offered although Claude Code\'s suggestion names a settings file');
  assert.equal(ask.always, 'rule');
  assert.equal(ask.alwaysText, 'Bash(npm view *)', 'the page says what it covers');
  assert.equal(ask.why, '');
  c.answer(ask.request, { allow: true, always: true });
  await done;
  assert.deepEqual(answers(c)[0].updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }], behavior: 'allow', destination: 'session' }], 'for the session, never a settings file');
  assert.equal(c.events.filter((e) => e.kind === 'answer').at(-1).always, true);

  // The same kind again: Claude Code does not ask.
  await turn(c, 'run npm view react');
  assert.equal(asks(c).length, 1);
  assert.equal(c.events.filter((e) => e.kind === 'result').at(-1).text, 'ran: npm view react');
  assert.ok(!c.seen.slice(2).includes('attention'));

  // Another command: asked; a plain Allow is for once.
  done = turnEnd(c);
  await c.send('run git status --short');
  const other = await card(c, 2);
  c.answer(other.request, { allow: true });
  await done;
  done = turnEnd(c);
  await c.send('run git status --short');
  const again = await card(c, 3);
  c.answer(again.request, { allow: false });
  await done;
  assert.equal(answers(c).at(-2).updatedPermissions, undefined);
});

test('"Allow in this chat" holds when the process starts again, and is kept with the chat', async (t) => {
  const c = newChat({ permissionMode: 'manual' });
  t.after(() => c.stopAndWait());
  let saved = 0;
  c.on('record', () => saved++);
  let done = turnEnd(c);
  await c.send('run npm view left-pad');
  c.answer((await card(c)).request, { allow: true, always: true });
  await done;
  done = turnEnd(c);
  await c.send('write e1.txt');
  c.answer((await card(c, 2)).request, { allow: true, always: true });
  await done;
  assert.equal(saved, 2, 'the list of open chats is saved with each one');
  assert.deepEqual(c.record().grants, ['rule:Bash:npm view *', 'mode:acceptEdits']);

  // Another effort: a new process (--resume), which has forgotten the session's rules and asks again.
  c.setNext({ effort: 'low' });
  await until('the process to stop', () => !c.child);
  const before = asks(c).length;
  await turn(c, 'run npm view react');
  await turn(c, 'write e2.txt');
  assert.equal(asks(c).length, before, 'answered from what the owner allowed in this chat: no card');
  assert.ok(fs.existsSync(path.join(c.cwd, 'e2.txt')));
  const auto = answers(c).slice(-2);
  assert.deepEqual(auto[0].updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }], behavior: 'allow', destination: 'session' }], 'the new process gets the rule again');
  assert.deepEqual(auto[1].updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  await turn(c, 'write e3.txt');
  assert.equal(answers(c).length, 4, 'and from then on Claude Code does not ask at all');

  // A dashboard restart: the chat is made again from its record.
  await c.stopAndWait();
  const again = newChat({ ...c.record(), cwd: c.cwd });
  t.after(() => again.stopAndWait());
  await turn(again, 'run npm view vue');
  assert.equal(asks(again).length, 0);
  // What was not allowed still asks.
  const done2 = turnEnd(again);
  await again.send('run git push origin main');
  const ask = await card(again);
  assert.equal(ask.alwaysText, 'Bash(git push *)');
  again.answer(ask.request, { allow: false });
  await done2;
});

test('a sensitive file asks every time: no "in this chat" on its card, and "all edits" allowed before does not answer it', async (t) => {
  const c = newChat({ permissionMode: 'manual' });
  t.after(() => c.stopAndWait());
  const hook = path.join(c.cwd, '.git', 'hooks', 'pre-commit');
  // In the default mode Claude Code suggests "edits without asking" for it too. That would not stop the next such
  // ask, so the card does not offer it.
  let done = turnEnd(c);
  await c.send('protect .git/hooks/pre-commit');
  const first = await card(c);
  assert.equal(first.canAlways, false);
  assert.match(first.why, /which is a sensitive file\.$/);
  c.answer(first.request, { allow: true, always: true });
  await done;
  assert.equal(answers(c).at(-1).updatedPermissions, undefined, 'allowed for this once');
  assert.equal(c.grants.size, 0);
  assert.ok(fs.existsSync(hook));
  fs.rmSync(hook);

  // The owner allows all edits in this chat. A sensitive file still asks, in the same process …
  done = turnEnd(c);
  await c.send('write e1.txt');
  c.answer((await card(c, 2)).request, { allow: true, always: true });
  await done;
  assert.deepEqual(c.record().grants, ['mode:acceptEdits']);
  done = turnEnd(c);
  await c.send('protect .git/hooks/pre-commit');
  c.answer((await card(c, 3)).request, { allow: false });
  await done;

  // … and in a new one, where Claude Code suggests exactly what the chat remembers: shown, not answered from it.
  c.setNext({ effort: 'low' });
  await until('the process to stop', () => !c.child);
  done = turnEnd(c);
  await c.send('protect .git/hooks/pre-commit');
  const again = await card(c, 4);
  assert.equal(again.canAlways, false);
  assert.equal(c.status(), 'attention');
  assert.ok(!fs.existsSync(hook), 'not written before the owner says so');
  c.answer(again.request, { allow: false });
  await done;
  assert.ok(!fs.existsSync(hook));
  // A plain edit in that new process is answered from what the chat remembers.
  await turn(c, 'write e2.txt');
  assert.equal(asks(c).length, 4);
  assert.ok(fs.existsSync(path.join(c.cwd, 'e2.txt')));
});

test('an ask no rule is known to settle is shown every time, whatever was allowed in this chat', async (t) => {
  const c = newChat({ permissionMode: 'auto' });
  t.after(() => c.stopAndWait());
  let done = turnEnd(c);
  await c.send('judged npm view left-pad');
  const first = await card(c);
  assert.equal(first.alwaysText, 'Bash(npm view *)', 'Claude Code\'s suggestion is offered as it is');
  c.answer(first.request, { allow: true, always: true });
  await done;
  assert.deepEqual(c.record().grants, ['rule:Bash:npm view *']);
  done = turnEnd(c);
  await c.send('judged npm view react');
  const again = await card(c, 2);
  assert.equal(c.status(), 'attention', 'a card, not an answer from what the chat remembers');
  c.answer(again.request, { allow: false });
  await done;
  assert.equal(c.events.filter((e) => e.kind === 'result').at(-1).isError, true);
});

test('Stop while a card is open: the card closes, the turn ends, the chat waits', async (t) => {
  const c = newChat({ permissionMode: 'manual' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('run git push origin main');
  const ask = await card(c);
  assert.equal(c.interrupt(), true);
  assert.equal(c.pending.size, 0, 'closed at once, before Claude Code confirms');
  const d = await done;
  assert.equal(d.subtype, 'error_during_execution');
  assert.equal(c.status(), 'waiting');
  assert.deepEqual(c.events.filter((e) => e.kind === 'answer').map((e) => [e.request, e.cancelled]), [[ask.request, true]], 'once, although Claude Code takes the ask back too');
  assert.throws(() => c.answer(ask.request, { allow: true }), /already answered/);
  assert.equal(answers(c).length, 0, 'nothing was allowed');
  // The chat goes on.
  await turn(c, 'still there?');
  assert.equal(c.events.filter((e) => e.kind === 'text').at(-1).text, 'echo: still there?');
});

test('two cards at once: each is answered by itself; the status says "needs your OK" until the last', async (t) => {
  const c = newChat({ permissionMode: 'manual' });
  t.after(() => c.stopAndWait());
  const out = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'outside-')));
  fs.writeFileSync(path.join(out, 'a.txt'), 'A');
  fs.writeFileSync(path.join(out, 'b.txt'), 'B');
  const done = turnEnd(c);
  await c.send(`reads ${path.join(out, 'a.txt')} ${path.join(out, 'b.txt')}`);
  await until('two cards', () => c.pending.size === 2);
  const [a, b] = asks(c);
  assert.equal(a.why, 'Path is outside allowed working directories');
  c.answer(a.request, { allow: true });
  assert.equal(c.status(), 'attention', 'one still waits');
  assert.deepEqual([...c.pending.keys()], [b.request]);
  c.answer(b.request, { allow: false });
  assert.equal(c.status(), 'working');
  await done;
  assert.equal(c.events.filter((e) => e.kind === 'text').at(-1).text, 'Read 1 of 2.');
});

// ---------- Home and the notifications ----------

test('a new state that comes while the sessions are being read is seen by one more look right after', async () => {
  const { Watcher } = await import('../../src/server/watcher.mjs');
  const looks = [];
  const w = new Watcher({
    cards: () => new Promise((resolve) => looks.push(() => resolve([]))),
    deck: {}, auto: { getAutoSwitch: () => ({ enabled: false }) }, settings: () => ({}), log: () => {}, send: async () => ({}), tickMs: 60_000,
  });
  w.stopped = false; // as start() does, without its first look a second later
  try {
    // A look with nothing new: the next one is a slow one.
    let look = w.tick();
    looks.shift()();
    await look;
    assert.ok(w.nextAt - Date.now() > 50_000, 'nothing to hurry for');
    // A chat asks for an OK while a look is under way (its sessions were already read).
    look = w.tick();
    w.poke();
    looks.shift()();
    await look;
    assert.ok(w.nextAt - Date.now() <= 250, 'looked at again right away, not half a minute later');
    await until('that look', () => looks.length === 1, 2000);
    looks.shift()();
  } finally {
    w.stop();
  }
});

// ---------- the protocol ----------

test('protocol: what an ask says about itself, and who must answer it', () => {
  const ask = (more) => P.parseLine({ type: 'control_request', request_id: 'R', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' }, tool_use_id: 't', ...more } })[0];
  assert.equal(P.ownerOnly(ask({})), null);
  assert.equal(P.ownerOnly(ask({ decision_reason_type: 'mode' })), null, 'plan mode is not the owner\'s word');
  assert.equal(P.ownerOnly(ask({ decision_reason_type: 'safetyCheck', classifier_approvable: true })), null);
  assert.equal(P.ownerOnly(ask({ requires_user_interaction: true })), 'question');
  assert.equal(P.ownerOnly(ask({ tool_name: 'AskUserQuestion' })), 'question', 'by its name too, where Claude Code does not mark it');
  assert.equal(P.ownerOnly(ask({ tool_name: 'ExitPlanMode' })), 'question');
  assert.equal(P.ownerOnly(ask({ decision_reason_type: 'rule' })), 'rule');
  assert.equal(P.ownerOnly(ask({ decision_reason_type: 'other', matched_ask_rule: { source: 'userSettings', tool_name: 'Bash' } })), 'rule', 'an ask rule behind another reason');
  assert.equal(P.ownerOnly(ask({ decision_reason_type: 'hook' })), 'hook');
  assert.equal(P.ownerOnly(ask({ decision_reason_type: 'subcommandResults', classifier_approvable: false })), 'safety');
  // The reason is text of Claude Code or a hook: shown plain, without escape sequences.
  assert.equal(ask({ decision_reason_type: 'hook', decision_reason: '\u001b[31mlook\u001b[0m\nhere' }).reason, 'look here');
  assert.equal(P.askWhy(ask({ decision_reason_type: 'mode' })), 'Claude is in plan mode, where it asks before it changes anything.');
  assert.equal(P.askWhy(ask({ decision_reason_type: 'other', decision_reason: 'This command requires approval' })), '', 'nothing the card does not already say');
  assert.deepEqual(P.parseLine({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' }), [{ kind: 'mode', permissionMode: 'plan' }]);
  assert.deepEqual(P.parseLine({ type: 'system', subtype: 'status', status: 'compacting' }), []);
});

test('protocol: "allow in this chat" takes only what asks less, and only for the session', () => {
  const g = P.sessionGrant([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cd /tmp && ls' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' },
    { type: 'addDirectories', directories: ['/work/other'], destination: 'userSettings' },
    { type: 'addRules', rules: [{ toolName: 'mcp__echo__echo' }], behavior: 'allow', destination: 'projectSettings' },
  ]);
  assert.ok(g.updates.every((u) => u.destination === 'session'));
  assert.deepEqual(g.atoms, ['rule:Bash:cd /tmp && ls', 'rule:Read://tmp/**', 'dir:/work/other', 'rule:mcp__echo__echo:']);
  assert.equal(g.text, 'Bash(cd /tmp && ls), Read(//tmp/**), the folder /work/other, mcp__echo__echo');
  assert.equal(g.edits, false);
  assert.equal(P.sessionGrant([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]).edits, true);
  // Never another mode, a deny or ask rule, a removal, or something unknown.
  assert.equal(P.sessionGrant([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]), null);
  assert.equal(P.sessionGrant([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }]), null);
  assert.equal(P.sessionGrant([{ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }]), null);
  assert.equal(P.sessionGrant([{ type: 'addRules', rules: [{ toolName: 7 }], behavior: 'allow', destination: 'session' }]), null);
  assert.equal(P.sessionGrant([]), null);
  assert.equal(P.sessionGrant(undefined), null);
  const line = JSON.parse(P.allowLine('r', { a: 1 }, g.updates));
  assert.deepEqual(line.response.response.updatedPermissions, g.updates);
});
