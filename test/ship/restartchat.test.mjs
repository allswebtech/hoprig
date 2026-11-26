// What a restart would cut (rule 6b of docs/GO-LIVE.md) with the dashboard's REAL App sessions: a real dashboard
// (createServer) whose App runs the stand-in coding tool. A turn that runs until the test lets it end is named before the tap,
// waited for, and not cut: the update runs only after it ended. A turn that never ends stops a go-live by itself, which
// says why and runs nothing. The project says that its update restarts the dashboard ("restarts": "hoprig").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';
import { loopWatch, oneCall } from '../onecall.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chat', 'fixtures', 'fake-claude.mjs');
const t = tempShip('ship-restartchat');
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
// tempShip gives this dashboard a workspace of its own (HOPRIG_WORKSPACE_DIR in its root): never the real one.
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
};

/** A project whose update restarts the dashboard; its update writes the moment it ran. */
function project(name, turnSeconds) {
  const dir = path.join(t.projects, name);
  const ran = path.join(t.root, `${name}-update`);
  const live = { update: [['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, String(Date.now()))`]], verify: [['node', '-e', '0']], back: [['node', '-e', '0']], restarts: 'hoprig', turnSeconds };
  t.repo(dir, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live }) });
  t.branch(dir, 'work/faster', { 'fast.txt': 'fast\n' }, 'Faster pages');
  return { dir, ran };
}
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('real App sessions: a short turn is waited for and not cut; a turn that never ends stops a go-live by itself', { timeout: 120_000 }, async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    backend: { kind: 'pty', list: async () => [], capture: async () => '', kill: async () => {} },
    watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
    ship: { busy: () => ({ over: false, why: null }) },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const chats = [];
  const loop = loopWatch('restartchat:');
  loop.mark('the start of the dashboard and the projects');
  try {
    const login = await oneCall(origin, 'POST', '/api/login', { headers: { Origin: origin }, body: { password: 'pw' } });
    const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
    // Each call on a connection of its own (test/onecall.mjs): never a request on a kept-alive connection the server
    // may be closing. A failure names its call and how long after the one before it came.
    let lastCall = Date.now();
    const call = async (method, p, body) => {
      const since = Date.now() - lastCall;
      lastCall = Date.now();
      try {
        const r = await oneCall(origin, method, p, { headers: { Cookie: cookie, ...(body ? { Origin: origin } : {}) }, body });
        return { status: r.status, body: r.json };
      } catch (e) {
        e.message += ` (${since} ms after the call before it)`;
        throw e;
      }
    };
    const ready = async (name) => {
      const tg = await call('POST', `/api/ship/p/${name}/together`, { name, branches: ['work/faster'] });
      assert.equal(tg.status, 200, JSON.stringify(tg.body));
      let v = await call('GET', `/api/ship/p/${name}`);
      assert.equal((await call('POST', `/api/ship/p/${name}/allow`, { kind: 'check', seen: v.body.check.shown.hash, id: tg.body.id })).status, 200);
      assert.equal((await call('POST', `/api/ship/p/${name}/allow`, { kind: 'live', seen: v.body.live.shown.hash, id: tg.body.id })).status, 200);
      return tg.body.id;
    };
    const ship = app.features.find((f) => f.name === 'ship');

    // 1. On his tap: a turn runs in an App session in the project, until this test lets it end (after the step says it
    // waits for it): the order never depends on how fast this computer is.
    const cafe = project('cafe', 20);
    const id = await ready('cafe');
    assert.equal((await call('POST', `/api/ship/p/cafe/check`, { id })).body.check.state, 'ready');
    const tChat = Date.now();
    const release = path.join(t.root, 'cafe-turn-may-end');
    const chat = (await call('POST', '/api/chats', { dir: cafe.dir, profile: 'sub', text: `waitfor ${release}` })).body.id;
    chats.push(chat);
    const v = await until('the turn shows as one a restart would cut', async () => {
      const x = await call('GET', '/api/ship/p/cafe');
      return x.body.cut && x.body.cut.turns.length ? Object.assign(x, { at: Date.now() }) : null;
    });
    assert.equal(v.body.cut.turns[0].kind, 'app');
    assert.match(v.body.cut.words, /^A restart would end a turn that is still running: App session "/, 'named before the tap');
    // The tap names what it was shown, as the page's "Restart anyway" does.
    const tTap = Date.now();
    loop.mark('the go-live step of cafe, waiting for its turn');
    const go = await call('POST', '/api/ship/p/cafe/live', { id, seen: v.body.live.shown.hash, anyway: { turns: v.body.cut.turns.map((x) => x.id), terminals: [] } });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    // The update's mark is read BEFORE the step that says it waits: a later read may come after the turn ended (a slower
    // computer), when the update has rightly run.
    let seenStep = null;
    const step = await until('the step says it waits', async () => {
      const ranBefore = fs.existsSync(cafe.ran);
      const s = (await call('GET', '/api/ship/p/cafe')).body.step;
      seenStep = s || seenStep;
      return s?.waiting ? { ...s, ranBefore } : null;
    }, 60_000).catch(async (e) => {
      // One line for a run where the wait was never seen: when the turn answered against the tap (all times from the
      // chat's start), what the step showed last, and how the go-live ended.
      const c = (await call('GET', `/api/chats/${chat}`)).body;
      const done = (c.events || []).find((x) => JSON.stringify(x).includes('waitfor: done'));
      const last = (await call('GET', '/api/ship/p/cafe')).body.last;
      e.message += ` | DIAG restartchat: the turn shown at ${v.at - tChat} ms, the tap at ${tTap - tChat} ms, the turn answered at ${done ? done.at - tChat : 'never'} ms, chat ${c.status}; the step last seen ${seenStep ? JSON.stringify({ part: seenStep.part, waiting: seenStep.waiting, outcome: seenStep.outcome }) : 'never'}; the go-live ended ${last ? `${last.outcome}: ${String(last.why || '').slice(0, 120)}` : 'not yet'}; the update ${fs.existsSync(cafe.ran) ? `ran at ${Number(fs.readFileSync(cafe.ran, 'utf8')) - tChat} ms` : 'did not run'}`;
      throw e;
    });
    assert.equal(step.turnSeconds, 20, 'it waits, and says for how long');
    assert.equal(step.ranBefore, false, 'nothing of the update ran while it waits');
    fs.writeFileSync(release, '1'); // now the turn ends by itself
    // When the turn's answer came, by the dashboard's own clock (the event's time): this test's look comes later, by as
    // much as its requests take, so its own clock would put the end of the turn after the update on a slower computer.
    const ended = await until('the turn ended by itself', async () => {
      const c = (await call('GET', `/api/chats/${chat}`)).body;
      const done = c.status !== 'working' && c.events.find((e) => JSON.stringify(e).includes('waitfor: done (the file is there)'));
      return done ? done.at : null;
    });
    assert.ok(Number.isFinite(ended), 'the answer of the turn has its time');
    loop.mark('the update and the end of the go-live of cafe');
    await Promise.all(ship.running());
    const last = (await call('GET', '/api/ship/p/cafe')).body.last;
    assert.equal(last.outcome, 'live', last.why);
    const ranAt = Number(fs.readFileSync(cafe.ran, 'utf8'));
    assert.ok(ranAt >= ended, `the update ran after the turn had answered (${ended - ranAt} ms before it)`);
    const c = (await call('GET', `/api/chats/${chat}`)).body;
    assert.equal(JSON.stringify(c.events).includes('interrupted'), false, 'the turn was not cut');

    // 2. By itself: a turn that never ends; the switch on, inside the hours.
    const deli = project('deli', 3);
    const id2 = await ready('deli');
    const hang = (await call('POST', '/api/chats', { dir: deli.dir, profile: 'sub', text: 'sleep' })).body.id;
    chats.push(hang);
    await until('the second turn runs', async () => (await call('GET', '/api/ship/p/deli')).body.cut?.turns.length);
    const now = new Date();
    const on = await call('POST', '/api/ship/p/deli/auto', { on: true, typed: 'deli', from: hm(new Date(now - 3_600_000)), to: hm(new Date(+now + 3_600_000)) });
    assert.equal(on.body.auto, true, JSON.stringify(on.body));
    loop.mark('the check and the go-live by itself of deli');
    const ck = await call('POST', '/api/ship/p/deli/check', { id: id2 });
    assert.equal(ck.body.check.state, 'ready');
    await Promise.all(ship.running());
    const l2 = (await call('GET', '/api/ship/p/deli')).body.last;
    assert.equal(l2.outcome, 'did-not-start');
    assert.match(l2.why, /^it did not go live by itself: a restart would have ended a turn that is still running: App session ".*" \(waited 3 s\)$/);
    assert.equal(fs.existsSync(deli.ran), false, 'its update never ran');
    assert.equal((await call('GET', `/api/chats/${hang}`)).body.status, 'working', 'the turn that runs was not cut');
    assert.deepEqual(t.trapped(), []);
  } finally {
    loop.end();
    for (const c of chats) await oneCall(origin, 'POST', `/api/chats/${c}/stop`).catch(() => {});
    await app.close();
  }
});
