// What a role's session starts with, by its role file's `runs` and the owner's switches (src/mission/engine.mjs,
// src/work/alone.mjs): the real engine and runner with the stand-in coding tool (fixtures/fake-tool.mjs), which starts
// the tool servers its arguments name and says its tools on its first line, as the real one does. A developer and ops
// get the box's three tools where the project has a test command, a build command and scripts; a writer gets none; the
// researcher reads the web only with the owner's switch on, and then still has no shell and no tool server. The box is
// a stand-in that says yes: no session here calls a tool, only its start is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome } from './helpers.mjs';

const t = missionHome('mission-boxkinds');
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

const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
const BOX = ['mcp__hoprig__run_tests', 'mcp__hoprig__run_build', 'mcp__hoprig__run_script'];
const shop = path.join(t.projects, 'shop');
const pkg = { name: 'shop', scripts: { lint: 'node lint.cjs' } };
t.repo(shop, { 'README.md': '# shop\n', 'check.cjs': "console.log('checked');\n", 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const cfg = {
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, test: [process.execPath, 'check.cjs'], build: [process.execPath, 'check.cjs'] } }, capUsd: 5, providers: ['key'], atOnce: 1 },
};
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const toolLog = path.join(t.root, 'tool.log');
process.env.FAKE_TOOL_LOG = toolLog;
process.env.FAKE_VERDICTS = path.join(t.root, 'verdicts');
const logLines = () => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const theBox = { check: async () => ({ ok: true }), run: async () => ({ ok: true, code: 0, out: 'checked\n', timedOut: false }) };
const tools = boxTools({ settings: () => missionSettings(cfg), box: () => theBox, on: (p) => worksOn(missionSettings(cfg), p) });
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
const engine = missionEngine({ log: (x) => logged.push(x), config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 1, machine: () => null,
  box: () => theBox, tools, address: () => srv.address(), reopen: (id) => store().status(id, 'open'), accept: (id) => store().status(id, 'done'), tickMs: 3_600_000 });
test.after(async () => {
  await engine.close();
  await runner.close();
});
test.afterEach(() => {
  assert.deepEqual(logged.splice(0), [], 'the engine logged no failure');
});

async function until(id, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await engine.tick();
    const m = readMission(place(), id);
    if (m && ['done', 'waits', 'failed', 'stopped'].includes(m.state) && !m.tasks.some((x) => x.state === 'running' || x.state === 'queued')) return m;
    if (Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}
/** A mission of one task of `by`, run to its end. → { m, work } (its first work run's start, as the coding tool got it) */
async function runOf(by, title, note) {
  const from = logLines().length;
  const g = await engine.give({ goal: title, project: 'shop' });
  const id = (await store().add({ title, project: 'shop', by, note })).item.id;
  await engine.accepts.after(g.proposal.id, { plan: 'p', tasks: [id] });
  const m = await until(g.mission.id);
  const work = logLines().slice(from).filter((l) => Array.isArray(l.args) && !l.review)[0];
  return { m, work };
}
const arg = (args, flag) => args[args.indexOf(flag) + 1];
const lineWords = (m) => m.line.map((l) => l.words).join('\n');

for (const by of ['developer', 'ops']) {
  test(`a ${by}'s work run gets the box's three tools of its list, named in its own start, and still no shell`, async () => {
    const { m, work } = await runOf(by, `Build the cart (${by})`, `Files: cart-${by}.js`);
    assert.ok(work, 'it started');
    assert.deepEqual(arg(work.args, '--tools').split(','), FILE_TOOLS, 'the coding tool\'s own tools: the file tools only');
    assert.deepEqual(arg(work.args, '--allowedTools').split(','), [...FILE_TOOLS, ...BOX]);
    const servers = JSON.parse(arg(work.args, '--mcp-config')).mcpServers;
    assert.deepEqual(Object.keys(servers), ['hoprig']);
    assert.deepEqual(servers.hoprig.args, [TOOL_SERVER]);
    assert.equal(servers.hoprig.env.HOPRIG_TOOL_KINDS, 'tests,build,scripts');
    assert.ok(work.args.includes('--restricted') && work.args.includes('--strict-mcp-config'));
    assert.equal(arg(work.args, '--allowedTools').split(',').includes('Bash'), false, 'Bash is never given');
    assert.ok(arg(work.args, '--disallowedTools').split(',').includes('Bash'), 'Bash stays denied by its role file');
    // The runner's first-line check took the session's three tools (the stand-in names them from the server's list).
    assert.doesNotMatch(lineWords(m), /did not start restricted/);
    assert.equal(tools.size(), 0, 'its token died with the session');
  });
}

test('a writer runs nothing: its start has no tool server and no token', async () => {
  const { work } = await runOf('writer', 'Write the about page', 'Files: about.md');
  assert.equal(arg(work.args, '--mcp-config'), '{"mcpServers":{}}');
  assert.equal(work.args.join(' ').includes('hbt_') || work.args.join(' ').includes('mcp__'), false);
  assert.ok(work.args.includes('--restricted'));
});

test('the researcher starts restricted with the file tools alone, the web tools denied', async () => {
  const { work } = await runOf('researcher', 'Find the shipping rules', 'Files: notes/shipping.md');
  assert.ok(work.args.includes('--restricted'));
  assert.deepEqual(arg(work.args, '--tools').split(','), FILE_TOOLS);
  for (const w of ['WebSearch', 'WebFetch']) assert.ok(arg(work.args, '--disallowedTools').split(',').includes(w), `${w} is denied`);
});
