// A look into what nobody can explain (src/operator/look.mjs), through Work's real door for Tia's sessions (alone.mjs)
// with the stand-in coding tool: started restricted (Read, Glob, Grep) on the strongest model with its own budget, its
// finding parsed strictly into one file, its worktree and branch gone after it, the project's tree and refs as they
// were, one look per item, the day's count and dollars over a restart and a second dashboard, and "Make it a task"
// only by the owner's tap. In a temporary home with traps for the real system's programs first on PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome } from '../mission/helpers.mjs';
import { repoTree } from '../work/helpers.mjs';

const t = missionHome('operator-look');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, readDoc } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { listRuns, viewRun } = await import('../../src/work/runs.mjs');
const { detectUnknown } = await import('../../src/operator/detect/unknown.mjs');
const { looks, lookStore, parseFinding, readLook, applyLookPatch, readFinding, usedToday, lookEstimate, strongestServed, STRONGEST } = await import('../../src/operator/look.mjs');
const { forgetModels, modelsFor } = await import('../../src/models/catalog.mjs');
const { applyDecidePatch, readDecide } = await import('../../src/operator/decide-store.mjs');
const { cleanAlone } = await import('../../src/automation/settings.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { stateDir } = await import('../../src/paths.mjs');

const shop = path.join(t.projects, 'shop');
// Work's file lives in a project of its own, so the project a look reads is compared whole, with nothing left out.
t.repo(shop, { 'README.md': '# shop\n', 'src/cart.mjs': 'export const total = (items) => items.reduce((n, i) => n + i.price, 0);\n' });
t.repo(path.join(t.projects, 'plans'), { 'README.md': '# plans\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const cfg = { work: { place: 'project', project: 'plans', path: 'docs/plans', ownerId: 'alex' }, assistant: { enabled: true }, operator: { acts: true, look: { on: true } } };
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const log = path.join(t.root, 'tool.log');
process.env.FAKE_TOOL_LOG = log;
const told = [];
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 1 }), minuteMs: 2000, killGraceMs: 200, notify: (n) => told.push(['notify', n]), record: (r) => told.push(['record', r]) });
test.after(() => runner.close());
const work = { start: (j) => runner.startAlone(j), drop: (id) => runner.dropLook(id), stop: (id, why) => runner.stop(id, why), add: (b) => store().add(b) };
const accounts = async () => ({ profiles: [{ name: 'key', kind: 'subscription' }], autoSwitch: { enabled: false } });
const ctx = { config: () => cfg };
const lk = looks({ ctx, runner: () => work, accounts });

/** A task of Work whose run failed for a reason no check knows → its `unknown` item. */
let n = 0;
async function failedItem() {
  const id = (await store().add({ title: `Cart ${++n}`, project: 'shop', note: 'DO:fail' })).item.id;
  const fin = await (await runner.startAlone({ item: id, provider: 'key', by: 'owner' })).done;
  assert.equal(fin.state, 'failed');
  const runs = listRuns(place()).filter((r) => r.id === fin.id).map((r) => viewRun(r));
  const [it] = detectUnknown({ work: { runs } }, { now: Date.now() });
  assert.ok(it, 'the failed run is an item of the kind unknown');
  return it;
}
const branches = () => t.git(shop, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').filter(Boolean);

test('the finding is parsed strictly: exactly its four parts, nothing else of the answer counts', () => {
  const ok = parseFinding('Looked.\n{"cause":"total() adds price, not price*qty","where":[{"file":"src/cart.mjs","line":1}],"mend":"Multiply by qty","sure":"sure"}');
  assert.deepEqual(ok.finding, { cause: 'total() adds price, not price*qty', where: [{ file: 'src/cart.mjs', line: 1 }], mend: 'Multiply by qty', sure: 'sure' });
  assert.equal(parseFinding('{"cause":"not found","where":[],"mend":"","sure":"a guess"}').finding.cause, 'not found');
  for (const bad of [
    'no line of JSON',
    '{"cause":"x","where":[],"mend":"y","sure":"sure","run":"git push"}', // a key more
    '{"cause":"x","where":[],"mend":"y","sure":"certain"}',
    '{"cause":"x","where":[{"file":"/etc/passwd","line":1}],"mend":"y","sure":"sure"}',
    '{"cause":"x","where":[{"file":"../up","line":1}],"mend":"y","sure":"sure"}',
    '{"cause":"","where":[],"mend":"y","sure":"sure"}',
    '{"cause":"x","where":[],"mend":"y","sure":"sure"}\nand then more words',
  ]) assert.ok(parseFinding(bad).fault, bad);
});

test('the switch is off when absent, with 2 looks and $3 a day by default; the strongest model is never a decision\'s', () => {
  assert.deepEqual(readLook({}), { on: false, perDay: 2, dollarsPerDay: 3 });
  assert.deepEqual(readLook({ operator: { look: { on: 'yes', perDay: 99 } } }), { on: false, perDay: 2, dollarsPerDay: 3 });
  assert.deepEqual(applyLookPatch({}, { on: true, perDay: 3, dollarsPerDay: 1.5 }), { on: true, perDay: 3, dollarsPerDay: 1.5 });
  assert.throws(() => applyLookPatch({}, { model: 'opus' }), /not a setting of a look/);
  assert.throws(() => applyLookPatch({}, { dollarsPerDay: 500 }), /from 0.5 to 50/);
  assert.equal(STRONGEST, 'opus');
  assert.throws(() => applyDecidePatch({}, { model: 'opus' }), /for a look only/);
  assert.throws(() => applyDecidePatch({}, { model: 'claude-opus-5-5' }), /for a look only/);
  assert.equal(readDecide({ operator: { decide: { model: 'opus' } } }).model, null, 'a model written by hand is not used for a decision either');
  assert.equal(readDecide({ operator: { decide: { model: 'haiku' } } }).model, 'haiku');
  assert.equal(readDecide({ operator: { decide: { model: 'opus' } } }).modelRefused, 'opus', 'a saved one that is refused is kept to be said on the page');
  assert.equal(readDecide({ operator: { decide: { model: 'haiku' } } }).modelRefused, null);
  // Any model stronger than the small ones, of whatever name, is refused: an allow-list, not one word.
  for (const m of ['fable', 'claude-fable-5-2', 'claude-mythos-5-2', 'some-new-model', 'opus-haiku', 'claude-opus-5-5-sonnet', 'fable[sonnet]', 'claude-sonnet-5-opus']) {
    assert.throws(() => applyDecidePatch({}, { model: m }), /for a look only/, m);
    assert.equal(readDecide({ operator: { decide: { model: m } } }).model, null, m);
  }
  for (const m of ['claude-sonnet-5-5', 'sonnet', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'sonnet[1m]', 'claude-3-5-haiku', 'claude-3-5-sonnet', 'claude-3-7-sonnet', 'us.anthropic.claude-haiku-4-5-20251001-v1:0']) {
    assert.equal(applyDecidePatch({}, { model: m }).model, m, m);
    assert.equal(readDecide({ operator: { decide: { model: m } } }).model, m, m);
  }
  const e = lookEstimate();
  assert.equal(e.model, 'Claude Opus 5.5');
  // The tokens of the real look, at opus's list price: 25,971 x $4 + 645 x $20 per million.
  assert.deepEqual([e.tokens, e.usd, e.unknown], [26_616, 0.1168, []]);
  assert.deepEqual(e.prices, { input: 4, output: 20, read: '2026-11-19' }, 'the prices and the day they were read go with it');
});

test('a look is started restricted on the strongest model with its own budget, writes one finding, and changes nothing', async () => {
  const it = await failedItem();
  const before = repoTree(shop);
  const heads = branches();
  fs.writeFileSync(log, '');
  const r = await lk.startOne(it);
  assert.ok(r.started, r.why);
  const f = await r.done;
  const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).args;
  assert.ok(call.includes('--restricted') && call.includes('--strict-mcp-config'), call.join(' '));
  assert.equal(call[call.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(call[call.indexOf('--model') + 1], 'opus');
  assert.equal(call[call.indexOf('--max-budget-usd') + 1], '3', 'the day\'s dollars left');
  const facts = call[call.indexOf('--add-dir') + 1];
  assert.ok(facts.startsWith(path.join(stateDir(), 'operator', 'look-facts')), facts);
  assert.ok(!call.includes('--allow-dangerously-skip-permissions'));
  assert.deepEqual(f.finding, { cause: 'cart.mjs adds the price instead of multiplying it by the quantity', where: [{ file: 'src/cart.mjs', line: 3 }], mend: 'Multiply price by qty in total()', sure: 'fairly sure' });
  assert.equal(f.notCounted, null);
  assert.equal(f.cost, 0.01);
  assert.equal(f.tokens, 1000);
  assert.ok(!fs.existsSync(facts), 'the facts folder is removed after the finding');
  assert.deepEqual(branches(), heads, 'its branch is gone');
  assert.deepEqual(repoTree(shop), before, 'the project\'s tree and refs are as they were');
  // A look is no run of Work's task list, and it changed no task.
  const look = listRuns(place()).find((x) => x.id === f.run);
  assert.equal(look.by, 'look', 'its run record stays, with by look');
  assert.equal(readDoc(place().file).doc.items.length, n, 'no task was added or changed by the look');
  const { workRuns } = await import('../../src/work/doit.mjs');
  const { workUnits } = await import('../../src/work/pulse.mjs');
  const shown = workRuns({ config: () => cfg, log: () => {} });
  assert.ok(!shown.list().some((x) => x.id === f.run), 'Work\'s run list has no look');
  assert.ok(!Object.keys(shown.latest()).includes(look.item), 'nor the newest run of a task');
  assert.ok(!(await workUnits({ place: place(), cfg })).units.some((u) => u.run === f.run), 'nor the pieces of work it follows');
  assert.equal(t.trapped(), '', 'no trapped program was called');
  // Its answer is a card only: no notification to his push address, no line in the automations' history.
  assert.deepEqual(told.filter(([, x]) => /A look at/.test(JSON.stringify(x))), [], 'a look sends nothing and records nothing');
  // One look per item, also for a second dashboard on the same state folder, and over a restart.
  assert.match((await lk.startOne(it)).why, /looked into already/);
  const other = looks({ ctx, runner: () => work, accounts });
  assert.match((await other.startOne(it)).why, /looked into already/);
  assert.equal(usedToday(lookStore().read(), Date.now()).looks, 1);
  assert.equal(usedToday(lookStore().read(), Date.now()).dollars, 0.01);
});

test('the day\'s count holds: past it, no look starts, for this dashboard and another one', async () => {
  cfg.operator.look = { on: true, perDay: 2, dollarsPerDay: 3 };
  const a = await failedItem();
  const r = await lk.startOne(a);
  await r.done;
  const b = await failedItem();
  assert.match((await lk.startOne(b)).why, /2 looks in the last 24 hours, the limit of 2 a day/);
  assert.match((await looks({ ctx, runner: () => work, accounts }).startOne(b)).why, /limit of 2 a day/);
  cfg.operator.look = { on: true, perDay: 5, dollarsPerDay: 0.5 };
  // The dollars of the day: a look that reports no cost counts its whole budget.
  process.env.FAKE_COST = '0.45';
  try {
    const r2 = await lk.startOne(b);
    assert.ok(r2.started, r2.why);
    await r2.done;
  } finally {
    delete process.env.FAKE_COST;
  }
  const c = await failedItem();
  assert.match((await lk.startOne(c)).why, /used the \$0.5 a day/);
  cfg.operator.look = { on: true };
});

test('a look whose branch got a commit of its own keeps the branch and its finding is not counted; a bad answer is no finding', async () => {
  fs.rmSync(lookStore().file(), { force: true });
  const it = await failedItem();
  process.env.FAKE_LOOK = 'COMMIT';
  let f;
  try {
    f = await (await lk.startOne(it)).done;
  } finally {
    delete process.env.FAKE_LOOK;
  }
  assert.match(f.notCounted, /has 1 commit of its own, so it is kept/);
  assert.ok(branches().some((b) => b.includes('look-unknown')), 'the branch is kept');
  await assert.rejects(lk.toTask(it.id, async () => assert.fail('no task')), /not counted/);
  const it2 = await failedItem();
  process.env.FAKE_LOOK = 'ORDERS';
  try {
    f = await (await lk.startOne(it2)).done;
  } finally {
    delete process.env.FAKE_LOOK;
  }
  assert.equal(f.finding, null);
  assert.match(f.fault, /exactly the four parts/);
});

test('"Make it a task" turns the mend into a task of Work, once', async () => {
  fs.rmSync(lookStore().file(), { force: true });
  const it = await failedItem();
  await (await lk.startOne(it)).done;
  const r = await lk.toTask(it.id, (b) => work.add(b));
  const task = readDoc(place().file).doc.items.find((x) => x.id === r.task);
  assert.match(task.title, /^Mend: cart.mjs adds the price/);
  assert.match(task.note, /Multiply price by qty/);
  assert.match(task.note, /src\/cart.mjs:3/);
  assert.equal(readFinding(it.id).task, r.task);
  assert.equal(readFinding(it.id).taskTitle, task.title, 'the card names it by its title');
  await assert.rejects(lk.toTask(it.id, (b) => work.add(b)), /a task already/);
});

test('a look cannot be started another way: not by a schedule\'s job, not through the run route, not by Tia\'s token', async () => {
  const job = { look: { id: 'look-x', label: 'x' }, project: 'shop', provider: 'key', prompt: 'You look into why something failed.', restricted: ['Read', 'Glob', 'Grep'] };
  fs.writeFileSync(log, '');
  await assert.rejects(runner.startAlone(job), /belongs to an item or a schedule/);
  await assert.rejects(runner.startAlone({ ...job, by: 'owner' }), /belongs to an item or a schedule/);
  assert.equal(fs.readFileSync(log, 'utf8'), '', 'nothing was started');
  assert.throws(() => cleanAlone({ type: 'alone', project: 'shop', prompt: 'x', provider: 'key', by: 'look' }), /by/);
  assert.throws(() => cleanAlone({ type: 'alone', project: 'shop', prompt: 'x', provider: 'key', restricted: ['Read'] }), /restricted/);
  assert.throws(() => checkRoute('POST', '/api/operator/look/task', { item: 'unknown-0123456789ab' }));
  assert.throws(() => checkRoute('POST', '/api/operator/settings', { look: { on: true } }));
  // With the switch off nothing is started, whatever the list holds.
  cfg.operator.look = { on: false };
  try {
    assert.equal(await lk.tick({ items: [{ id: 'unknown-0123456789ab', kind: 'unknown', target: { project: 'shop' } }] }), null);
  } finally {
    cfg.operator.look = { on: true };
  }
  assert.equal(t.trapped(), '');
});

test('a dashboard that dies while its look runs: the next one removes its worktree, branch and facts, and the card says so', { timeout: 60_000 }, async () => {
  fs.rmSync(lookStore().file(), { force: true });
  const { spawnSync } = await import('node:child_process');
  const it = { id: 'unknown-0123456789ab', kind: 'unknown', subject: 'Work run x', facts: ['it failed'], target: { case: 'reason', project: 'shop' } };
  const heads = branches();
  const env = { ...process.env, FAKE_LOOK: 'SLOW' };
  delete env.NODE_TEST_CONTEXT;
  const a = spawnSync(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'look-dies.mjs'), JSON.stringify(it)], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(a.signal, 'SIGKILL', a.stderr);
  assert.ok(JSON.parse(a.stdout).started, a.stdout);
  assert.ok(branches().some((b) => b.includes('look-unknown-0123456789ab')), 'its branch was made');
  assert.ok(fs.existsSync(path.join(stateDir(), 'operator', 'look-facts', 'look-unknown-0123456789ab')));
  // The next dashboard on the same state folder: its runs settled at its start, then a tick past the look's time.
  await runner.begin();
  const later = looks({ ctx, runner: () => work, accounts, now: () => Date.now() + 25 * 60_000 });
  await later.tick({ items: [it] });
  assert.deepEqual(branches(), heads, 'its branch is gone');
  assert.ok(!t.git(shop, 'worktree', 'list').includes('look-unknown-0123456789ab'), 'its worktree is gone');
  assert.ok(!fs.existsSync(path.join(stateDir(), 'operator', 'look-facts', 'look-unknown-0123456789ab')), 'its facts folder is gone');
  const f = later.about(it.id);
  assert.equal(f.state, 'lost');
  assert.match(f.fault, /dashboard stopped while it ran/);
  assert.equal(f.notCounted, null);
  assert.equal(f.counted, false, 'a lost look has no finding that counts');
  assert.match((await later.startOne(it)).why, /looked into already/, 'still one look per item');
  // A second tick does it once: the look is cleared.
  await later.tick({ items: [it] });
  assert.equal(later.store.read().looks.filter((l) => l.item === it.id).length, 1);
  assert.equal(t.trapped(), '');
});

test('a look lost to a stopped dashboard is cleared by the next one also while looks are off, or Tia is', { timeout: 60_000 }, async () => {
  fs.rmSync(lookStore().file(), { force: true });
  const { spawnSync } = await import('node:child_process');
  const { operatorFeature } = await import('../../src/operator/feature.mjs');
  const it = { id: 'unknown-0123456789ac', kind: 'unknown', subject: 'Work run z', facts: ['it failed'], target: { case: 'reason', project: 'shop' } };
  const heads = branches();
  const env = { ...process.env, FAKE_LOOK: 'SLOW' };
  delete env.NODE_TEST_CONTEXT;
  const a = spawnSync(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'look-dies.mjs'), JSON.stringify(it)], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(a.signal, 'SIGKILL', a.stderr);
  assert.ok(JSON.parse(a.stdout).started, a.stdout);
  const facts = path.join(stateDir(), 'operator', 'look-facts', 'look-unknown-0123456789ac');
  assert.ok(fs.existsSync(facts));
  // He turned looks off, and Tia too, before the next dashboard started.
  const was = cfg.operator;
  cfg.operator = { ...was, acts: false, look: { on: false } };
  try {
    await runner.begin();
    const ticker = { fn: null };
    const fail = class extends Error {};
    const f = operatorFeature({ HttpError: fail, caller: () => 'page', readJson: async () => ({}), config: () => cfg, saveConfig: () => {}, state: async () => ({}), onTick: (fn) => { ticker.fn = fn; return () => {}; } },
      { sources: {}, work: () => work, accounts, now: () => Date.now() + 25 * 60_000 });
    try {
      await ticker.fn();
      await f.looking();
      assert.deepEqual(branches(), heads, 'its branch is gone');
      assert.ok(!t.git(shop, 'worktree', 'list').includes('look-unknown-0123456789ac'), 'its worktree is gone');
      assert.ok(!fs.existsSync(facts), 'its facts folder is gone');
      const l = f.look.store.read().looks.find((x) => x.item === it.id);
      assert.equal(l.state, 'lost');
      assert.equal(l.cleared, true);
      assert.equal(f.look.about(it.id).state, 'lost', 'the card says the dashboard stopped, with no finding');
    } finally {
      f.close();
    }
  } finally {
    cfg.operator = was;
  }
  assert.equal(t.trapped(), '');
});

test('a broken record of looks is set aside and freezes the looks for a day, and shows no dollars that were not spent', async () => {
  const file = lookStore().file();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.broken`, { force: true });
  fs.writeFileSync(file, '{broken');
  const v = await lk.view();
  assert.equal(v.frozen, 'unread');
  assert.deepEqual([v.today.looks, v.today.dollars], [0, 0], 'no made-up looks or dollars');
  await lk.tick({ items: [] });
  const w = await lk.view();
  assert.ok(Date.parse(w.frozen) > Date.now() + 23 * 3600_000, w.frozen);
  assert.deepEqual([w.today.looks, w.today.dollars, w.today.reserved], [0, 0, 0], 'still none: the freeze is no cost');
  assert.equal(fs.readFileSync(`${file}.broken`, 'utf8'), '{broken', 'the broken record is set aside, not written over');
  const it = { id: 'unknown-00000000000f', kind: 'unknown', subject: 'Work run y', facts: [], target: { case: 'reason', project: 'shop' } };
  assert.match((await lk.startOne(it)).why, /record of looks could not be read, so she starts none until/);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.broken`, { force: true });
  // A look whose tool reported no cost: its budget counts against the day, said as held back, not as spent.
  const u = usedToday({ looks: [{ item: 'a', at: Date.now(), budget: 3, cost: null }, { item: 'b', at: Date.now(), budget: 3, cost: 0.2 }] }, Date.now());
  assert.deepEqual(u, { looks: 2, dollars: 3.2, reserved: 3 });
  // A cheap look's real cost is not rounded away before the page formats it.
  fs.writeFileSync(file, JSON.stringify({ v: 1, looks: [{ item: 'unknown-00000000000e', at: Date.now(), state: 'done', budget: 3, cost: 0.0029 }] }));
  assert.equal((await lk.view()).today.dollars, 0.0029);
  fs.rmSync(file, { force: true });
});

// A provider of a gateway that answers its model list (a stand-in fetch, never the network): `ids` are what it serves.
async function gatewayWith(name, ids) {
  const p = { name, kind: 'api', models: '', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8363', ANTHROPIC_AUTH_TOKEN: 'sk-made-up-0123456789' } };
  const fetchImpl = async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id, display_name: id })) }), { status: 200 });
  await modelsFor(p, { fetchImpl });
  return p;
}

test('a look takes the strongest model its provider really serves, from the one list of its models', async () => {
  forgetModels();
  assert.deepEqual(strongestServed({ name: 'key', kind: 'subscription' }), { model: 'opus', family: 'opus' }, 'a subscription serves opus');
  const both = await gatewayWith('relay-a', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(strongestServed(both), { model: 'claude-opus-5-5', family: 'opus' }, 'its own id, as the provider names it');
  const fable = await gatewayWith('relay-b', ['claude-sonnet-5-5', 'claude-fable-5-2']);
  assert.deepEqual(strongestServed(fable), { model: 'claude-fable-5-2', family: 'fable' }, 'where it serves no opus, its fable');
  const small = await gatewayWith('relay-c', ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.match(strongestServed(small).why, /^relay-c serves no model of the strongest family \(Opus or Fable\), so no look starts on it$/);
  const never = { name: 'relay-d', kind: 'api', models: '', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8364', ANTHROPIC_AUTH_TOKEN: 'sk-made-up-9876543210' } };
  assert.match(strongestServed(never).why, /models of relay-d have not been asked for yet/, 'the family names of a fallback are not its models');
  assert.match(strongestServed(null, 'gone').why, /not on this computer/);
  // The estimate names the model it was priced for.
  assert.equal(lookEstimate('fable', 'claude-fable-5-2').model, 'Claude Fable 5.2');
  assert.equal(lookEstimate('fable', 'claude-fable-5-2').usd, 0.2336, '25,971 x $8 + 645 x $40 per million');
  forgetModels();
});

test('the switch hands the provider a look runs on by its label, its short name only where it has none', async () => {
  const withLabel = async () => ({ profiles: [{ name: 'key', kind: 'subscription', label: 'Shop Team Plan' }], autoSwitch: { enabled: false } });
  const v = await looks({ ctx, runner: () => work, accounts: withLabel }).view();
  assert.deepEqual(v.runsOn, { provider: 'key', model: 'opus', label: 'Shop Team Plan' });
  const bare = await lk.view();
  assert.deepEqual(bare.runsOn, { provider: 'key', model: 'opus', label: 'key' });
});

test('where the provider serves no strong model, no look starts and the switch says why in one line', async () => {
  forgetModels();
  const small = await gatewayWith('relay-e', ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  const only = async () => ({ profiles: [small], autoSwitch: { enabled: false } });
  const c2 = { config: () => ({ ...cfg, assistant: { enabled: true, accounts: ['relay-e'], level: 'handsoff' } }) };
  const l2 = looks({ ctx: c2, runner: () => ({ start: () => assert.fail('no look may start') }), accounts: only });
  const v = await l2.view();
  assert.equal(v.runsOn, null);
  assert.ok(v.cannot, 'the switch has a reason');
  const it = { id: 'unknown-0000000000aa', kind: 'unknown', subject: 'Work run q', facts: [], target: { case: 'reason', project: 'shop' } };
  const r = await l2.startOne(it);
  assert.equal(r.started, undefined);
  assert.equal(r.why, v.cannot, 'the item says the same line as the switch');
  forgetModels();
});

test('a look waits while a session of his works on its provider, the card says so, and it starts once he is idle', async () => {
  const starts = [];
  const stub = { start: async (j) => {
    starts.push(j);
    return { waiting: true, why: 'held by the test' }; // counted, then given back: nothing runs
  } };
  const own = looks({ ctx, runner: () => stub, accounts, model: 'claude-haiku-5-5', dir: () => path.join(t.root, 'look-wait') });
  const it = { id: 'unknown-0000000000bb', kind: 'unknown', subject: 'Work run w', facts: [], target: { case: 'reason', project: 'shop' } };
  const busy = { name: 'shop-fix', provider: 'key', state: 'working' };
  for (let i = 0; i < 3; i++) {
    const r = await own.tick({ items: [it], board: { sessions: [busy] } });
    assert.equal(r.why, 'it waits while your session on key works');
  }
  assert.equal(starts.length, 0, 'no look started while his session works on its provider');
  assert.deepEqual(own.about(it.id), { state: 'waits', on: 'key' });
  await own.tick({ items: [it], board: { sessions: [{ ...busy, provider: 'other' }] } });
  assert.equal(starts.length, 1, 'a session on another provider holds nothing');
  await own.tick({ items: [it], board: { sessions: [{ ...busy, state: 'waiting' }] } });
  assert.equal(starts.length, 2, 'the look starts once his session is idle');
  assert.equal(own.about(it.id), null, 'the card no longer says it waits');
});
