// A run that ends by itself (src/work/alone.mjs) with a stand-in coding tool, on a temporary computer: the answer,
// the commits and the changed files are captured on a branch of its own in a worktree, the owner's checkout stays
// byte for byte the same, the time limit ends it, a refused step is said, tell-me and silence, the limits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoTree, tempWork } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-alone.mjs');
const t = tempWork('work-alone');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, readDoc } = await import('../../src/work/store.mjs');
const { aloneRunner, aloneArgs, hasNews, readStream, branchOf, checkMinutes, descendants } = await import('../../src/work/alone.mjs');
const { listRuns, isRunFile } = await import('../../src/work/runs.mjs');
const { workRuns } = await import('../../src/work/doit.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const blog = path.join(t.projects, 'blog');
t.repo(blog, { 'README.md': '# blog\n' });
fs.mkdirSync(path.join(t.projects, 'plain'), { recursive: true });
fs.writeFileSync(path.join(t.projects, 'plain', 'a.txt'), 'x\n');
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const notes = [];
const logged = [];
let atOnce = 1;
const runner = aloneRunner({
  config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }),
  notify: (n) => notes.push(n), record: (e) => logged.push(e), settings: () => ({ atOnce }), minuteMs: 300, killGraceMs: 200,
  defaultProvider: async () => 'sub',
});
test.after(() => runner.close());
const itemOf = (id) => readDoc(place().file).doc.items.find((x) => x.id === id);
let n = 0;
async function task(brief, project = 'shop') {
  const r = await store().add({ title: `Run alone ${++n}`, project, note: brief });
  return r.item.id;
}
const job = (id, o = {}) => ({ item: id, provider: 'sub', ...o });

test('the result is captured on a branch of its own; the owner\'s checkout stays byte for byte the same', async () => {
  const before = repoTree(shop);
  const id = await task('DO:commit');
  const r = await runner.startAlone(job(id));
  assert.equal(r.run.branch, `work/${id}`);
  assert.equal(itemOf(id).status, 'doing');
  const fin = await r.done;
  assert.equal(fin.state, 'done', fin.reason);
  assert.match(fin.answer, /added the notes/);
  assert.deepEqual(fin.commits.map((c) => [c.repo, c.subject]), [['.', 'Add the notes']]);
  assert.deepEqual(fin.changed, [{ repo: '.', path: 'draft.txt', kind: 'new' }]);
  assert.equal(itemOf(id).status, 'review');
  // his checkout: only the Work file and the run's record changed there; HEAD, branch and every other file as before
  const after = repoTree(shop);
  assert.equal(after.head, before.head);
  assert.equal(t.git(shop, 'symbolic-ref', '--short', 'HEAD'), 'main');
  const rest = (tr) => Object.fromEntries(Object.entries(tr.files).filter(([k]) => !k.startsWith('docs/plans/')));
  assert.deepEqual(rest(after), rest(before));
  assert.equal(fs.existsSync(path.join(shop, 'notes.txt')), false);
  assert.match(t.git(shop, 'log', '--format=%s', `work/${id}`, '-1'), /Add the notes/, 'the commit is on the run\'s branch');
  assert.equal(t.git(shop, 'log', '--format=%s', 'main', '-1'), 'Start', 'nothing on the default branch');
  assert.ok(isRunFile(path.join(place().folder, 'runs', `${fin.id}.json`)), 'a run file Save takes');
  assert.ok(notes.some((x) => /is done/.test(x.title)), 'told: there is something to report');
  // nothing pushed: the server has only main
  assert.equal(t.git(path.join(t.server, 'shop.git'), 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
});

test('the time limit ends it: "stopped at the time limit", the answer so far kept, the item open again', async () => {
  const id = await task('DO:sleep');
  const r = await runner.startAlone(job(id, { minutes: 1 })); // a minute is 300 ms here
  const fin = await r.done;
  assert.equal(fin.state, 'stopped');
  assert.match(fin.reason, /time limit \(1 minute\)/);
  assert.match(fin.answer, /Starting the long job/);
  assert.equal(itemOf(id).status, 'open');
  assert.ok(notes.some((x) => /stopped at its time limit/.test(x.title)));
});

test('it runs in the mode that asks: a step that needed an OK is refused and said; bypass only when chosen', async () => {
  const a = aloneArgs({ prompt: 'x' });
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default', 'the mode that asks');
  assert.ok(!aloneArgs({ prompt: 'x' }).includes('--allow-dangerously-skip-permissions'));
  assert.ok(aloneArgs({ prompt: 'x', mode: 'bypassPermissions' }).includes('--allow-dangerously-skip-permissions'));
  const id = await task('DO:refuse');
  const fin = await (await runner.startAlone(job(id))).done;
  assert.equal(fin.state, 'done');
  assert.match(fin.reason, /needed an OK and was refused \(Bash\)/);
  assert.ok(notes.some((x) => x.message.includes('refused')), 'a refused step is always told');
});

test('tell me: silence when there is nothing to report, unless "every time"', async () => {
  const before = notes.length;
  const id = await task('DO:nothing');
  const fin = await (await runner.startAlone(job(id))).done;
  assert.equal(fin.state, 'done');
  assert.equal(notes.length, before, 'nothing to report: nothing told');
  assert.ok(logged.some((e) => e.outcome === 'ok: nothing to report'));
  await store().status(id, 'open');
  await (await runner.startAlone(job(id, { tell: 'always' }))).done;
  assert.equal(notes.length, before + 1, 'every time: told');
  assert.equal(hasNews({ state: 'failed', commits: [], changed: [], more: 0, answer: 'Nothing to report.' }), true, 'a failure is always news');
});

test('limits: a second run of one project waits, the at-once cap holds, and a waiting run starts when a place is free', async () => {
  const a = await task('DO:sleep');
  const b = await task('DO:nothing');
  const c = await task('DO:nothing', 'blog');
  const ra = await runner.startAlone(job(a, { minutes: 2 }));
  const rb = await runner.startAlone(job(b));
  assert.equal(rb.waiting, true);
  assert.match(rb.why, /another run of shop/);
  const rc = await runner.startAlone(job(c, { project: 'blog' }));
  assert.equal(rc.waiting, true);
  assert.match(rc.why, /at most 1 at once/);
  assert.deepEqual(runner.waiting().map((w) => w.key).sort(), [b, c].sort());
  await ra.done;
  const end = Date.now() + 10_000;
  while (Date.now() < end && !(listRuns(place(), { item: b }).some((r) => r.state === 'done') && listRuns(place(), { item: c }).some((r) => r.state === 'done'))) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(runner.waiting(), [], 'nothing lost: both ran');
  assert.equal(itemOf(b).status, 'review');
});

test('a hold on new starts: a schedule\'s run and an item\'s start wait with the hold\'s words, and start once it is lifted', async () => {
  const { setHold, liftHold } = await import('../../src/operator/decide-store.mjs');
  const id = await task('DO:nothing');
  setHold(Date.now() + 20 * 60_000);
  let ra;
  let rb;
  try {
    ra = await runner.startAlone({ schedule: { id: 'hold0001' }, project: 'blog', prompt: 'DO:nothing', provider: 'sub', by: 'schedule' });
    rb = await runner.startAlone({ item: id, provider: 'sub', by: 'schedule' });
    await runner.drain(); // a drain while held starts nothing either
  } finally {
    liftHold();
  }
  assert.equal(ra.waiting, true);
  assert.match(ra.why, /Tia holds new starts/);
  assert.equal(rb.waiting, true);
  assert.equal(listRuns(place(), { item: id }).length, 0, 'no coding tool started under the hold');
  assert.equal(itemOf(id).status, 'open');
  await runner.drain();
  const end = Date.now() + 10_000;
  while (Date.now() < end && !listRuns(place(), { item: id }).some((r) => r.state === 'done')) await new Promise((r) => setTimeout(r, 50));
  while (Date.now() < end && runner.waiting().length) {
    await runner.drain();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(listRuns(place(), { item: id }).some((r) => r.state === 'done'), 'it ran once the hold was lifted');
  assert.deepEqual(runner.waiting(), [], 'nothing lost');
});

test('refused: a project that is not a git repository; a dry run starts nothing', async () => {
  const id = await task('DO:commit', 'plain');
  await assert.rejects(runner.startAlone(job(id, { project: 'plain' })), /not a git repository/);
  const id2 = await task('DO:commit');
  const before = listRuns(place()).length;
  const d = await runner.startAlone(job(id2), { dryRun: true });
  assert.equal(d.dryRun, true);
  assert.equal(d.would.branch, `work/${id2}`);
  assert.equal(listRuns(place()).length, before);
  assert.equal(itemOf(id2).status, 'open');
});

test('Accept removes a clean worktree and keeps the branch; one with changes left is kept', async () => {
  const id = await task('DO:commit');
  await (await runner.startAlone(job(id))).done;
  const r = await runner.released(id);
  assert.equal(r.removed, false, 'draft.txt is not committed');
  assert.match(r.why, /kept/);
  const top = fs.realpathSync(shop);
  const tree = runner.keptTree(top, branchOf(id));
  fs.rmSync(path.join(tree, 'draft.txt'));
  assert.equal((await runner.released(id)).removed, true);
  assert.match(t.git(shop, 'branch', '--list', branchOf(id)), new RegExp(branchOf(id)), 'the branch stays');
});

test('a task whose run time names no provider runs on the folder\'s default provider (set on the page)', async () => {
  const id = await task('DO:nothing');
  const fin = await (await runner.startAlone({ item: id })).done;
  assert.equal(fin.provider, 'sub');
  assert.equal(fin.state, 'done');
  const none = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, defaultProvider: async () => null });
  await assert.rejects(none.startAlone({ item: await task('DO:nothing') }), /no provider for Claude Code yet/);
});

test('the words: stream reading, limits of the time limit', () => {
  const s = readStream(['{"type":"assistant","message":{"content":[{"type":"text","text":"half"}]}}', 'not json']);
  assert.equal(s.text, 'half');
  assert.equal(s.result, null);
  assert.equal(checkMinutes(undefined), 30);
  for (const v of [0, 241, 1.5, '30']) assert.throws(() => checkMinutes(v), /1 to 240/);
  assert.equal(branchOf('Renew The Domain!'), 'work/renew-the-domain');
});

test('Accept on a repeating task run by itself makes its next occurrence, with the run time carried over', async () => {
  const runs = workRuns({ config: () => cfg, chat: { open() {}, peek() {} }, log: () => {} });
  try {
    const a = await store().add({ title: 'Check the backups', project: 'shop', note: 'DO:nothing', repeat: { kind: 'daily' }, runAt: { time: '07:30', computer: null } });
    const fin = await (await runner.startAlone(job(a.item.id))).done;
    assert.equal(fin.state, 'done', fin.reason);
    assert.equal(itemOf(a.item.id).status, 'review');
    const r = await runs.accept(a.item.id);
    assert.equal(itemOf(a.item.id).status, 'done');
    assert.ok(r.next, 'the next occurrence is named');
    const next = itemOf(r.next);
    assert.equal(next.status, 'open');
    assert.equal(next.repeat.series, a.item.id);
    assert.deepEqual(next.work.at, { time: '07:30', computer: null });
  } finally {
    runs.close();
  }
});

test('paused or schedules off: what waits does not start and keeps its place; a gone schedule\'s entry is dropped; switched back on in the settings, it starts', async () => {
  // The switches as the automations keep them (their settings, saved by the page); the runner reads them from there.
  const { createAutomation } = await import('../../src/automation/index.mjs');
  const { readSettings } = await import('../../src/automation/settings.mjs');
  const { fakeCtx, fakeDeck } = await import('../automation/helpers.mjs');
  const sw = { list: [{ id: 'sched0001' }, { id: 'sched0002' }] };
  let r2 = null;
  const f = fakeCtx({ deck: fakeDeck(), stateDir: path.join(t.root, 'auto-state'), work: { itemRuns: async () => null, startItem: async () => ({}), drain: () => r2.drain() } });
  const flags = () => {
    const a = readSettings(f.config().automation);
    return { atOnce: 1, paused: a.paused, enabled: a.schedules.enabled, list: sw.list };
  };
  r2 = aloneRunner({
    config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }),
    record: (e) => logged.push(e), settings: flags, minuteMs: 300, killGraceMs: 200,
  });
  const auto = createAutomation(f.ctx);
  try {
    const first = await r2.startAlone({ schedule: { id: 'sched0001', label: 'Long' }, project: 'shop', prompt: 'DO:sleep', provider: 'sub', minutes: 1 });
    const second = await task('DO:nothing');
    await store().edit(second, { runAt: { time: '07:30', computer: null } });
    assert.equal((await r2.startAlone(job(second))).waiting, true);
    assert.equal((await r2.startAlone({ schedule: { id: 'sched0002' }, project: 'shop', prompt: 'DO:nothing', provider: 'sub' })).waiting, true);
    auto.api.changeSettings({ paused: true, schedules: { enabled: false } });
    sw.list = [{ id: 'sched0001' }];
    auto.start();
    await assert.rejects(r2.startAlone({ schedule: { id: 'sched0001' }, project: 'blog', prompt: 'DO:nothing', provider: 'sub' }), /paused/);
    const started = Date.now();
    await first.done;
    // past the first tick of start() (due at 1 s): paused, the next one is a slow tick (20 s) away
    await new Promise((r) => setTimeout(r, Math.max(600, 1600 - (Date.now() - started))));
    assert.equal(itemOf(second).status, 'open', 'the waiting run did not start while paused');
    assert.deepEqual(r2.waiting().map((w) => w.key).sort(), [second, 'sched0002'].sort(), 'both keep their place');
    // back on in the settings, nothing called by hand: the automations start what waits
    auto.api.changeSettings({ paused: false, schedules: { enabled: true } });
    // the save brings the tick forward (about 0.3 s), not the next slow tick
    const end = Date.now() + 2500;
    while (Date.now() < end && itemOf(second).status !== 'review') await new Promise((r) => setTimeout(r, 50));
    assert.equal(itemOf(second).status, 'review', 'switched back on: it ran within moments of the save');
    assert.ok(logged.some((e) => e.outcome === 'dropped: its schedule is gone'), 'the deleted schedule\'s entry is dropped and said');
    assert.deepEqual(r2.waiting(), []);
  } finally {
    await auto.close();
    await r2.close();
  }
});

test('a run another computer asks for is refused here while this computer\'s schedules switch is off', async () => {
  const { schedPart } = await import('../../src/work/schedfeature.mjs');
  const c2 = { ...cfg, automation: { schedules: { enabled: false } } };
  const part = schedPart({ sctx: { readJson: async () => ({ schedule: { id: 'abcd1234' }, action: { type: 'alone', project: 'shop', prompt: 'DO:nothing', provider: 'sub' } }) }, cfg: () => c2, places: () => ({}), place, store, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }) });
  const route = part.routes.find(([m, re]) => m === 'POST' && re.test('/api/work/alone/run'));
  const before = listRuns(place()).length;
  // the route's own refusal (startAlone refuses too, in other words): this pins the route's check
  await assert.rejects(route[2]({}), (e) => e.message === 'schedules are off on this computer' && e.status === 409);
  assert.equal(listRuns(place()).length, before, 'nothing started');
  await part.runner.close();
});

test('a run time in the shared Work file that names bypass runs in the mode that asks, and the page or command cannot set one', async () => {
  const { checkRunAt } = await import('../../src/work/repeat.mjs');
  assert.throws(() => checkRunAt({ time: '07:30', mode: 'bypassPermissions' }), /"mode" is not part/);
  const id = await task('DO:nothing');
  // written into the file by someone else (a collaborator's push, a merge)
  const { writeText, serialize } = await import('../../src/work/store.mjs');
  const doc = readDoc(place().file).doc;
  doc.items.find((x) => x.id === id).work = { at: { time: '07:30', computer: null, mode: 'bypassPermissions' } };
  writeText(place().file, serialize(doc));
  const argsFile = path.join(t.root, 'bypass-args.jsonl');
  process.env.FAKE_ALONE_ARGS = argsFile;
  try {
    await (await runner.startAlone({ item: id, by: 'schedule' })).done;
  } finally {
    delete process.env.FAKE_ALONE_ARGS;
  }
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8').trim().split('\n').pop()).args;
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'), 'no bypass');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
});

test('runs started at the same moment still hold the limits: one per project, at most atOnce in all', async () => {
  const a = await task('DO:sleep');
  const b = await task('DO:sleep');
  const c = await task('DO:sleep', 'blog');
  const rs = await Promise.all([runner.startAlone(job(a, { minutes: 1 })), runner.startAlone(job(b, { minutes: 1 })), runner.startAlone(job(c, { project: 'blog', minutes: 1 }))]);
  const started = rs.filter((r) => r.run);
  assert.equal(started.length, 1, `at most 1 at once: ${JSON.stringify(rs.map((r) => r.why || r.run.branch))}`);
  await Promise.all(started.map((r) => r.done));
  // what waited runs one after another; wait until all three are settled
  const end = Date.now() + 15_000;
  const settled = (id) => listRuns(place(), { item: id }).some((r) => r.state !== 'running');
  while (Date.now() < end && ![a, b, c].every(settled)) await new Promise((r) => setTimeout(r, 50));
  assert.ok([a, b, c].every(settled), 'all three ran, one after another');
  assert.deepEqual(runner.waiting(), []);
});

const aliveP = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lastArgs = (file) => JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());

test('without /proc (macOS) the processes below a run come from one ps table, read strictly', () => {
  // As macOS's `ps -A -o pid=,ppid=` prints it: right-aligned columns. 500 is the tool, 501 its child in a group of
  // its own, 502 that one's child; 600 and 700 are not the run's.
  const table = '    1     0\n  500     1\n  501   500\n  502   501\n  600     1\n  700   600\n';
  const mac = (out) => ({ platform: 'darwin', ps: () => out });
  assert.deepEqual(descendants(500, mac(table)).sort(), [501, 502]);
  assert.deepEqual(descendants(600, mac(table)), [700]);
  assert.deepEqual(descendants(502, mac(table)), []);
  // A table that is not what was asked for ends nothing: a header, a stray word, a pid twice, no answer at all.
  for (const bad of ['  PID  PPID\n  500     1\n  501   500\n', `${table}  501   600 x\n`, `${table}  501   600\n`, null]) assert.deepEqual(descendants(500, mac(bad)), [], JSON.stringify(bad));
  assert.deepEqual(descendants(500, { platform: 'darwin', ps: () => { throw new Error('no ps'); } }), []);
  // Never pid 1, or what points back to the run's own pid or this process.
  assert.deepEqual(descendants(1, mac(table)), []);
  assert.deepEqual(descendants(500, mac(`  500     1\n  501   500\n  ${process.pid}   501\n`)), [501]);
  assert.deepEqual(descendants(500, { platform: 'win32', ps: () => table }), []);
});

test('without /proc the processes below a run are found with this computer\'s ps', { skip: process.platform === 'win32' && 'no ps' }, async (t) => {
  // A tool that started a process in a group of its own: the darwin path asks ps (under the runner, the suite's).
  const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
  const { spawn } = await import('node:child_process');
  const tool = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  let kid = null;
  t.after(() => {
    for (const p of [tool.pid, kid]) if (p) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  });
  kid = await new Promise((res) => tool.stdout.once('data', (d) => res(Number(String(d).trim()))));
  assert.deepEqual(descendants(tool.pid, { platform: 'darwin' }), [kid]);
});

test('the time limit ends a run whose tool ignores SIGTERM and left a process holding its output', { skip: process.platform === 'win32' }, async () => {
  const pids = path.join(t.root, 'escape-pids');
  process.env.FAKE_ALONE_PIDS = pids;
  try {
    const id = await task('DO:escape');
    const t0 = Date.now();
    const fin = await (await runner.startAlone(job(id, { minutes: 1 }))).done; // a minute is 300 ms, the grace 200 ms
    assert.ok(Date.now() - t0 < 8000, `settled after ${Date.now() - t0} ms, not when the 20 s process left`);
    assert.equal(fin.state, 'stopped');
    assert.equal(itemOf(id).status, 'open');
    const kid = Number(fs.readFileSync(pids, 'utf8').trim().split('\n').pop());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(aliveP(kid), false, 'what the tool started is ended too');
  } finally {
    delete process.env.FAKE_ALONE_PIDS;
  }
});

test('stopping the dashboard ends a tool that ignores SIGTERM and does not hang', { skip: process.platform === 'win32' }, async () => {
  const argsFile = path.join(t.root, 'closehang-args.jsonl');
  const r2 = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_ALONE_ARGS: argsFile }), record: () => {}, settings: () => ({ atOnce: 4 }), killGraceMs: 200, defaultProvider: async () => 'sub' });
  const id = await task('DO:ignoreterm', 'blog');
  await r2.startAlone(job(id, { project: 'blog', minutes: 5 }));
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  await r2.close();
  assert.ok(Date.now() - t0 < 5000, `close returned after ${Date.now() - t0} ms`);
  assert.equal(aliveP(lastArgs(argsFile).pid), false, 'the tool is ended');
});

test('after a crash of the dashboard, its next start ends the tool that was left running before it marks the run stopped', { skip: process.platform !== 'linux' }, async () => {
  const argsFile = path.join(t.root, 'crash-args.jsonl');
  const id = await task('DO:sleep', 'blog');
  await store().edit(id, { project: 'blog' });
  const { spawnSync } = await import('node:child_process');
  const k = spawnSync(process.execPath, [path.join(path.dirname(FAKE), 'alone-crash.mjs'), id], { env: { ...process.env, FAKE_ALONE_ARGS: argsFile }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(k.signal, 'SIGKILL', k.stderr);
  const pid = lastArgs(argsFile).pid;
  assert.equal(aliveP(pid), true, 'the crash left the tool running');
  const r2 = aloneRunner({ config: () => cfg, record: () => {}, killGraceMs: 200 });
  await r2.begin();
  await new Promise((r) => setTimeout(r, 500));
  const left = aliveP(pid);
  if (left) process.kill(-pid, 'SIGKILL');
  assert.equal(left, false, 'ended at the next start');
  assert.equal(listRuns(place(), { item: id })[0].state, 'stopped');
  assert.equal(itemOf(id).status, 'open');
  await r2.close();
});

test('a run that moves another branch (main) is told, with that branch named, even when it says there is nothing to report', async () => {
  const id = await task('DO:movemain', 'blog');
  const main0 = t.git(blog, 'rev-parse', 'main');
  const before = notes.length;
  const fin = await (await runner.startAlone(job(id, { project: 'blog' }))).done;
  assert.notEqual(t.git(blog, 'rev-parse', 'main'), main0, 'the stand-in moved main');
  assert.match(fin.reason || '', /other than its own moved .*main/);
  assert.equal(notes.length, before + 1, 'told');
  t.git(blog, 'update-ref', 'refs/heads/main', main0);
});

test('a kept worktree a run switched to another branch is refused; the owner\'s own branch of that name is never taken', async () => {
  const id = await task('DO:nothing', 'blog');
  await (await runner.startAlone(job(id, { project: 'blog' }))).done;
  const top = fs.realpathSync(blog);
  const tree = runner.keptTree(top, branchOf(id));
  t.git(tree, 'switch', '-q', '--detach');
  await store().status(id, 'open');
  await assert.rejects(runner.startAlone(job(id, { project: 'blog' })), /not on that branch any more/);
  t.git(tree, 'switch', '-q', branchOf(id));
  // his own branch work/<id>, made before any run of that id
  const mine = await task('DO:commit', 'blog');
  t.git(blog, 'branch', branchOf(mine));
  const own = t.git(blog, 'rev-parse', branchOf(mine));
  const fin = await (await runner.startAlone(job(mine, { project: 'blog' }))).done;
  assert.equal(t.git(blog, 'rev-parse', branchOf(mine)), own, 'his branch did not move');
  assert.equal(fin.branch, `${branchOf(mine)}-2`, 'the run took a free name');
  assert.match(t.git(blog, 'log', '--format=%s', '-1', fin.branch), /Add the notes/);
});

test('a brief that starts with "-" reaches the tool as the prompt, not as an unknown option', async () => {
  const id = (await store().add({ title: 'Dash brief', project: 'shop', note: '- DO:nothing\n- and nothing else' })).item.id;
  const fin = await (await runner.startAlone(job(id))).done;
  assert.equal(fin.state, 'done', fin.reason);
  assert.ok(!aloneArgs({ prompt: '- x' }).includes('- x'), 'the prompt is not an argument');
});

test('a run with a refused step is logged and told as one that needs the owner, never as a plain success', async () => {
  const id = await task('DO:refuse');
  const before = notes.length;
  await (await runner.startAlone(job(id))).done;
  const e = logged.filter((x) => x.did.includes(itemOf(id).title)).pop();
  assert.equal(e.outcome, 'ok: a step needed an OK and was refused (Bash)');
  assert.match(notes[before].title, /needs you/);
});

test('done with a schedule\'s run: its clean worktree goes and the branch stays; a task\'s run is refused there', async () => {
  const fin = await (await runner.startAlone({ schedule: { id: 'quiet0001', label: 'Quiet' }, project: 'blog', prompt: 'DO:nothing', provider: 'sub' })).done;
  const top = fs.realpathSync(blog);
  assert.ok(runner.keptTree(top, 'work/quiet0001'));
  assert.equal((await runner.releaseRun(fin.id)).removed, true);
  assert.equal(runner.keptTree(top, 'work/quiet0001'), null);
  assert.match(t.git(blog, 'branch', '--list', 'work/quiet0001'), /quiet0001/);
  const id = await task('DO:nothing');
  const f2 = await (await runner.startAlone(job(id))).done;
  await assert.rejects(runner.releaseRun(f2.id), /no run of a schedule/);
});

test('the free name a run got never clashes with the next task of the same title: two tasks, two branches, two worktrees', async () => {
  // His own branch work/mend; two tasks titled "Mend" (ids mend and mend-2): the run of mend gets work/mend-2.
  t.git(blog, 'branch', 'work/mend');
  const a = (await store().add({ title: 'Mend', project: 'blog', note: 'DO:commit' })).item.id;
  const b = (await store().add({ title: 'Mend', project: 'blog', note: 'DO:commit' })).item.id;
  assert.deepEqual([a, b], ['mend', 'mend-2']);
  const fa = await (await runner.startAlone(job(a, { project: 'blog' }))).done;
  assert.equal(fa.branch, 'work/mend-2');
  const fb = await (await runner.startAlone(job(b, { project: 'blog' }))).done;
  assert.equal(fb.state, 'done', fb.reason);
  assert.notEqual(fb.branch, fa.branch, 'a branch of its own');
  const top = fs.realpathSync(blog);
  const ta = runner.keptTree(top, branchOf(a));
  const tb = runner.keptTree(top, branchOf(b));
  assert.ok(ta && tb && ta !== tb, 'a worktree of its own');
  for (const f of [fa, fb]) assert.equal(t.git(blog, 'log', '--format=%s', `main..${f.branch}`), 'Add the notes', `only its own commit on ${f.branch}`);
  // Accept of one removes its own worktree only
  fs.rmSync(path.join(tb, 'draft.txt'));
  assert.equal((await runner.released(b)).removed, true);
  assert.ok(fs.existsSync(ta), 'the other task\'s worktree stays');
  assert.equal(runner.keptTree(top, branchOf(a)), ta);
});

test('done with a schedule\'s earlier run while its next slot works in the same worktree: refused, the worktree stays', async () => {
  const f1 = await (await runner.startAlone({ schedule: { id: 'twice0001', label: 'Twice' }, project: 'blog', prompt: 'DO:nothing', provider: 'sub' })).done;
  const s2 = await runner.startAlone({ schedule: { id: 'twice0001', label: 'Twice' }, project: 'blog', prompt: 'DO:sleep', provider: 'sub', minutes: 2 });
  assert.ok(s2.run, 'the next slot runs');
  const top = fs.realpathSync(blog);
  const tree = runner.keptTree(top, 'work/twice0001');
  assert.ok(tree);
  await assert.rejects(runner.releaseRun(f1.id), /a later run of this schedule works in that worktree/);
  assert.ok(fs.existsSync(tree), 'the running slot\'s worktree is still there');
  const fin = await s2.done;
  assert.equal(fin.state, 'stopped');
  assert.equal((await runner.releaseRun(f1.id)).removed, true, 'once it has ended, done with it removes it');
});

test('the owner\'s own commit on main while a run works is named with its commit, for him to recognise, not as the run\'s doing', async () => {
  const id = await task('DO:sleep', 'blog');
  const main0 = t.git(blog, 'rev-parse', 'main');
  const s = await runner.startAlone(job(id, { project: 'blog', minutes: 3 }));
  fs.writeFileSync(path.join(blog, 'own.txt'), 'mine\n');
  t.git(blog, 'add', 'own.txt');
  t.git(blog, 'commit', '-q', '-m', 'Update the price list');
  const mine = t.git(blog, 'rev-parse', '--short', 'main');
  const fin = await s.done;
  assert.match(fin.reason, new RegExp(`by the run or by you: main moved from ${main0.slice(0, 7)} to ${mine} \\("Update the price list"\\)`));
  const e = logged.filter((x) => x.did.includes(itemOf(id).title)).pop();
  assert.match(e.outcome, /Update the price list/, 'the activity line names his commit too');
  const told = notes.filter((x) => x.title.includes(itemOf(id).title)).pop();
  assert.match(told.message, new RegExp(`main moved from ${main0.slice(0, 7)} to ${mine} \\("Update the price list"\\)`), 'the notification names his commit whole');
  assert.match(told.message, /time limit/, 'and still says why it ended');
  assert.ok(told.message.length <= 200);
  t.git(blog, 'reset', '-q', '--hard', main0);
});

test('done with a schedule\'s run and its next slot at the same moment: the removal ends first, the slot waits, then runs in a worktree of its own', async () => {
  const sch = { id: 'race0001', label: 'Race' };
  const top = fs.realpathSync(blog);
  const f1 = await (await runner.startAlone({ schedule: sch, project: 'blog', prompt: 'DO:nothing', provider: 'sub' })).done;
  assert.ok(runner.keptTree(top, 'work/race0001'));
  // both asked for in the same moment (the click and the tick)
  const [released] = await Promise.all([
    runner.releaseRun(f1.id),
    runner.startAlone({ schedule: sch, project: 'blog', prompt: 'DO:sleep', provider: 'sub', minutes: 2 }),
  ]);
  assert.equal(released.removed, true, 'the release was asked first: it removes the ended run\'s worktree');
  // the slot runs at once, or from the waiting list as soon as the removal has ended
  const slot = () => listRuns(place()).find((x) => x.id !== f1.id && x.schedule === 'race0001');
  const end = Date.now() + 5000;
  while (!slot() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(slot(), 'the next slot ran');
  const tree = runner.keptTree(top, 'work/race0001');
  assert.ok(tree && fs.existsSync(tree), 'its worktree is there');
  assert.ok(t.git(blog, 'worktree', 'list').includes(tree), 'and git knows it');
  while (slot().state === 'running' && Date.now() < end + 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(slot().state, 'stopped', `it worked until its time limit: ${slot().reason}`);
  assert.deepEqual(runner.waiting(), []);
  assert.equal((await runner.releaseRun(slot().id)).removed, true);
});

test('a dashboard stop during a drain never drops what waits: every entry keeps its place and its time', async () => {
  const sw = { atOnce: 1, list: [{ id: 'stop0001' }, { id: 'stop0002' }, { id: 'stop0003' }] };
  const mk = (settings) => aloneRunner({
    config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }),
    record: (e) => logged.push(e), settings: () => settings, minuteMs: 60_000, killGraceMs: 200, closeWaitMs: 3000,
  });
  const r = mk(sw);
  await r.startAlone({ schedule: { id: 'stop0001' }, project: 'shop', prompt: 'DO:sleep', provider: 'sub', minutes: 5 });
  for (const id of ['stop0002', 'stop0003']) assert.equal((await r.startAlone({ schedule: { id }, project: 'shop', prompt: 'DO:nothing', provider: 'sub' })).waiting, true);
  const before = r.waiting();
  const d = r.drain(); // the tick, or a run's end
  const c = r.close(); // the dashboard stops at that moment
  await d;
  await c;
  const again = mk(sw);
  assert.deepEqual(again.waiting().sort((x, y) => x.key.localeCompare(y.key)), before.sort((x, y) => x.key.localeCompare(y.key)), 'both still wait, each with the time it began to wait');
  assert.equal(logged.some((e) => /stop000[23]/.test(e.did) && /did not run/.test(e.did)), false, 'nothing said it failed');
  await again.close();
  // tidy for the tests after this one: their schedules are gone, so a drain drops them
  const tidy = mk({ atOnce: 1, list: [] });
  await tidy.drain();
  assert.deepEqual(tidy.waiting(), []);
  await tidy.close();
});

test('the computer\'s one measure of slots: a session that runs by itself elsewhere (a Lead chat\'s part) takes one too', async () => {
  let others = 1;
  const r2 = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), record: () => {}, settings: () => ({ atOnce: 1 }), killGraceMs: 200, minuteMs: 300, defaultProvider: async () => 'sub', othersRunning: () => others });
  try {
    const id = await task('DO:nothing', 'blog');
    const w = await r2.startAlone(job(id, { project: 'blog', minutes: 1 }));
    assert.equal(w.waiting, true, 'one part runs and the limit is one: the run waits');
    assert.match(w.why, /1 run by itself works now \(at most 1 at once\)/);
    others = 0;
    await r2.drain();
    assert.deepEqual(r2.waiting(), [], 'once the part ended, the run starts');
  } finally {
    await r2.close();
  }
});
