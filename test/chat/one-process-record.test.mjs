// One durable record of who runs a conversation, end to end: the REAL launcher (src/launch.mjs) with a stand-in Claude
// Code that reports late (../automation/fixtures/fake-claude.mjs), one that ends at once (a crash), and the chat's
// stand-in, on the built-in terminals and on tmux (an own socket). Each row ends with at most one process on the
// conversation and with no conversation that nobody can open:
//   F1  a move whose new Claude Code ends at once
//   F2  a start from the page whose Claude Code ends at once
//   F3  a move to Auto mode that the launcher refuses (no order)
//   B2  two moves of one terminal at the same moment
//   A1  the launcher's own menu after Claude Code ended, while a chat took the conversation meanwhile
//   O1  a launcher from a plain shell while a chat runs the conversation, and while a terminal of the dashboard does
// and the launcher's refusal from the page's resume, "Open as chat" before Claude Code has reported its conversation.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_TERM = path.join(HERE, '..', 'automation', 'fixtures', 'fake-claude.mjs');
const FAKE_CHAT = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const BIN = path.join(HERE, '..', '..', 'bin', 'hoprig.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const until = async (what, fn, ms = 20_000) => {
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

test('one record of who runs a conversation, on the built-in terminals', { timeout: 300_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, (t) => run(t, 'pty'));
test('one record of who runs a conversation, on tmux', { timeout: 300_000, skip: !tmuxUsable() && 'no tmux 3.2 or newer here' }, (t) => run(t, 'tmux'));

async function run(t, kind) {
  const box = sandbox(`onerecord-${kind}`);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'work-')));
  const claudeBin = path.join(box.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TERM}' "$@"\n`, { mode: 0o755 });
  const crashBin = path.join(box.root, 'crash-claude.sh'); // a Claude Code that ends at once (a crash, a bad flag)
  fs.writeFileSync(crashBin, '#!/bin/sh\necho "claude crashed at start"\nexit 1\n', { mode: 0o755 });
  const emptyConf = path.join(box.root, 'empty.conf');
  fs.writeFileSync(emptyConf, '');
  const router = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"ok":true}');
  });
  const routerPort = await new Promise((r) => router.listen(0, '127.0.0.1', () => r(router.address().port)));
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { setAutoSwitch } = await import('../../src/autoswitch.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { launchDir } = await import('../../src/launchfile.mjs');
  const { listRuns } = await import('../../src/runs.mjs');
  const pw = await hashPassword('pw-for-tests');
  const conf = (bin) => saveConfig({ claudeBin: bin, usage: false, router: { port: routerPort }, server: { backend: kind, roots: [box.root], passwordHash: pw } });
  conf(claudeBin);
  writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });
  setAutoSwitch({ enabled: true, order: ['work', 'backup'] });
  const late = (ms) => fs.writeFileSync(path.join(box.state, 'fake-claude-late-ms'), String(ms));

  const app = createServer({
    tmuxSocket: `onerecord-${process.pid}`, tmuxConfigFile: emptyConf, watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CHAT] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const outside = [];
  t.after(async () => {
    for (const p of outside) p.kill('SIGTERM');
    if (kind === 'tmux') {
      // Every terminal was closed: tmux has ended by itself and left its socket file.
      await app.backend.killServer().catch(() => {});
      fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, `onerecord-${process.pid}`), { force: true });
    }
    await app.close().catch(() => {});
    router.close();
    router.closeAllConnections();
    box.cleanup();
  });
  const req = async (p, body) => {
    const r = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  const card = async (name) => (await req('/api/state')).json.sessions.find((x) => x.name === name);
  const screen = async (name) => (await req(`/api/sessions/${name}/history?lines=200`)).json?.text || '';
  // Every process on conversation `id`: stand-ins in terminals and chat processes (ps), the launchers' records that
  // run it, and the chats with a process.
  const count = async (id) => {
    const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(id));
    const chats = (await req('/api/chats')).json.chats.filter((c) => c.sessionId === id && c.running).length;
    return {
      term: ps.filter((l) => l.includes(FAKE_TERM)).length,
      chat: Math.max(ps.filter((l) => l.includes(FAKE_CHAT)).length, chats),
      runs: listRuns().filter((r) => r.sessionId === id || (!r.sessionId && r.conversation === id)).length,
    };
  };
  const chatWith = async (id, text) => {
    const r = await req('/api/chats', { dir: work, profile: 'work', ...(id ? { sessionId: id } : {}), ...(text ? { text } : {}) });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const close = async (chatId) => assert.equal((await req(`/api/chats/${chatId}/close`, {})).status, 200);
  // Nothing runs the conversation and anyone can open it: a chat on it sees no terminal that runs it (at once, or a
  // moment after the terminal is back at its shell), its message is sent, and it is the one process.
  const free = async (id, what) => {
    const c = await chatWith(id, undefined);
    await until(`${what}: the chat sees no terminal on it`, async () => (await req(`/api/chats/${c.id}`)).json.terminal === null, 3000);
    assert.deepEqual(await count(id), { term: 0, chat: 0, runs: 0 }, `${what}: nothing runs it`);
    const s = await req(`/api/chats/${c.id}/send`, { text: `after: ${what}` });
    assert.equal(s.status, 200, `${what}: the chat's message is sent: ${s.text}`);
    await until('the chat\'s answer', async () => (await req(`/api/chats/${c.id}`)).json.events.some((e) => e.kind === 'turn-end' && e.ok !== false));
    assert.deepEqual(await count(id), { term: 0, chat: 1, runs: 0 }, `${what}: the chat is the one process`);
    await close(c.id);
    await until('the chat process gone', async () => (await count(id)).chat === 0);
  };
  const newConv = async (text) => {
    late(0);
    const made = await chatWith(undefined, text);
    await until('the first answer', async () => (await req(`/api/chats/${made.id}`)).json.events.some((e) => e.kind === 'turn-end'));
    await close(made.id);
    await until('the chat process gone', async () => (await count(made.id)).chat === 0);
    return made.id;
  };
  const opened = async (id, profile = 'work') => {
    late(0);
    const r = await req('/api/sessions', { dir: work, profile, mode: 'resume', sessionId: id });
    assert.equal(r.status, 200, r.text);
    await until('reported', async () => (await card(r.json.name))?.sessionId === id);
    return r.json.name;
  };
  const kill = async (name) => assert.equal((await req(`/api/sessions/${name}/kill`, {})).status, 200);
  // The terminal is back at its own shell (the launcher said why it ended, and the conversation is free at once).
  const backAtShell = async (name, words) => {
    await until(`"${words}" on the screen`, async () => (await screen(name)).includes(words));
    await until('the card a plain shell', async () => (await card(name))?.kind === 'shell');
  };

  // ---- F1: a move whose new Claude Code ends at once ----
  {
    const id = await newConv('f1');
    const T = await opened(id);
    conf(crashBin);
    assert.equal((await req(`/api/sessions/${T}/switch`, { profile: 'backup' })).status, 200);
    await backAtShell(T, 'claude crashed at start');
    conf(claudeBin);
    await free(id, 'F1 a move whose Claude Code ended at once');
    await kill(T);
  }

  // ---- F2: a start from the page whose Claude Code ends at once ----
  {
    const id = await newConv('f2');
    conf(crashBin);
    const r = await req('/api/sessions', { dir: work, profile: 'work', mode: 'resume', sessionId: id });
    assert.equal(r.status, 200, r.text);
    await backAtShell(r.json.name, 'claude crashed at start');
    conf(claudeBin);
    await free(id, 'F2 a start whose Claude Code ended at once');
    const again = await req('/api/sessions', { dir: work, profile: 'work', mode: 'resume', sessionId: id });
    assert.equal(again.status, 200, again.text);
    assert.ok(!again.json.existing && again.json.name !== r.json.name, `F2: a resume opens a new terminal: ${again.text}`);
    await until('reported', async () => (await card(again.json.name))?.sessionId === id);
    assert.deepEqual(await count(id), { term: 1, chat: 0, runs: 1 });
    await kill(r.json.name);
    await kill(again.json.name);
    await until('gone', async () => (await count(id)).term === 0);
  }

  // ---- F3: a move to Auto mode that the launcher refuses (no order of providers) ----
  {
    const id = await newConv('f3');
    const T = await opened(id);
    setAutoSwitch({ enabled: true, order: [] });
    assert.equal((await req(`/api/sessions/${T}/switch`, { profile: 'auto' })).status, 200);
    await backAtShell(T, 'Auto mode needs the order of providers first');
    setAutoSwitch({ enabled: true, order: ['work', 'backup'] });
    await free(id, 'F3 a move to Auto mode the launcher refused');
    await kill(T);
  }

  // ---- B2: two moves of one terminal at the same moment: one launcher ----
  {
    const id = await newConv('b2');
    const T = await opened(id);
    late(2000);
    const out = await Promise.all([req(`/api/sessions/${T}/switch`, { profile: 'backup' }), req(`/api/sessions/${T}/switch`, { profile: 'work' })]);
    // Both read the same record before either moved it: one moves it, the other is late (it restarts nothing).
    assert.deepEqual(out.map((o) => o.status).sort(), [200, 409], out.map((o) => o.text).join(' | '));
    await until('reported after the move', async () => {
      const c = await card(T);
      return c && c.sessionId === id && c.status === 'waiting';
    });
    await sleep(1500); // a second launcher started by mistake would show by now
    assert.deepEqual(await count(id), { term: 1, chat: 0, runs: 1 }, 'B2: one process');
    // The launchers of this dashboard: started as `<launcher> --launch <its launch folder>/…` (src/launchfile.mjs), so
    // their command line names no conversation; this block's is the only one that runs now.
    const launchers = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(BIN) && l.includes(launchDir()));
    assert.equal(launchers.length, 1, `B2: one launcher: ${launchers.join(' | ')}`);
    const c = await chatWith(id, 'after two moves');
    assert.equal(c.sent, false, 'B2: the terminal runs it, a chat does not send');
    await close(c.id);
    await kill(T);
    await until('gone', async () => (await count(id)).term === 0);
  }

  // ---- A1: the launcher's own menu, while a chat took the conversation meanwhile ----
  {
    const id = await newConv('a1');
    const T = await opened(id);
    const menus = async () => (await screen(T)).split('Continue it on another profile').length - 1;
    assert.equal((await req(`/api/sessions/${T}/send`, { text: '/exit' })).status, 200);
    await until('the menu', async () => (await menus()) === 1);
    // While the menu waits nothing runs the conversation: a chat takes it.
    const c = await chatWith(id, undefined);
    await until('the chat sees no terminal on it', async () => (await req(`/api/chats/${c.id}`)).json.terminal === null, 3000);
    assert.equal((await req(`/api/chats/${c.id}/send`, { text: 'while the menu waits' })).status, 200);
    await until('the chat\'s answer', async () => (await req(`/api/chats/${c.id}`)).json.events.some((e) => e.kind === 'turn-end' && e.ok !== false));
    // The owner answers the menu (his own typing, owner: true; the launcher's menu takes no one else's text): the
    // launcher starts nothing, says where the conversation is open, asks again.
    assert.equal((await req(`/api/sessions/${T}/send`, { text: 'backup', owner: true })).status, 200);
    await until('the menu again', async () => (await menus()) === 2);
    assert.match(await screen(T), /this conversation is open in a chat in the dashboard\. Close that chat, or choose "Open in terminal" in its menu\./);
    assert.deepEqual(await count(id), { term: 0, chat: 1, runs: 0 }, 'A1: the chat is the one process');
    const s = await req(`/api/chats/${c.id}/send`, { text: 'the chat goes on' });
    assert.equal(s.status, 200, s.text);
    // The chat closes: the same menu starts it now.
    await close(c.id);
    await until('the chat process gone', async () => (await count(id)).chat === 0);
    late(0);
    assert.equal((await req(`/api/sessions/${T}/send`, { text: 'backup', owner: true })).status, 200);
    await until('reported on backup', async () => {
      const k = await card(T);
      return k && k.sessionId === id && k.profile && k.profile.name === 'backup';
    });
    assert.deepEqual(await count(id), { term: 1, chat: 0, runs: 1 }, 'A1: then the terminal is the one process');
    await kill(T);
    await until('gone', async () => (await count(id)).term === 0);
  }

  // ---- O1: a launcher from a plain shell, while a chat runs the conversation, and while a terminal does ----
  const plainShell = async (id) => {
    const env = { ...process.env };
    for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete env[k];
    const p = spawn(process.execPath, [BIN, 'work', '--resume', id], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env });
    outside.push(p);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const code = await new Promise((r) => p.on('exit', r));
    return { code, err };
  };
  {
    const id = await newConv('o1');
    const c = await chatWith(id, 'the chat holds it');
    assert.equal(c.sent, true);
    await until('the chat\'s answer', async () => (await req(`/api/chats/${c.id}`)).json.events.filter((e) => e.kind === 'turn-end').length >= 1);
    const o = await plainShell(id);
    assert.equal(o.code, 2, o.err);
    assert.equal(o.err, 'hoprig: this conversation is open in a chat in the dashboard. Close that chat, or choose "Open in terminal" in its menu.\n');
    assert.deepEqual(await count(id), { term: 0, chat: 1, runs: 0 }, 'O1: the chat is the one process');

    // The page's resume meanwhile: the dashboard's claim finds the chat and starts nothing.
    const before = (await req('/api/state')).json.sessions.filter((x) => x.kind !== 'chat').length;
    const page = await req('/api/sessions', { dir: work, profile: 'work', mode: 'resume', sessionId: id });
    assert.deepEqual([page.status, page.json.chat, page.json.existing], [200, c.id, true], page.text);
    assert.equal((await req('/api/state')).json.sessions.filter((x) => x.kind !== 'chat').length, before, 'no terminal started');
    // Past the claim (a start that came at the same moment): the launcher itself refuses in the terminal.
    const { readProfile } = await import('../../src/profiles.mjs');
    const name = await app.deck.start({ dir: work, profile: readProfile('work'), mode: 'resume', sessionId: id });
    await backAtShell(name, 'this conversation is open in a chat in the dashboard');
    assert.deepEqual(await count(id), { term: 0, chat: 1, runs: 0 }, 'the page\'s resume: the chat is the one process');
    assert.equal((await req(`/api/chats/${c.id}/send`, { text: 'still the chat' })).status, 200);
    await close(c.id);
    await until('the chat process gone', async () => (await count(id)).chat === 0);
    await kill(name);

    // A terminal of the dashboard runs it: the launcher names that session.
    const T = await opened(id);
    const o2 = await plainShell(id);
    assert.equal(o2.code, 2, o2.err);
    assert.equal(o2.err, `hoprig: this conversation runs in the terminal session "${T}". Stop Claude Code there first, or open that session as a chat and choose "Continue here".\n`);
    assert.deepEqual(await count(id), { term: 1, chat: 0, runs: 1 }, 'O1: the terminal is the one process');
    await kill(T);
    await until('gone', async () => (await count(id)).term === 0);
  }

  // ---- "Open as chat" before Claude Code has reported its conversation: the launcher's record names it ----
  {
    const id = await newConv('o5');
    late(8000);
    const r = await req('/api/sessions', { dir: work, profile: 'work', mode: 'resume', sessionId: id });
    assert.equal(r.status, 200, r.text);
    await until('the launcher\'s record', async () => listRuns().some((x) => x.conversation === id && !x.sessionId));
    const asChat = await req('/api/chats/from-session', { session: r.json.name });
    assert.equal(asChat.status, 200, asChat.text);
    const v = (await req(`/api/chats/${asChat.json.id}`)).json;
    assert.deepEqual([v.conversationId, v.terminal && v.terminal.name], [id, r.json.name], 'the chat of that conversation, which runs in that terminal');
    assert.deepEqual(await count(id), { term: 1, chat: 0, runs: 1 });
    await close(asChat.json.id);
    await kill(r.json.name);
    await until('gone', async () => (await count(id)).term === 0);
  }
}
