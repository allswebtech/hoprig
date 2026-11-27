// A session of Tia's stays hers across the hand-offs between a chat and a terminal (her safety: the mark and her git
// sign-in; never her right to answer its OKs): a chat of hers opened in a terminal starts that terminal as hers, a
// terminal of hers shown as a chat is a chat that is hers, and a chat of hers the owner then wrote in keeps her
// safety until it ends. A session of the owner's stays his. The routes are driven with stand-ins (no dashboard).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-hershandoff-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_PROFILES_DIR = path.join(tmp, 'profiles');
process.env.HOPRIG_WORKSPACE_DIR = path.join(tmp, 'ws');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { handoffRoutes } = await import('../../src/chat/handoff.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');
const { start } = await import('../../src/chat/run.mjs');
const { startAsHers } = await import('../../src/assistant/hersignin.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const R = await import('../../src/runs.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const CONV = 'c0ffee00-0000-4000-8000-00000000000a';
const route = (routes, method, url) => {
  const r = routes.find(([m, re]) => m === method && re.test(url));
  return (body) => r[2]({ body }, r[1].exec(url));
};

function harness({ found = null, chat = null, config = {}, root = false } = {}) {
  const made = [];
  const started = [];
  const ctx = {
    HttpError, config: () => ({ handsOff: { offered: false }, ...config }), root, backend: { list: async () => [] }, poke() {},
    readJson: async (req) => req.body || {},
    deck: { find: async () => found, start: async (o) => { started.push(o); return 'alpha'; }, respawn: async () => {} },
  };
  const chats = new Map(chat ? [[chat.id, chat]] : []);
  const o = {
    chats, make: (rec) => made.push(rec), save() {}, load() {}, chatOr404: () => chat, memory: { last: () => null }, models: () => [],
    openChatOf: () => null, freeId: (id) => id, terminalOf: async () => null, claim: async (id, fn) => ({ started: await fn() }),
    serial: (id, fn) => fn(), forget() {}, auto: { name: 'auto', on: () => false }, handedFile: path.join(tmp, 'state', 'handed.json'),
  };
  return { routes: handoffRoutes(ctx, o), made, started };
}

const terminalRun = (hers) => {
  const { file, run } = R.createRun({ profile: 'work', cwd: tmp, conversation: CONV });
  if (hers) startAsHers(file, {}, { cfg: {} });
  return { file, run: { ...run, sessionId: CONV, tool: 'claude', carryArgs: [] } };
};

test('a terminal of hers shown as a chat is a chat that is hers (not one whose OKs she answers); his stays his', async () => {
  for (const hers of [true, false]) {
    const { file, run } = terminalRun(hers);
    const { routes, made } = harness({ found: { run } });
    await route(routes, 'POST', '/api/chats/from-session')({ session: 'alpha' });
    assert.equal(made.length, 1);
    assert.equal(made[0].hers === true, hers, hers ? 'hers stays hers' : 'his stays his');
    assert.notEqual(made[0].byTia, true, 'its OKs stay the owner\'s');
    R.removeRun(file);
  }
});

test('a terminal started in bypass opens as a chat in bypass while it is allowed; else as the fallback says', async () => {
  const { file, run } = terminalRun(false);
  const d = { sessionDefaults: { permissionMode: 'acceptEdits' } };
  const cases = [
    [['--dangerously-skip-permissions'], { allowBypass: true }, false, 'bypassPermissions'],
    [['--model', 'opus', '--dangerously-skip-permissions'], { allowBypass: false }, false, 'acceptEdits'],
    [['--dangerously-skip-permissions'], { allowBypass: true }, true, 'acceptEdits'], // as root: never bypass
    [['--permission-mode', 'plan'], { allowBypass: true }, false, 'plan'],
  ];
  try {
    for (const [carryArgs, config, root, mode] of cases) {
      const { routes, made } = harness({ found: { run: { ...run, carryArgs } }, config: { ...d, ...config }, root });
      await route(routes, 'POST', '/api/chats/from-session')({ session: 'alpha' });
      assert.equal(made[0].permissionMode, mode, JSON.stringify([carryArgs, config, root]));
    }
  } finally {
    R.removeRun(file); // a failed case must not leave a terminal on the conversation for the tests after it
  }
});

// The real chat with its real engine, only told that its conversation exists and kept from starting a process.
const chatOf = (o) => {
  const c = new Chat({ id: CONV, engine: 'claude', cwd: tmp, profile: 'work', ...o });
  return Object.assign(c, { engine: Object.assign(Object.create(c.engine), { exists: async () => true }), busy: () => false, close: async () => {} });
};

test('a chat of hers opened in a terminal starts that terminal as hers; his opens as his', async () => {
  for (const [o, hers] of [[{ byTia: true }, true], [{ hers: true }, true], [{}, false]]) {
    const c = chatOf(o);
    const { routes, started } = harness({ chat: c });
    await route(routes, 'POST', `/api/chats/${CONV}/terminal`)({});
    assert.equal(started.length, 1);
    assert.equal(started[0].hers, hers, JSON.stringify(o));
  }
});

test('the owner writing in a chat of hers takes her OKs away, not her safety: it stays hers until it ends', () => {
  const c = chatOf({ byTia: true });
  assert.equal(c.dropMark(), true);
  assert.equal(c.byTia, false, 'her rules no longer answer its OKs');
  assert.equal(c.hers, true, 'still marked and signed in as hers');
  assert.equal(c.record().hers, true, 'kept over a restart of the dashboard');
  assert.equal(chatOf({}).record().hers, undefined, 'a chat of his has no such word');
});

test('a chat that is hers starts through startAsHers (her sign-in is asked for)', async () => {
  saveConfig({ server: { herGitSignin: { file: 'gone', at: 1 } } });
  for (const [o, asked] of [[{ hers: true }, true], [{}, false]]) {
    const notes = [];
    const c = { id: CONV, conversationId: CONV, gen: 1, closed: false, session: null, starting: null, ending: null, cwd: tmp, profile: 'work', byTia: false, hers: false, ...o,
      engine: { id: 'claude', exists: async () => { throw new Error('stop here'); } }, o: { resolveEnv: async () => ({}) }, push: (n) => notes.push(n) };
    await assert.rejects(start(c), /stop here/);
    assert.equal(notes.some((n) => /git sign-in could not be used/.test(n.text)), asked, JSON.stringify(o));
  }
});
