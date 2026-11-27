// Allow everything over a hand-over between a terminal and a chat: kept only by the rules of the mode (the owner's own
// session, the switch on, the mode accepted); else it comes out in Bypass permissions. Routes driven with stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-allhandoff-')));
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

const { markAll } = await import('../../src/allmark.mjs');
const { startAsHers: asHers } = await import('../../src/assistant/hersignin.mjs');
const ON = { allowBypass: true, allowEverythingAt: 5 };
const terminal = ({ all, hers }) => {
  const { file, run } = R.createRun({ profile: 'work', cwd: tmp, conversation: CONV });
  if (all) markAll(file);
  if (hers) asHers(file, {}, { cfg: {} });
  return { file, run: { ...run, sessionId: CONV, tool: 'claude', carryArgs: ['--permission-mode', 'bypassPermissions'] } };
};

test('terminal to chat: a terminal in Allow everything opens in it only under the rules of the mode', { skip: process.platform === 'win32' }, async () => {
  const cases = [
    ['kept', { all: true }, ON, 'allowEverything'],
    ['not marked', { all: false }, ON, 'bypassPermissions'],
    ['switch off', { all: true }, { allowBypass: false, allowEverythingAt: 5 }, null],
    ['not accepted', { all: true }, { allowBypass: true }, 'bypassPermissions'],
    ['hers', { all: true, hers: true }, ON, 'bypassPermissions'],
  ];
  for (const [what, t, config, want] of cases) {
    const { file, run } = terminal(t);
    const { routes, made } = harness({ found: { run }, config });
    await route(routes, 'POST', '/api/chats/from-session')({ session: 'alpha' });
    if (want !== null) assert.equal(made[0].permissionMode, want, what);
    else assert.notEqual(made[0].permissionMode, 'allowEverything', what);
    R.removeRun(file);
  }
});

test('chat to terminal: a chat in Allow everything starts its terminal in it only under the rules of the mode', { skip: process.platform === 'win32' }, async () => {
  for (const [what, extra, config, want] of [['kept', {}, ON, true], ['switch off', {}, { allowBypass: false, allowEverythingAt: 5 }, false], ['hers', { hers: true }, ON, false]]) {
    const chat = { id: CONV, conversationId: CONV, engine: { id: 'claude', exists: async () => true }, cwd: tmp, profile: 'work', permissionMode: 'allowEverything', busy: () => false, o: {}, record: () => ({}), emit() {}, close() {}, stopAndWait: async () => {}, ...extra };
    const { routes, started } = harness({ chat, config });
    try {
      await route(routes, 'POST', `/api/chats/${CONV}/terminal`)({});
    } catch {
      /* the stand-in chat may stop short after the start: only what was started matters */
    }
    assert.equal(started.length >= 1 && started[0].all === true, want, what);
    if (started[0]) assert.ok(started[0].flags.includes('bypassPermissions'), 'Claude Code itself always gets bypassPermissions');
  }
});
