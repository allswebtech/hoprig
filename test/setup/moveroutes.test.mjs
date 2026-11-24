// The move on the server's own page (src/setup/moveroutes.mjs): it starts only from the signed-in page here, only as
// root, after one confirmation that names this server; a computer token and Tia's door never start it. The process of
// the move is a stand-in that writes the job file a real one would.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const R = await import('../../src/setup/moveroutes.mjs');
const J = await import('../../src/setup/movejob.mjs');

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const okPlan = { ok: true, stops: [], user: { name: 'hoprig', home: '/home/hoprig' }, parts: [], admin: [], running: { working: [], idle: [], terminals: [], work: 0, assistant: 0 } };
function feature({ root = true, plan = okPlan } = {}) {
  const jobFile = path.join(s.tmp, `job-${Math.random().toString(36).slice(2)}.json`);
  const started = [];
  const seenAtStart = [];
  const startedWith = [];
  const ctx = { root, config: () => ({}), readJson: async (req) => req.body, HttpError, caller: (req) => req.who };
  const f = R.moveFeature(ctx, {
    jobFile: () => jobFile, server: () => 'box2', plan: async () => plan,
    start: (file, more) => {
      started.push(file);
      startedWith.push(more);
      seenAtStart.push(J.readJob(file));
      const w = J.jobWriter(file);
      w.line('Copying 47 entries (27 KB) to /home/hoprig…');
    },
  });
  const route = (method, p) => f.routes.find(([m, re]) => m === method && re.test(p));
  const call = (method, url, req = {}) => {
    const [p, q = ''] = url.split('?');
    const r = route(method, p);
    return r[2](req, p.match(r[1]), new URLSearchParams(q));
  };
  return { call, started, seenAtStart, startedWith, jobFile };
}
const rejects = async (p, status, re) => {
  await assert.rejects(p, (e) => e.status === status && re.test(e.message));
};

test('only the signed-in page here starts it, after a confirmation that names this server', async () => {
  const f = feature();
  const look = await f.call('GET', '/api/move');
  assert.equal(look.root, true);
  assert.equal(look.server, 'box2');
  assert.equal(look.plan.user.name, 'hoprig');
  await rejects(f.call('POST', '/api/move', { who: 'computer', body: { confirm: 'box2' } }), 403, /only from this server's own page/);
  await rejects(f.call('POST', '/api/move', { who: 'self', body: { confirm: 'box2' } }), 403, /not by another computer or Tia/);
  await rejects(f.call('POST', '/api/move', { who: 'page', body: {} }), 400, /confirm the move with this server's name, box2/);
  await rejects(f.call('POST', '/api/move', { who: 'page', body: { confirm: 'box3' } }), 400, /box2/);
  assert.deepEqual(f.started, []);
  assert.deepEqual(await f.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), { started: true });
  assert.equal(f.started.length, 1);
  const job = await f.call('GET', '/api/move/job?from=0');
  assert.equal(job.running, true);
  assert.match(job.lines[0], /^Copying 47 entries/);
  await rejects(f.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), 409, /running already/);
  assert.equal((await f.call('GET', '/api/move')).plan, null, 'no new look while it runs');
});

test('not root, or a look that stops: nothing starts, and the reason is the answer', async () => {
  const notRoot = feature({ root: false });
  assert.equal((await notRoot.call('GET', '/api/move')).plan, null);
  await rejects(notRoot.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), 409, /does not run as root/);
  const stopped = feature({ plan: { ...okPlan, ok: false, stops: ['a session is working now (shop (working)): end it first, then run the move again'] } });
  await rejects(stopped.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), 409, /a session is working now/);
  assert.deepEqual(stopped.started, []);
});

test('the job file says "running" before the process starts, and an earlier move\'s lines are not shown again', async () => {
  const f = feature();
  // An earlier move that stopped left its file.
  const old = J.jobWriter(f.jobFile);
  old.line('STOPPED at "the trial": an old reason');
  old.end({ ok: false, code: 1 });
  assert.deepEqual(await f.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), { started: true });
  assert.equal(f.seenAtStart[0].running, true);
  assert.deepEqual(f.seenAtStart[0].lines, [], 'the old lines are gone before the new process writes');
  assert.equal(f.seenAtStart[0].result, null);
});

test('the page\'s choice of no administrator rights starts the move with --no-admin', async () => {
  const f = feature();
  await f.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2', noAdmin: true } });
  assert.deepEqual(f.startedWith, [{ noAdmin: true }]);
  const argv = [];
  R.startMoveProcess('/x/job.json', { noAdmin: true, spawnFn: (bin, a) => (argv.push(...a), { pid: 1 }) });
  assert.deepEqual(argv.slice(1), ['move-to-user', '--yes', '--no-admin', '--job', '/x/job.json']);
});

test('two presses at the same moment start one move: the second is told it runs, while the first one\'s look still runs', async () => {
  const f = feature();
  // The look takes time, as movePlan's measuring does.
  const slow = R.moveFeature({ root: true, config: () => ({}), readJson: async (req) => req.body, HttpError, caller: (req) => req.who }, {
    jobFile: () => f.jobFile, server: () => 'box2',
    plan: () => new Promise((r) => setTimeout(() => r(okPlan), 100)),
    start: (file) => f.started.push(file),
  });
  const post = slow.routes.find(([m, re]) => m === 'POST' && re.test('/api/move'))[2];
  const both = await Promise.allSettled([1, 2].map(() => post({ who: 'page', body: { confirm: 'box2' } })));
  assert.equal(f.started.length, 1, both.map((x) => x.status).join(','));
  assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1);
  const no = both.find((x) => x.status === 'rejected').reason;
  assert.equal(no.status, 409);
  assert.match(no.message, /running already/);
  // A look that stops lets the next press look again.
  const g = feature({ plan: { ...okPlan, ok: false, stops: ['made-up stop'] } });
  await rejects(g.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), 409, /made-up stop/);
  await rejects(g.call('POST', '/api/move', { who: 'page', body: { confirm: 'box2' } }), 409, /made-up stop/);
});
