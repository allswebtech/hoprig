// The routes of a running chat in the real dashboard (src/chat/live.mjs and the send route's files): the event
// stream behind the login, mode and settings without a restart, the queue, one task's stop, rewind, the @ file search
// inside the chat's folder, the / commands, usage, and a message's uploaded picture and file. Claude Code is the
// stand-in (fixtures/fake-claude.mjs).
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
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function request(base, method, p, { body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw || (body === undefined ? null : JSON.stringify(body));
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Origin: base } : {}), ...headers } }, (res) => {
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

/** Read a server-sent event stream: { events: [{ event, data }], close() }. */
function stream(base, p, headers) {
  const got = [];
  let res;
  const req = http.get(new URL(p, base), { headers }, (r) => {
    res = r;
    let buf = '';
    r.setEncoding('utf8');
    r.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && data) got.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on('error', () => {});
  return { got, status: () => res && res.statusCode, close: () => req.destroy() };
}

test('the routes of a running chat', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatlive');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'theme-toggle.js'), 'x\n');
  fs.writeFileSync(path.join(proj, 'README.md'), 'y\n');
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'bypassPermissions' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 },
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
  const owner = (method, p, body, o = {}) => request(base, method, p, { body, headers: { Cookie: cookie }, ...o });
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  const A = `/api/chats/${id}`;
  const view = async () => (await owner('GET', A)).json;

  // ---- the stream: behind the login; events, state and deltas ----
  const outside = stream(base, `${A}/stream`, {});
  await until('the refusal', () => outside.status());
  assert.equal(outside.status(), 401);
  outside.close();
  const v0 = await view();
  const s = stream(base, `${A}/stream?from=${v0.next}&epoch=${v0.epoch}`, { Cookie: cookie });
  t.after(() => s.close());
  await until('the first state', () => s.got.some((e) => e.event === 'state'));
  assert.equal((await owner('POST', `${A}/send`, { text: 'think' })).json.queued, false);
  await until('the end of the turn in the stream', () => s.got.some((e) => e.event === 'events' && e.data.events.some((x) => x.kind === 'turn-end')));
  const evs = s.got.filter((e) => e.event === 'events').flatMap((e) => e.data.events);
  assert.deepEqual(evs.map((e) => e.kind), ['user', 'thinking', 'text', 'turn-end']);
  const deltas = s.got.filter((e) => e.event === 'live').flatMap((e) => e.data);
  assert.equal(deltas.filter((d) => d.kind === 'text-delta').map((d) => d.text).join(''), 'Forty-two.');
  assert.equal(s.got.filter((e) => e.event === 'state').at(-1).data.status, 'waiting');

  // ---- mode and settings: in the running process ----
  assert.equal((await owner('POST', `${A}/mode`, { mode: 'acceptEdits' })).json.liveMode, 'acceptEdits');
  assert.equal((await owner('POST', `${A}/mode`, { mode: 'everything' })).status, 400);
  const set = await owner('POST', `${A}/settings`, { model: 'haiku', effort: 'xhigh', ultracode: true });
  assert.deepEqual(set.json, { model: 'haiku', effort: 'xhigh', ultracode: true, restart: false });
  assert.equal((await owner('POST', `${A}/settings`, { ultracode: 'yes' })).status, 400);
  assert.equal((await owner('POST', `${A}/next`, { model: 'haiku' })).status, 404, 'the old route is gone');
  const v1 = await view();
  assert.deepEqual([v1.model, v1.effort, v1.ultracode, v1.permissionMode], ['haiku', 'xhigh', true, 'acceptEdits']);
  assert.equal(v1.engine.id, 'claude');

  // ---- the queue ----
  await owner('POST', `${A}/send`, { text: 'slow 600' });
  await until('working', async () => (await view()).working);
  const q2 = (await owner('POST', `${A}/send`, { text: 'queued one' })).json;
  const q3 = (await owner('POST', `${A}/send`, { text: 'taken back' })).json;
  assert.equal(q2.queued, true);
  assert.deepEqual((await view()).queue.map((x) => x.text), ['queued one', 'taken back']);
  assert.equal((await owner('POST', `${A}/unqueue`, { id: q3.id })).status, 200);
  assert.equal((await owner('POST', `${A}/unqueue`, { id: q3.id })).status, 409);
  await until('both turns', async () => {
    const x = await view();
    return x.status === 'waiting' && x.events.filter((e) => e.kind === 'user').map((e) => e.text).join('|') === 'think|slow 600|queued one' && x;
  });

  // ---- a background task, stopped on its own ----
  await owner('POST', `${A}/send`, { text: 'bgsleep' });
  const task = await until('the task', async () => (await view()).tasks.find((x) => x.type === 'shell' && x.status === 'running'));
  assert.equal((await view()).status, 'working', 'its card says working while the task runs');
  const card = (await owner('GET', '/api/state')).json.sessions.find((x) => x.name === `chat:${id}`);
  assert.equal(card.status, 'working');
  assert.equal((await owner('POST', `${A}/tasks/${task.taskId}/stop`, {})).status, 200);
  await until('waiting', async () => (await view()).status === 'waiting');

  // ---- rewind ----
  await owner('POST', `${A}/send`, { text: 'write made.txt' });
  const vw = await until('the write', async () => {
    const x = await view();
    return x.status === 'waiting' && fs.existsSync(path.join(proj, 'made.txt')) && x;
  });
  const msg = vw.events.filter((e) => e.kind === 'user').at(-1);
  const dry = (await owner('POST', `${A}/rewind`, { messageId: msg.messageId, dryRun: true })).json;
  assert.deepEqual(dry.files, [fs.realpathSync(path.join(proj, 'made.txt'))]);
  assert.equal((await owner('POST', `${A}/rewind`, { messageId: msg.messageId })).json.canRewind, true);
  assert.ok(!fs.existsSync(path.join(proj, 'made.txt')));
  assert.equal((await owner('POST', `${A}/rewind`, { messageId: '../x' })).status, 400);

  // ---- the composer's menus ----
  assert.deepEqual((await owner('GET', `${A}/files?q=thtog`)).json.files, ['src/theme-toggle.js']);
  assert.ok((await owner('GET', `${A}/files?q=`)).json.files.includes('README.md'));
  assert.ok(!(await owner('GET', `${A}/files?q=passwd`)).json.files.length, 'only the chat\'s own folder');
  assert.deepEqual((await owner('GET', `${A}/commands`)).json.commands.map((x) => x.name), ['compact', 'review']);
  const usage = (await owner('GET', `${A}/usage`)).json;
  assert.equal(usage.limits.five_hour.utilization, 0.42);

  // ---- a message's files: a picture goes in as an image, any other file as @path ----
  const up = async (name, bytes) => (await owner('POST', `${A}/upload`, undefined, { raw: bytes, headers: { Cookie: cookie, 'X-File-Name': name } })).json.path;
  const png = await up('shot.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  const log = await up('build.log', Buffer.from('error at line 3\n'));
  assert.equal((await owner('POST', `${A}/send`, { text: 'see these', attachments: [{ path: png }, { path: log }] })).status, 200);
  const va = await until('the answer', async () => {
    const x = await view();
    return x.events.some((e) => e.kind === 'text' && e.text.startsWith('echo: see these')) && x;
  });
  const said = va.events.filter((e) => e.kind === 'text').at(-1).text;
  assert.match(said, /\[1 image\]$/);
  assert.match(said, /@\.uploads\/[^ ]+build\.log/, 'the file is named for Claude Code to read');
  assert.deepEqual(va.events.filter((e) => e.kind === 'user').at(-1).attachments.map((x) => x.type), ['image', 'file']);
  assert.equal((await owner('POST', `${A}/send`, { text: 'x', attachments: [{ path: path.join(proj, 'README.md') }] })).status, 400, 'only files uploaded to this chat');
  assert.equal((await owner('POST', `${A}/send`, { text: 'x', attachments: [{ path: '/etc/passwd' }] })).status, 400);
});
