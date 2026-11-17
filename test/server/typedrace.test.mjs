// The moment a coding tool ends while text for it is on its way (src/typinglock.mjs, src/server/typing.mjs). Real
// terminals, built-in and tmux (own socket), under bash and dash. The tool turns bracketed paste off as it ends, so
// text of several lines typed then goes as plain lines: a shell that got them would run each one. The launcher removes
// its record under the typing lock and throws its terminal's input away before the shell gets the terminal back.
//   the real launcher   a message typed while the test holds the typing lock (as the dashboard does while it types),
//                       the tool ending meanwhile: the launcher waits for the lock, then nothing of it runs
//   the send route      a launcher whose record outlives its tool by 150 ms, a message of
//                       several lines sent right after the tool ended: 409, nothing runs, nothing stands on the line
//   typed, not sent     the tool ends in the pause before the Enter: the route says so with its own code, and the
//                       queue pauses with the message first instead of typing it a second time
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const RACE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'race-launcher.mjs');
const POSIX = process.platform !== 'win32';
const box = sandbox('typedrace');
process.env.HOME = box.home; // the shells read their (empty) start files from here
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { nodePty } = await import('../../src/server/backends/nodepty.mjs');
const { lockOf, noteTyped, typedOf } = await import('../../src/typinglock.mjs');
const { runsDir } = await import('../../src/paths.mjs');
const kinds = POSIX ? [...(nodePty ? ['pty'] : []), ...(tmuxUsable() ? ['tmux'] : [])] : [];
const SHELLS = ['/bin/bash', '/bin/dash'].filter((s) => fs.existsSync(s));
test.after(() => box.cleanup());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000, step = 50) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await wait(step)) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last))})`);
}
const ran = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('RAN_'));

let n = 0;
/** A dashboard of `kind` whose terminals run `shell`; `launcher` null: the real one, with the stand-in as Claude Code. */
async function dashboard(t, kind, shell, { launcher = null } = {}) {
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const socket = `hoprig-race-${process.pid}-${++n}`;
  const conf = path.join(box.root, `${socket}.conf`);
  fs.writeFileSync(conf, `set -g default-shell ${shell}\n`);
  const claudeBin = path.join(box.root, 'tool.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${RACE}' --child\n`, { mode: 0o755 });
  saveConfig({
    ...(launcher ? { launcher } : { claudeBin }),
    usage: false,
    server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('test-password-1') },
    automation: { restore: { enabled: false } },
  });
  writeProfile('p', { label: 'P', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const was = process.env.SHELL;
  process.env.SHELL = shell; // the built-in terminals' shell
  const app = createServer({ tmuxSocket: socket, tmuxConfigFile: conf, watch: false, automation: { tick: false }, dashboardFile: false });
  process.env.SHELL = was;
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  t.after(async () => {
    await app.close().catch(() => {});
    if (kind === 'tmux') {
      const sock = await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
      await app.backend.killServer().catch(() => {});
      if (sock.trim()) fs.rmSync(sock.trim(), { force: true });
    }
  });
  /** A session of the stand-in in a folder of its own, its tool reading the terminal. */
  const session = async (label) => {
    const dir = fs.mkdtempSync(path.join(box.root, `${kind}-${label}-`));
    const name = await app.deck.create({ base: `${kind}-${label}`, dir, argv: [...app.deck.launcher(), 'p'] });
    const { term, run } = await until(`${label}'s run`, async () => {
      const f = await app.deck.find(name);
      return f && f.run ? f : null;
    });
    await until(`${label}'s tool reads its terminal`, async () => (await app.backend.capture(term.id, 20)).includes('STANDIN-READY'));
    await wait(200);
    return { name, dir, term, run, record: path.join(runsDir(), `${run.runId}.json`) };
  };
  /** The shell is back: no record, and an Enter of the owner's own runs whatever would stand on its line. */
  const settle = async (s) => {
    await until('the launcher ended', async () => (await app.deck.find(s.name)).run === null);
    await wait(500);
    await app.backend.sendKey(s.term.id, 'Enter');
    await wait(700);
  };
  const auto = () => app.features.find((f) => f.name === 'automation').automation;
  return { app, req, session, settle, auto };
}

const LINES = 'touch RAN_one\ntouch RAN_two\ntouch RAN_three';

for (const kind of kinds) {
  for (const shell of SHELLS) {
    const label = `${kind}, ${path.basename(shell)}`;

    test(`${label}: the real launcher waits for a message being typed, then throws away what its tool did not read`, { timeout: 60_000 }, async (t) => {
      const d = await dashboard(t, kind, shell);
      const s = await d.session('real');
      // The dashboard's side of the lock, held by the test: a message is being typed right now.
      fs.writeFileSync(lockOf(s.record), '', { flag: 'wx' });
      noteTyped(s.record);
      fs.writeFileSync(path.join(s.dir, 'QUIT'), '');
      await until('the tool ended', () => fs.existsSync(path.join(s.dir, 'CHILD_EXITED')), 10_000, 5);
      await wait(400);
      assert.ok(fs.existsSync(s.record), 'the launcher keeps its record while the lock is held');
      // What the dashboard types under the lock lands in a terminal whose tool has ended: plain lines, no paste.
      await d.app.backend.sendText(s.term.id, LINES);
      fs.rmSync(lockOf(s.record));
      await d.settle(s);
      assert.equal(fs.existsSync(s.record), false, 'the record went once the lock was let go');
      assert.deepEqual(ran(s.dir), [], 'the shell ran no line of it');
      assert.equal(fs.existsSync(lockOf(s.record)), false);
      assert.equal(fs.existsSync(typedOf(s.record)), false, 'the note went with the record');
    });

    test(`${label}: several lines sent the moment the tool ended (its record still there): 409, nothing runs`, { timeout: 60_000 }, async (t) => {
      const d = await dashboard(t, kind, shell, { launcher: [process.execPath, RACE] });
      const s = await d.session('route');
      fs.writeFileSync(path.join(s.dir, 'WINDOW'), '150');
      fs.writeFileSync(path.join(s.dir, 'QUIT'), '');
      await until('the tool ended', () => fs.existsSync(path.join(s.dir, 'CHILD_EXITED')), 10_000, 2);
      const r = await d.req(`/api/sessions/${s.name}/send`, { text: LINES });
      t.diagnostic(`${r.status} ${r.text}`);
      assert.equal(r.status, 409, r.text);
      // Typed in the moment (the launcher threw it away, and says the Enter did not follow), or too late to type.
      assert.ok(['typed_not_sent', 'not_in_front'].includes(r.json.code), r.text);
      await d.settle(s);
      assert.deepEqual(ran(s.dir), [], 'no line ran, and none stood on the shell\'s line');
    });
  }

  test(`${kind}: the tool ends in the pause before the Enter: "typed but not sent"; the queue pauses with the message first`, { timeout: 90_000 }, async (t) => {
    const d = await dashboard(t, kind, '/bin/bash', { launcher: [process.execPath, RACE] });
    const quitOnArrival = async (s) => {
      await until('the text reached the tool', () => fs.existsSync(path.join(s.dir, 'got.raw')), 10_000, 5);
      fs.writeFileSync(path.join(s.dir, 'QUIT'), '');
    };

    // The send route.
    const s = await d.session('route');
    const [r] = await Promise.all([d.req(`/api/sessions/${s.name}/send`, { text: 'hello there' }), quitOnArrival(s)]);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'typed_not_sent');
    assert.match(r.json.error, /^The text was typed into session ".+" but not sent: its coding tool ended or changed before the Enter/);

    // The queue: paused, the message first, the reason on its row; once the owner resumes it goes to the next run.
    const q = await d.session('queue');
    assert.equal((await d.req(`/api/automation/queue/${q.name}`, { op: 'add', text: 'the next step' })).status, 200);
    await Promise.all([d.auto().tick(), quitOnArrival(q)]);
    const held = d.auto().api.queueOf(q.name);
    assert.equal(held.paused, true, 'the queue paused itself');
    assert.deepEqual(held.items.map((x) => x.text), ['the next step'], 'the message is first again, not lost');
    assert.match(held.waits, /^its last message was typed but not sent/);
    const rows = d.auto().activity.recent(20).filter((x) => x.session === q.name);
    assert.deepEqual(rows.map((x) => x.did), ['typed but not sent: the next step']);
    assert.match(rows[0].outcome, /^the queue is paused: The text was typed/);
    await d.auto().tick();
    assert.equal(d.auto().api.queueOf(q.name).items.length, 1, 'paused: not typed a second time by itself');
    // The owner resumes: the reason goes with the pause.
    const resumed = (await d.req(`/api/automation/queue/${q.name}`, { op: 'pause', paused: false })).json;
    assert.equal(resumed.paused, false);
    assert.equal(resumed.waits, undefined);
  });
}
