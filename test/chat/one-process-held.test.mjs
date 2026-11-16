// One record of who runs a conversation, piece by piece (the whole of it end to end: one-process-record.test.mjs):
// the records of the launcher and of a chat in one folder (runs.mjs), who came first, the launcher's refusal and its
// words (held.mjs), a chat that starts nothing when a launcher came first (chat/run.mjs), the start's mark that ends
// the dashboard's note when the terminal is back at its shell (deck.mjs, backends), and two moves at the same moment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CHAT = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('held');
test.after(() => box.cleanup());
// Records written here must not name the terminal this test runs in (a tmux pane of the person running it).
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];

const R = await import('../../src/runs.mjs');
const { binFile } = await import('../../src/paths.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { shellLine, CLEAR } = await import('../../src/server/backends/shell.mjs');
const { PtyBackend, startPlan, termEnv } = await import('../../src/server/backends/pty.mjs');

const ID = '0f4d6a52-8a7e-4b8e-9d55-2f8c2d1e6b01';
const clear = () => fs.rmSync(path.join(box.state, 'runs'), { recursive: true, force: true });
const withEnv = (vars, fn) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

test('a chat\'s record sits with the launchers\' records, but only the readers of "who runs it" list it', () => {
  clear();
  const term = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  const chat = R.createChatRun({ chat: 'c1', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
  assert.deepEqual(R.listRuns().map((r) => r.runId), [term.run.runId], 'the cards, the watcher, the coding tools\' servers see launchers only');
  assert.deepEqual(R.listRuns({ chats: true }).map((r) => r.kind || 'terminal').sort(), ['chat', 'terminal']);
  assert.equal(R.runsConversation(chat.run, ID), true);
  assert.equal(R.runsConversation(chat.run, ID, 'opencode'), false, 'by coding tool and id');
  // Who was first keeps it: the later one sees the earlier, the earlier sees nobody before it.
  assert.equal(R.heldBefore(chat.run, ID).runId, term.run.runId);
  assert.equal(R.heldBefore(term.run, ID), null);
  // The same millisecond: the run ids decide, the same way for both.
  const a = { ...term.run, startedAt: 5, runId: 'a' };
  const b = { ...chat.run, startedAt: 5, runId: 'b' };
  fs.writeFileSync(term.file, JSON.stringify(a));
  fs.writeFileSync(chat.file, JSON.stringify(b));
  assert.equal(R.heldBefore(b, ID).runId, 'a');
  assert.equal(R.heldBefore(a, ID), null);
  // A record whose process is dead never counts, nor one that has ended.
  fs.writeFileSync(term.file, JSON.stringify({ ...a, pid: 2 ** 22 + 7 }));
  assert.equal(R.heldBefore(b, ID), null);
  R.removeRun(chat.file);
  // The launcher's own move writes its record anew and keeps when it first held the conversation.
  const first = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  const again = R.createRun({ profile: 'backup', cwd: box.root, conversation: ID, file: first.file });
  assert.equal(again.run.startedAt, first.run.startedAt);
  clear();
});

test('the launcher from a plain shell: a chat or another terminal on the conversation keeps it, said in one sentence', () => {
  clear();
  const fake = path.join(box.root, 'claude-started.sh');
  const started = path.join(box.root, 'claude-started');
  fs.writeFileSync(fake, `#!/bin/sh\ntouch '${started}'\n`, { mode: 0o755 });
  saveConfig({ claudeBin: fake, usage: false });
  writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const env = { ...process.env };
  for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete env[k];
  const launch = (args) => spawnSync(process.execPath, [binFile(), ...args], { cwd: box.root, env, encoding: 'utf8' });

  const chat = R.createChatRun({ chat: 'c1', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
  for (const args of [['work', '--resume', ID], ['work', `--session-id=${ID}`], ['run', 'nope', '-r', ID]]) {
    const r = launch(args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr, 'hoprig: this conversation is open in a chat in the dashboard. Close that chat, or choose "Open in terminal" in its menu.\n', args.join(' '));
    assert.equal(fs.existsSync(started), false, 'Claude Code was not started');
    assert.deepEqual(R.listRuns({ chats: true }).map((x) => x.kind), ['chat'], 'the refused launcher left no record');
  }
  R.removeRun(chat.file);

  // Another terminal: the dashboard's name of it when it has one, else its process.
  const named = withEnv({ HOPRIG_TERM_NAME: 'proj-a', HOPRIG_TERM_ID: 'pty-0123456789ab' }, () => R.createRun({ profile: 'work', cwd: box.root, conversation: ID }));
  let r = launch(['work', '--resume', ID]);
  assert.equal(r.stderr, 'hoprig: this conversation runs in the terminal session "proj-a". Stop Claude Code there first, or open that session as a chat and choose "Continue here".\n');
  R.removeRun(named.file);
  const bare = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  r = launch(['work', '--resume', ID]);
  assert.equal(r.stderr, `hoprig: this conversation runs in another terminal (process ${process.pid}). Stop Claude Code there first.\n`);
  R.removeRun(bare.file);

  // Nothing runs it: the launcher starts Claude Code; a start that is refused for another reason holds nothing.
  r = launch(['work', '--resume', ID]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(started), true);
  r = launch(['run', 'nope', '--resume', ID]);
  assert.match(r.stderr, /no profile "nope"/);
  assert.deepEqual(R.listRuns({ chats: true }), []);
  clear();
});

test('the launcher of another coding tool asks too, before any check that can refuse the start', async () => {
  clear();
  const T = await import('../../src/codetools/terminal.mjs');
  const sid = 'ses_abcdefgh12345678';
  const chat = R.createChatRun({ chat: 'c2', conversation: sid, tool: 'opencode', cwd: box.root, profile: 'nope' });
  await new Promise((r) => setTimeout(r, 5)); // the launcher comes later (in the same millisecond the run ids decide)
  const said = [];
  const err = console.error;
  console.error = (...x) => said.push(x.join(' '));
  let code;
  try {
    code = await T.launchTool('opencode', 'nope', ['--resume', sid], { cwd: box.root });
  } finally {
    console.error = err;
  }
  assert.equal(code, 2);
  assert.deepEqual(said, ['hoprig: this conversation is open in a chat in the dashboard. Close that chat, or choose "Open in terminal" in its menu.']);
  R.removeRun(chat.file);
  console.error = (...x) => said.push(x.join(' '));
  try {
    code = await T.launchTool('opencode', 'nope', ['--resume', sid], { cwd: box.root });
  } finally {
    console.error = err;
  }
  assert.equal(code, 2);
  assert.match(said.at(-1), /no provider "nope"/);
  assert.deepEqual(R.listRuns({ chats: true }), [], 'a refused start holds nothing');
  clear();
});

test('a chat holds its conversation by a record while its process runs, and starts nothing when a launcher came first', async () => {
  clear();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE_CHAT] }, resolveEnv: async () => ({ ...process.env }) });
  const done = new Promise((r) => c.once('turn', r));
  await c.send('hello');
  await done;
  const mine = R.listRuns({ chats: true });
  assert.deepEqual(mine.map((r) => [r.kind, r.chat, r.conversation, r.pid]), [['chat', c.id, c.conversationId, process.pid]]);
  await c.stopAndWait();
  assert.deepEqual(R.listRuns({ chats: true }), [], 'gone with its process');

  // A launcher wrote its record first (a terminal outside the dashboard, at the same moment as this message).
  const term = R.createRun({ profile: 'p', cwd, conversation: c.conversationId });
  await c.send('second');
  assert.equal(c.session, null, 'no process');
  assert.match(c.events.at(-1).error, /This conversation runs in a terminal now/);
  assert.deepEqual(R.listRuns({ chats: true }).map((r) => r.runId), [term.run.runId], 'and no record of the chat\'s');
  R.removeRun(term.file);
  await c.close();
  clear();
});

test('the start\'s mark: the shell removes it after the launcher, or when the launcher could not start', { skip: process.platform === 'win32' && 'POSIX shells' }, () => {
  const mark = path.join(box.root, '.start-x');
  assert.equal(shellLine('/w', ['/n', 'a b'], { mark }), `${CLEAR}; cd /w && /n 'a b'; rm -f ${mark}`);
  assert.equal(shellLine('/w', ['/n']), `${CLEAR}; cd /w && /n`, 'no mark, the same line as before');
  for (const [dir, argv] of [[box.root, ['true']], [box.root, ['false']], [path.join(box.root, 'gone'), ['true']], [box.root, [path.join(box.root, 'no-such-program')]]]) {
    fs.writeFileSync(mark, '');
    spawnSync('/bin/sh', ['-c', shellLine(dir, argv, { mark })], { stdio: 'ignore' });
    assert.equal(fs.existsSync(mark), false, `${dir} ${argv}`);
  }
});

test('the start\'s mark on Windows: the built-in terminal removes it when its command exits', async () => {
  const mark = path.join(box.root, '.start-win');
  fs.writeFileSync(mark, '');
  const plan = startPlan({ platform: 'win32', dir: 'C:\\w', argv: ['node.exe', 'hoprig.mjs', 'work'], mark });
  assert.equal(plan.mark, mark);
  assert.equal(startPlan({ platform: 'linux', dir: '/w', argv: ['/n'], mark, shell: { file: '/bin/sh', args: ['-l'] } }).type, shellLine('/w', ['/n'], { mark }));
  const procs = [];
  const spawn = (file) => {
    const exits = [];
    const p = { pid: 4242, file, onData() {}, onExit: (fn) => exits.push(fn), write() {}, resize() {}, kill() { for (const f of exits) f({ exitCode: 0 }); }, exit: (code) => exits.forEach((f) => f({ exitCode: code })) };
    procs.push(p);
    return p;
  };
  const b = new PtyBackend({ platform: 'win32', spawn, descendants: async () => [] });
  await b.create({ name: 'w1', dir: 'C:\\w', argv: ['node.exe', 'hoprig.mjs', 'work'], mark });
  assert.equal(fs.existsSync(mark), true, 'while the launcher runs');
  procs[0].exit(2);
  assert.equal(fs.existsSync(mark), false, 'gone with it; the terminal goes on as PowerShell');
  assert.equal(procs[1].file, 'powershell.exe');
  await b.close();
  assert.equal(termEnv('pty-1', 'linux', {}, 'proj').HOPRIG_TERM_NAME, 'proj');
  assert.equal('HOPRIG_TERM_NAME' in termEnv('pty-1', 'linux', { HOPRIG_TERM_NAME: 'outer' }), false, 'never the name of a terminal around the dashboard');
});

test('the dashboard\'s note of a start ends when the terminal is back at its shell; two moves at once start one launcher', async () => {
  clear();
  const respawns = [];
  const terms = [{ session: 'proj', id: 'pty-aaaaaaaaaaaa', pid: process.pid, cwd: box.root }];
  const backend = {
    list: async () => terms,
    create: async ({ name, mark }) => ({ name, id: 'pty-bbbbbbbbbbbb', mark }),
    respawn: async (id, dir, argv, o) => {
      respawns.push(o.mark);
      await new Promise((r) => setTimeout(r, 50)); // a terminal takes a moment to stop what runs in it
    },
    capture: async () => '',
  };
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });
  const deck = new Deck({ backend, config: () => ({}), profiles: () => [] });
  const run = { runId: 'r1', sessionId: ID, cwd: box.root, carryArgs: [], tool: 'claude' };
  const out = await Promise.allSettled([deck.move(terms[0], run, 'backup'), deck.move(terms[0], run, 'work')]);
  assert.deepEqual(out.map((o) => o.status), ['fulfilled', 'rejected']);
  assert.equal(out[1].reason.status, 409);
  assert.equal(respawns.length, 1, 'one restart of the terminal, one launcher');
  const note = deck.launchOf(ID);
  assert.equal(note.mark, respawns[0]);
  assert.equal(fs.existsSync(note.mark), true);
  assert.equal(deck.launchEnded(note), false, 'the launcher has not ended');
  await deck.list();
  assert.equal(deck.launchOf(ID), note, 'a look keeps the note while the terminal has no record and is not back at its shell');
  fs.rmSync(note.mark); // what the shell does after the launcher
  assert.equal(deck.launchEnded(note), true);
  await deck.list();
  assert.equal(deck.launchOf(ID), null, 'the next look ends it: no timer');
  // A move asked for after the last one went through is a move again.
  await deck.move(terms[0], run, 'backup');
  assert.equal(respawns.length, 2);
  deck.launchOf(ID, 'claude', { drop: true });
  assert.equal(fs.existsSync(respawns[1]), false, 'a note that ends takes its mark along');
  // A start on a conversation: noted with its mark after the terminal exists.
  const name = await deck.create({ base: 'proj', dir: box.root, argv: ['x'], conversation: ID });
  assert.equal(deck.launchOf(ID).name, name);
  assert.equal(fs.existsSync(deck.launchOf(ID).mark), true);
  deck.launchOf(ID, 'claude', { drop: true });
  assert.deepEqual(fs.readdirSync(path.join(box.state, 'runs')), [], 'no mark is left behind');
  clear();
});
