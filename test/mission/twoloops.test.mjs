// Two loops never act on one thing, through one real dashboard (createServer): the mission's engine and the Operator
// both on, with the limit rule, "Tia decides" and her decisions about missions on. A mission's task stops at a usage
// limit: it is moved to the next provider ONCE (by the engine, the limit rule's name on its line, one act in the rule's
// record), and the Operator, which sees the same limit on a session of the mission, moves nothing. A session of his own
// at a limit is still moved by the Operator: its loop is live in this dashboard. The coding tool is the stand-in, every
// gateway is on a closed port, and the model is a stand-in that leaves every choice to him.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome, standInBox } from './helpers.mjs';
import { closedGateways } from '../seal.mjs';
import { ago, session } from '../operator/fixtures/cases.mjs';

const t = missionHome('mission-twoloops');
test.after(() => t.cleanup());
// The dashboard tidies its workspace a second after it starts: this test's own, never the real one.
if (!process.env.HOPRIG_WORKSPACE_DIR || !process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root)) throw new Error('HOPRIG_WORKSPACE_DIR is not this test\'s own');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { readMission } = await import('../../src/mission/file.mjs');
const { stateDir } = await import('../../src/paths.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const OK = [process.execPath, '-e', 'process.exit(0)'];
const cfg = {
  addons: closedGateways(), claudeBin: path.join(t.root, 'no-claude'), usage: false,
  server: { backend: 'pty', roots: [t.home], passwordHash: await hashPassword('pw-for-tests') },
  assistant: { enabled: true },
  operator: { acts: true, rules: { limit: true }, decide: { on: true, missions: true } },
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, test: OK } }, capUsd: 5, providers: ['key', 'key2'], atOnce: 1 },
};
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
process.env.FAKE_TOOL_LOG = path.join(t.root, 'tool.log');

// Plan with AI, stood in: a proposal record, and an Accept that adds the plan's one task to Work.
const planner = {
  async start(c) {
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
  async accept() {
    const id = (await store().add({ title: 'Limited note', project: 'shop', by: 'writer', note: 'DO:limit' })).item.id;
    return { plan: 'a-plan', tasks: [id] };
  },
};
// What the Operator's board sees: a session of the mission's at the same limit (marked as the board marks one).
const world = { sessions: [] };
const moves = [];
// A choice no rule answers (the second limit, with no provider free) goes to the decision; it leaves it to him.
const calls = [];
const model = async (req) => {
  calls.push(req);
  return { ok: true, text: 'ask_owner\nThe owner decides this one.', tokens: 100 };
};
const accounts = async () => ({ profiles: [{ name: 'key', kind: 'subscription' }, { name: 'key2', kind: 'subscription' }], autoSwitch: { enabled: false } });

test('a limit of a mission\'s session is moved once, by the engine; the Operator moves only a session of his own', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async () => {
  const app = createServer({
    watch: false, dashboardFile: false, tmuxSocket: `twoloops-${process.pid}`,
    work: {
      alone: { command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), minuteMs: 600 },
      missions: { planner, providers: () => [{ name: 'key', kind: 'api' }, { name: 'key2', kind: 'api' }], engine: { box: () => standInBox, machine: () => null, slots: () => 2, tickMs: 200 } },
    },
    operator: { sources: { sessions: () => world.sessions }, cacheMs: 0, turn: model, accounts, session: { move: async (name, to) => { moves.push([name, to]); } } },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'pw-for-tests' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const g = await post('/api/work/missions', { goal: 'A goal at a limit', project: 'shop' });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const mid = g.body.mission.id;
    const acc = await post(`/api/work/proposals/${g.body.proposal.id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const op = app.features.find((f) => f.name === 'operator');
    // Until the task has gone on with the next provider (or the time is up), both loops at work all the while.
    let m = null;
    let seen = false;
    for (let i = 0; i < 300; i++) {
      m = readMission(place(), mid);
      const t0 = m && m.tasks[0];
      if (t0 && t0.runs.length >= 1) world.sessions = [session({ name: `mission-${t0.id}`, provider: 'key', nextProvider: 'key2', limit: { at: ago(1), text: 'Usage limit reached', source: 'hook' }, mission: true })];
      await app.watcher.tick();
      if (world.sessions.length) seen = seen || (await op.list()).items.some((i) => i.kind === 'limit');
      await op.reflex.round();
      if (t0 && t0.runs.length >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const moved = m.line.filter((l) => /reached its usage limit: it goes on with key2, the next provider of your order \(the limit rule\)/.test(l.words));
    assert.equal(moved.length, 1, m.line.map((l) => l.words).join('\n'));
    assert.ok(m.tasks[0].runs.length >= 2, 'the task went on');
    const rec = JSON.parse(fs.readFileSync(path.join(stateDir(), 'operator', 'reflexes.json'), 'utf8'));
    assert.equal(rec.acts.filter((a) => a.rule === 'limit').length, 1, 'one act in the limit rule\'s record');
    assert.ok(seen, 'the Operator saw the limit of the mission\'s session');
    assert.deepEqual(moves, [], 'the Operator moved no session of the mission');
    const timeline = fs.readFileSync(path.join(stateDir(), 'operator', 'timeline.jsonl'), 'utf8');
    assert.doesNotMatch(timeline, /session mission-/, 'and wrote no line about it: it is the engine\'s');
    // His own session at a limit: the Operator's loop moves it, once.
    world.sessions = [session({ name: 'alpha', provider: 'key', nextProvider: 'key2', limit: { at: ago(1), text: 'Usage limit reached', source: 'hook' } })];
    await op.reflex.round();
    await op.reflex.round();
    assert.deepEqual(moves, [['alpha', 'key2']]);
    await post(`/api/work/missions/${mid}/stop`, {});
  } finally {
    await app.close();
  }
  assert.equal(t.trapped(), '', 'no trapped program was called');
});
