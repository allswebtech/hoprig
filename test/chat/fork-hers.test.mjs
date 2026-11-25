// A fork that comes through Tia's door is hers for her safety, as a chat she opens: when a message starts its
// process, that start goes through startAsHers (her git sign-in is asked for). A fork by the owner's page stays his.
// The routes run against the stand-in Claude Code (fixtures/fake-claude.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const box = sandbox('forkhers');
test.after(() => box.cleanup());
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { chatFeature } = await import('../../src/chat/feature.mjs');
writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('a fork through her door starts as hers at its first message; a fork by the owner\'s page stays his', { skip: process.platform === 'win32' && 'POSIX stand-in', timeout: 60_000 }, async (t) => {
  const proj = path.join(box.root, 'proj', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  // A chosen sign-in file that is not there: a start as hers says so in the chat; a start of his does not ask for it.
  saveConfig({ server: { roots: [path.dirname(proj)], herGitSignin: { file: 'gone', at: 1 } } });
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const ctx = { HttpError, config: () => loadConfig(), readJson: async (req) => req.body || {}, backend: { list: async () => [] }, caller: (req) => (req.tia ? 'self' : 'page') };
  const f = chatFeature(ctx, { file: path.join(box.root, 'chats.json'), command: { command: process.execPath, args: [FAKE] }, idleMs: 400, resolveEnv: async () => ({ ...process.env }) });
  t.after(() => f.close());
  const route = (method, url, req = {}) => {
    const r = f.routes.find(([m, re]) => m === method && re.test(url));
    return r[2]({ headers: {}, ...req }, r[1].exec(url), new URLSearchParams(), null);
  };
  const events = async (id) => (await route('GET', `/api/chats/${id}`)).events;
  const ended = async (id) => (await events(id)).some((e) => e.kind === 'turn-end');
  const signinAsked = async (id) => (await events(id)).some((e) => e.kind === 'notice' && /git sign-in could not be used/.test(e.text || ''));

  const his = await f.open({ dir: proj, profile: 'work', text: 'look over the shop' });
  await until('the first turn', () => ended(his.id));
  assert.equal(await signinAsked(his.id), false, 'his own chat does not ask for her sign-in');

  for (const [tia, hers] of [[true, true], [false, false]]) {
    const fork = await route('POST', `/api/chats/${his.id}/fork`, { tia, body: {} });
    assert.equal(f.recordOf(fork.id).hers === true, hers, `the fork's record (${tia ? 'her door' : 'his page'})`);
    // The owner writes in it from his page: her safety stays on a fork of hers, as on a chat she opened.
    await route('POST', `/api/chats/${fork.id}/send`, { body: { text: 'go on' } });
    await until('the fork\'s turn', () => ended(fork.id));
    assert.equal(await signinAsked(fork.id), hers, tia ? 'a fork through her door starts through startAsHers' : 'a fork by his page starts as today');
  }
});
