// One conversation, one process, with the REAL launcher (src/launch.mjs) and a stand-in Claude Code that reports its
// conversation late (../automation/fixtures/fake-claude.mjs: <state>/fake-claude-late-ms). The launcher names the
// conversation in its run record before Claude Code starts (runs.mjs: conversation), so a terminal on it counts from
// its first moment on every path that starts or restarts one: a move to another provider, a move to Auto mode, the
// launcher's own move at a usage limit, a restart of the dashboard while the terminal lives on (tmux), the restore
// after a restart (built-in terminals) and a launcher started outside the dashboard. After each, at once: a new chat
// with text, a resume from the page, the assistant's start (a resume with a first message, as Tia sends it), a
// continue of the folder, and a schedule that sends into a chat on the conversation. Never a second process (counted
// with ps, in the run records and in /api/chats). And the ordinary hand-off both ways keeps the conversation whole.
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
const LATE = 8000; // how long the moved Claude Code takes to report: longer than every attempt below together

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
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 300))})`);
};

test('one conversation, one process with the real launcher, on the built-in terminals', { timeout: 300_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, (t) => run(t, 'pty'));
test('one conversation, one process with the real launcher, on tmux', { timeout: 300_000, skip: !tmuxUsable() && 'no tmux 3.2 or newer here' }, (t) => run(t, 'tmux'));

async function run(t, kind) {
  const box = sandbox(`onelaunch-${kind}`);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'work-')));
  const claudeBin = path.join(box.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TERM}' "$@"\n`, { mode: 0o755 });
  const emptyConf = path.join(box.root, 'empty.conf');
  fs.writeFileSync(emptyConf, '');
  // Auto mode's router, as the launcher test does: a stand-in that answers "are you there", so no real one starts.
  const router = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"ok":true}');
  });
  const routerPort = await new Promise((r) => router.listen(0, '127.0.0.1', () => r(router.address().port)));
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { setAutoSwitch, clearLimited } = await import('../../src/autoswitch.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { listRuns } = await import('../../src/runs.mjs');
  const { sessionsIn } = await import('../../src/sessions.mjs');
  saveConfig({ claudeBin, usage: false, router: { port: routerPort }, server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });
  setAutoSwitch({ enabled: true, order: ['work', 'backup'] });
  const late = (ms) => fs.writeFileSync(path.join(box.state, 'fake-claude-late-ms'), String(ms));

  const options = {
    tmuxSocket: `onelaunch-${process.pid}`, tmuxConfigFile: emptyConf, watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CHAT] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
  };
  let app = null;
  let base = '';
  let cookie = '';
  const start = async () => {
    app = createServer(options);
    const { port } = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
    cookie = login.headers.get('set-cookie').split(';')[0];
  };
  let outside = null;
  t.after(async () => {
    if (outside) outside.kill('SIGTERM');
    if (app) {
      if (kind === 'tmux') {
        const sock = await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
        await app.backend.killServer().catch(() => {});
        if (sock.trim()) fs.rmSync(sock.trim(), { force: true });
      }
      await app.close().catch(() => {});
    }
    router.close();
    router.closeAllConnections();
    box.cleanup();
  });
  await start();
  const req = async (p, body) => {
    const r = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  const automation = () => app.features.find((f) => f.name === 'automation').automation;
  const card = async (name) => (await req('/api/state')).json.sessions.find((x) => x.name === name);
  const screen = async (name) => (await req(`/api/sessions/${name}/history?lines=200`)).json?.text || '';

  // Every process on conversation `id`: Claude Code stand-ins in terminals and chat processes (ps), the run records
  // that run it (either way), and the chats the dashboard has a process for.
  const count = async (id) => {
    const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(id));
    const chats = (await req('/api/chats')).json.chats.filter((c) => c.sessionId === id && c.running).length;
    return {
      term: ps.filter((l) => l.includes(FAKE_TERM)).length,
      chat: ps.filter((l) => l.includes(FAKE_CHAT)).length + chats,
      runs: listRuns().filter((r) => r.sessionId === id || (!r.sessionId && r.conversation === id)).length,
    };
  };
  const alone = async (id, what) => {
    await sleep(800); // a process started by mistake would show by now
    assert.deepEqual(await count(id), { term: 1, chat: 0, runs: 1 }, `${what}: one process on the conversation`);
  };
  // Everything that could start a second process on conversation `id`, at once. `term`: the terminal that runs it
  // (null: one outside the dashboard).
  const attempts = async (id, term, what) => {
    const here = (r, label) => {
      if (term) assert.deepEqual([r.status, r.json && r.json.name, r.json && r.json.existing], [200, term, true], `${what}, ${label}: ${r.text}`);
      else assert.equal(r.status, 409, `${what}, ${label}: ${r.text}`);
    };
    const chat = await req('/api/chats', { dir: work, profile: 'work', sessionId: id, text: `a new chat (${what})` });
    assert.equal(chat.status, 200, chat.text);
    assert.equal(chat.json.sent, false, `${what}: a new chat with text is not sent into a second process`);
    here(await req('/api/sessions', { dir: work, profile: 'work', mode: 'resume', sessionId: id }), 'a resume');
    const tia = await req('/api/sessions', { dir: work, profile: 'backup', mode: 'resume', sessionId: id, prompt: 'from the assistant' });
    here(tia, 'the assistant\'s start');
    if (term) assert.equal(tia.json.sent, false);
    if (sessionsIn(work)[0]?.id === id) here(await req('/api/sessions', { dir: work, profile: 'work', mode: 'continue' }), 'a continue of the folder');
    // A schedule that sends into that chat, due now.
    const now = new Date(Date.now() + 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    const when = { kind: 'once', date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}` };
    const added = await req('/api/automation/schedules', { op: 'add', schedule: { label: `into the chat (${what})`, when, action: { type: 'send', session: `chat:${chat.json.id}`, text: 'from a schedule' } } });
    assert.equal(added.status, 200, added.text);
    const sid = added.json.schedules.find((s) => s.label === `into the chat (${what})`).id;
    await automation().tick(now.getTime() + 1000);
    const log = (await req('/api/automation/log?limit=5')).json.entries.find((e) => e.automation === 'schedules');
    assert.match(`${log.did} | ${log.outcome}`, /could not run .* \| failed: .*terminal/, `${what}: the schedule's message is not sent`);
    await req('/api/automation/schedules', { op: 'delete', id: sid });
    assert.equal((await req(`/api/chats/${chat.json.id}/close`, {})).status, 200);
    await alone(id, what);
  };
  // Right after a restart in place (a move): a chat start at once, then everything again once the old Claude Code and
  // its record are gone, the moment nothing but the new launcher's record can say who runs the conversation.
  const moved = async (id, term, what) => {
    const first = await req('/api/chats', { dir: work, profile: 'work', sessionId: id, text: `at once (${what})` });
    assert.equal(first.json.sent, false, `${what}: ${first.text}`);
    assert.equal((await req(`/api/chats/${first.json.id}/close`, {})).status, 200);
    await until('the old run gone', async () => !listRuns().some((r) => r.sessionId === id));
    await attempts(id, term, what);
  };
  // Reported: and the dashboard looked at it then (a resume finds that terminal), so what it knew of the start is
  // used up, as on a dashboard where a page is open.
  const reported = async (name, profile, id) => {
    await until(`${name} reported on ${profile}`, async () => {
      const c = await card(name);
      return c && c.sessionId === id && c.profile && c.profile.name === profile && c.status === 'waiting' ? c : null;
    });
    const look = await req('/api/sessions', { dir: work, profile: 'work', mode: 'resume', sessionId: id });
    assert.deepEqual([look.json && look.json.name, look.json && look.json.existing], [name, true], look.text);
  };

  // ---- a chat with a first answer; the hand-off to a terminal ----
  late(0);
  const made = await req('/api/chats', { dir: work, profile: 'work', text: 'hello' });
  assert.equal(made.status, 200, made.text);
  const id = made.json.id;
  await until('the first answer', async () => (await req(`/api/chats/${id}`)).json.events.some((e) => e.kind === 'turn-end'));
  await until('the idle chat process to stop', async () => !(await req(`/api/chats/${id}`)).json.running);
  const opened = await req(`/api/chats/${id}/terminal`, {});
  assert.equal(opened.status, 200, opened.text);
  const term = opened.json.name;
  await reported(term, 'work', id);
  assert.equal((await req(`/api/sessions/${term}/send`, { text: 'from the terminal' })).status, 200);
  await until('the terminal\'s reply', async () => (await screen(term)).includes('DONE: from the terminal'));
  await alone(id, 'the hand-off to a terminal');

  // ---- a move to another provider: at once, everything else on that conversation ----
  late(LATE);
  assert.equal((await req(`/api/sessions/${term}/switch`, { profile: 'backup' })).status, 200);
  await moved(id, term, 'a move to another provider');
  assert.ok(listRuns().some((r) => r.conversation === id && !r.sessionId && r.profile === 'backup'), 'not reported yet: the record names it');
  await reported(term, 'backup', id);

  // ---- the launcher's own move at a usage limit (backup → work): its record never goes away in between ----
  const before = listRuns().find((r) => r.sessionId === id);
  assert.equal((await req(`/api/sessions/${term}/send`, { text: 'FAIL-LIMIT' })).status, 200);
  const wrong = [];
  await until('the launcher moved by itself', async () => {
    // Meanwhile a chat start every moment: none is ever sent, and one record names the conversation all along.
    const c = await req('/api/chats', { dir: work, profile: 'work', sessionId: id, text: 'during the launcher\'s move' });
    if (c.json.sent !== false) wrong.push(c.text);
    await req(`/api/chats/${c.json.id}/close`, {});
    const runs = listRuns().filter((r) => r.conversation === id || r.sessionId === id);
    if (runs.length !== 1) wrong.push(JSON.stringify(runs));
    return runs.length === 1 && runs[0].runId === before.runId && runs[0].profile === 'work' && !runs[0].sessionId;
  });
  assert.deepEqual(wrong, [], 'never a chat process, never a moment without the record');
  await attempts(id, term, 'the launcher\'s own move');
  await reported(term, 'work', id);
  clearLimited('backup');

  // ---- a move to Auto mode ----
  late(LATE);
  assert.equal((await req(`/api/sessions/${term}/switch`, { profile: 'auto' })).status, 200);
  await moved(id, term, 'a move to Auto mode');
  await reported(term, 'auto', id);

  // ---- a restart of the dashboard ----
  late(LATE);
  if (kind === 'tmux') {
    // The terminal lives on and has not reported yet; the dashboard knows nothing of it but its run record.
    assert.equal((await req(`/api/sessions/${term}/switch`, { profile: 'work' })).status, 200);
    await until('its launcher', async () => listRuns().some((r) => r.conversation === id && !r.sessionId && r.profile === 'work'));
    await app.close();
    app = null;
    await start();
    await attempts(id, term, 'a restart with the terminal living on');
    await reported(term, 'work', id);
  } else {
    // The built-in terminals end with the dashboard; the restore reopens the terminal, which reports late.
    await automation().tick();
    await automation().tick(); // restore has learnt the session
    await app.close();
    app = null;
    await until('the launcher gone with the built-in terminal', async () => !listRuns().length);
    await start();
    await automation().tick();
    await until('the terminal reopened', async () => card(term));
    await until('its launcher', async () => listRuns().some((r) => r.conversation === id && !r.sessionId));
    await attempts(id, term, 'the restore after a restart');
    await reported(term, 'auto', id);
  }

  // ---- the hand-off back to a chat: the conversation is whole ----
  const back = await req('/api/chats/from-session', { session: term });
  assert.equal(back.status, 200, back.text);
  const chatId = back.json.id;
  assert.equal((await req(`/api/chats/${chatId}/take`, {})).status, 200);
  const sent = await req(`/api/chats/${chatId}/send`, { text: 'back in the chat' });
  assert.equal(sent.status, 200, sent.text);
  const file = sessionsIn(work).find((s) => s.id === id).file;
  const said = await until('the chat\'s message in the conversation', async () => {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('back in the chat') ? text : null;
  });
  for (const line of ['hello', 'from the terminal', 'back in the chat']) assert.ok(said.includes(line), `the conversation keeps "${line}"`);
  await until('the idle chat process to stop', async () => !(await req(`/api/chats/${chatId}`)).json.running);
  assert.equal((await count(id)).term, 0, 'the terminal stopped running it');

  // ---- a launcher started from a plain shell, outside the dashboard ----
  late(LATE);
  const env = { ...process.env };
  delete env.TMUX_PANE;
  delete env.HOPRIG_TERM_ID;
  outside = spawn(process.execPath, [BIN, 'work', '--resume', id], { cwd: work, stdio: ['pipe', 'ignore', 'ignore'], env });
  await until('the outside launcher\'s record', async () => listRuns().some((r) => r.conversation === id && !r.sessionId));
  await attempts(id, null, 'a launcher outside the dashboard');
  await alone(id, 'a launcher outside the dashboard');
  outside.kill('SIGTERM');
  await until('the outside launcher gone', async () => !listRuns().some((r) => r.conversation === id || r.sessionId === id));
  outside = null;
}
