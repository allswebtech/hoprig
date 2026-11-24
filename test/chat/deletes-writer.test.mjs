// A conversation someone else writes is never deleted (src/chat/deletes.mjs, growth.mjs), by construction: the size a
// delete compares with is set only by the session's own process (its turn end, its exit), never by a page's read; a
// change seen by any reader is stamped with the time it was seen; and the file is looked at again inside the
// journal's first step, at the moment of the move. Also: a quiet conversation, and an App session whose own process
// writes a last line when it ends (as Claude Code 2.1.327 does), are deleted at the first try.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');
const LINE = '{"type":"assistant","message":{"content":[]}}\n';

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
};
const ago = (f) => fs.utimesSync(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

const box = sandbox('delwriter');
const work = path.join(box.root, 'work');
const proj = path.join(work, 'shop');
fs.mkdirSync(proj, { recursive: true });
let armed = null; // tests: what to do at a step of the trash's journal
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { projectDir } = await import('../../src/sessions.mjs');
saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
writeProfile('sub', { label: 'Main' });
process.env.FAKE_CLAUDE_RECORD = '1'; // as Claude Code 2.1.327: a record of each running session
process.env.FAKE_CLAUDE_EXIT_LINE = '1'; // …and a last line in the transcript when it ends
const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000, trashStep: (s) => armed?.(s) } });
const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
test.after(async () => {
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
const dir = projectDir(fs.realpathSync(proj));
const card = async (id) => (await owner('GET', '/api/chats')).json.chats.find((k) => k.chatId === id);
const trashed = async () => (await owner('GET', '/api/chats/trash')).json.list;
/** An App session of `text` after its first turn → { id (the chat), conv (its conversation), file } */
async function open(text) {
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text })).json.id;
  await until(`the first turn of "${text}"`, async () => {
    const v = (await owner('GET', `/api/chats/${id}`)).json;
    return v.status === 'waiting' && v.events.some((e) => e.kind === 'turn-end');
  });
  const conv = (await card(id)).sessionId;
  return { id, conv, file: path.join(dir, `${conv}.jsonl`) };
}
/** Its Claude Code is killed (as a crash): the App session stays, with no process. */
async function crash(s) {
  const recs = path.join(box.claude, 'sessions');
  const rec = fs.readdirSync(recs).map((n) => JSON.parse(fs.readFileSync(path.join(recs, n), 'utf8'))).find((j) => j.sessionId === s.conv);
  process.kill(rec.pid, 'SIGKILL');
  await until('its process ended', async () => (await card(s.id)).running === false);
}
/** An ended conversation of the folder (a terminal ran it), last written a minute ago. */
function ended(words) {
  const id = crypto.randomUUID();
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: words } })}\n`);
  ago(file);
  return { id, file };
}

test('a delete right after a page read what someone else wrote is refused: the page\'s read does not make it the session\'s own', async () => {
  const s = await open('pay by cash');
  await crash(s);
  await sleep(50);
  fs.appendFileSync(s.file, LINE); // a Claude Code that keeps no record goes on with it in a terminal
  assert.equal((await owner('GET', `/api/chats/${s.id}`)).status, 200, 'the page reads it (its stream does every 1.5 s)');
  const r = await owner('POST', '/api/chats/delete', { chats: [s.id] });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error, /^It is still being written/);
  assert.ok(fs.existsSync(s.file) && (await card(s.id)), 'left where it is, and still listed');
  // Twice more after reads, as an open page goes on reading it.
  for (let i = 0; i < 2; i++) {
    await owner('GET', `/api/chats/${s.id}`);
    assert.equal((await owner('POST', '/api/chats/delete', { chats: [s.id] })).status, 409, `read again (${i + 1})`);
  }
});

test('an outside writer that appends every 200 ms is never deleted in fifty tries, as an ended conversation or as an App session', async () => {
  const conv = ended('my own terminal work');
  const s = await open('pay by card');
  await crash(s);
  const writer = setInterval(() => {
    fs.appendFileSync(conv.file, LINE);
    fs.appendFileSync(s.file, LINE);
  }, 200);
  try {
    await sleep(250);
    let deleted = 0;
    for (let i = 0; i < 50; i++) {
      await sleep(Math.floor(Math.random() * 120)); // any moment between two writes
      if (i % 2) await owner('GET', `/api/chats/${s.id}`); // the page reads the App session meanwhile
      const a = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: conv.id }] });
      const b = await owner('POST', '/api/chats/delete', { chats: [s.id] });
      deleted += (a.status === 200) + (b.status === 200);
      assert.equal(a.status, 409, `try ${i + 1}, the ended conversation: ${JSON.stringify(a.json)}`);
      assert.equal(b.status, 409, `try ${i + 1}, the App session: ${JSON.stringify(b.json)}`);
    }
    assert.equal(deleted, 0);
  } finally {
    clearInterval(writer);
  }
  assert.ok(fs.existsSync(conv.file) && fs.existsSync(s.file), 'both whole where they were');
  assert.ok(!(await trashed()).some((x) => ['my own terminal work', 'pay by card'].includes(x.title)), 'nothing of them in the trash');
});

test('written between the check and the move (inside the journal\'s first step): nothing moves', async () => {
  const conv = ended('older work');
  const before = fs.readFileSync(conv.file);
  armed = (step) => {
    if (step !== 'journal') return;
    armed = null;
    fs.appendFileSync(conv.file, LINE); // after the check, before the files move
  };
  const r = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: conv.id }] });
  armed = null;
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error, /^It is still being written/);
  assert.equal(fs.readFileSync(conv.file).length, before.length + LINE.length, 'the file is where it was, with what was written');
  assert.deepEqual((await trashed()).filter((x) => x.title === 'older work'), [], 'no entry is left in the trash');
  assert.deepEqual(fs.readdirSync(path.join(box.state, 'trash')).filter((n) => /^[0-9a-f]{16}$/.test(n) && !fs.existsSync(path.join(box.state, 'trash', n, 'entry.json'))), [], 'no half entry');
});

test('a quiet conversation is deleted at the first try, and so is an App session whose own process writes a last line as it ends', async () => {
  const conv = ended('quiet work');
  const r1 = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: conv.id }] });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const s = await open('ship it');
  const size = fs.statSync(s.file).size;
  await owner('GET', `/api/chats/${s.id}`); // a page looks at it while its process runs
  const r2 = await owner('POST', '/api/chats/delete', { chats: [s.id] });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  const e = (await trashed()).find((x) => x.title === 'ship it');
  assert.ok(e, 'in the trash');
  const moved = path.join(box.state, 'trash', e.id, 'files', `${s.conv}.jsonl`);
  assert.ok(fs.statSync(moved).size > size, 'with the line its own process wrote at its end, whole');
  // Put back, then a page's read: the line its own process wrote at its end is still its own (kept in its record).
  const back = await owner('POST', `/api/chats/trash/${e.id}/restore`, {});
  assert.equal(back.status, 200);
  await owner('GET', `/api/chats/${s.id}`);
  assert.equal((await owner('POST', '/api/chats/delete', { chats: [s.id] })).status, 200, 'after Put back: deleted at the first try');
});
