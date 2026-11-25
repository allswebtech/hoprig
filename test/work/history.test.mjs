// Work's one history (src/work/history.mjs, GET /api/work/history): on a temporary computer with sessions of the
// owner, of Tia and of a schedule, a Work run that made a commit, a failed run, a commit and a save of the Work file,
// and a failed automation: one list, newest first, with who, provider and how each ended; each filter; the paging;
// no full path in the answer; and the repositories are read without a fetch or a lock and are left as they were.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-history');
test.after(() => t.cleanup());
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { stateDir } = await import('../../src/paths.mjs');
const { noteStart, noteEnd } = await import('../../src/work/sessionlog.mjs');
const { markHers } = await import('../../src/hermark.mjs');
const { writeRun, writerId } = await import('../../src/work/runs.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');
const { forgetCommits, mergeHistory, pageOf, readHistory, PAGE } = await import('../../src/work/history.mjs');

const now = Date.now();
const ago = (min) => now - min * 60_000;
const at = (min) => new Date(ago(min)).toISOString();

// The AI brain keeps the Work file (the default place); a save of it is Work's own commit subject.
t.repo(t.brain, { 'README.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n' });
fs.writeFileSync(path.join(t.brain, 'work', 'tasks.json'), '{\n  "items": [{ "id": "a", "title": "A" }]\n}\n');
t.git(t.brain, 'commit', '-q', '-am', 'Update work items');
// A project with a commit of the owner's and a commit a Work run made.
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n' });
fs.writeFileSync(path.join(shop, 'cart.js'), 'export const total = 1;\n');
t.git(shop, 'add', '-A');
t.git(shop, 'commit', '-q', '-m', 'Fix the cart total');
const runCommit = t.git(shop, 'rev-parse', 'HEAD');
fs.writeFileSync(path.join(shop, 'notes.md'), 'notes\n');
t.git(shop, 'add', '-A');
t.git(shop, 'commit', '-q', '-m', 'Write the notes');
const blog = path.join(t.projects, 'blog');
fs.mkdirSync(blog, { recursive: true });

// Sessions: the owner's terminal at a limit, Tia's that failed, and one a schedule started.
const st = stateDir();
const rec = (runId, extra) => ({ runId, profile: 'max', cwd: shop, tool: 'claude', startedAt: ago(300), ...extra });
const file = (id) => path.join(st, 'runs', `${id}.json`);
noteStart(file('own-1'), rec('own-1', { termName: 'shop' }), { now: ago(300) });
noteEnd(file('own-1'), rec('own-1', { termName: 'shop', limit: { at: 'x' }, title: 'Tidy the styles' }), { now: ago(200) });
markHers(file('tia-1'));
noteEnd(file('tia-1'), rec('tia-1', { profile: 'team', cwd: blog, startedAt: ago(150), failure: { at: 'y' }, title: `Look at ${t.home}/secret-place` }), { now: ago(100) });
noteStart(file('sch-1'), rec('sch-1', { profile: 'auto', termName: 'shop-2', startedAt: ago(60) }), { now: ago(60) });
noteEnd(file('sch-1'), rec('sch-1', { profile: 'auto', termName: 'shop-2', startedAt: ago(60), title: 'Morning check' }), { now: ago(50) });
const log = (e) => fs.appendFileSync(path.join(st, 'automation.log'), `${JSON.stringify(e)}\n`);
fs.mkdirSync(st, { recursive: true });
log({ time: at(60), automation: 'schedules', session: 'shop-2', did: 'started "Morning check"', outcome: 'ok' });
log({ time: at(20), automation: 'queue', session: 'shop', did: 'could not send the next queued message to shop', outcome: 'failed: the session was waiting for your OK' });

// Work's runs: one done that made the run commit, one failed.
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
const place = resolvePlace({});
const run = (id, min, extra) => writeRun(place, {
  v: 1, id, item: 'fix-cart', title: 'Fix the cart', writer: writerId(), by: 'owner', startedAt: at(min), endedAt: at(min - 5), project: 'shop', folder: '.',
  tool: 'claude', provider: 'max', model: null, effort: null, session: null, conversation: null, message: null, brief: 'Fix the cart', state: 'done',
  reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null, ...extra,
});
run('20261120-100000-aaaaaaaa', 40, { commits: [{ repo: '.', short: runCommit.slice(0, 7), subject: 'Fix the cart total' }] });
run('20261120-110000-bbbbbbbb', 30, { state: 'failed', reason: 'the tests did not pass', title: 'Add a test' });

const gitState = (d) => ({ status: t.git(d, 'status', '--porcelain=v2', '--branch'), head: t.git(d, 'rev-parse', 'HEAD'), fetch: fs.existsSync(path.join(d, '.git', 'FETCH_HEAD')), lock: fs.existsSync(path.join(d, '.git', 'index.lock')) });
const before = { shop: gitState(shop), brain: gitState(t.brain) };

const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
const { port } = await app.listen(0, '127.0.0.1');
test.after(() => app.close());
const origin = `http://127.0.0.1:${port}`;
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async (q = '') => {
  const r = await fetch(`${origin}/api/work/history${q}`, { headers: { Origin: origin, Cookie: cookie } });
  return { status: r.status, body: await r.json() };
};

test('one list, newest first: sessions, runs, commits, a save and errors, with who, provider and end', async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  const l = body.lines;
  const ats = l.map((x) => x.at);
  assert.deepEqual(ats, [...ats].sort().reverse(), 'newest first');
  const kinds = new Set(l.map((x) => x.kind));
  for (const k of ['session', 'run', 'commit', 'save', 'error']) assert.ok(kinds.has(k), `a ${k} line`);
  const own = l.find((x) => x.id === 'session:terminal:own-1');
  assert.deepEqual([own.who, own.project, own.provider, own.end, own.text], ['owner', 'shop', 'max', 'limit', 'Tidy the styles']);
  assert.match(own.detail, /Claude Code on max · stopped at a usage limit/);
  const tia = l.find((x) => x.id === 'session:terminal:tia-1');
  assert.deepEqual([tia.who, tia.project, tia.provider, tia.end], ['tia', 'blog', 'team', 'failed']);
  const sch = l.find((x) => x.id === 'session:terminal:sch-1');
  assert.equal(sch.who, 'schedule', 'the schedule that started it, from the automations\' log');
  assert.ok(!l.some((x) => x.kind === 'automation' && /Morning check/.test(x.text)), 'its "started" line is the session\'s, not a second line');
  const failed = l.find((x) => x.run === '20261120-110000-bbbbbbbb');
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /"Add a test" failed: the tests did not pass/);
  assert.ok(l.some((x) => x.kind === 'error' && /waiting for your OK/.test(x.text)), 'a failed automation is an error');
  const save = l.find((x) => x.kind === 'save');
  assert.equal(save.text, 'Saved the Work list');
  assert.equal(save.who, null, 'a save that no run made has no who');
  const byRun = l.find((x) => x.kind === 'commit' && x.text === 'Fix the cart total');
  assert.equal(byRun.who, 'owner', 'a run\'s commit carries the run\'s who');
  const plain = l.find((x) => x.kind === 'commit' && x.text === 'Write the notes');
  assert.equal(plain.who, null, 'any other commit has no who (never guessed)');
  assert.deepEqual(body.projects, ['blog', 'shop']);
});

test('no full path and no secret in the answer', async () => {
  const text = JSON.stringify((await get()).body);
  for (const bad of [t.root, t.home, t.projects, t.brain, st, 'passwordHash']) assert.ok(!text.includes(bad), `"${bad}" in the answer`);
  assert.match(text, /Look at ~\/secret-place/, 'a path in a title is said from the home folder');
});

test('each filter: project, day, who; a who filter hides the lines whose who is not known', async () => {
  const p = (await get('?project=blog')).body.lines;
  assert.ok(p.length >= 1 && p.every((x) => x.project === 'blog'));
  const today = (await get()).body.lines[0].day;
  const d = (await get(`?day=${today}`)).body.lines;
  assert.ok(d.length && d.every((x) => x.day === today));
  assert.equal((await get('?day=2001-01-01')).body.lines.length, 0, 'a day with nothing: an empty page');
  const tia = (await get('?who=tia')).body.lines;
  assert.deepEqual(tia.map((x) => x.id), ['session:terminal:tia-1']);
  const sched = (await get('?who=schedule')).body.lines;
  assert.ok(sched.length && sched.every((x) => x.who === 'schedule'));
  const owner = (await get('?who=owner')).body.lines;
  assert.ok(owner.every((x) => x.who === 'owner'));
  assert.ok(!owner.some((x) => x.text === 'Write the notes'), 'a commit of no known who is not "you"');
  assert.equal((await get('?who=everyone')).body.lines.length, (await get()).body.lines.length);
  for (const q of ['?who=me', '?project=../x', '?day=today', '?before=yesterday']) assert.equal((await get(q)).status, 400, q);
});

test('the read starts no fetch and takes no lock: git status is as it was', async () => {
  await get();
  assert.deepEqual({ shop: gitState(shop), brain: gitState(t.brain) }, before);
});

test('paging: at most 200 lines a page, `before` gives the next, a time is never split', () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ id: `x${String(i).padStart(3, '0')}`, at: new Date(now - Math.floor(i / 2) * 1000).toISOString(), day: '2026-11-20', project: 'shop', who: null, kind: 'commit', text: 'c' }));
  const one = pageOf(many);
  assert.equal(one.lines.length, PAGE);
  assert.equal(one.more, true);
  const two = pageOf(many, { before: one.before });
  assert.ok(two.lines.every((x) => x.at < one.before));
  const three = pageOf(many, { before: two.before });
  assert.equal(three.more, false);
  assert.equal(one.lines.length + two.lines.length + three.lines.length, 450, 'every line once');
});

test('the route pages too', async () => {
  const all = (await get()).body;
  assert.equal(all.more, false);
  assert.equal(all.before, null);
  const older = (await get(`?before=${encodeURIComponent(all.lines[1].at)}`)).body.lines;
  assert.ok(older.length && older.every((x) => x.at < all.lines[1].at));
});

test('Tia\'s Work run and a mission\'s are hers; a run of a schedule is the schedule\'s', () => {
  const l = mergeHistory({ runs: [
    { id: 'r1', item: 'a', title: 'A', by: 'mission', startedAt: at(5), endedAt: at(4), project: 'shop', tool: 'claude', provider: 'max', state: 'done', commits: [] },
    { id: 'r2', item: 'b', title: 'B', by: 'schedule', startedAt: at(3), endedAt: at(2), project: 'shop', tool: 'claude', provider: 'max', state: 'done', commits: [] },
  ] });
  assert.deepEqual(l.map((x) => [x.run, x.who]), [['r2', 'schedule'], ['r1', 'tia']]);
});

test('a Do it run Tia started (its chat hers, open or ended) shows under Tia, with its commit; his own run under You', () => {
  const run = (id, session, short) => ({ id, item: 'a', title: id, by: 'owner', session, startedAt: at(5), endedAt: at(4), project: 'shop', tool: 'claude', provider: 'max', state: 'done', commits: [{ repo: '.', short, subject: id }] });
  const open = '11111111-1111-4111-8111-111111111111';
  const ended = '22222222-2222-4222-8222-222222222222';
  const his = '33333333-3333-4333-8333-333333333333';
  const l = mergeHistory({
    runs: [run('r-open', open, 'aaaaaaa'), run('r-ended', ended, 'bbbbbbb'), run('r-his', his, 'ccccccc')],
    sessions: [{ id: ended, kind: 'chat', chat: ended, who: 'tia', startedAt: at(5), endedAt: at(4) }, { id: his, kind: 'chat', chat: his, who: 'owner', startedAt: at(5), endedAt: at(4) }],
    chats: { open: new Map([[open, { title: '', byTia: false, hers: true }]]), archived: new Map() },
    commits: [{ project: 'shop', repo: '.', list: ['aaaaaaa', 'bbbbbbb', 'ccccccc'].map((s, i) => ({ sha: s.repeat(6).slice(0, 40), short: s, at: at(3 - i), subject: s })) }],
  });
  const who = (k, v) => l.find((x) => x[k] === v).who;
  assert.deepEqual([who('run', 'r-open'), who('run', 'r-ended'), who('run', 'r-his')], ['tia', 'tia', 'owner']);
  assert.deepEqual([who('short', 'aaaaaaa'), who('short', 'bbbbbbb'), who('short', 'ccccccc')], ['tia', 'tia', 'owner'], 'a run\'s commit carries its who');
});

test('an empty computer: an empty history', async () => {
  forgetCommits();
  const was = process.env.HOPRIG_STATE_DIR;
  process.env.HOPRIG_STATE_DIR = path.join(t.root, 'empty-state');
  try {
    const l = await readHistory({ cfg: {}, projects: path.join(t.root, 'none'), runs: () => [], place: () => null });
    assert.deepEqual(l, []);
  } finally {
    process.env.HOPRIG_STATE_DIR = was;
  }
});

// The git reads are cached (a few minutes): a test after this one would see the old list.
test('git is read once within the cache time', async () => {
  forgetCommits();
  let calls = 0;
  const counting = (argv, o) => {
    calls += 1;
    return new Promise((resolve) => {
      try {
        resolve({ ok: true, code: 0, stdout: execFileSync(argv[0], argv.slice(1), { env: o.env, encoding: 'utf8' }), stderr: '' });
      } catch (e) {
        resolve({ ok: false, code: 1, stdout: '', stderr: String(e.stderr || '') });
      }
    });
  };
  await readHistory({ cfg: {}, runs: () => [], place: () => place, run: counting });
  const first = calls;
  assert.ok(first > 0);
  await readHistory({ cfg: {}, runs: () => [], place: () => place, run: counting });
  assert.equal(calls, first);
});

test('a session\'s provider is named by its label, as on a run and in Settings; a provider that is gone by its name', async () => {
  const { writeProfile } = await import('../../src/profiles.mjs');
  writeProfile('team', { label: 'Team plan' });
  forgetCommits();
  const l = await readHistory({ cfg: {}, runs: () => [], place: () => place });
  const tia = l.find((x) => x.id === 'session:terminal:tia-1');
  assert.match(tia.detail, /Claude Code on Team plan · ended with an error/);
  assert.equal(tia.provider, 'team', 'the filter value stays the name');
  assert.match(l.find((x) => x.id === 'session:terminal:own-1').detail, /Claude Code on max · /, 'no such provider any more: its name');
  assert.match(l.find((x) => x.id === 'session:terminal:sch-1').detail, /Claude Code on Auto mode/);
});

test('an open App session whose process has not ended has its line, by its project, with no folder', async () => {
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  fs.writeFileSync(path.join(st, 'chats.json'), `${JSON.stringify([{ id, engine: 'claude', cwd: shop, profile: 'team', title: 'The cart total is a cent off', openedAt: ago(10) }])}\n`);
  forgetCommits();
  const l = await readHistory({ cfg: {}, runs: () => [], place: () => place });
  const open = l.find((x) => x.id === `session:chat:${id}`);
  assert.ok(open, 'a line for the open App session');
  assert.deepEqual([open.who, open.project, open.chat, open.open, open.text], ['owner', 'shop', id, true, 'The cart total is a cent off']);
  assert.match(open.detail, /^An App session · Claude Code on Team plan · is open in the App$/);
  assert.equal(JSON.stringify(open).includes(t.root), false, 'no path');
  fs.rmSync(path.join(st, 'chats.json'));
});
