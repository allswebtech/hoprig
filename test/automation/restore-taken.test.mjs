// "Continue here" in a chat ends the terminal that ran its conversation: a dashboard start at ANY moment after the
// press must not reopen that terminal on the conversation, while a terminal nobody took over still comes back. The
// take-over is written down (src/automation/taken.mjs) before the terminal is respawned, and the restore reads it at
// the start; no tick has to see the terminal as a shell first.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeCtx, fakeDeck } from './helpers.mjs';

const box = sandbox('restore-taken');
test.after(() => box.cleanup());

const TAKEN_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const TAKEN_RUN = 'm1abc-4242';
const OTHER_RUN = 'm1abd-4343';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Press "Continue here" on a chat whose conversation runs in terminal "t" (run TAKEN_RUN); `respawn` is the deck's. */
async function pressContinueHere(respawn, { stops = true } = {}) {
  const { handoffRoutes } = await import('../../src/chat/handoff.mjs');
  let stopped = false;
  const terminalOf = async () => (stopped ? null : { name: 't', termId: '%1', cwd: box.root, run: { runId: TAKEN_RUN, pid: null } });
  const c = { id: crypto.randomUUID(), cwd: box.root, engine: { id: 'claude' }, conversationId: TAKEN_ID, refresh() {}, emit() {}, dropMark: () => false };
  const deck = { respawn: async (...a) => { await respawn(...a); stopped = stops; } };
  const routes = handoffRoutes({ HttpError, readJson: async () => ({}), backend: {}, config: () => ({}), deck }, {
    chats: new Map([[c.id, c]]), chatOr404: () => c, terminalOf, serial: (id, fn) => fn(), forget: () => {}, save() {}, auto: {},
  });
  const [, re, fn] = routes.find(([, r]) => String(r).includes('take'));
  return fn({}, re.exec(`/api/chats/${c.id}/take`));
}

const takenFile = () => path.join(box.state, 'automation', 'taken.json');
const readTaken = () => (fs.existsSync(takenFile()) ? JSON.parse(fs.readFileSync(takenFile(), 'utf8')) : null);

/** What the restore knew at its last tick before the dashboard ended: both terminals ran, neither seen as a shell. */
function knownBefore() {
  fs.mkdirSync(path.join(box.state, 'automation'), { recursive: true });
  const s = (name, sessionId, runId) => ({ name, cwd: box.root, profile: 'api', sessionId, runId, carryArgs: [], goneAt: null, shellSince: null });
  fs.writeFileSync(path.join(box.state, 'automation', 'restore.json'), JSON.stringify({ lastTickAt: 1000, sessions: { t: s('t', TAKEN_ID, TAKEN_RUN), u: s('u', OTHER_ID, OTHER_RUN) } }));
}

test('Continue here, then a dashboard start at once: the taken terminal is not reopened, the other one is', async () => {
  knownBefore();
  let seenBefore = null;
  assert.deepEqual(await pressContinueHere(async () => (seenBefore = readTaken())), { ok: true });
  assert.ok(seenBefore && seenBefore.some((e) => e.runId === TAKEN_RUN && e.conversation === TAKEN_ID && e.tool === 'claude'), `written before the respawn: ${JSON.stringify(seenBefore)}`);

  // No wait, no tick in between: the next dashboard's first tick.
  const { createAutomation } = await import('../../src/automation/index.mjs');
  const deck = fakeDeck();
  const a = createAutomation(fakeCtx({ deck, stateDir: box.state, now: () => 2000, automation: { restore: { enabled: true } } }).ctx);
  try {
    await a.tick();
  } finally {
    await a.close();
  }
  assert.deepEqual(deck.started.map((o) => [o.name, o.sessionId]), [['u', OTHER_ID]], 'only the terminal nobody took over comes back');
  assert.deepEqual(readTaken(), [], 'the start used the record: it is dropped');
});

test('a respawn that fails takes the record back', async () => {
  fs.rmSync(takenFile(), { force: true });
  await assert.rejects(pressContinueHere(async () => { throw new Error('the terminal is gone'); }), /the terminal is gone/);
  assert.deepEqual(readTaken() || [], [], 'nothing is left that would keep the terminal from coming back');
});

test('a terminal that does not stop after the respawn takes the record back too (the route says 409)', async () => {
  fs.rmSync(takenFile(), { force: true });
  await assert.rejects(pressContinueHere(async () => {}, { stops: false }), (e) => e.status === 409 && /the terminal did not stop/.test(e.message));
  assert.deepEqual(readTaken() || [], [], 'it still runs the conversation: a restore may bring it back');
});

test('a later tick that sees the conversation run in a terminal again drops the record; another tick keeps it', async () => {
  const { decide } = await import('../../src/automation/restore.mjs');
  const taken = [{ tool: 'claude', conversation: TAKEN_ID, runId: TAKEN_RUN }];
  const card = (runId) => ({ name: 't', kind: 'claude', tool: 'claude', cwd: box.root, sessionId: TAKEN_ID, runId, profile: { name: 'api' } });
  const shell = { name: 't', kind: 'shell', cwd: box.root };
  assert.deepEqual(decide({ cards: [shell], data: null, taken, now: 1, boot: false, enabled: true }).taken, taken, 'a shell: kept');
  assert.deepEqual(decide({ cards: [card(TAKEN_RUN)], data: null, taken, now: 1, boot: false, enabled: true }).taken, taken, 'the old run still ending: kept');
  assert.deepEqual(decide({ cards: [card(OTHER_RUN)], data: null, taken, now: 1, boot: false, enabled: true }).taken, [], 'runs the conversation again: dropped');
});
