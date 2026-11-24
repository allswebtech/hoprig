// Plans and "Plan with AI" over real HTTP, end to end with the stand-in Claude Code (test/chat/fixtures/fake-claude.mjs):
// a goal becomes a planning session, its proposal waits on Today, nothing is in the repository before Accept, Accept
// writes the plan, Do it does one of its tasks. Every id from the browser is checked, and no full path leaves.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoTree as wholeRepo, tempWork } from './helpers.mjs';

const t = tempWork('work-planroutes');
test.after(() => t.cleanup());
// The dashboard below runs in this process: its workspace is the temporary one, never the real one.
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chat', 'fixtures', 'fake-claude.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

t.repo(t.brain, { 'README.md': '# brain\n' });
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'index.html': '<p>shop</p>\n' });
t.repo(path.join(t.projects, 'blog'));

const repoTree = () => wholeRepo(t.brain);

test('Plan with AI end to end over HTTP with the stand-in coding tool, and the plan routes', async () => {
  // The owner's own New-session default is the mode that asks nothing: a planning session never takes it.
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] }, sessionDefaults: { permissionMode: 'bypassPermissions' }, operator: { corrections: { on: true } } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400, stopGraceMs: 1500 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => {
      const r = await fetch(origin + p, { headers: { Cookie: cookie } });
      return { status: r.status, body: await r.json() };
    };
    const post = async (p, body) => {
      const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const noPath = (body, what) => assert.ok(!JSON.stringify(body).includes(t.root), `${what}: no full path`);
    assert.equal((await fetch(`${origin}/api/work/plans`)).status, 401, 'behind the login');

    // The sheet's choices, then Plan.
    const ch = await get('/api/work/propose?project=shop');
    assert.equal(ch.status, 200);
    assert.equal(ch.body.provider, 'sub');
    assert.equal((await get('/api/work/propose?project=..%2Fx')).status, 400);
    assert.equal((await post('/api/work/propose', { goal: 'Make it fast', project: 'nope' })).status, 400);
    assert.equal((await post('/api/work/propose', { goal: 'Make it​ fast', project: 'shop' })).body.code, 'brief-hidden');
    const before = repoTree();
    const started = await post('/api/work/propose', { goal: 'Make this small site load faster', project: 'shop' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const pid = started.body.proposal.id;
    // The planning session reads untrusted pages and files: it runs in the mode that asks before any change.
    const planning = await get(`/api/chats/${started.body.proposal.session}`);
    assert.equal(planning.status, 200);
    assert.equal(planning.body.permissionMode, 'manual', 'the planning chat asks before it changes anything');
    // It waits on Today, then is ready.
    let w;
    for (let i = 0; i < 200; i++) {
      w = (await get('/api/work')).body;
      if (w.proposals.find((x) => x.id === pid && x.state !== 'working')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const row = w.proposals.find((x) => x.id === pid);
    assert.equal(row.state, 'ready', JSON.stringify(row));
    assert.equal(w.planWithAi, true);
    const one = await get(`/api/work/proposals/${pid}`);
    assert.equal(one.body.proposal.proposal.tasks.length, 4);
    noPath(one.body, 'a proposal');
    assert.deepEqual(repoTree(), before, 'nothing in the repository before Accept');
    assert.equal((await get('/api/work/proposals/..%2F..%2Fetc')).status, 400);
    assert.equal((await get('/api/work/proposals/20261118-000000-00000000')).status, 404);

    // Accept, with one change.
    const acc = await post(`/api/work/proposals/${pid}/accept`, { seen: one.body.proposal.hash, tasks: { 3: { date: null } } });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const { listCorrections } = await import('../../src/operator/corrections.mjs');
    assert.deepEqual(listCorrections().map((c) => [c.kind, c.about]), [['plan-changed', { decision: 'plan' }]], 'he changed her plan before he accepted it');
    const planId = acc.body.plan;
    const list = await get('/api/work/plans');
    assert.deepEqual(list.body.plans.map((p) => [p.id, p.progress]), [[planId, { done: 0, all: 4 }]]);
    const plan = await get(`/api/work/plans/${planId}`);
    assert.equal(plan.status, 200);
    assert.match(plan.body.note, /What exists/);
    assert.equal(plan.body.plan.milestones.length, 2);
    assert.ok(plan.body.plan.timeline.weeks.length >= 1);
    noPath(plan.body, 'a plan');
    assert.equal((await get('/api/work/plans/..%2F..%2Fsecret')).status, 400);
    assert.equal((await get('/api/work/plans/nope')).status, 404);

    // A task that waits says so and Do it refuses it; the first one is done by Do it with the brief the sheet shows.
    w = (await get('/api/work')).body;
    assert.equal(w.planTitles[planId], plan.body.plan.title, 'the list names each plan by its title, for the task rows');
    const second = w.items.find((x) => x.plan === planId && x.after.length);
    assert.ok(second.waits.length, 'the second task waits for the first');
    const first = w.items.find((x) => x.plan === planId && !x.after.length);
    const refused = await post(`/api/work/items/${second.id}/do`, { at: second.at, seen: (await get(`/api/work/items/${second.id}/do?at=${second.at}`)).body.brief });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'waits');
    const sheet = (await get(`/api/work/items/${first.id}/do?at=${first.at}`)).body;
    assert.match(sheet.brief, /Measure how long the home page of shop takes/, 'the session\'s brief is shown on the Do it sheet');
    const run = await post(`/api/work/items/${first.id}/do`, { at: first.at, seen: sheet.brief });
    assert.equal(run.status, 200, JSON.stringify(run.body));

    // A plan by hand, changed with the version it saw; a task put into it and taken out.
    const made = await post('/api/work/plans', { title: 'Grow the blog', goal: 'Twice the visits.', projects: ['blog'], milestones: [{ title: 'Ten posts', date: '2027-01-15' }] });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const g = await get(`/api/work/plans/${made.body.plan.id}`);
    assert.equal((await post(`/api/work/plans/${made.body.plan.id}`, { title: 'Grow it' })).status, 400, 'a change names what it saw');
    const ed = await post(`/api/work/plans/${made.body.plan.id}`, { seen: g.body.hash, status: 'dropped' });
    assert.equal(ed.body.plan.status, 'dropped');
    const added = (await post('/api/work/items', { title: 'Write a post' })).body.item;
    const put = await post(`/api/work/items/${added.id}/plan`, { at: added.at, plan: made.body.plan.id, milestone: 'ten-posts' });
    assert.deepEqual(put.body.item, { id: 'write-a-post', plan: made.body.plan.id, milestone: 'ten-posts' });
    assert.equal((await post(`/api/work/items/${added.id}/plan`, { at: added.at, plan: '../x' })).status, 400);
    // Stop waiting sends only what the task waits for: its plan and milestone stay as they are, unread.
    const waits = await post(`/api/work/items/${added.id}/plan`, { at: added.at, after: [] });
    assert.deepEqual(waits.body.item, { id: 'write-a-post', plan: made.body.plan.id, milestone: 'ten-posts' });
    assert.equal((await post(`/api/work/items/${added.id}/plan`, { at: added.at, milestone: 'ten-posts', after: [] })).status, 400, 'a milestone without its plan');
    assert.equal((await post(`/api/work/items/${added.id}/plan`, { at: added.at })).status, 400, 'nothing to change');
    const out = await post(`/api/work/items/${added.id}/plan`, { at: added.at, plan: null });
    assert.equal(out.body.item.plan, null);

    // A goal the session does not plan: shown with the reason; Dismiss leaves nothing.
    const bad = await post('/api/work/propose', { goal: 'There is no plan for this', project: 'shop' });
    let b;
    for (let i = 0; i < 200; i++) {
      b = (await get(`/api/work/proposals/${bad.body.proposal.id}`)).body.proposal;
      if (b.state !== 'working') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(b.state, 'unreadable');
    assert.match(b.problem.message, /did not answer with a plan in the shape Hoprig reads/);
    assert.match(b.answer, /rather not plan/);
    assert.deepEqual((await post(`/api/work/proposals/${b.id}/dismiss`, {})).body, { dismissed: true });
  } finally {
    await app.close();
  }
});
