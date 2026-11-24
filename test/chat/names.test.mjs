// A session's name through the real dashboard (createServer): the App session's card (the list, Home, a
// notification: its display), its page (the title bar and the tab: its title) and the folder's conversations all
// take Claude Code's title when it is written after the start; a rename made here wins over a later generated title
// and is still the name after a restart of the dashboard.
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

test('names: a title written later reaches every list; a rename here wins over a later one and survives a restart', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('names');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  let app;
  let base;
  let cookie;
  const up = async () => {
    app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 } });
    base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
    cookie = await new Promise((resolve) => {
      const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
        res.resume();
        resolve(res.headers['set-cookie'][0].split(';')[0]);
      });
      req.end(JSON.stringify({ password: 'pw-for-tests' }));
    });
  };
  await up();
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'fix the cart total' })).json.id;
  await until('the first turn', async () => (await owner('GET', `/api/chats/${id}`)).json.status === 'waiting');
  const card = async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.chatId === id);
  const names = async () => [(await card()).display, (await owner('GET', `/api/chats/${id}`)).json.title, (await owner('GET', `/api/folders/sessions?path=${encodeURIComponent(proj)}`)).json.sessions[0].title];
  assert.deepEqual(await names(), ['fix the cart total', 'fix the cart total', 'fix the cart total'], 'the first words until a title exists');
  const file = path.join(projectDir(fs.realpathSync(proj)), `${id}.jsonl`);
  const titled = (x) => {
    fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: x, sessionId: id })}\n`);
    const at = new Date(fs.statSync(file).mtimeMs + 1000);
    fs.utimesSync(file, at, at);
  };
  titled('Cart total fix');
  assert.deepEqual(await names(), ['Cart total fix', 'Cart total fix', 'Cart total fix'], 'the list, Home and notifications (display), the title bar and tab (title), the folder\'s list');
  // The page open meanwhile (its title bar and tab read the stream's state) gets the title written to the file.
  const got = [];
  const sse = http.get(new URL(`/api/chats/${id}/stream`, base), { headers: { Cookie: cookie } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const m = /^event: state\ndata: (.*)$/s.exec(buf.slice(0, i));
        if (m) got.push(JSON.parse(m[1]).title);
      }
    });
  });
  await until('the first state', async () => got.length > 0);
  titled('Cart total and rounding');
  await until('the new title in the stream', async () => got.at(-1) === 'Cart total and rounding');
  sse.destroy();
  assert.deepEqual(await names(), ['Cart total and rounding', 'Cart total and rounding', 'Cart total and rounding'], 'changed again');
  await owner('POST', `/api/chats/${id}/title`, { title: 'Checkout totals' });
  titled('Something the model wrote later');
  assert.deepEqual(await names(), ['Checkout totals', 'Checkout totals', 'Checkout totals'], 'a rename here wins over a later title');
  await app.close();
  await up();
  assert.deepEqual(await names(), ['Checkout totals', 'Checkout totals', 'Checkout totals'], 'after a restart');
});

test('names: a terminal session is named as Claude Code names its conversation, in the list Home and the App\'s list read', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('termnames');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
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
  const made = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'new' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const card = () => until('the terminal session with its conversation', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === made.json.name && s.sessionId));
  const first = await card();
  assert.equal(first.display || first.name, made.json.name, 'no conversation yet: the terminal\'s own name');
  const file = path.join(projectDir(fs.realpathSync(proj)), `${first.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'tidy the styles' } })}\n${'{"type":"assistant","message":{"content":[]}}\n'.repeat(3000)}`);
  await until('its first words', async () => (await card()).display === 'tidy the styles');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Style cleanup', sessionId: first.sessionId })}\n`);
  await until('Claude Code\'s title', async () => (await card()).display === 'Style cleanup');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'css-pass', sessionId: first.sessionId })}\n`);
  await until('a rename in Claude Code', async () => (await card()).display === 'css-pass');
  assert.equal((await card()).name, made.json.name, 'the terminal keeps its own id for its address');
  // Rename on the terminal's page ("the name shown everywhere"): its conversation is named so.
  const renamed = await owner('POST', `/api/sessions/${encodeURIComponent(made.json.name)}/rename`, { name: 'styles-v2' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  const named = await until('the new name', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === 'styles-v2'));
  assert.equal(named.display, 'styles-v2', 'the list, Home and notifications show the rename');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'A later generated title', sessionId: first.sessionId })}\n`);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await owner('GET', '/api/state')).json.sessions.find((s) => s.name === 'styles-v2').display, 'styles-v2', 'and wins over a later title');
});

test('names: an App session gets Claude Code\'s generated title, asked for after its first turn, in the list and the title bar', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('gentitle');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const args = path.join(box.root, 'args.jsonl');
  // The stand-in knows generate_session_title (as 2.1.327 does) and writes no title unless it is asked for one.
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_TITLE: 'Cart total fix', FAKE_CLAUDE_ARGS: args }), idleMs: 60_000 } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
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
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'please look at the checkout where the total is counted twice' })).json.id;
  const names = async () => [(await owner('GET', '/api/state')).json.sessions.find((s) => s.chatId === id).display, (await owner('GET', `/api/chats/${id}`)).json.title];
  await until('Claude Code\'s title', async () => JSON.stringify(await names()) === JSON.stringify(['Cart total fix', 'Cart total fix']));
  const asked = fs.readFileSync(args, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.control && x.control.subtype === 'generate_session_title');
  assert.deepEqual(asked.map((x) => x.control), [{ subtype: 'generate_session_title', description: 'please look at the checkout where the total is counted twice', persist: true }], 'asked once, from the first prompt');
  const file = path.join(projectDir(fs.realpathSync(proj)), `${id}.jsonl`);
  assert.ok(fs.readFileSync(file, 'utf8').includes('"aiTitle":"Cart total fix"'), 'kept in the transcript, where a terminal reads it too');
  await owner('POST', `/api/chats/${id}/send`, { text: 'and the coupon' });
  await until('the second turn', async () => (await owner('GET', `/api/chats/${id}`)).json.events.filter((e) => e.kind === 'turn-end').length === 2);
  assert.equal(fs.readFileSync(args, 'utf8').split('generate_session_title').length - 1, 1, 'a conversation with a title is not asked again');
});

test('names: after /clear the new conversation drops a generated title and keeps a name given here', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('clearnames');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { ownName, setOwnName } = await import('../../src/titles.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_TITLE: 'Cart total fix' }), idleMs: 60_000 } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
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
  const names = async (id) => [(await owner('GET', '/api/state')).json.sessions.find((s) => s.chatId === id).display, (await owner('GET', `/api/chats/${id}`)).json.title];
  const ends = async (id) => (await owner('GET', `/api/chats/${id}`)).json.events.filter((e) => e.kind === 'turn-end').length;
  const send = async (id, text) => {
    const n = await ends(id);
    await owner('POST', `/api/chats/${id}/send`, { text });
    await until(`the end of "${text}"`, async () => (await ends(id)) > n);
  };

  // ---- not named: the generated title goes with the old conversation ----
  const a = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'the cart total is wrong' })).json.id;
  await until('the generated title', async () => (await names(a))[1] === 'Cart total fix');
  await send(a, 'clear');
  assert.deepEqual(await names(a), ['New session', ''], 'the old conversation\'s title is not the new one\'s');
  await send(a, 'add a search box to the blog');
  assert.deepEqual(await names(a), ['add a search box to the blog', 'add a search box to the blog'], 'named after its own first words');

  // ---- named here: the name stays, for the new conversation too ----
  const b = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'tidy the styles' })).json.id;
  await until('the first turn', async () => (await ends(b)) === 1);
  await owner('POST', `/api/chats/${b}/title`, { title: 'Style pass' });
  await send(b, 'clear');
  const conv = (await owner('GET', '/api/state')).json.sessions.find((s) => s.chatId === b).sessionId;
  assert.notEqual(conv, b, 'a new conversation');
  assert.deepEqual(await names(b), ['Style pass', 'Style pass']);
  assert.equal(ownName(conv), 'Style pass', 'kept for the new conversation, so the folder\'s lists agree');

  // ---- named in Hoprig outside this chat (a terminal's Rename names the conversation): the name stays too ----
  const c = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'speed up the build' })).json.id;
  await until('the generated title', async () => (await names(c))[1] === 'Cart total fix');
  const before = (await owner('GET', '/api/state')).json.sessions.find((s) => s.chatId === c).sessionId;
  setOwnName(before, 'Build speed'); // what the terminal's Rename keeps (server.mjs)
  await until('the name', async () => (await names(c))[0] === 'Build speed');
  await send(c, 'clear');
  const after = (await owner('GET', '/api/state')).json.sessions.find((s) => s.chatId === c).sessionId;
  assert.notEqual(after, before);
  assert.deepEqual(await names(c), ['Build speed', 'Build speed']);
  assert.equal(ownName(after), 'Build speed', 'kept for the new conversation');
});

test('names: the title request is sent only while Settings has it on, once per conversation, never for one that has a title or a name', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('titleswitch');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const args = path.join(box.root, 'args.jsonl');
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_TITLE: 'Title for %s', FAKE_CLAUDE_ARGS: args }), idleMs: 60_000 } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
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
  const asked = () => (fs.existsSync(args) ? fs.readFileSync(args, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.control && x.control.subtype === 'generate_session_title').map((x) => x.control.description) : []);
  const turns = async (id, n) => until(`turn ${n} of ${id}`, async () => {
    const v = (await owner('GET', `/api/chats/${id}`)).json;
    return v.status === 'waiting' && v.events.filter((e) => e.kind === 'turn-end').length === n;
  });
  const dir = projectDir(fs.realpathSync(proj));

  assert.equal((await owner('GET', '/api/settings')).json.sessionTitles, true, 'on by default');
  assert.equal((await owner('POST', '/api/settings', { sessionTitles: 'no' })).status, 400, 'only true or false');
  assert.equal((await owner('POST', '/api/settings', { sessionTitles: false })).json.sessionTitles, false);

  // Off: nothing is sent, the first words stay the name.
  const a = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'count the coupons' })).json.id;
  await turns(a, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(asked(), [], 'with the switch off nothing is sent');
  assert.equal((await owner('GET', `/api/chats/${a}`)).json.title, 'count the coupons');

  // On again: asked after the next turn of that conversation, once.
  await owner('POST', '/api/settings', { sessionTitles: true });
  await owner('POST', `/api/chats/${a}/send`, { text: 'and the gift cards' });
  await turns(a, 2);
  await until('its title', async () => (await owner('GET', `/api/chats/${a}`)).json.title === 'Title for count the coupons');
  await owner('POST', `/api/chats/${a}/send`, { text: 'thanks' });
  await turns(a, 3);
  assert.deepEqual(asked(), ['count the coupons'], 'asked once, from the first prompt');

  // A conversation that has a title already (a terminal ran it), and one renamed here: never asked.
  const old = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${old}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'older work' } })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Older work on the cart' })}\n`);
  const b = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: old, text: 'go on' })).json.id;
  await turns(b, 1);
  const c = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'ship the order page' })).json.id;
  assert.equal((await owner('POST', `/api/chats/${c}/title`, { title: 'Order page' })).status, 200);
  await turns(c, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(asked(), ['count the coupons'], 'not for a conversation with a title, nor for one renamed here');
  assert.equal((await owner('GET', `/api/chats/${b}`)).json.title, 'Older work on the cart');
  assert.equal((await owner('GET', `/api/chats/${c}`)).json.title, 'Order page');

  // A terminal session is never asked: only the App's session object knows the request.
  const users = fs.readdirSync(path.join(HERE, '..', '..', 'src'), { recursive: true }).filter((f) => f.endsWith('.mjs') && fs.readFileSync(path.join(HERE, '..', '..', 'src', f), 'utf8').includes('generateTitle('));
  assert.deepEqual(users.sort(), ['chat/chat.mjs', 'chat/engines/claude.mjs'].sort(), 'the request is made from the App session alone');
});
