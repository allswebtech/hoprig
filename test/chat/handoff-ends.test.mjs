// Continue here (src/chat/handoff.mjs take) ENDS a terminal the dashboard made for the conversation, when it has one
// pane, instead of leaving it a plain shell that was only a second card on Home; the take-over is written down before
// it ends, the launcher gets its time to end, and the next Open in Terminal gets the folder's plain name again (no
// "-2"). A terminal made outside the dashboard (adopted), or one with more panes, keeps its shell, and the page does
// not list that shell while it stays one. The restore after a restart does not reopen the ended terminal. Real tmux on
// a socket of this test's own.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('handoffends');
process.env.HOME = box.home; // a respawned login shell reads its start files from here
process.env.SHELL = '/bin/bash';
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { TmuxBackend } = await import('../../src/server/backends/tmux.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');
const { handoffRoutes, terminals } = await import('../../src/chat/handoff.mjs');
const { listRuns } = await import('../../src/runs.mjs');
const { readTaken } = await import('../../src/automation/taken.mjs');
const { decide } = await import('../../src/automation/restore.mjs');
const { oneCard } = await import('../../src/server/onecard.mjs');
const { plainShell } = await import('../../src/automation/cards.mjs');
const usable = process.platform !== 'win32' && tmuxUsable();
test.after(() => box.cleanup());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The stand-in launcher: a run record on the conversation named by its argument, as the launcher with --resume writes
// one; on SIGHUP it takes a moment (as Claude Code saves), notes that it ended, and removes its record.
const launcher = path.join(box.root, 'launcher.mjs');
const endedLog = path.join(box.root, 'ended.txt');
fs.writeFileSync(launcher, `import fs from 'node:fs';
const { createRun, removeRun, updateRun } = await import(${JSON.stringify(new URL('../../src/runs.mjs', import.meta.url).href)});
const { file } = createRun({ profile: 'p', cwd: process.cwd(), carryArgs: [] });
updateRun(file, { sessionId: process.argv[2], status: 'waiting' });
const bye = () => setTimeout(() => { removeRun(file); fs.appendFileSync(${JSON.stringify(endedLog)}, process.argv[2] + '\\n'); process.exit(0); }, 2600);
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
setInterval(() => {}, 1000);
`);

async function setup(t, label) {
  const socket = `hoprig-handoff-ends-${label}-${process.pid}`;
  const conf = path.join(box.root, `${socket}.conf`);
  fs.writeFileSync(conf, 'set -g default-shell /bin/bash\n');
  const backend = new TmuxBackend({ socket, configFile: conf });
  t.after(async () => {
    const sock = await backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await backend.killServer().catch(() => {});
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
  });
  const cwd = path.join(box.root, `project-${label}`);
  fs.mkdirSync(cwd, { recursive: true });
  const deck = new Deck({ backend, config: () => ({}), profiles: () => [] });
  const ctx = { HttpError, readJson: async (req) => req.body, config: () => ({ handsOff: { offered: false } }), deck, backend, poke: () => {} };
  const { terminalOf, claim, serial, forget } = terminals(ctx, { chatOf: () => null });
  const take = async (X) => {
    const chats = new Map();
    const c = new Chat({ id: crypto.randomUUID(), conversationId: X, engine: 'claude', cwd, profile: 'p', turnsDir: path.join(box.root, 'turns'), resolveEnv: async () => ({}), idleMs: 60_000 });
    chats.set(c.id, c);
    t.after(() => c.close());
    const routes = handoffRoutes(ctx, {
      chats, make: () => {}, save: () => {}, load: () => {}, memory: { last: () => null }, models: () => [],
      chatOr404: (id) => chats.get(id), openChatOf: () => null, freeId: (id) => id, terminalOf, claim, serial, forget,
      auto: { name: 'auto', on: () => false },
    });
    const [, re, fn] = routes.find(([m, r]) => m === 'POST' && r.test(`/api/chats/${c.id}/take`));
    return fn({ body: {} }, re.exec(`/api/chats/${c.id}/take`));
  };
  const argv = (X) => [process.execPath, launcher, X];
  const recordOf = (X) => until('the launcher\'s record', () => listRuns().find((r) => r.sessionId === X && r.status !== 'ended'));
  return { backend, deck, cwd, terminalOf, take, argv, recordOf };
}

const sessions = async (backend) => [...new Set((await backend.list()).map((p) => p.session))];
const endedOf = (X) => (fs.existsSync(endedLog) ? fs.readFileSync(endedLog, 'utf8').split('\n').includes(X) : false);

test('Continue here ends a terminal the dashboard made, the name is free again, and a restart does not reopen it', { timeout: 60_000, skip: !usable && 'no tmux 3.2 or newer here' }, async (t) => {
  const { backend, deck, cwd, terminalOf, take, argv, recordOf } = await setup(t, 'made');
  const X = crypto.randomUUID();
  const name = await deck.create({ base: path.basename(cwd), dir: cwd, argv: argv(X), conversation: X });
  assert.equal(name, path.basename(cwd));
  const run = await recordOf(X);
  assert.equal((await terminalOf(X))?.name, name);

  // The take-over is written down before the terminal ends; the launcher is given its time to end (hold).
  let before = null;
  const end = deck.end.bind(deck);
  deck.end = async (n, o) => { before = readTaken(); return end(n, o); };
  assert.deepEqual(await take(X), { ok: true });
  assert.ok(before && before.some((e) => e.conversation === X && e.runId === run.runId), `noted before it ended: ${JSON.stringify(before)}`);
  assert.ok(endedOf(X), 'its launcher ended by itself, given its time');
  assert.deepEqual(await sessions(backend), [], 'the terminal is gone, no plain shell left');
  assert.equal(await terminalOf(X), null);

  // The restore: a tick that sees it gone, then a dashboard start: not reopened (the take-over is written down).
  const known = { lastTickAt: 1000, sessions: { [name]: { name, cwd, profile: 'p', sessionId: X, runId: run.runId, carryArgs: [], goneAt: null, shellSince: null } } };
  const tick = decide({ cards: [], data: known, now: 2000, boot: false, enabled: true, taken: readTaken() });
  const start = decide({ cards: [], data: tick.data, now: 3000, boot: true, enabled: true, taken: tick.taken });
  assert.deepEqual(start.actions.filter((a) => a.type === 'reopen'), [], 'the ended terminal is not reopened');

  // The next Open in Terminal of the conversation: the folder's plain name, no "-2".
  const again = await deck.create({ base: path.basename(cwd), dir: cwd, argv: argv(X), conversation: X });
  assert.equal(again, path.basename(cwd));
  await recordOf(X);
  await backend.kill(again);
});

test('Continue here on an adopted terminal, or one with two panes, keeps the shell and the page does not list it', { timeout: 90_000, skip: !usable && 'no tmux 3.2 or newer here' }, async (t) => {
  const { backend, deck, cwd, take, argv, recordOf } = await setup(t, 'kept');
  // Adopted: made outside the dashboard, its pane running the launcher line.
  const A = crypto.randomUUID();
  await backend.run(['new-session', '-d', '-s', 'adopted', '-c', cwd, '-e', `HOPRIG_STATE_DIR=${process.env.HOPRIG_STATE_DIR}`, `'${process.execPath}' '${launcher}' ${A}; exec bash`]);
  await recordOf(A);
  assert.deepEqual(await take(A), { ok: true });
  // Two panes: made by the dashboard, then split by the owner.
  const B = crypto.randomUUID();
  const two = await deck.create({ base: 'split', dir: cwd, argv: argv(B), conversation: B });
  await recordOf(B);
  await backend.run(['split-window', '-d', '-t', (await backend.list()).find((p) => p.session === two).id, '-c', cwd]);
  assert.deepEqual(await take(B), { ok: true });

  assert.deepEqual((await sessions(backend)).sort(), ['adopted', 'split'], 'both terminals stay');
  const cards = await until('both back at their shell', async () => {
    const list = await deck.list();
    return list.filter(plainShell).length === 2 && list; // the typed `node -e 0` of the respawn has ended too
  });
  assert.deepEqual(cards.filter((c) => c.shellLeft).map((c) => c.name).sort(), ['adopted', 'split']);
  assert.deepEqual(oneCard(cards).map((c) => c.name), [], 'neither is listed while it stays a plain shell');

  // A coding tool there again: listed again.
  await backend.sendText((await backend.list()).find((p) => p.session === 'adopted').id, `'${process.execPath}' '${launcher}' ${A}`);
  await backend.sendKey((await backend.list()).find((p) => p.session === 'adopted').id, 'Enter');
  await recordOf(A);
  const back = await until('the adopted terminal listed again', async () => oneCard(await deck.list()).find((c) => c.name === 'adopted'));
  assert.equal(back.key, `claude:${A}`);
  assert.equal(back.where, 'terminal');
});
