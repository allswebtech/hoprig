// The routes of a running chat in the real dashboard (src/chat/live.mjs and the send route's files): the event
// stream behind the login, mode and settings without a restart, the queue, one task's stop, rewind, the @ file search
// inside the chat's folder, the / commands, usage, and a message's uploaded picture and file. Claude Code is the
// stand-in (fixtures/fake-claude.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(parts);
        let json = null;
        try {
          json = JSON.parse(bytes.toString('utf8'));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, bytes, type: res.headers['content-type'] || '' });
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
  assert.equal(v0.hasMessage, false, 'nothing sent yet: the status line says Ready, not Finished');
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
  assert.equal(v1.hasMessage, true, 'a message was sent: the turn that ended is Finished');

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
  assert.match((await view()).events.filter((e) => e.kind === 'notice').at(-1).text, /^Files rewound to before your message \(1 file\)\. The conversation itself goes on as it was\./, 'the conversation says so');
  assert.equal((await owner('POST', `${A}/rewind`, { messageId: '../x' })).status, 400);

  // ---- the composer's menus ----
  assert.deepEqual((await owner('GET', `${A}/files?q=thtog`)).json.files, ['src/theme-toggle.js']);
  assert.ok((await owner('GET', `${A}/files?q=`)).json.files.includes('README.md'));
  assert.ok(!(await owner('GET', `${A}/files?q=passwd`)).json.files.length, 'only the chat\'s own folder');
  assert.deepEqual((await owner('GET', `${A}/commands`)).json.commands.map((x) => x.name), ['compact', 'review']);
  const usage = (await owner('GET', `${A}/usage`)).json;
  assert.equal(usage.limits.five_hour.percent, 42);
  // The session rail's Changes card: the chat's own folder, behind the login. The folder is a subfolder of a
  // repository here (made for this check, removed after it): a change beside it never shows.
  assert.deepEqual((await owner('GET', `${A}/changes`)).json, { git: false }, 'no repository: no card');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@box2', '-c', 'commit.gpgsign=false', ...a], { cwd: work, stdio: 'pipe' });
  const beside = path.join(work, 'beside');
  fs.mkdirSync(beside);
  fs.writeFileSync(path.join(beside, 'x.txt'), 'a\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(proj, 'README.md'), 'Y\nmore\n'); // 2 added, 1 removed
  fs.writeFileSync(path.join(proj, 'todo.md'), 'a\nb\nc\n'); // new: 3 added
  fs.writeFileSync(path.join(beside, 'x.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(beside, 'new.txt'), 'n\n');
  const ch = await owner('GET', `${A}/changes`);
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.json, { git: true, files: 2, untracked: 1, added: 5, removed: 1, list: [{ path: 'README.md', added: 2, removed: 1, new: false }, { path: 'todo.md', added: 3, removed: 0, new: true }] });
  assert.equal((await request(base, 'GET', `${A}/changes`)).status, 401);
  fs.rmSync(path.join(work, '.git'), { recursive: true, force: true });
  fs.rmSync(beside, { recursive: true, force: true });
  fs.rmSync(path.join(proj, 'todo.md'));
  fs.writeFileSync(path.join(proj, 'README.md'), 'y\n');

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

  // ---- the picture of a message, for the timeline: only this chat's uploads, only pictures, only with the login ----
  const pic = va.events.filter((e) => e.kind === 'user').at(-1).attachments[0].name;
  assert.equal(pic, path.basename(png));
  const got = await owner('GET', `${A}/attachment?name=${encodeURIComponent(pic)}`);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'image/png');
  assert.equal(got.bytes.toString('hex'), '89504e470d0a1a0a');
  assert.equal((await request(base, 'GET', `${A}/attachment?name=${encodeURIComponent(pic)}`)).status, 401, 'behind the login');
  assert.equal((await owner('GET', `${A}/attachment?name=${encodeURIComponent(path.basename(log))}`)).status, 400, 'pictures only');
  assert.equal((await owner('GET', `${A}/attachment?name=..%2F..%2FREADME.png`)).status, 400);
  assert.equal((await owner('GET', `${A}/attachment?name=nothing-here.png`)).status, 404);
  fs.symlinkSync(path.join(proj, 'README.md'), path.join(path.dirname(png), 'link.png'));
  assert.equal((await owner('GET', `${A}/attachment?name=link.png`)).status, 404, 'a link out of the uploads folder is not followed');

  // ---- the folder's history: earlier conversations with a title; one that a chat has open says which ----
  const hist = (await owner('GET', `${A}/history`)).json.conversations;
  const mine = hist.find((x) => x.current);
  assert.ok(mine, 'this chat\'s conversation is listed');
  assert.equal(mine.chat, id);
  assert.equal(mine.title, 'think');
  const cont = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: mine.id, defaults: true })).json;
  assert.equal(cont.id, id, 'continuing it opens this chat');
  assert.equal(cont.existing, true, 'said to be an open chat already (Tia does not take it for hers)');
  assert.equal(cont.permissionMode, (await owner('GET', `/api/chats/${id}`)).json.permissionMode ?? null, 'with its own mode: defaults do not apply to it');

  // ---- rewind of the conversation through the route: the message comes back for the box ----
  await owner('POST', `${A}/send`, { text: 'first of the new one' });
  await owner('POST', `${A}/send`, { text: 'second of the new one' });
  const vr = await until('two turns', async () => {
    const x = await view();
    return x.status === 'waiting' && x.events.filter((e) => e.kind === 'user').length >= 2 && x;
  });
  const second = vr.events.filter((e) => e.kind === 'user').at(-1);
  const rd = (await owner('POST', `${A}/rewind`, { messageId: second.messageId, dryRun: true, files: false, conversation: true })).json;
  assert.deepEqual(rd.conversation, { messages: 1, text: 'second of the new one' });
  assert.equal((await owner('POST', `${A}/rewind`, { messageId: second.messageId, files: false, conversation: true })).status, 200);
  assert.ok(!(await view()).events.some((e) => e.kind === 'user' && e.text === 'second of the new one'), 'the conversation went back');

  // ---- after a clear the chat runs another conversation under its old id: the old one is free to continue ----
  await owner('POST', `${A}/send`, { text: 'clear' });
  await until('the new conversation', async () => (await owner('GET', '/api/state')).json.sessions.find((x) => x.name === `chat:${id}`).sessionId !== id);
  const cleared = (await owner('GET', `${A}/history`)).json.conversations;
  assert.equal(cleared.find((x) => x.id === id).chat, null, 'the chat\'s own id is not the conversation it runs now');
  assert.equal(cleared.find((x) => x.id === id).current, false);
  const again = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: id })).json.id;
  assert.notEqual(again, id, 'the old conversation opens in a chat of its own');
  assert.equal((await owner('GET', `/api/chats/${again}`)).json.events.find((e) => e.kind === 'user').text, 'think', 'with its history');
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: id })).json.id, again, 'and only one');
  // A page that follows a chat learns at once that it closed, with what a look would answer: it never asks once more.
  const vAgain = (await owner('GET', `/api/chats/${again}`)).json;
  const sa = stream(base, `/api/chats/${again}/stream?from=${vAgain.next}&epoch=${vAgain.epoch}`, { Cookie: cookie });
  t.after(() => sa.close());
  await until('the stream of the second chat', () => sa.got.some((e) => e.event === 'state'));
  await owner('POST', `/api/chats/${again}/close`, {});
  const closedEv = await until('the closed event', () => sa.got.find((e) => e.event === 'closed'));
  assert.equal(sa.got.at(-1).event, 'closed', 'the last thing the stream says');
  assert.deepEqual([closedEv.data.closed.conversationId, closedEv.data.closed.tool], [id, 'claude']);
  assert.ok([proj, fs.realpathSync(proj)].includes(closedEv.data.closed.cwd));
  const look = await owner('GET', `/api/chats/${again}`);
  assert.deepEqual([look.status, look.json.closed], [404, closedEv.data.closed], 'the same as the 404 of a look');

  // ---- a folder whose uploads folder is a link out of it (a repository can commit one): nothing is read there ----
  const evil = path.join(work, 'evil');
  const outsideDir = path.join(box.root, 'outside');
  fs.mkdirSync(evil, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'not for Claude\n');
  fs.writeFileSync(path.join(outsideDir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.symlinkSync(outsideDir, path.join(evil, '.uploads'));
  const E = `/api/chats/${(await owner('POST', '/api/chats', { dir: evil, profile: 'sub' })).json.id}`;
  assert.equal((await owner('POST', `${E}/upload`, undefined, { raw: Buffer.from('x'), headers: { Cookie: cookie, 'X-File-Name': 'a.txt' } })).status, 400);
  const sent = await owner('POST', `${E}/send`, { text: 'x', attachments: [{ path: path.join(outsideDir, 'secret.txt') }] });
  assert.equal(sent.status, 400, 'a file behind the link is not attached');
  assert.match(sent.json.error, /not inside the chat's folder/);
  assert.equal((await owner('GET', `${E}/attachment?name=shot.png`)).status, 404, 'nor served as a picture');
});
