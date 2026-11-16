// One conversation, one process, while a terminal has not yet said which conversation it runs (its launcher writes the
// run record first, Claude Code reports the conversation at its start): through the real routes of a dashboard
// (createServer, built-in terminals). The terminal counts as that conversation's from its start until it reports it or
// ends, however long Claude Code takes to report (not for a fixed while), and also when the restore after a restart
// reopened it: a message or a resume right after the restart gets that terminal, never a second process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
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

test('a terminal that has not reported its conversation yet still runs it: after a slow start and after a restart', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('onestart');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { listRuns } = await import('../../src/runs.mjs');
  saveConfig({ launcher: [process.execPath, SLOW_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const slow = (ms) => fs.writeFileSync(path.join(box.state, 'slow-session-ms'), String(ms));
  const options = {
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
  };
  let app = null;
  let base = '';
  let cookie = '';
  const start = async () => {
    app = createServer(options);
    const { port } = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
    cookie = await new Promise((resolve) => {
      const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
        res.resume();
        resolve(res.headers['set-cookie'][0].split(';')[0]);
      });
      req.end(JSON.stringify({ password: 'pw-for-tests' }));
    });
  };
  t.after(async () => {
    if (app) await app.close();
    box.cleanup();
  });
  await start();
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const automation = () => app.features.find((f) => f.name === 'automation').automation;
  // Every launcher that runs (a terminal's), and whether a chat has a process.
  const launchers = () => listRuns().length;
  const chatProcesses = async () => (await owner('GET', '/api/chats')).json.chats.filter((c) => c.running).length;

  // A chat with a first answer: the conversation exists on disk.
  const made = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'hello' });
  const id = made.json.id;
  await until('the first answer', async () => (await owner('GET', `/api/chats/${id}`)).json.events.some((e) => e.kind === 'turn-end'));
  await until('the idle chat process to stop', async () => !(await owner('GET', `/api/chats/${id}`)).json.running);

  // ---- a slow start: Claude Code reports the conversation 4 s after the terminal opened ----
  slow(4000);
  const opened = await owner('POST', `/api/chats/${id}/terminal`, {});
  assert.equal(opened.status, 200);
  const term = opened.json.name;
  await until('its launcher', async () => listRuns().some((r) => !r.sessionId));
  await sleep(1500); // past the launch while: only the run record without a conversation says it now
  assert.ok(listRuns().every((r) => !r.sessionId), 'not reported yet');
  const early = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id });
  assert.deepEqual(early.json, { name: term, existing: true }, 'a resume before it reports gets that terminal');
  const chatEarly = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: id, text: 'too early' });
  assert.equal(chatEarly.json.sent, false, 'a message before it reports is not sent');
  assert.equal(launchers(), 1, 'one launcher');
  assert.equal(await chatProcesses(), 0, 'and no chat process');
  await until('the conversation reported', async () => listRuns().some((r) => r.sessionId === id), 10_000);
  const later = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id });
  assert.deepEqual(later.json, { name: term, existing: true }, 'and after, by its run record');

  assert.equal((await owner('POST', `/api/chats/${chatEarly.json.id}/close`, {})).status, 200); // no chat open on it now

  // ---- a restart: the restore reopens the terminal; its Claude Code reports late ----
  await automation().tick();
  await automation().tick(); // restore has learnt the session
  slow(20_000);
  await app.close();
  app = null;
  await until('the launcher gone with the built-in terminal', async () => launchers() === 0);
  await start();
  await automation().tick(); // the first tick after a start: restore reopens what the restart took away
  const reopened = await until('the terminal reopened', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === term));
  assert.ok(reopened, 'the restore reopened it');
  await until('its launcher', async () => listRuns().length === 1);
  const after = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: id, text: 'after the restart' });
  assert.equal(after.json.sent, false, 'a message right after the restart is not sent into a second process');
  assert.equal((await owner('POST', `/api/chats/${after.json.id}/send`, { text: 'again' })).status, 409, 'nor from that chat');
  const resumed = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id });
  assert.deepEqual(resumed.json, { name: term, existing: true });
  await sleep(500);
  assert.equal(launchers(), 1, 'one launcher on the conversation');
  assert.ok(listRuns().every((r) => !r.sessionId), 'which had not reported it yet');
  assert.equal(await chatProcesses(), 0, 'and no chat process');
  // The activity names the provider as the owner named it, not its id.
  const log = (await owner('GET', '/api/automation/log?limit=20')).json.entries.filter((e) => e.automation === 'restore');
  assert.ok(log.length >= 1, JSON.stringify(log));
  assert.match(log[0].did, /^reopened on Main \(resumed [0-9a-f]{8}\)$/);
});
