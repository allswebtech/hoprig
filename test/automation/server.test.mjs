// The automations inside the real dashboard, end to end on each session backend: the REAL launcher (session
// defaults, carried arguments, hooks, run records) with a fake Claude Code (fixtures/fake-claude.mjs) behind it.
// Ticks are driven by hand on a clock the test can move forward. Nothing touches the user's tmux server, config
// or Claude sessions.
//
// Set AUTOMATION_EVIDENCE=<file> to have each run write what it saw (activity log, command lines) to <file>.<kind>.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from '../server/helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';

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
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last))})`);
};

test('automations end to end on the built-in pty backend', { timeout: 180_000, skip: !posix && 'the fake Claude wrapper is a POSIX shell script' }, (t) => run(t, 'pty'));
test('automations end to end on tmux', { timeout: 180_000, skip: !tmuxUsable() && 'no tmux 3.2 or newer here' }, (t) => run(t, 'tmux'));

async function run(t, kind) {
  const box = sandbox('auto');
  const work = path.join(box.root, 'work');
  fs.mkdirSync(work);
  // Claude Code is a one-path setting; a small wrapper runs the fake with this node (no PATH needed).
  const claudeBin = path.join(box.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  const socket = `auto-test-${process.pid}`;
  const emptyConf = path.join(box.root, 'empty.conf');
  fs.writeFileSync(emptyConf, '');

  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({
    claudeBin,
    usage: false,
    server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('test-password-1') },
    automation: { retry: { enabled: true }, restore: { enabled: true } },
  });
  // A subscription: the retry rule never sends again on a provider paid per use.
  writeProfile('work', { label: 'Work', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-test-not-real' } });

  let offset = 0; // how far the automations' clock is ahead of the real one
  const now = () => Date.now() + offset;
  let app = null;
  let base = '';
  let cookie = '';
  const start = async () => {
    app = createServer({ tmuxSocket: socket, tmuxConfigFile: emptyConf, watch: false, automation: { now }, dashboardFile: false });
    const { port } = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1' }) });
    cookie = r.headers.get('set-cookie').split(';')[0];
  };
  const req = async (p, body) => {
    const r = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  const auto = () => app.features.find((f) => f.name === 'automation').automation;
  const tick = () => auto().tick();
  const screen = async (name) => (await req(`/api/sessions/${name}/history?lines=400`)).json?.text || '';
  const card = async (name) => (await req('/api/state')).json.sessions.find((s) => s.name === name);
  const argsLine = (text) => {
    const lines = [...text.matchAll(/FAKE-CLAUDE args=(\[.*?\])\s*$/gm)].map((m) => m[1]);
    // A terminal may wrap a long line; history joins it back only on tmux. Take the last complete one.
    for (const l of lines.reverse()) {
      try {
        return JSON.parse(l);
      } catch {
        /* cut */
      }
    }
    return null;
  };

  // tmux leaves its socket file behind; with no server left to ask at the end, the path seen before the restart.
  let sockSeen = '';
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    if (kind === 'tmux' && app) {
      const sock = (await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '')).trim() || sockSeen;
      await app.backend.killServer().catch(() => {});
      if (sock) fs.rmSync(sock, { force: true });
    }
    box.cleanup();
  });

  await start();
  const evidence = { kind, steps: [] };
  const note = (step, data) => evidence.steps.push({ step, ...data });

  // ---- session defaults: through the settings route, refused when wrong ----
  assert.equal((await req('/api/settings', { sessionDefaults: { effort: 'turbo' } })).status, 400);
  assert.equal((await req('/api/settings', { sessionDefaults: { permissionMode: 'everything' } })).status, 400);
  const saved = await req('/api/settings', { sessionDefaults: { permissionMode: 'plan', effort: 'high', model: 'sonnet' } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.sessionDefaults, { permissionMode: 'plan', effort: 'high', model: 'sonnet' });
  assert.deepEqual(saved.json.sessionChoices.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(loadConfig().sessionDefaults, { permissionMode: 'plan', effort: 'high', model: 'sonnet' });

  // A session started from a terminal with its own flag (--model opus), so restore has something to keep.
  await app.backend.create({ name: 'alpha', dir: work, argv: [...app.deck.launcher(), 'work', '--model', 'opus'] });
  await until('alpha waits', async () => (await card('alpha'))?.status === 'waiting');
  const first = argsLine(await until('the command line', () => screen('alpha').then((s) => (argsLine(s) ? s : null))));
  note('alpha command line', { args: first });
  for (const [f, v] of [['--permission-mode', 'plan'], ['--effort', 'high'], ['--model', 'opus']]) {
    assert.equal(first[first.indexOf(f) + 1], v, `${f} ${v} reaches Claude Code (session default, or the session's own flag winning)`);
  }
  assert.equal(first.filter((a) => a === '--model').length, 1, 'one --model: the session\'s own flag replaces the default');

  // ---- queue: three messages, one per finished reply ----
  for (const text of ['first job', 'second job', 'third job']) {
    const r = await req('/api/automation/queue/alpha', { op: 'add', text });
    assert.equal(r.status, 200, r.text);
  }
  assert.deepEqual((await req('/api/automation')).json.queues, { alpha: { paused: false, count: 3 } });
  let maxOpen = 0;
  await until('three replies', async () => {
    await tick();
    const s = await screen('alpha');
    const got = (s.match(/GOT: \w+ job/g) || []).length;
    const done = (s.match(/DONE: \w+ job/g) || []).length;
    maxOpen = Math.max(maxOpen, got - done);
    return done === 3;
  }, 40_000);
  assert.equal(maxOpen, 1, 'never a second message before the reply to the first');
  const s1 = await screen('alpha');
  assert.ok(s1.indexOf('DONE: first job') < s1.indexOf('GOT: second job') && s1.indexOf('DONE: second job') < s1.indexOf('GOT: third job'));
  for (let i = 0; i < 3; i++) await tick();
  assert.equal((s1.match(/GOT: /g) || []).length, (await screen('alpha')).match(/GOT: /g).length, 'nothing more is sent');

  // ---- retry after an "overloaded" failure ----
  await req('/api/automation/queue/alpha', { op: 'add', text: 'FAIL-OVERLOADED please' });
  await until('the failure in the run record', async () => {
    await tick();
    return (await screen('alpha')).includes('API Error: 529');
  });
  await tick();
  assert.equal((await screen('alpha')).includes('GOT: Continue from where you stopped.'), false, 'the first retry waits a minute');
  offset += 61_000;
  await until('the retry', async () => {
    await tick();
    return (await screen('alpha')).includes('DONE: Continue from where you stopped.');
  });

  // ---- a schedule fires: once, at the next whole minute two minutes from now ----
  const at = new Date(now() + 120_000);
  at.setSeconds(0, 0);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const ymd = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const sch = await req('/api/automation/schedules', { op: 'add', schedule: { label: 'Nightly check', when: { kind: 'once', time: hhmm, date: ymd }, action: { type: 'start', dir: work, profile: 'work', prompt: 'scheduled hello' } } });
  assert.equal(sch.status, 200, sch.text);
  assert.equal(sch.json.schedules[0].nextAt, at.getTime());
  await tick();
  assert.equal((await req('/api/state')).json.sessions.length, 1, 'not yet');
  offset += at.getTime() - now() + 5_000;
  await tick();
  const started = await until('the scheduled session', async () => (await req('/api/state')).json.sessions.find((s) => s.name !== 'alpha'));
  await until('its first message answered', async () => {
    await tick();
    return (await screen(started.name)).includes('DONE: scheduled hello');
  });
  // A session opened and never typed into (its own flag: --model haiku): it has no conversation on disk.
  await app.backend.create({ name: 'beta', dir: work, argv: [...app.deck.launcher(), 'work', '--model', 'haiku'] });
  await until('beta waits', async () => (await card('beta'))?.status === 'waiting' && (await card('beta')).sessionId);
  for (let i = 0; i < 2; i++) await tick(); // restore learns the new sessions

  // ---- restart: the sessions come back the way they ran, with nothing typed ----
  const before = {};
  for (const s of (await req('/api/state')).json.sessions) before[s.name] = s.sessionId;
  await app.close();
  if (kind === 'tmux') {
    // A reboot takes tmux with it, and every program of its sessions is gone before the dashboard starts again.
    // killServer ends the programs of every pane, then tmux; the wait for their run records to go models the reboot
    // itself. (A tmux that ends without a reboot closes the terminals under their programs: they end a moment later,
    // and a restore meanwhile finds the conversations running and tries once more: restore-retry.test.mjs.)
    sockSeen = (await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '')).trim();
    await app.backend.killServer();
    const { listRuns } = await import('../../src/runs.mjs');
    await until('the programs of the sessions ended, as after a reboot', async () => !listRuns().length);
  }
  await start();
  await tick();
  await until('both sessions back', async () => {
    const st = (await req('/api/state')).json.sessions;
    return Object.keys(before).every((n) => st.some((s) => s.name === n && s.kind === 'claude' && s.status === 'waiting'));
  });
  const back = argsLine(await until('alpha\'s new command line', async () => {
    const s = await screen('alpha');
    return s.includes('--resume') ? s : null;
  }));
  note('alpha after restart', { args: back });
  assert.equal(back[back.indexOf('--resume') + 1], before.alpha, 'resumed the same conversation');
  assert.equal(back[back.indexOf('--model') + 1], 'opus', 'its own flag came back');
  assert.equal(back[back.indexOf('--permission-mode') + 1], 'plan');
  // The one nobody typed into is back too: the same id, started fresh (nothing to resume), its own flag kept.
  const beta = argsLine(await until('beta\'s new command line', async () => {
    const s = await screen('beta');
    return s.includes('--session-id') ? s : null;
  }));
  note('beta after restart', { args: beta });
  assert.equal(beta[beta.indexOf('--session-id') + 1], before.beta, 'the same session id');
  assert.equal(beta.includes('--resume'), false);
  assert.equal(beta[beta.indexOf('--model') + 1], 'haiku');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal((await screen('alpha')).includes('GOT:'), false, 'a restart types nothing');
  assert.equal((await screen('beta')).includes('GOT:'), false);

  const log = (await req('/api/automation/log?limit=100')).json.entries.reverse();
  note('activity log', { entries: log.map((e) => `${e.time} ${e.automation} [${e.session}] ${e.did} → ${e.outcome}`) });
  const kinds = log.map((e) => `${e.automation}:${e.outcome.split(':')[0]}`);
  assert.equal(kinds.filter((k) => k === 'queue:ok').length, 5, 'three jobs, the failing one, the scheduled first message, and nothing else');
  assert.ok(kinds.includes('retry:ok'));
  assert.ok(kinds.includes('schedules:ok'));
  assert.equal(kinds.filter((k) => k === 'restore:ok').length, 3);
  if (process.env.AUTOMATION_EVIDENCE) fs.writeFileSync(`${process.env.AUTOMATION_EVIDENCE}.${kind}.json`, JSON.stringify(evidence, null, 2));
}
