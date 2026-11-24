// Delete through the real dashboard (createServer, src/chat/deletes.mjs): one App session and several at once go to
// the trash and leave the list, a working one and one a terminal runs are refused with the reason, Undo (Put back)
// opens the session again, Put back is refused while the conversation is there again, an ended conversation of a
// folder is deleted from its folder, a folder outside the allowed roots and a request from another site are refused.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');

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
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((res) => setTimeout(res, 50));
  }
};

test('Delete: one and several, a working one refused, Undo, Put back refused when the conversation is back, ended conversations, bad paths', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('deletes');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  const { createRun, updateRun } = await import('../../src/runs.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const WRITING = 800; // the window in which someone else's write refuses a delete (the product's: 5 s)
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000, writingMs: WRITING } });
  const { port } = await app.listen(0, '127.0.0.1');
  const quiet = () => new Promise((r) => setTimeout(r, WRITING + 200)); // nobody wrote it for longer than the window
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
  const listed = async () => (await owner('GET', '/api/chats')).json.chats.map((c) => c.chatId);
  const dir = projectDir(fs.realpathSync(proj));
  const open = async (text) => {
    const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text })).json.id;
    await until(`the first turn of "${text}"`, async () => {
      const v = (await owner('GET', `/api/chats/${id}`)).json;
      return v.status === 'waiting' && v.events.some((e) => e.kind === 'turn-end');
    });
    return id;
  };

  assert.equal((await request(base, 'GET', '/api/chats/trash')).status, 401, 'behind the sign-in');
  assert.deepEqual((await owner('GET', '/api/chats/trash')).json, { list: [], keepDays: 30 });

  // ---- one ----
  const a = await open('fix the cart');
  assert.ok(fs.existsSync(path.join(dir, `${a}.jsonl`)));
  // The folder's list (the terminal page's and the Projects page's Earlier conversations) marks a conversation that is
  // open in an App session, as the App's own list does: those pages then offer no Delete for it.
  const inFolder = (await owner('GET', `/api/folders/sessions?path=${encodeURIComponent(proj)}`)).json.sessions;
  assert.equal(inFolder.find((c) => c.id === a).chat, a, 'open in the App session that waits');
  // Asked as a folder's ended conversation all the same (a list drawn before, another tab): refused, the session stays.
  const asConv = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: a }] });
  assert.equal(asConv.status, 409, JSON.stringify(asConv.json));
  assert.equal(asConv.json.error, 'It is open in an App session: delete that session there.');
  assert.ok((await listed()).includes(a), 'still in the App\'s list');
  assert.ok(JSON.parse(fs.readFileSync(path.join(box.state, 'chats.json'), 'utf8')).some((r) => r.id === a), 'and in chats.json');
  assert.ok(fs.existsSync(path.join(dir, `${a}.jsonl`)), 'its transcript where it was');
  assert.deepEqual((await owner('GET', '/api/chats/trash')).json.list, [], 'nothing in the trash');
  const r1 = await owner('POST', '/api/chats/delete', { chats: [a] });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.deepEqual(r1.json.deleted.map((x) => [x.title, x.chat]), [['fix the cart', a]]);
  const left = await owner('GET', `/api/chats/${a}`);
  assert.equal(left.status, 404);
  assert.deepEqual([left.json.closed.deleted, left.json.closed.conversationId], [true, null], 'its page says it was deleted and offers no Continue');
  assert.ok(!(await listed()).includes(a), 'it left the list');
  assert.ok(!fs.existsSync(path.join(dir, `${a}.jsonl`)), 'its transcript went to the trash');
  const trashed = (await owner('GET', '/api/chats/trash')).json.list;
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].title, 'fix the cart');
  assert.equal(trashed[0].until - trashed[0].at, 30 * 86_400_000);
  assert.equal(trashed[0].cwd, undefined, 'the page gets the short folder, not more');

  // ---- Undo (Put back): the session is open again with its conversation ----
  const back = await owner('POST', `/api/chats/trash/${r1.json.deleted[0].trash}/restore`, {});
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.chat, a);
  assert.ok((await listed()).includes(a));
  assert.ok((await owner('GET', `/api/chats/${a}`)).json.events.some((e) => e.kind === 'user' && e.text === 'fix the cart'), 'its conversation is read back');
  assert.deepEqual((await owner('GET', '/api/chats/trash')).json.list, []);

  // ---- several at once, one of them working: that one is refused and says why ----
  const b = await open('add a coupon');
  const c = await open('busy one');
  await owner('POST', `/api/chats/${c}/send`, { text: 'sleep' });
  await until('the long command', async () => (await owner('GET', `/api/chats/${c}`)).json.status === 'working');
  const r2 = await owner('POST', '/api/chats/delete', { chats: [a, b, c] });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.deleted.map((x) => x.title).sort(), ['add a coupon', 'fix the cart']);
  assert.deepEqual(r2.json.refused.map((x) => [x.chat, x.why]), [[c, 'Claude is working in it. Stop it first, or wait until it is done.']]);
  assert.deepEqual(await listed(), [c]);
  const only = await owner('POST', '/api/chats/delete', { chats: [c] });
  assert.equal(only.status, 409, 'nothing could be deleted');
  assert.match(only.json.error, /working in it/);
  assert.ok(fs.existsSync(path.join(dir, `${c}.jsonl`)), 'the working one is untouched');
  await owner('POST', `/api/chats/${c}/stop`, {});

  // ---- Put back refused while a conversation with the same id is there again ----
  const entryB = (await owner('GET', '/api/chats/trash')).json.list.find((x) => x.title === 'add a coupon');
  fs.writeFileSync(path.join(dir, `${b}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a new one' } })}\n`);
  const clash = await owner('POST', `/api/chats/trash/${entryB.id}/restore`, {});
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /same id is in that folder again/);
  assert.equal(fs.readFileSync(path.join(dir, `${b}.jsonl`), 'utf8').includes('a new one'), true, 'the one there is kept');
  assert.ok((await owner('GET', '/api/chats/trash')).json.list.some((x) => x.id === entryB.id), 'the deleted one stays in the trash');

  // ---- an ended conversation of the folder (a terminal ran it), and one a terminal runs now ----
  const ended = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${ended}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'old terminal work' } })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Old terminal work' })}\n`);
  const running = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${running}.jsonl`), '{"type":"user","message":{"role":"user","content":"live"}}\n');
  const ago = (f) => fs.utimesSync(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // it ended a while ago
  ago(path.join(dir, `${ended}.jsonl`));
  const run = createRun({ profile: 'sub', cwd: fs.realpathSync(proj) });
  updateRun(run.file, { status: 'working', sessionId: running });
  t.after(() => fs.rmSync(run.file, { force: true }));
  const folder = (await owner('GET', `/api/folders/sessions?path=${encodeURIComponent(proj)}`)).json.sessions;
  assert.deepEqual([folder.find((c) => c.id === ended).chat, folder.find((c) => c.id === ended).terminal], [null, false], 'an ended one is open nowhere');
  assert.equal(folder.find((c) => c.id === running).terminal, true, 'the one a terminal runs is marked: a page offers no Delete for it');
  const hist = (await owner('GET', `/api/chats/${c}/history`)).json.conversations;
  assert.deepEqual([hist.find((x) => x.id === running)?.terminal, hist.find((x) => x.id === ended)?.terminal], [true, false], 'the App\'s Earlier conversations marks it too');
  const r3 = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: ended }, { dir: proj, id: running }] });
  assert.equal(r3.status, 200, JSON.stringify(r3.json));
  assert.deepEqual(r3.json.deleted.map((x) => x.title), ['Old terminal work'], 'named as Claude Code named it');
  assert.equal(r3.json.refused.length, 1);
  assert.match(r3.json.refused[0].why, /runs in a terminal/);
  assert.ok(!fs.existsSync(path.join(dir, `${ended}.jsonl`)));
  assert.ok(fs.existsSync(path.join(dir, `${running}.jsonl`)), 'the running one is untouched');

  // ---- one a Claude Code outside the dashboard runs: by its own record of what runs, or by a file written now ----
  const outsider = crypto.randomUUID();
  const outFile = path.join(dir, `${outsider}.jsonl`);
  fs.writeFileSync(outFile, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'my own terminal' } })}\n`);
  ago(outFile);
  const sessions = path.join(box.claude, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: outsider, kind: 'interactive' }));
  const r6 = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: outsider }] });
  assert.equal(r6.status, 409);
  assert.equal(r6.json.error, 'It runs in Claude Code outside the dashboard. End it there first.');
  fs.rmSync(path.join(sessions, `${process.pid}.json`));
  const writer = setInterval(() => fs.appendFileSync(outFile, '{"type":"assistant","message":{"content":[]}}\n'), 200);
  await new Promise((r) => setTimeout(r, 300));
  const r7 = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: outsider }] });
  clearInterval(writer);
  assert.equal(r7.status, 409);
  assert.match(r7.json.error, /^It is still being written/);
  assert.ok(fs.existsSync(outFile), 'left where it is, whole');
  await quiet();
  assert.equal((await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: outsider }] })).status, 200, 'once it ended');

  // ---- a record a killed Claude Code left behind, whose pid another process has now: its start says so ----
  if (process.platform === 'linux') {
    const st = fs.readFileSync('/proc/self/stat', 'utf8');
    const mine = st.slice(st.lastIndexOf(')') + 2).split(' ')[19];
    const left = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, `${left}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'crashed once' } })}\n`);
    ago(path.join(dir, `${left}.jsonl`));
    const rec = path.join(sessions, `${process.pid}.json`);
    fs.writeFileSync(rec, JSON.stringify({ pid: process.pid, sessionId: left, procStart: mine }));
    assert.equal((await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: left }] })).status, 409, 'the process that wrote it still runs');
    fs.writeFileSync(rec, JSON.stringify({ pid: process.pid, sessionId: left, procStart: String(Number(mine) + 1) }));
    assert.equal((await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: left }] })).status, 200, 'another process has its pid');
    fs.rmSync(rec);
  }

  // ---- an App session whose conversation a Claude Code outside the dashboard runs too (claude --resume in a terminal),
  // by both ways to name it; the record its own Claude Code writes does not count ----
  process.env.FAKE_CLAUDE_RECORD = '1'; // the stand-ins write their own record, as Claude Code does
  const x = await open('pay by cash');
  const y = await open('pay by card');
  delete process.env.FAKE_CLAUDE_RECORD;
  const card = async (id) => (await owner('GET', '/api/chats')).json.chats.find((k) => k.chatId === id);
  const convX = (await card(x)).sessionId;
  const recOf = (conv) => fs.readdirSync(sessions).find((n) => JSON.parse(fs.readFileSync(path.join(sessions, n), 'utf8')).sessionId === conv);
  assert.ok(recOf(convX), 'its own process wrote a record');
  const theirs = path.join(sessions, `${process.pid}.json`);
  fs.writeFileSync(theirs, JSON.stringify({ pid: process.pid, sessionId: convX, kind: 'interactive' }));
  for (const body of [{ chats: [x] }, { conversations: [{ dir: proj, id: convX }] }]) {
    const r = await owner('POST', '/api/chats/delete', body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(r.json.error, 'It runs in Claude Code outside the dashboard. End it there first.');
  }
  assert.ok((await listed()).includes(x) && fs.existsSync(path.join(dir, `${convX}.jsonl`)), 'nothing moved');
  fs.rmSync(theirs);
  assert.equal((await owner('POST', '/api/chats/delete', { chats: [x] })).status, 200, 'its own record alone: deleted');
  // ---- …or one that writes no record: its transcript grew a moment ago while the App session's process was down ----
  const convY = (await card(y)).sessionId;
  process.kill(JSON.parse(fs.readFileSync(path.join(sessions, recOf(convY)), 'utf8')).pid, 'SIGKILL');
  await until('its process ended', async () => (await card(y)).running === false);
  const fileY = path.join(dir, `${convY}.jsonl`);
  fs.appendFileSync(fileY, '{"type":"assistant","message":{"content":[]}}\n');
  const r8 = await owner('POST', '/api/chats/delete', { chats: [y] });
  assert.equal(r8.status, 409);
  assert.match(r8.json.error, /^It is still being written/);
  await quiet();
  assert.equal((await owner('POST', '/api/chats/delete', { chats: [y] })).status, 200, 'once it ended');

  // ---- a batch with one that is gone meanwhile: the rest is deleted, that one refused, the answer lists both ----
  const d = await open('pay by card');
  const e = await open('ship it');
  const ghost = crypto.randomUUID();
  const r4 = await owner('POST', '/api/chats/delete', { chats: [d, ghost, e] });
  assert.equal(r4.status, 200, JSON.stringify(r4.json));
  assert.deepEqual(r4.json.deleted.map((x) => x.title), ['pay by card', 'ship it']);
  assert.deepEqual(r4.json.refused.map((x) => [x.chat, x.why]), [[ghost, 'this chat is not open (it was archived or opened in a terminal)']]);
  // ---- a batch with one a browser may not name: refused before anything moves ----
  const ended2 = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${ended2}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'older work' } })}\n`);
  const r5 = await owner('POST', '/api/chats/delete', { conversations: [{ dir: proj, id: ended2 }, { dir: '/etc', id: ended2 }] });
  assert.equal(r5.status, 400);
  assert.ok(fs.existsSync(path.join(dir, `${ended2}.jsonl`)), 'the first one was not moved');
  assert.ok(!(await owner('GET', '/api/chats/trash')).json.list.some((x) => x.title === 'older work'));

  // ---- what a browser may not ask ----
  const outside = path.join(box.root, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  for (const bad of [{ conversations: [{ dir: outside, id: ended }] }, { conversations: [{ dir: proj, id: '../x' }] }, { conversations: [{ dir: `${proj}/../..`, id: ended }] }, { chats: ['../../etc'] }, { chats: 'x' }, {}]) {
    assert.equal((await owner('POST', '/api/chats/delete', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await owner('POST', '/api/chats/delete', { chats: Array.from({ length: 51 }, () => crypto.randomUUID()) })).status, 400, 'at most 50');
  assert.equal((await request(base, 'POST', '/api/chats/delete', { body: { chats: [c] }, headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403, 'not from another site');
  assert.equal((await request(base, 'POST', '/api/chats/delete', { body: { chats: [c] } })).status, 401, 'not without the sign-in');
  assert.equal((await owner('POST', '/api/chats/trash/0123456789abcdef/restore', {})).status, 404);
});

test('a dashboard killed while it deletes an App session or puts it back: at its next start the session is listed or in the trash, never lost', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('delkilled');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  t.after(() => box.cleanup());
  const killed = path.join(HERE, 'fixtures', 'delete-killed.mjs');
  // journal: the delete's first step (before: after the session had left the list); closed: the session left the
  // list, nothing moved yet; restoring's done: the files are back, the journal gone.
  for (const [op, at] of [['delete', 'journal'], ['delete', 'closed'], ['restore', 'done']]) {
    fs.rmSync(path.join(box.state, 'chats.json'), { force: true });
    const r = spawnSync(process.execPath, [killed, op, at, proj, FAKE_CLAUDE], { env: process.env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.signal, 'SIGKILL', `${op} killed at ${at}: ${r.stderr}`);
    const { id } = JSON.parse(r.stdout.split('\n')[0]);
    const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 } });
    const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
    try {
      const cookie = await new Promise((resolve) => {
        const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
          res.resume();
          resolve(res.headers['set-cookie'][0].split(';')[0]);
        });
        req.end(JSON.stringify({ password: 'pw-for-tests' }));
      });
      const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
      const listed = (await owner('GET', '/api/chats')).json.chats.some((c) => c.chatId === id);
      const trashed = (await owner('GET', '/api/chats/trash')).json.list.filter((x) => x.title === 'fix the cart');
      assert.equal(listed, true, `${op} killed at ${at}: the session is listed again`);
      assert.equal(trashed.length, 0, `${op} killed at ${at}: and not also in the trash`);
      assert.equal((await owner('GET', `/api/chats/${id}`)).json.events.some((e) => e.kind === 'user' && e.text === 'fix the cart'), true, 'with its conversation');
      await owner('POST', `/api/chats/${id}/close`, {});
    } finally {
      await app.close();
    }
  }
});
