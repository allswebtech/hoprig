// Continue here for a terminal made outside the dashboard with a command of its own (as `tmux new-session '<launcher
// line> -- <first message>'` makes one), the whole path: the chat takes the conversation over (src/chat/handoff.mjs
// take), the Deck starts the pane anew as a shell (tmux respawn), and the command the pane was created with never runs
// again (it would start a new conversation with the first message). Real tmux on a socket of this test's own.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('handoffadopted');
process.env.HOME = box.home; // the respawned login shell reads its start files from here
process.env.SHELL = '/bin/bash';
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { TmuxBackend } = await import('../../src/server/backends/tmux.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');
const { handoffRoutes, terminals } = await import('../../src/chat/handoff.mjs');
const { listRuns } = await import('../../src/runs.mjs');
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

// The stand-in launcher: each run is one line in starts.txt and a run record on a NEW conversation, as the launcher
// with a first message and no --resume starts one; it ends (and removes its record) when its terminal stops it.
const starts = path.join(box.root, 'starts.txt');
const launcher = path.join(box.root, 'launcher.mjs');
fs.writeFileSync(launcher, `import fs from 'node:fs';
import crypto from 'node:crypto';
const { createRun, removeRun, updateRun } = await import(${JSON.stringify(new URL('../../src/runs.mjs', import.meta.url).href)});
fs.appendFileSync(${JSON.stringify(starts)}, 'started\\n');
const { file } = createRun({ profile: 'p', cwd: process.cwd(), carryArgs: [] });
updateRun(file, { sessionId: crypto.randomUUID(), status: 'waiting' });
const bye = () => { removeRun(file); process.exit(0); };
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
setInterval(() => {}, 1000);
`);

test('Continue here on an adopted tmux session made with a launcher line never starts that line again', { timeout: 60_000, skip: !usable && 'no tmux 3.2 or newer here' }, async (t) => {
  const socket = `hoprig-handoff-adopted-${process.pid}`;
  const conf = path.join(box.root, `${socket}.conf`);
  fs.writeFileSync(conf, 'set -g default-shell /bin/bash\n');
  const backend = new TmuxBackend({ socket, configFile: conf });
  t.after(async () => {
    const sock = await backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await backend.killServer().catch(() => {});
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
  });
  const cwd = path.join(box.root, 'project');
  fs.mkdirSync(cwd);
  const line = `'${process.execPath}' '${launcher}' p -- 'do the work'`;
  await backend.run(['new-session', '-d', '-s', 'adopted', '-c', cwd, '-e', `HOPRIG_STATE_DIR=${box.state}`, `exec ${line}`]);
  const runs = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0);
  const first = await until('the launcher\'s record', () => listRuns().find((r) => r.sessionId));
  const X = first.sessionId;
  assert.equal(runs(), 1);

  const deck = new Deck({ backend, config: () => ({}), profiles: () => [] });
  const ctx = { HttpError, readJson: async (req) => req.body, config: () => ({ handsOff: { offered: false } }), deck, backend, poke: () => {} };
  const { terminalOf, claim, serial, forget } = terminals(ctx, { chatOf: () => null });
  assert.equal((await terminalOf(X))?.name, 'adopted', 'the adopted terminal runs X');
  const chats = new Map();
  const c = new Chat({ id: crypto.randomUUID(), conversationId: X, engine: 'claude', cwd, profile: 'p', turnsDir: path.join(box.root, 'turns'), resolveEnv: async () => ({}), idleMs: 60_000 });
  chats.set(c.id, c);
  t.after(() => c.close());
  const routes = handoffRoutes(ctx, {
    chats, make: () => {}, save: () => {}, load: () => {}, memory: { last: () => null }, models: () => [],
    chatOr404: (id) => chats.get(id), openChatOf: () => null, freeId: (id) => id, terminalOf, claim, serial, forget,
    auto: { name: 'auto', on: () => false },
  });
  const [, re, take] = routes.find(([m, r]) => m === 'POST' && r.test(`/api/chats/${c.id}/take`));
  await take({ body: {} }, re.exec(`/api/chats/${c.id}/take`));

  const [pane] = (await backend.list()).filter((p) => p.session === 'adopted');
  // The pane back at its shell, or the creation command run again: whichever comes first.
  await until('the pane back at its shell', async () => runs() > 1 || (await backend.list()).some((p) => p.id === pane.id && p.command === 'bash'));
  await wait(1000); // a creation command run again would have written by now
  assert.equal(runs(), 1, 'the command the pane was created with did not run again');
  assert.deepEqual(listRuns().filter((r) => r.status !== 'ended' && r.sessionId !== X).map((r) => r.sessionId), [], 'no new conversation started');
  assert.equal(await terminalOf(X), null, 'one process: the chat may run X now');
});
