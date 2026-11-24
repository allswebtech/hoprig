// A refusal of Tia's that names a place carries the place as a code of the page's table of places (web/errorways.js)
// in the field `ways`: on his card's note and on its line of Done by Tia, beside the same words. What Tia may do is
// the same: the same refusal, the same words, nothing done. Made-up sources and stand-in acts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

const box = sandbox('operator-ways');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const projects = path.join(box.workspace, 'projects');
fs.mkdirSync(path.join(projects, 'shop'), { recursive: true });
fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true });
const opDir = path.join(box.state, 'operator');
const recFile = path.join(opDir, 'reflexes.json');
const lines = () => {
  try {
    return fs.readFileSync(path.join(opDir, 'timeline.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const MIN = 60_000;
const oldTmux = (pid, over = {}) => ({ what: 'tmux', pid, socket: `test-${pid}`, startedAt: ago(90), clients: 0, parentAlive: false, panes: [{ command: 'sh', children: 0 }], cwd: path.join(projects, 'alpha'), temp: true, proc: `p${pid}`, ...over });

/** A fresh state folder, the given settings, a made-up world and stand-in acts. */
function rig({ rules = {}, acts = true, tia = true, operator = {}, assistant = {}, world: w = {}, slow = null } = {}) {
  fs.rmSync(opDir, { recursive: true, force: true });
  saveConfig({ projectsDir: projects, assistant: { enabled: tia, ...assistant }, operator: { acts, rules, ...operator } });
  const world = { sessions: [], gateways: [], live: null, leftovers: [], ...w };
  const calls = [];
  const clock = { t: NOW };
  const accounts = { profiles: [{ name: 'plan-a', kind: 'subscription' }, { name: 'plan-b', kind: 'subscription' }, { name: 'paid-x', kind: 'api' }], autoSwitch: { enabled: false } };
  const hooks = { accounts: null };
  const ticker = { fn: null };
  const ctx = { HttpError, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: (fn) => { ticker.fn = fn; return () => {}; } };
  const f = operatorFeature(ctx, {
    sources: { sessions: () => world.sessions, gateways: () => world.gateways, live: () => world.live, leftovers: () => world.leftovers },
    now: () => clock.t,
    cacheMs: 0,
    accounts: async () => {
      if (hooks.accounts) await hooks.accounts();
      return accounts;
    },
    session: {
      move: async (name, to) => {
        calls.push(['move', name, to]);
        world.sessions = world.sessions.map((s) => (s.name === name ? { ...s, provider: to, limit: null, nextProvider: s.provider } : s));
      },
      stop: async (name) => calls.push(['stop', name]),
    },
    acts: {
      end: async (t) => {
        calls.push(['end', t.pid]);
        if (slow) await slow(t);
        world.leftovers = world.leftovers.filter((p) => p.pid !== t.pid);
        return { ended: true };
      },
      restartGateway: async (t) => {
        calls.push(['restart-gateway', t.addon]);
        world.gateways = world.gateways.map((g) => (g.name === t.addon ? { ...g, answers: true, running: true } : g));
        return { did: `restarted ${t.addon}` };
      },
      restartLink: async () => {
        calls.push(['restart-link']);
        world.live = { link: { on: true, status: 200, since: ago(0), checkedAt: ago(0) } };
        return { did: 'restarted the public link' };
      },
    },
  });
  const route = (method, p) => f.routes.find(([m, re]) => m === method && re.test(p))[2];
  const call = (method, p, body, who = 'page') => {
    ctx.caller = () => who;
    return route(method, p)({ url: p, body, socket: {} });
  };
  return { f, world, calls, clock, accounts, hooks, ticker, ctx, call, round: () => f.reflex.round(), view: () => f.reflex.view() };
}
// A limit Claude Code reported itself (the run record's), as the board's sessions source marks it.
const limited = (over = {}) => session({ name: 'alpha', folder: path.join(projects, 'alpha', 'code'), limit: { at: ago(3), text: 'Usage limit reached', source: 'hook' }, ...over });

test('a move to a provider Tia may not use: the same refusal and words, now with the code of Settings → Tia', async () => {
  const r = rig({ rules: { limit: true }, world: { sessions: [limited({ nextProvider: 'paid-x' })] } });
  await r.round();
  assert.deepEqual(r.calls, [], 'nothing was done');
  const l = lines()[0];
  assert.equal(l.result, 'paid-x is not a provider Tia may use (Settings → Tia). You decide this move yourself.');
  assert.equal(l.refused, true);
  assert.deepEqual(l.ways, ['tia-settings']);
  const it = (await r.call('GET', '/api/operator/attention')).items.find((i) => i.kind === 'limit');
  assert.equal(r.view().his[it.id].words, l.result);
  assert.deepEqual(r.view().his[it.id].ways, ['tia-settings']);
});

test('a refusal that names no place carries no code', async () => {
  const r = rig({ rules: { limit: true }, world: { sessions: [limited({ nextProvider: 'plan-b' })] } });
  r.accounts.autoSwitch = { enabled: true };
  await r.round();
  assert.deepEqual(r.calls, []);
  const l = lines()[0];
  assert.match(l.result, /^Auto mode is on/);
  assert.equal('ways' in l, false);
});

test('the limit rule as the page reads it carries its places; Tia turned off names Settings → Tia by its code', async () => {
  const r = rig({ tia: false });
  const v = r.view();
  assert.deepEqual(v.rules.find((x) => x.id === 'limit').ways, ['auto-mode', 'tia-settings']);
  assert.equal(v.said, 'Tia is turned off in Settings → Tia, so she does nothing by herself.');
  assert.deepEqual(v.ways, ['tia-off']);
  assert.equal('ways' in rig({}).view(), false, 'a sentence that names no place carries no code');
});
