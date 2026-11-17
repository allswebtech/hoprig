// Text typed into a running session by something other than the owner's own keys (the queue, the continue prompt after
// a move, the assistant and a linked hub through the send route) is typed only while the coding tool is the terminal's
// foreground program, and never carries a control byte. Real terminals, built-in and tmux (on its own socket), with a
// stand-in coding tool that reads its terminal raw (fixtures/quit-launcher.mjs). The probe: the tool reports that it
// waits, a sender looks at it, then the tool ends before the sender types; the terminal's shell must run nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const QUIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'quit-launcher.mjs');
const POSIX = process.platform !== 'win32';
const box = sandbox('typedtext');
process.env.HOME = box.home; // the shells read their (empty) start files from here
process.env.SHELL = '/bin/bash';
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { nodePty } = await import('../../src/server/backends/nodepty.mjs');
const kinds = POSIX ? [...(nodePty ? ['pty'] : []), ...(tmuxUsable() ? ['tmux'] : [])] : [];
test.after(() => box.cleanup());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last))})`);
}
const got = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'got.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const typedIntoShell = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('TYPED_INTO_SHELL'));

/** A dashboard of `kind` whose terminals run the stand-in as their coding tool. */
async function dashboard(t, kind) {
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const socket = `hoprig-typed-${process.pid}`;
  const conf = path.join(box.root, `${socket}.conf`);
  fs.writeFileSync(conf, 'set -g default-shell /bin/bash\n');
  saveConfig({
    launcher: [process.execPath, QUIT],
    usage: false,
    server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('test-password-1') },
    automation: { restore: { enabled: false } },
  });
  writeProfile('p', { label: 'P', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  const app = createServer({ tmuxSocket: socket, tmuxConfigFile: conf, watch: false, automation: { tick: false }, dashboardFile: false });
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
  const auto = () => app.features.find((f) => f.name === 'automation').automation;
  /** A session of the stand-in in a folder of its own, waiting. Returns { name, dir, card }. */
  // The state folder (and with it the queue's store) is shared by the tests of this file: names differ per kind.
  const session = async (label0) => {
    const label = `${kind}-${label0}`;
    const dir = fs.mkdtempSync(path.join(box.root, `${label}-`));
    const name = await app.deck.create({ base: label, dir, argv: [...app.deck.launcher(), 'p'] });
    const card = await until(`${label} waits`, async () => (await app.deck.list()).find((c) => c.name === name && c.kind === 'claude' && c.status === 'waiting'));
    const { term } = await app.deck.find(name);
    await until(`${label} reads its terminal`, async () => (await app.backend.capture(term.id, 20)).includes('STANDIN-READY'));
    return { name, dir, card };
  };
  /** The stand-in ends (its record goes with it): the terminal is back at its shell. */
  const quit = async ({ name, dir }) => {
    fs.writeFileSync(path.join(dir, 'QUIT'), '');
    await until(`${name}'s coding tool ended`, async () => (await app.deck.find(name)).run === null);
    await wait(300); // the shell shows its prompt again
  };
  return { app, req, auto, session, quit, cookie };
}

for (const kind of kinds) {
  test(`${kind}: the coding tool ended after its status was read: no sender types into the shell`, { timeout: 120_000 }, async (t) => {
    const d = await dashboard(t, kind);
    const { Watcher } = await import('../../src/server/watcher.mjs');
    const outcome = {};
    let queueCase;

    // The queue: its tick reads the cards (the tool waits), the tool ends, then the queue types.
    {
      const s = await d.session('queue');
      assert.equal((await d.req(`/api/automation/queue/${s.name}`, { op: 'add', text: 'touch TYPED_INTO_SHELL_queue' })).status, 200);
      const stale = await d.app.deck.list();
      await d.quit(s);
      const list = d.app.deck.list;
      d.app.deck.list = async () => stale; // the tick's look at the sessions, from before the tool ended
      let r;
      try {
        r = await d.auto().tick();
      } finally {
        d.app.deck.list = list;
      }
      assert.deepEqual(r.plan.queue.map((a) => a.type), ['send'], 'the queue saw the tool waiting and meant to type');
      await wait(1500);
      const q = await d.auto().api.queueOf(s.name);
      outcome.queue = { file: typedIntoShell(s.dir).length > 0, queued: q.items.length, waits: q.waits };
      queueCase = s;
    }

    // The continue prompt after a move: the new run waited when the watcher looked, then it ended.
    {
      const s = await d.session('cont');
      const stale = await d.app.deck.list();
      await d.quit(s);
      const w = new Watcher({ cards: async () => stale, deck: d.app.deck, auto: { getAutoSwitch: () => ({ enabled: false }) }, settings: () => ({}), log: () => {}, send: async () => {} });
      w.pending.set(s.name, { to: 'p', prompt: 'touch TYPED_INTO_SHELL_continue', since: Date.now() });
      await w.tick();
      w.stop();
      await wait(1500);
      outcome.continue = { file: typedIntoShell(s.dir).length > 0 };
    }

    // The assistant and a linked hub: the send route (her send_to_session; a hub relays the same request).
    {
      const s = await d.session('tia');
      await d.quit(s);
      const r = await d.req(`/api/sessions/${s.name}/send`, { text: 'touch TYPED_INTO_SHELL_send' });
      await wait(1500);
      outcome.send = { status: r.status, error: r.json && r.json.error, file: typedIntoShell(s.dir).length > 0 };
    }

    // The page's "continue at a limit": its own check reads the run record, which is gone with the tool.
    {
      const s = await d.session('limit');
      await d.quit(s);
      const r = await d.req(`/api/sessions/${s.name}/continue`, {});
      await wait(500);
      outcome.limitContinue = { status: r.status, file: typedIntoShell(s.dir).length > 0 };
    }

    t.diagnostic(JSON.stringify(outcome));
    assert.equal(outcome.queue.file, false, 'the queue typed into the shell');
    assert.equal(outcome.queue.queued, 1, 'the queue keeps its item');
    assert.equal(outcome.continue.file, false, 'the continue prompt was typed into the shell');
    assert.equal(outcome.send.file, false, 'the send route typed into the shell');
    assert.equal(outcome.send.status, 409);
    assert.equal(outcome.limitContinue.file, false);
    assert.match(outcome.send.error, /^Nothing was typed: no coding tool runs in session/);
    assert.match(outcome.queue.waits, /^its coding tool is not the program in front in this session/, 'the queue says why its message waits');
    const st = (await (await fetch(`http://127.0.0.1:${d.app.server.address().port}/api/automation`, { headers: { Cookie: d.cookie } })).json());
    assert.match(st.queues[queueCase.name].waits, /goes when a coding tool waits there again/, 'the Queue page\'s row says it too');
    const rows = d.auto().activity.recent(50).filter((x) => x.session === queueCase.name);
    assert.deepEqual(rows.map((x) => x.did), ['not delivered: touch TYPED_INTO_SHELL_queue'], 'recorded once, as not delivered');

    // The queue's item stays and goes the next time a coding tool waits in that session (a new run of it).
    const { term } = await d.app.deck.find(queueCase.name);
    await d.app.deck.respawn(term.id, queueCase.dir, [...d.app.deck.launcher(), 'p']);
    await until('the new run waits', async () => (await d.app.deck.list()).find((c) => c.name === queueCase.name && c.kind === 'claude' && c.status === 'waiting'));
    await until('the stand-in reads its terminal', async () => (await d.app.backend.capture(term.id, 20)).includes('STANDIN-READY'));
    await d.auto().tick();
    await until('the queued message reached the coding tool', () => got(queueCase.dir).includes('touch TYPED_INTO_SHELL_queue'));
    const after = await d.auto().api.queueOf(queueCase.name);
    assert.deepEqual(after.items, []);
    assert.equal(after.waits, undefined, 'no longer waiting');
    assert.deepEqual(typedIntoShell(queueCase.dir), []);
  });

  test(`${kind}: the coding tool is stopped and the shell is in front, its record still says it waits: nothing is typed`, { timeout: 120_000 }, async (t) => {
    const d = await dashboard(t, kind);
    const { Watcher } = await import('../../src/server/watcher.mjs');
    const s = await d.session('stopped');
    fs.writeFileSync(path.join(s.dir, 'STOP'), '');
    await until('the stand-in stopped', () => !fs.existsSync(path.join(s.dir, 'STOP')));
    await wait(500);
    const found = await d.app.deck.find(s.name);
    assert.ok(found.run, 'the run record is still there');
    const card = (await d.app.deck.list()).find((c) => c.name === s.name);
    assert.equal(card.status, 'waiting', 'and says it waits');
    try {
      // The send route (the assistant, a hub).
      const r = await d.req(`/api/sessions/${s.name}/send`, { text: 'touch TYPED_INTO_SHELL_send' });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.code, 'not_in_front');
      assert.match(r.json.error, /not the program in front/);
      // The queue, on the live cards: it sees the tool waiting and keeps its item.
      assert.equal((await d.req(`/api/automation/queue/${s.name}`, { op: 'add', text: 'touch TYPED_INTO_SHELL_queue' })).status, 200);
      const tick = await d.auto().tick();
      assert.deepEqual(tick.plan.queue.map((a) => a.type), ['send']);
      assert.equal((await d.auto().api.queueOf(s.name)).items.length, 1);
      // The continue prompt.
      const w = new Watcher({ cards: async () => d.app.deck.list(), deck: d.app.deck, auto: { getAutoSwitch: () => ({ enabled: false }) }, settings: () => ({}), log: () => {}, send: async () => {} });
      w.pending.set(s.name, { to: 'p', prompt: 'touch TYPED_INTO_SHELL_continue', since: Date.now() });
      await w.tick();
      w.stop();
      assert.equal(w.pending.size, 0, 'the prompt was dropped');
      await wait(1500);
      assert.deepEqual(typedIntoShell(s.dir), [], 'the shell ran nothing');
    } finally {
      try {
        process.kill(found.run.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  test(`${kind}: text reaches a waiting coding tool whole, without control bytes; the owner's own typing is as before`, { timeout: 120_000 }, async (t) => {
    const d = await dashboard(t, kind);
    const { toolText } = await import('../../src/server/deck.mjs');
    const s = await d.session('intact');
    const one = 'one\x03two\x1b[31mred\x7fdel\ttab \u009bcsi नमस्ते 🙂 $(touch TYPED_INTO_SHELL_x) \'"!';
    const many = 'first line\x15erase\r\nsecond\rthird\n\x1b[201~fourth';
    for (const text of [one, many]) {
      const r = await d.req(`/api/sessions/${s.name}/send`, { text });
      assert.equal(r.status, 200, r.text);
    }
    await until('both messages arrived', () => got(s.dir).length >= 2);
    const [a, b] = got(s.dir);
    assert.equal(toolText(one), 'one two [31mred del tab  csi नमस्ते 🙂 $(touch TYPED_INTO_SHELL_x) \'"!', 'every run of control characters is one space');
    assert.equal(a, toolText(one), 'one line: typed as it is, nothing else');
    assert.equal(toolText(many), 'first line erase\nsecond\nthird\n [201~fourth');
    assert.equal(b, `\x1b[200~${toolText(many).replace(/\n/g, '\r')}\x1b[201~`, 'several lines: one paste, as the tool asked for, nothing else');
    for (const m of [a, b.slice(6, -6)]) assert.equal(/[\x00-\x0c\x0e-\x1f\x7f-\x9f]/.test(m), false, JSON.stringify(m));

    // The owner's own keys: the page's terminal sends every key as before, control keys included, to whatever runs
    // there; the message box (owner: true) types as before, also into a shell.
    await d.quit(s);
    const r = await d.req(`/api/sessions/${s.name}/send`, { text: 'touch OWNER_BOX', owner: true });
    assert.equal(r.status, 200, r.text);
    const live = d.app.backend.attach(s.name, { cols: 100, rows: 30 });
    live.onData(() => {});
    await wait(500);
    live.write('echo not this\x15touch OWNER_KEYS\r');
    await until('the owner\'s own typing ran in the shell', () => fs.existsSync(path.join(s.dir, 'OWNER_BOX')) && fs.existsSync(path.join(s.dir, 'OWNER_KEYS')));
    live.close();
    assert.deepEqual(typedIntoShell(s.dir), []);
  });
}
