// Two taps on one card at the same moment (two tabs, a double click that sends twice): its act runs once, through
// the page's real route (POST /api/assistant/cards/<id>/confirm) on a real dashboard. One tap gets the result, the
// other is refused and runs nothing. A new project's stand-in counts how often it ran; a start counts its sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE_SESSION = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-session.mjs');

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

test('two confirms of one card at the same moment run its act once', { timeout: 120_000, skip: process.platform === 'win32' && 'the fake launcher is POSIX' }, async (t) => {
  const box = sandbox('tia-twice');
  const work = path.join(box.root, 'work');
  const projects = path.join(work, 'projects');
  fs.mkdirSync(path.join(projects, 'shop', '.git'), { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  let made = 0;
  // "Ask me": a start is a card too, so both kinds are taps of his.
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'ask' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watch: false, dashboardFile: false,
    pcsetup: {
      // A computer with no programs: the new project's card asks whether GitHub is signed in, and no gh is there.
      sys: { platform: 'linux', has: () => false, run: async () => ({ ok: false, stdout: '', stderr: '' }), env: process.env, home: process.env.HOME },
      projectsDir: () => projects,
      projectNew: async ([name]) => {
        made++;
        await new Promise((r) => setTimeout(r, 200)); // long enough for the second tap to arrive while it runs
        fs.mkdirSync(path.join(projects, name, '.git'), { recursive: true });
        return 0;
      },
    },
    workspace: { dir: path.join(box.root, 'ws'), projectsDir: () => projects },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': 'twice' } })).json;
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => resolve(res.headers['set-cookie'][0].split(';')[0]));
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const twice = async (text) => {
    const id = /card (c_[0-9a-f]{12})/.exec(text)[1];
    const tap = () => request(base, 'POST', `/api/assistant/cards/${id}/confirm`, { body: {}, headers: { Cookie: cookie } });
    const rs = await Promise.all([tap(), tap()]);
    return rs.sort((x, y) => x.status - y.status);
  };
  const ops = app.features.find((f) => f.name === 'assistant').ops;

  // A new project: the act ran once, one tap is told so, the other is refused.
  let r = await call('manage_project', { action: 'new', name: 'blog' });
  assert.match(r.text, /Waiting for the owner's OK/, r.text);
  let [won, lost] = await twice(r.text);
  assert.deepEqual([won.status, lost.status], [200, 409]);
  // The card itself is taken once (cards.mjs take): the second tap never reaches the act, so the card ends done.
  assert.equal(won.json.card.status, 'done', JSON.stringify(won.json.card.outcome));
  assert.match(lost.json.error, /the card was already used/);
  assert.equal(made, 1, 'the project was made more than once');

  // A start in a terminal: one session, not two.
  const before = (await ops.listSessions({ computer: 'this' })).length;
  r = await call('start_session', { folder: path.join(projects, 'shop'), account: 'sub', message: 'run the tests' });
  assert.match(r.text, /Waiting for the owner's OK/, r.text);
  [won, lost] = await twice(r.text);
  assert.deepEqual([won.status, lost.status], [200, 409]);
  assert.match(lost.json.error, /already used|the same start ran a moment ago/);
  const after = await ops.listSessions({ computer: 'this' });
  assert.equal(after.length, before + 1, `${after.length - before} sessions started`);
  for (const s of after) await ops.stopSession?.({ computer: 'this', session: s.name }).catch(() => {});
});
