// A chat that hits a usage limit marks its provider as a terminal session's limit does (src/chat/providerlimit.mjs):
// the state every page reads says it, a new chat in that folder does not start on it by itself, and a turn that goes
// well on it takes the mark off. Through the real routes of a dashboard; Claude Code is the stand-in, whose "big"
// ends at "You've hit your usage limit · resets 5pm".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 300))})`);
};

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a chat at its usage limit marks its provider everywhere, and no default picks it', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatlimit');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { limitedProfiles } = await import('../../src/autoswitch.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  writeProfile('sub2', { label: 'Second account' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const provider = async (name) => (await owner('GET', '/api/state')).json.profiles.find((p) => p.name === name);

  // The owner's chat in this folder runs on Second account and hits its limit.
  const made = await owner('POST', '/api/chats', { dir: proj, profile: 'sub2', text: 'big' });
  assert.equal(made.status, 200);
  const id = made.json.id;
  await until('the limit', async () => (await owner('GET', `/api/chats/${id}`)).json.lastEnd === 'limit');

  // Marked as a terminal's limit is: in the state Home, the provider lists and the sheets read, with the reset time.
  const marked = await until('the mark', async () => (await provider('sub2')).limited);
  assert.equal(marked.exact, true, 'the reset time the message gives ("resets 5pm")');
  assert.ok(marked.until > Date.now() && marked.until < Date.now() + 25 * 3600_000);
  assert.ok(limitedProfiles().sub2, 'the one mark the launcher and the watcher write');
  assert.equal((await provider('sub')).limited, null, 'only that provider');
  assert.equal((await owner('GET', '/api/state')).json.recommended, 'sub', 'the recommended provider is a free one');

  // A new chat in that folder, provider left out: not the one at its limit, although the folder's last chat ran there.
  const next = await owner('POST', '/api/chats', { dir: proj });
  assert.equal(next.status, 200);
  assert.equal((await owner('GET', `/api/chats/${next.json.id}`)).json.profile.name, 'sub');
  // The owner may still choose it: a turn that goes well there takes the mark off.
  await owner('POST', `/api/chats/${next.json.id}/close`, {});
  const again = await owner('POST', '/api/chats', { dir: proj, profile: 'sub2', text: 'hello' });
  await until('the answer', async () => (await owner('GET', `/api/chats/${again.json.id}`)).json.lastEnd === 'ok');
  await until('the mark to go', async () => (await provider('sub2')).limited === null);
});

test('another coding tool\'s chat: an error that only mentions a limit marks no provider; one its engine calls a usage limit does', async (t) => {
  const box = sandbox('chatlimit-oc');
  t.after(() => box.cleanup());
  const { Chat } = await import('../../src/chat/chat.mjs');
  const { hear } = await import('../../src/chat/hear.mjs');
  const { limitMark } = await import('../../src/chat/providerlimit.mjs');
  const { limitedProfiles } = await import('../../src/autoswitch.mjs');
  const cwd = fs.mkdtempSync(path.join(box.root, 'proj-'));
  const c = new Chat({ id: '6f1d2c3b-4a5e-4f6a-8b7c-9d0e1f2a3b4c', engine: 'opencode', cwd, profile: 'gw' });
  const end = (ev) => {
    hear(c, { kind: 'turn-end', costUsd: null, usage: null, durationMs: 1, ...ev });
    limitMark(c, ev, { auto: 'auto' });
  };
  // The gateway's passing "rate limit" (Claude Code's words for its plan's limit, read from another tool) and a retry
  // that refused: an error, not a usage limit.
  hear(c, { kind: 'status', state: 'retrying', retry: { attempt: 1, error: 'rate_limit' } });
  assert.equal(c.limit, null, 'a retry of another coding tool is not a limit');
  end({ ok: false, subtype: 'error', error: 'Rate limit exceeded, please slow down (429)' });
  assert.equal(c.lastEnd, 'error');
  assert.equal(c.limit, null);
  assert.equal(limitedProfiles().gw, undefined, 'the provider is not marked');
  // Its engine says it is the provider's usage limit: then it is marked, as a Claude Code chat's would be.
  end({ ok: false, subtype: 'error', error: 'The provider\'s usage limit is reached', limited: true });
  assert.equal(c.lastEnd, 'limit');
  assert.ok(limitedProfiles().gw, 'marked');
  c.close();
});

test('a chat\'s other ends that read like a limit do not mark the provider (a full context, a per-minute 429)', async (t) => {
  const box = sandbox('chatlimit2');
  t.after(() => box.cleanup());
  const { limitMark } = await import('../../src/chat/providerlimit.mjs');
  const { LIMIT_TEXT } = await import('../../src/chat/hear.mjs');
  const { limitedProfiles, clearLimited } = await import('../../src/autoswitch.mjs');
  const end = (text, limits = {}) => ({ profile: 'sub', engine: { id: 'claude' }, lastEnd: 'limit', limit: { text }, limits });
  const notLimits = [
    'Context limit reached · /compact or /clear to continue',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 40,000 input tokens per minute."}}',
  ];
  for (const text of notLimits) {
    limitMark(end(text), { ok: false });
    assert.equal(limitedProfiles().sub, undefined, text);
  }
  assert.equal(LIMIT_TEXT.test(notLimits[0]), false, 'a full context is not shown as a limit: another provider would not help');
  // Claude Code's words for a usage limit, and a plan window that refused, do.
  for (const text of ["You've hit your usage limit · resets 5pm", 'Claude AI usage limit reached|1763300000', '5-hour limit reached ∙ resets 2am']) {
    limitMark(end(text), { ok: false });
    assert.ok(limitedProfiles().sub, text);
    clearLimited('sub');
  }
  limitMark(end('API Error: 429', { five_hour: { status: 'rejected', resetsAt: Date.now() + 3600_000 } }), { ok: false });
  assert.ok(limitedProfiles().sub, 'the plan said the window refused');
});
