// Who gets the one tool of the box, and how a session with it starts (src/mission/engine.mjs, src/work/alone.mjs): the
// real engine and runner with the stand-in coding tool (fixtures/fake-tool.mjs), which starts the tool servers its
// arguments name. Only a work or fix run of a role whose check is its tests, with a test command and a box that says
// yes, gets it; anything else starts as before, with the file tools alone and an empty tool-server list. The gate stays
// the judge: a session that ran the tests itself and passed still waits for the gate's own run in the box.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome } from './helpers.mjs';

const t = missionHome('mission-boxstart');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner, TOOL_SERVER } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { readMission } = await import('../../src/mission/file.mjs');
const { boxTools, toolDoor } = await import('../../src/mission/boxtool.mjs');
const { missionSettings, worksOn } = await import('../../src/mission/settings.mjs');
const { box: seamBox } = await import('../../src/mission/seam.mjs');
const { boxCheck } = await import('../../src/box/box.mjs');
const realBox = await boxCheck();
const realSkip = !realBox.ok && `no box here: ${realBox.why}`;

const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
const CHECK = "const fs = require('fs');\nconsole.log('checked');\nprocess.exit(fs.existsSync('broken.flag') ? 1 : 0);\n";
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'check.cjs': CHECK, 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const cfg = {
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, test: [process.execPath, 'check.cjs'] } }, capUsd: 5, providers: ['key'], atOnce: 1, selfAccept: ['tests'] },
};
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const toolLog = path.join(t.root, 'tool.log');
process.env.FAKE_TOOL_LOG = toolLog;
process.env.FAKE_VERDICTS = path.join(t.root, 'verdicts');
const logLines = () => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The box: the real one where this computer has it (else a stand-in that says yes and runs nothing of the session's),
// with a count of its checks and a switch that makes its check say no.
const box = { off: false, checks: 0, runs: 0, real: realBox.ok ? seamBox() : null };
const theBox = { check: async () => {
  box.checks += 1;
  if (box.off) return { ok: false, why: 'a made-up no' };
  return box.real ? box.real.check() : { ok: true };
}, run: async (argv, opts) => {
  box.runs += 1;
  return box.real ? box.real.run(argv, opts) : { ok: true, code: 0, out: 'checked\n', timedOut: false };
} };
let engine = null;
const tools = boxTools({ settings: () => missionSettings(cfg), box: () => theBox, on: (p) => worksOn(missionSettings(cfg), p), onRun: (rec, end) => engine.selfRan(rec, end) });
const door = toolDoor(tools);
const srv = http.createServer(async (req, res) => {
  if (!(await door.handle(req, res))) res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
test.after(() => srv.close());
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 1 }), minuteMs: 1200, killGraceMs: 200 });
const planner = {
  async start(c) {
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
const logged = [];
engine = missionEngine({ log: (x) => logged.push(x), config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 1, machine: () => null,
  box: () => theBox, tools, address: () => srv.address(), reopen: (id) => store().status(id, 'open'), accept: (id) => store().status(id, 'done'), tickMs: 3_600_000 });
test.after(async () => {
  await engine.close();
  await runner.close();
});
test.afterEach(() => {
  assert.deepEqual(logged.splice(0), [], 'the engine logged no failure');
  for (const k of ['FAKE_EXTRA_SERVERS', 'FAKE_EXTRA_TOOLS', 'FAKE_SERVER_NAME']) delete process.env[k];
  box.off = false;
});

async function until(id, states, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await engine.tick();
    const m = readMission(place(), id);
    if (m && states.includes(m.state) && !m.tasks.some((x) => x.state === 'running' || x.state === 'queued')) return m;
    if (Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function mission(goal, task) {
  const g = await engine.give({ goal, project: 'shop' });
  const id = (await store().add({ title: task.title, project: 'shop', by: task.by, note: task.note })).item.id;
  await engine.accepts.after(g.proposal.id, { plan: 'p', tasks: [id] });
  return { id: g.mission.id, tid: id };
}
const startsOf = (from) => logLines().slice(from).filter((l) => Array.isArray(l.args));
const arg = (args, flag) => args[args.indexOf(flag) + 1];
/** The start of a session without the tool: as before, the file tools alone and no tool server. */
const asToday = (l, what) => {
  assert.equal(arg(l.args, '--mcp-config'), '{"mcpServers":{}}', what);
  assert.equal(l.args.join(' ').includes('hbt_') || l.args.join(' ').includes(TOOL_SERVER), false, what);
  assert.equal(l.args.includes('mcp__hoprig__run_tests') || arg(l.args, '--allowedTools').includes('mcp__'), false, what);
  assert.equal(l.toolWords, false, `${what}: the brief says nothing of a tool`);
};

test('the brief of a session with the tool names its limit and tells it not to loop', async () => {
  const { TOOL_WORDS } = await import('../../src/mission/engine.mjs');
  const { RUNS_MAX, TOTAL_MS } = await import('../../src/mission/boxtool.mjs');
  assert.match(TOOL_WORDS, new RegExp(`at most ${RUNS_MAX} runs and ${TOTAL_MS / 60_000} minutes`), 'the brief names the limit');
  assert.match(TOOL_WORDS, /then it runs nothing/, 'the brief says what happens past the limit');
  assert.match(TOOL_WORDS, /not again and again|not in a loop/, 'the brief says not to call it in a loop');
});

test('a tester\'s work run gets exactly the file tools and the one tool, named in its own arguments; its review run does not', async () => {
  fs.writeFileSync(process.env.FAKE_VERDICTS, 'PASS\n');
  const from = logLines().length;
  const { id } = await mission('Test the cart', { title: 'Test the cart', by: 'tester', note: 'Files: cart.test.js\nRUNTESTS: {}' });
  const m = await until(id, ['done', 'waits', 'failed', 'stopped']);
  const [work, review] = startsOf(from);
  assert.deepEqual(arg(work.args, '--tools').split(','), FILE_TOOLS);
  assert.deepEqual(arg(work.args, '--allowedTools').split(','), [...FILE_TOOLS, 'mcp__hoprig__run_tests']);
  const servers = JSON.parse(arg(work.args, '--mcp-config')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['hoprig']);
  assert.deepEqual(servers.hoprig.args, [TOOL_SERVER], 'the product\'s own file, never one of the worktree');
  assert.equal(servers.hoprig.command, process.execPath, 'the Node that runs Hoprig');
  assert.equal(servers.hoprig.env.HOPRIG_TOOL_URL, `http://127.0.0.1:${srv.address().port}`, 'this dashboard\'s own address');
  assert.ok(work.args.includes('--strict-mcp-config') && work.args.includes('--restricted'));
  assert.equal(work.toolWords, true, 'its brief says what the tool is for');
  asToday(review, 'the review run');
  const x = m.tasks[0];
  assert.deepEqual({ runs: x.selfTests.runs, last: x.selfTests.last }, { runs: 1, last: 'passed' }, 'the card\'s count');
  assert.equal(tools.size(), 0, 'its token died with the session');
  assert.equal(fs.existsSync(path.join(shop, '.mcp.json')), false);
});

test('a writer (a file check) and a run with no test command, or with no box, start as before: no tool server, no token', async () => {
  const from = logLines().length;
  const w = await mission('Write the about page', { title: 'Write the about page', by: 'writer', note: 'Files: about.md' });
  await until(w.id, ['done', 'waits', 'failed', 'stopped']);
  const was = cfg.missions.projects.shop.test;
  cfg.missions.projects.shop.test = null;
  const n = await mission('Test the menu', { title: 'Test the menu', by: 'tester', note: 'Files: menu.test.js' });
  await until(n.id, ['done', 'waits', 'failed', 'stopped']);
  cfg.missions.projects.shop.test = was;
  box.off = true;
  const b = await mission('Test the footer', { title: 'Test the footer', by: 'developer', note: 'Files: footer.js' });
  await until(b.id, ['done', 'waits', 'failed', 'stopped']);
  const starts = startsOf(from).filter((l) => !l.review);
  assert.equal(starts.length >= 3, true, String(starts.length));
  for (const l of starts) asToday(l, l.cwd);
  assert.equal(tools.size(), 0);
});

test('a tests-role session without the tool is told the tests run after it; a file-check role is not', async () => {
  box.off = true; // no box: a tests role gets no tool, so it starts as today but is told the tests run after it
  const from = logLines().length;
  const d = await mission('Test the orders', { title: 'Test the orders', by: 'developer', note: 'Files: orders.js' });
  await until(d.id, ['done', 'waits', 'failed', 'stopped']);
  const w = await mission('Write the terms page', { title: 'Write the terms page', by: 'writer', note: 'Files: terms.md' });
  await until(w.id, ['done', 'waits', 'failed', 'stopped']);
  box.off = false;
  const starts = startsOf(from).filter((l) => !l.review);
  for (const l of starts) assert.equal(l.toolWords, false, 'no tool, so the brief says nothing of a tool');
  assert.ok(starts.some((l) => l.afterWords), 'a tests-role session without the tool is told the tests run after it');
  assert.ok(starts.some((l) => !l.afterWords), 'a file-check role (the writer) is not told that');
  // No test command: the check fails the task for want of one and runs nothing, so the session is not told it runs.
  const was = cfg.missions.projects.shop.test;
  cfg.missions.projects.shop.test = null;
  const from2 = logLines().length;
  const n = await mission('Test the payments', { title: 'Test the payments', by: 'developer', note: 'Files: pay.js' });
  await until(n.id, ['done', 'waits', 'failed', 'stopped']);
  cfg.missions.projects.shop.test = was;
  const none = startsOf(from2).filter((l) => !l.review);
  assert.ok(none.length >= 1, String(none.length));
  for (const l of none) assert.equal(l.afterWords, false, 'with no test command nothing runs after it, so it is not told so');
});

test('the words a session without the tool is told hold on a computer with a box and on one without', async () => {
  const { AFTER_WORDS } = await import('../../src/mission/engine.mjs');
  assert.match(AFTER_WORDS, /in a box, where this computer has one/, 'with a box: the check runs them there by itself');
  assert.match(AFTER_WORDS, /where it has none, only when the owner runs them/, 'without one: nothing runs them by itself');
  assert.doesNotMatch(AFTER_WORDS, /\b(gate|Tia)\b/, 'no word of the dashboard\'s own');
});

test('with missions off nothing starts, no token is made and the box is not even checked', async () => {
  const { id, tid } = await mission('Test the search', { title: 'Test the search', by: 'tester', note: 'Files: search.test.js' });
  cfg.missions.on = false;
  const checks = box.checks;
  const from = logLines().length;
  for (let i = 0; i < 3; i += 1) await engine.tick();
  cfg.missions.on = true;
  assert.equal(startsOf(from).length, 0, 'no session started');
  assert.equal(box.checks, checks, 'the box was not checked');
  assert.equal(tools.size(), 0);
  await engine.stop(id);
  assert.ok(tid);
});

test('the first line of a session with the tool: any other tool server or tool still ends it at once', async () => {
  process.env.FAKE_EXTRA_SERVERS = 'other';
  const { id } = await mission('Test the login', { title: 'Test the login', by: 'tester', note: 'Files: login.test.js' });
  const m = await until(id, ['done', 'waits', 'failed', 'stopped']);
  assert.match(m.line.map((l) => l.words).join('\n'), /did not start restricted \(it had 2 tool servers\)/);
  delete process.env.FAKE_EXTRA_SERVERS;
  process.env.FAKE_EXTRA_TOOLS = 'mcp__hoprig__run_anything';
  const k = await mission('Test the signup', { title: 'Test the signup', by: 'tester', note: 'Files: signup.test.js' });
  const m2 = await until(k.id, ['done', 'waits', 'failed', 'stopped']);
  assert.match(m2.line.map((l) => l.words).join('\n'), /did not start restricted \(it had mcp__hoprig__run_anything\)/);
  delete process.env.FAKE_EXTRA_TOOLS;
  process.env.FAKE_SERVER_NAME = 'other'; // one server, but not the product's by its name
  const o = await mission('Test the basket', { title: 'Test the basket', by: 'tester', note: 'Files: basket.test.js' });
  const m3 = await until(o.id, ['done', 'waits', 'failed', 'stopped']);
  assert.match(m3.line.map((l) => l.words).join('\n'), /did not start restricted \(it had 1 tool server\)/);
});

test('the runner itself never gives the tool to a review run, whatever its job says', async () => {
  const id = (await store().add({ title: 'Read the cart', project: 'shop', by: 'tester' })).item.id;
  await store().status(id, 'review');
  const from = logLines().length;
  const r = await runner.startAlone({ item: id, project: 'shop', by: 'mission', review: true, prompt: 'You review work another session did. Change nothing.', provider: 'key', restricted: ['Read', 'Glob', 'Grep'], tool: { url: `http://127.0.0.1:${srv.address().port}`, token: `hbt_${'a'.repeat(43)}` }, minutes: 1, mode: 'manual' });
  await r.done;
  const [l] = startsOf(from);
  asToday(l, 'a review run');
});

test('in the box: a session that ran the tests itself and passed still waits for the gate; "Accept by itself" follows the gate only', { skip: realSkip, timeout: 120_000 }, async () => {
  // The gate's run fails (the session's last file breaks the tests after its own run passed): no accept, a fix.
  fs.writeFileSync(process.env.FAKE_VERDICTS, 'PASS\nPASS\nPASS\n');
  const from = logLines().length;
  const a = await mission('Break the cart', { title: 'Break the cart', by: 'tester', note: 'Files: broken.flag\nRUNTESTS: {}' });
  const ma = await until(a.id, ['done', 'waits', 'failed', 'stopped'], 90_000);
  const ta = ma.tasks[0];
  // Its work run's own call came before it wrote broken.flag: it passed. (A fix run's call, after it, fails.)
  const own = logLines().slice(from).filter((l) => 'toolCall' in l);
  assert.match(own[0].answer, /^The tests passed/, 'its own first run passed');
  // The work session and the fix session each called the tool once; the card's count starts again each session, so it
  // shows the fix session's one run, not work + fix summed.
  assert.equal(own.length, 2, `the work and the fix session each called the tool once (${own.length})`);
  assert.equal(ta.selfTests.runs, 1, 'the count starts again each session, it is not summed across work and fix');
  assert.notEqual(ta.state, 'done', 'not accepted by itself');
  assert.equal(ta.gate.ok, false, ta.gate.words.join('; '));
  assert.match(ta.gate.words.join('; '), /the tests did not pass/);
  // No box when the gate runs, after the session's own run passed: the tests are his, nothing is accepted by itself.
  const b = await mission('Test the price', { title: 'Test the price', by: 'tester', note: 'Files: price.test.js\nRUNTESTS: {}' });
  const off = setInterval(() => {
    const m = readMission(place(), b.id);
    if (m && m.tasks[0].selfTests) box.off = true;
  }, 20);
  const mb = await until(b.id, ['done', 'waits', 'failed', 'stopped'], 90_000);
  clearInterval(off);
  const tb = mb.tasks[0];
  assert.equal(tb.selfTests.last, 'passed');
  assert.equal(tb.gate.testsNotRun, true, tb.gate.words.join('; '));
  assert.equal(tb.state, 'review', 'it waits for him');
  box.off = false;
  // The gate's own run in the box passes: accepted by itself, as before.
  const c = await mission('Test the tax', { title: 'Test the tax', by: 'tester', note: 'Files: tax.test.js\nRUNTESTS: {}' });
  const mc = await until(c.id, ['done', 'waits', 'failed', 'stopped'], 90_000);
  assert.equal(mc.tasks[0].gate.boxed, true);
  assert.equal(mc.tasks[0].state, 'done', mc.tasks[0].why || '');
});
