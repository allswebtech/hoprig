// One conversation, one process for OpenCode, where the two halves of the rule meet: the launcher names the
// conversation in its run record before the coding tool reports it (runs.mjs: conversation) and the Deck notes a
// start or a move for the moment before that record exists, while the claim looks a conversation up by coding tool
// and id (src/chat/handoff.mjs). Through the real routes of a dashboard (createServer, built-in terminals), with a
// stand-in launcher that reports late and the stand-in of OpenCode's server: an OpenCode terminal session that was
// continued (by its id) or resumed, or moved to another provider, and at once a new OpenCode chat on its
// conversation: one process, and the chat sends nothing to OpenCode's server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { SESSION_ID, standIn, standInOpts } from './fixtures/opencode-standin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLOW_SESSION = path.join(HERE, 'fixtures', 'slow-session.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(100);
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

test('OpenCode: a terminal session resumed or moved to another provider, then at once a new chat on its conversation: one process', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('oneprocess-oc');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const s = await standIn();
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { listRuns } = await import('../../src/runs.mjs');
  const { toolsDir } = await import('../../src/paths.mjs');
  saveConfig({ codingTools: ['claude', 'opencode'], launcher: [process.execPath, SLOW_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  const bin = path.join(toolsDir(), 'opencode', 'node_modules', '.bin', 'opencode'); // installed, as far as the checks look
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const gateway = (label, token) => ({ label, api: ['messages', 'models'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: token } });
  writeProfile('gw', gateway('Gateway', 'gw-token-of-the-test'));
  writeProfile('gw2', gateway('Second gateway', 'gw2-token-of-the-test'));
  const slow = (ms) => fs.writeFileSync(path.join(box.state, 'slow-session-ms'), String(ms));
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    toolSessions: async () => [{ id: SESSION_ID, at: 1, title: 'Recorded session' }],
    chat: { resolveEnv: async () => ({}), engineOpts: standInOpts(s), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    await s.close();
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
  // Every OpenCode launcher that runs (a terminal's), and every message a chat gave OpenCode's server.
  const launchers = () => listRuns().filter((r) => r.tool === 'opencode').length;
  const prompts = () => s.calls.filter((x) => x.path.endsWith('/prompt')).length;
  const newChat = (text) => owner('POST', '/api/chats', { dir: proj, tool: 'opencode', profile: 'gw', sessionId: SESSION_ID, text });
  // The conversation is made in a chat first (OpenCode's server knows it in this folder from then on), and closed.
  const first = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', profile: 'gw', text: 'Reply with exactly three short words, nothing else.' });
  assert.equal(first.status, 200, first.json && first.json.error);
  await until('its answer', async () => (await owner('GET', `/api/chats/${first.json.id}`)).json.events.some((e) => e.kind === 'turn-end'));
  assert.equal((await owner('POST', `/api/chats/${first.json.id}/close`, {})).status, 200);
  const shut = await owner('GET', `/api/chats/${first.json.id}`);
  assert.deepEqual([shut.status, shut.json.closed.conversationId, shut.json.closed.tool], [404, SESSION_ID, 'opencode'], 'its page can continue it');
  const sent = prompts();
  /** At once, before the launcher has even written its record: a new chat with text, then its send and a resume. */
  async function atOnce(term, why) {
    const c = await newChat(`hello (${why})`);
    assert.equal(c.status, 200, c.json && c.json.error);
    assert.equal(c.json.sent, false, `${why}: a new chat's first message is not sent`);
    assert.equal((await owner('POST', `/api/chats/${c.json.id}/send`, { text: 'again' })).status, 409, `${why}: nor a message from it`);
    const again = await owner('POST', '/api/sessions', { tool: 'opencode', dir: proj, profile: 'gw', mode: 'resume', sessionId: SESSION_ID });
    assert.deepEqual([again.json.name, again.json.existing], [term, true], `${why}: a resume gets that terminal`);
    assert.ok(launchers() <= 1, `${why}: never a second launcher`);
    assert.equal(prompts(), sent, `${why}: nothing more reached OpenCode's server`);
    return c.json.id;
  }

  // ---- the folder's newest continued in a terminal (the dashboard starts it by its id, as a resume): its launcher
  // reports the conversation 4 s late ----
  slow(4000);
  const started = await owner('POST', '/api/sessions', { tool: 'opencode', dir: proj, profile: 'gw', mode: 'continue' });
  assert.equal(started.status, 200, started.json && started.json.error);
  const term = started.json.name;
  let chat = await atOnce(term, 'continued');
  await until('its launcher', async () => launchers() === 1);
  assert.deepEqual(listRuns().map((r) => [r.sessionId, r.conversation]), [[null, SESSION_ID]], 'not reported yet: only the record\'s own conversation says it');
  assert.equal((await owner('POST', `/api/chats/${chat}/send`, { text: 'still early' })).status, 409);
  await until('the conversation reported', async () => listRuns().some((r) => r.sessionId === SESSION_ID), 10_000);
  assert.equal((await owner('POST', `/api/chats/${chat}/close`, {})).status, 200); // no chat open on it now

  // ---- moved to another provider: the launcher restarts in the same terminal and reports late again ----
  slow(4000);
  const moved = await owner('POST', `/api/sessions/${encodeURIComponent(term)}/switch`, { profile: 'gw2' });
  assert.equal(moved.status, 200, moved.json && moved.json.error);
  chat = await atOnce(term, 'moved');
  let most = launchers();
  const looks = setInterval(() => (most = Math.max(most, launchers())), 50);
  t.after(() => clearInterval(looks));
  await until('the new launcher on the second gateway', async () => listRuns().some((r) => r.tool === 'opencode' && r.profile === 'gw2'));
  assert.equal(launchers(), 1);
  assert.equal((await owner('POST', `/api/chats/${chat}/send`, { text: 'still early' })).status, 409, 'before it reports, by the record');
  await until('the conversation reported again', async () => listRuns().some((r) => r.profile === 'gw2' && r.sessionId === SESSION_ID), 10_000);
  assert.equal((await owner('POST', `/api/chats/${chat}/send`, { text: 'after' })).status, 409, 'and after, by its report');
  clearInterval(looks);
  assert.equal(most, 1, 'one launcher at every moment of the move');
  assert.equal(launchers(), 1, 'one launcher on the conversation');
  assert.equal(prompts(), sent, 'and no chat process: nothing more was sent to OpenCode\'s server');
});
