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
import { SESSION_ID, standIn, standInOpts } from './fixtures/opencode-standin.mjs';

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
const { writeLaunch } = await import('../../src/launchfile.mjs');
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
  // The same millisecond: the run ids decide, the same way for both. A record's id is its file's name (listRuns).
  R.removeRun(term.file);
  R.removeRun(chat.file);
  const aFile = path.join(path.dirname(term.file), 'a.json');
  const bFile = path.join(path.dirname(chat.file), 'b.json');
  const a = { ...term.run, startedAt: 5, runId: 'a' };
  const b = { ...chat.run, startedAt: 5, runId: 'b' };
  fs.writeFileSync(aFile, JSON.stringify(a));
  fs.writeFileSync(bFile, JSON.stringify(b));
  assert.equal(R.heldBefore(b, ID).runId, 'a');
  assert.equal(R.heldBefore(a, ID), null);
  // A record that has ended never counts, nor one whose process is dead.
  fs.writeFileSync(aFile, JSON.stringify({ ...a, status: 'ended' }));
  assert.equal(R.heldBefore(b, ID), null, 'ended');
  fs.writeFileSync(aFile, JSON.stringify({ ...a, pid: 2 ** 22 + 7 }));
  assert.equal(R.heldBefore(b, ID), null, 'dead');
  // Who runs it reads no plan usage (each launcher and chat start would write the provider's store).
  fs.writeFileSync(aFile, JSON.stringify(a));
  fs.writeFileSync(R.usageFile(aFile), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 40 } } }));
  assert.equal(R.heldBefore(b, ID).usage, undefined);
  assert.equal(R.listRuns()[0].usage.fiveHour.pct, 40, 'the cards still read it');
  R.removeRun(aFile);
  R.removeRun(bFile);
  // The launcher's own move writes its record anew and keeps when it first held the conversation.
  const first = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  const again = R.createRun({ profile: 'backup', cwd: box.root, conversation: ID, file: first.file });
  assert.equal(again.run.startedAt, first.run.startedAt);
  clear();
});

test('the launcher from a plain shell: a chat or another terminal on the conversation keeps it, said in one sentence', () => {
  clear();
  // A Node stand-in without an extension: the test seal starts it with Node on Windows too, as the system does here.
  const fake = path.join(box.root, 'fake-claude');
  const started = path.join(box.root, 'claude-started');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(started)}, '');\n`, { mode: 0o755 });
  saveConfig({ claudeBin: fake, usage: false });
  writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const env = { ...process.env };
  for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete env[k];
  const launch = (args) => spawnSync(process.execPath, [binFile(), ...args], { cwd: box.root, env, encoding: 'utf8' });

  const chat = R.createChatRun({ chat: 'c1', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
  for (const args of [['work', '--resume', ID], ['work', `--session-id=${ID}`], ['run', 'nope', '-r', ID]]) {
    const r = launch(args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr, 'hoprig: this conversation is open in a chat in the dashboard. Archive that session, or choose "Open in", then "Terminal", in its session menu.\n', args.join(' '));
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
  assert.deepEqual(said, ['hoprig: this conversation is open in a chat in the dashboard. Archive that session, or choose "Open in", then "Terminal", in its session menu.']);
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

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
// A chat on the stand-in, closed when its test ends however it ends (its process must not outlive a failure).
const chatOn = (t, cwd, o = {}) => {
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE_CHAT] }, resolveEnv: async () => ({ ...process.env }), ...o });
  t.after(() => c.close());
  return c;
};
const turn = async (c, text) => {
  let timer;
  const done = new Promise((resolve, reject) => {
    c.once('turn', resolve);
    timer = setTimeout(() => reject(new Error(`no turn for "${text}" (last event: ${JSON.stringify(c.events.at(-1)).slice(0, 200)})`)), 8000);
  });
  try {
    await c.send(text);
    await done;
  } finally {
    clearTimeout(timer);
  }
};

test('a chat\'s record follows its process into another conversation (a clear): the new one is held, the old one is free', { timeout: 30_000 }, async (t) => {
  clear();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const c = chatOn(t, cwd);
  await turn(c, 'hello');
  const A = c.conversationId;
  await turn(c, 'clear'); // Claude Code's /clear: the same process goes on in a new conversation
  const B = c.conversationId;
  assert.notEqual(B, A);
  assert.ok(c.session, 'the same process runs on');
  const [rec] = R.listRuns({ chats: true });
  assert.equal(rec.sessionId, B);
  assert.equal(R.runsConversation(rec, B), true);
  assert.equal(R.runsConversation(rec, A), false);
  const onB = R.createRun({ profile: 'p', cwd, conversation: B });
  assert.equal(R.heldBefore(onB.run, B)?.chat, c.id, 'a launcher on the new conversation is refused');
  R.removeRun(onB.file);
  const onA = R.createRun({ profile: 'p', cwd, conversation: A });
  assert.equal(R.heldBefore(onA.run, A), null, 'nothing runs the old one: a launcher may start on it');
  R.removeRun(onA.file);
  // …and so may another chat.
  const d = chatOn(t, cwd, { conversationId: A });
  await turn(d, 'on the old one');
  assert.ok(d.session, 'a second chat runs the old conversation');
  await d.close();
  await c.close();
  assert.deepEqual(R.listRuns({ chats: true }), []);
  clear();
});

test('a chat\'s record goes when its process ends by itself, and a record of its own that is left over never blocks it', { timeout: 30_000 }, async (t) => {
  clear();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const c = chatOn(t, cwd);
  await turn(c, 'hello');
  assert.equal(R.listRuns({ chats: true }).length, 1);
  await c.send('big'); // the stand-in answers, then exits at once (code 1), as Claude Code does at a usage limit
  await until('the process ended by itself', () => !c.session);
  await until('its record went with it', () => R.listRuns({ chats: true }).length === 0);
  // A record of this chat that outlived its process (its pid is the dashboard's: nothing else would remove it).
  const left = R.createChatRun({ chat: c.id, conversation: c.conversationId, tool: 'claude', cwd, profile: 'p' });
  await new Promise((r) => setTimeout(r, 5));
  await turn(c, 'again');
  assert.ok(c.session, 'the chat starts: its own leftover does not count');
  assert.equal(fs.existsSync(left.file), false, 'and is gone');
  assert.equal(R.listRuns({ chats: true }).length, 1);
  await c.close();
  assert.deepEqual(R.listRuns({ chats: true }), []);
  clear();
});

test('a chat closed and opened again at once under the same id: the record the closing process holds is no leftover', { timeout: 30_000 }, async (t) => {
  clear();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  // A process that takes its time to end (a real coding tool may: hooks, flushing); the stand-in: until SIGKILL.
  const o = { id: crypto.randomUUID(), resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_STUBBORN: '1' }), idleMs: 60_000 };
  const c1 = chatOn(t, cwd, o);
  await turn(c1, 'hello');
  const [rec] = R.listRuns({ chats: true });
  // The close route: the chat leaves the dashboard's list at once (its id is free again), its process ends meanwhile.
  const closing = c1.close(2000);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(c1.ending, 'the first chat\'s process is still ending');
  const c2 = chatOn(t, cwd, o);
  await c2.send('second').catch(() => null);
  assert.equal(c2.session, null, 'no second process on the conversation');
  assert.match(c2.events.at(-1).error, /another chat runs this conversation right now/);
  assert.deepEqual(R.listRuns({ chats: true }).map((r) => r.runId), [rec.runId], 'the closing process keeps its record');
  await closing;
  assert.deepEqual(R.listRuns({ chats: true }), [], 'gone with that process');
  await turn(c2, 'again');
  assert.ok(c2.session, 'once it has ended, the new chat runs the conversation');
  await c2.close(300); // the stand-in ends only on SIGKILL
  clear();
});

test('a chat closed while its start waits for the provider holds nothing from that moment ("Open in terminal")', { timeout: 30_000 }, async (t) => {
  clear();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  let ready;
  const gate = new Promise((r) => (ready = r));
  const c = chatOn(t, cwd, { resolveEnv: async () => { await gate; return { ...process.env }; } }); // a gateway that starts slowly
  const sent = c.send('hello').catch(() => null);
  await until('the start\'s record', () => R.listRuns({ chats: true }).length === 1);
  await c.close();
  assert.deepEqual(R.listRuns({ chats: true }), [], 'gone at the close, not when the provider is ready');
  const term = R.createRun({ profile: 'p', cwd, conversation: c.conversationId });
  assert.equal(R.heldBefore(term.run, c.conversationId), null, 'the terminal it is handed to starts');
  ready();
  await sent;
  assert.equal(c.session, null, 'and the chat started nothing');
  assert.deepEqual(R.listRuns({ chats: true }).map((r) => r.runId), [term.run.runId]);
  R.removeRun(term.file);
  clear();
});

test('OpenCode: a new chat\'s record names the conversation OpenCode made for it', { timeout: 30_000 }, async (t) => {
  clear();
  const ev = (type) => ({ event: { type, data: { sessionID: SESSION_ID } } });
  const s = await standIn({ turns: [{ text: 'hi', steps: [ev('session.execution.started'), ev('session.execution.succeeded')] }] });
  t.after(() => s.close());
  const c = new Chat({ id: crypto.randomUUID(), engine: 'opencode', cwd: '/work/proj', profile: 'gw', turnsDir: fs.mkdtempSync(path.join(box.root, 'oc-')), resolveEnv: async () => ({}), engineOpts: { enabled: () => true, ...standInOpts(s) }, idleMs: 60_000 });
  t.after(() => c.close());
  if (c.loading) await c.loading;
  await c.send('hi');
  await until('OpenCode named the conversation', () => c.conversationId === SESSION_ID);
  const [rec] = R.listRuns({ chats: true });
  assert.equal(rec.conversation, c.id, 'written before OpenCode named it');
  assert.equal(rec.sessionId, SESSION_ID);
  const term = R.createRun({ profile: 'gw', cwd: '/work/proj', conversation: SESSION_ID, tool: 'opencode' });
  assert.equal(R.heldBefore(term.run, SESSION_ID, 'opencode')?.chat, c.id, 'a launcher on it from a plain shell is refused');
  R.removeRun(term.file);
  await c.close();
  assert.deepEqual(R.listRuns({ chats: true }), []);
  clear();
});

test('the start\'s mark: the shell removes it after the launcher, or when the launcher could not start', { skip: process.platform === 'win32' && 'POSIX shells' }, () => {
  const mark = path.join(box.root, '.start-x');
  assert.deepEqual(shellLine(['/n', 'a b'], { mark }), { line: `${CLEAR}; /n 'a b'; command rm -f ${mark}`, env: {} });
  assert.deepEqual(shellLine(['/n']), { line: `${CLEAR}; /n`, env: {} }, 'no mark, the same line as before');
  // The launcher's folder is gone: it says so and ends (exit 2), and the shell is back.
  const gone = writeLaunch({ cwd: path.join(box.root, 'gone'), argv: ['--version'] });
  for (const argv of [['true'], ['false'], [path.join(box.root, 'no-such-program')], [process.execPath, binFile(), '--launch', gone]]) {
    fs.writeFileSync(mark, '');
    spawnSync('/bin/sh', ['-c', shellLine(argv, { mark }).line], { stdio: 'ignore', cwd: box.root });
    assert.equal(fs.existsSync(mark), false, `${argv}`);
  }
  // A shell whose rm is something else (a function that moves files to a trash): the program itself removes it.
  fs.writeFileSync(mark, '');
  spawnSync('bash', ['-c', `rm() { :; }; ${shellLine(['true'], { mark }).line}`], { stdio: 'ignore' });
  assert.equal(fs.existsSync(mark), false, 'not the shell\'s own rm');
});

test('the start\'s mark on Windows: the built-in terminal removes it when its command exits', async () => {
  const mark = path.join(box.root, '.start-win');
  fs.writeFileSync(mark, '');
  const plan = startPlan({ platform: 'win32', dir: 'C:\\w', argv: ['node.exe', 'hoprig.mjs', 'work'], mark });
  assert.equal(plan.mark, mark);
  const posixMark = '/w/.start-win'; // the Linux plan is given a Linux path, also when the test runs on Windows
  assert.equal(startPlan({ platform: 'linux', dir: '/w', argv: ['/n'], mark: posixMark, shell: { file: '/bin/sh', args: ['-l'] } }).type, shellLine(['/n'], { mark: posixMark }).line);
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
  // A request that read the same record but asks later (another page, after its own reads): late as well.
  await new Promise((r) => setImmediate(r));
  await assert.rejects(deck.move(terms[0], run, 'work'), (e) => e.status === 409);
  assert.equal(respawns.length, 1);
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
  // A move of the record the new launcher wrote is a move again.
  await deck.move(terms[0], { ...run, runId: 'r2' }, 'backup');
  assert.equal(respawns.length, 2);
  deck.launchOf(ID, 'claude', { drop: true });
  assert.equal(fs.existsSync(respawns[1]), false, 'a note that ends takes its mark along');
  // A start on a conversation: noted with its mark after the terminal exists.
  const name = await deck.create({ base: 'proj', dir: box.root, argv: ['x'], conversation: ID });
  assert.equal(deck.launchOf(ID).name, name);
  assert.equal(fs.existsSync(deck.launchOf(ID).mark), true);
  deck.launchOf(ID, 'claude', { drop: true });
  assert.deepEqual(fs.readdirSync(path.join(box.state, 'runs')), [], 'no mark is left behind');
  // A move that failed moved nothing: the same record may be moved again.
  let broken = true;
  backend.respawn = async (id, dir, argv, o) => {
    respawns.push(o.mark);
    if (broken) throw new Error('the terminal is gone');
  };
  await assert.rejects(deck.move(terms[0], { ...run, runId: 'r3' }, 'work'), /the terminal is gone/);
  broken = false;
  await deck.move(terms[0], { ...run, runId: 'r3' }, 'work');
  deck.launchOf(ID, 'claude', { drop: true });
  assert.deepEqual(fs.readdirSync(path.join(box.state, 'runs')), []);
  clear();
});

test('the marks an earlier dashboard left behind go when a dashboard starts', () => {
  clear();
  const runs = path.join(box.state, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const hourAgo = new Date(Date.now() - 3_600_000);
  for (const f of ['.start-old', '.start-new', 'other.json']) fs.writeFileSync(path.join(runs, f), '');
  for (const f of ['.start-old', 'other.json']) fs.utimesSync(path.join(runs, f), hourAgo, hourAgo);
  new Deck({ backend: { list: async () => [] }, config: () => ({}), profiles: () => [] });
  assert.deepEqual(fs.readdirSync(runs).sort(), ['.start-new', 'other.json'], 'a recent mark stays; a record is not a mark');
  clear();
});
