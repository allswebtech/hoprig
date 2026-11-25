// What a role's session may run in the box besides the tests (src/mission/boxtool.mjs, boxrun.mjs): the project's build
// (the owner's command) and a named script of the project, each a closed choice of the role's own list, each read by
// the wall first, all under one set of limits. The box is a stand-in that records what it was asked; the wall is the
// real one; the line it holds here is the project's own deploy script.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { missionHome } from './helpers.mjs';

const t = missionHome('mission-boxruns');
test.after(() => t.cleanup());
const { treeFor } = await import('../../src/work/alonegit.mjs');
const { aloneArgs, TOOL_SERVER } = await import('../../src/work/alone.mjs');
const { boxTools, toolDoor, RUNS_MAX } = await import('../../src/mission/boxtool.mjs');
const { SCRIPT_RE, lineOf } = await import('../../src/mission/boxrun.mjs');

const shop = path.join(t.projects, 'shop');
const pkg = { name: 'shop', scripts: { lint: 'node lint.cjs', deploy: 'node ship.cjs', 'check:types': 'node types.cjs' } };
t.repo(shop, { 'README.md': '# shop\n', 'package.json': `${JSON.stringify(pkg, null, 2)}\n` });
t.arm();
const settings = { projects: { shop: { on: true, test: ['node', 'run.cjs'], build: ['node', 'build.cjs'] } } };
const ran = [];
const box = { check: async () => ({ ok: true }), run: async (argv, opts) => (ran.push({ argv, cwd: opts.cwd, write: opts.write }), { ok: true, code: 0, out: 'built\n', timedOut: false }) };
const tools = boxTools({ settings: () => settings, box: () => box, on: () => true });
let n = 0;
async function session(kinds) {
  n += 1;
  const branch = `work/run-${n}`;
  const { dir: tree } = await treeFor(shop, branch);
  const tok = tools.make({ mission: 'm-20261124-aaaaaa', task: `run-${n}`, project: 'shop', top: shop, branch, ...(kinds ? { kinds } : {}) });
  return { tree, tok, call: (given, kind) => tools.call(tok.rec, given, kind) };
}
const audit = () => fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'mission-box-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the build and a named script run in the box, in the task\'s worktree, as argument arrays the dashboard built', async () => {
  const s = await session(['tests', 'build', 'scripts']);
  ran.length = 0;
  const b = await s.call(undefined, 'build');
  assert.equal(b.isError, false, b.text);
  assert.match(b.text, /^The build ended well \(node build\.cjs, /);
  const l = await s.call('lint', 'scripts');
  assert.match(l.text, /^The script "lint" ended well \(npm run lint, /);
  const c = await s.call('check:types', 'scripts');
  assert.equal(c.isError, false, c.text);
  assert.deepEqual(ran.map((r) => r.argv), [['node', 'build.cjs'], ['npm', 'run', 'lint'], ['npm', 'run', 'check:types']]);
  assert.deepEqual(ran.map((r) => r.cwd), [s.tree, s.tree, s.tree]);
  assert.deepEqual(ran[0].write, [s.tree], 'the worktree is the one folder it may write');
  const mine = audit().filter((x) => x.task === s.tok.rec.task);
  assert.deepEqual(mine.map((x) => [x.end, x.what]), [['passed', 'build'], ['passed', 'script lint'], ['passed', 'script check:types']], 'one audit line per run, saying what ran');
  s.tok.drop();
});

test('a command outside the role\'s list is refused, and nothing runs', async () => {
  const s = await session(['tests']);
  ran.length = 0;
  for (const kind of ['build', 'scripts', 'deploy', 'shell']) {
    const r = await s.call(kind === 'scripts' ? 'lint' : undefined, kind);
    assert.equal(r.isError, true, kind);
    assert.match(r.text, /^Refused: this session may run only the project's tests\b.*nothing ran\.$/, kind);
    assert.equal(r.text.split('\n').length, 1);
  }
  const none = await session([]);
  assert.match((await none.call([], 'tests')).text, /^Refused: this session may run nothing in the box/);
  assert.deepEqual(ran, []);
  s.tok.drop();
  none.tok.drop();
});

test('a script name that breaks the pattern, or that the project does not have, is refused, and nothing runs', async () => {
  const s = await session(['scripts']);
  ran.length = 0;
  for (const bad of ['-x', '--help', 'a b', '../lint', 'lint;rm', 'lint && x', 'Lint', '', 'x'.repeat(51), 'lint\n', '$(id)', 'a/b']) {
    assert.equal(SCRIPT_RE.test(bad), false, bad);
    const r = await s.call(bad, 'scripts');
    assert.match(r.text, /^Refused: .*nothing ran\.$/, JSON.stringify(bad));
  }
  for (const bad of [null, 3, ['lint'], { name: 'lint' }]) assert.match((await s.call(bad, 'scripts')).text, /^Refused: name one script/, JSON.stringify(bad));
  assert.match((await s.call('build', 'scripts')).text, /^Refused: the project has no script "build"/);
  assert.match((await s.call('constructor', 'scripts')).text, /^Refused: the project has no script "constructor"/, 'only its own names, never one of an object\'s');
  assert.deepEqual(ran, []);
  s.tok.drop();
});

test('with no build command set, the build is refused in one line', async () => {
  const s = await session(['build']);
  const was = settings.projects.shop.build;
  settings.projects.shop.build = null;
  ran.length = 0;
  const r = await s.call(undefined, 'build');
  settings.projects.shop.build = was;
  assert.match(r.text, /^This project has no build command: the owner sets one on Work → Team\. Nothing ran\.$/);
  assert.deepEqual(ran, []);
  s.tok.drop();
});

test('every command is read by the wall first: a held one is not run, and the tool says why in one line', async () => {
  const s = await session(['tests', 'build', 'scripts']);
  ran.length = 0;
  const deploy = await s.call('deploy', 'scripts');
  assert.match(deploy.text, /^Not run: Hoprig's wall holds "npm run deploy" \(A deploy\): it stays the owner's\. Nothing ran\.$/);
  assert.equal(deploy.isError, true);
  assert.deepEqual(ran, [], 'nothing held was run');
  // Nothing held: the same session's other script runs.
  assert.equal((await s.call('lint', 'scripts')).isError, false);
  assert.equal(ran.length, 1);
  // The line the wall reads is the whole argument array, each word quoted where it needs it.
  assert.equal(lineOf(['npm', 'run', 'lint']), 'npm run lint');
  assert.equal(lineOf(['node', 'a b.cjs', "it's"]), "node 'a b.cjs' 'it'\\''s'");
  s.tok.drop();
});

test('the limits are shared across kinds: runs and minutes per session, and one run of a worktree at a time', async () => {
  const s = await session(['tests', 'build', 'scripts']);
  ran.length = 0;
  s.tok.rec.runs = RUNS_MAX - 1;
  assert.equal((await s.call(undefined, 'build')).isError, false, 'the last run of the session');
  const tests = await s.call([], 'tests');
  assert.match(tests.text, /^This session ran 12 runs in the box \(tests, build and scripts together\), its limit/);
  const script = await s.call('lint', 'scripts');
  assert.match(script.text, /^This session ran 12 runs in the box \(tests, build and scripts together\), its limit: go on without the tool\. Nothing ran\.$/);
  s.tok.rec.runs = 0;
  s.tok.rec.running = true;
  assert.match((await s.call(undefined, 'build')).text, /^A run of this session is under way/);
  s.tok.rec.running = false;
  assert.equal(ran.length, 1, 'only the one run below the limit ran');
  s.tok.drop();
});

test('the tool server offers the role\'s closed list and nothing else; the start names those tools only', async () => {
  const list = async (kinds) => {
    const child = spawn(process.execPath, [TOOL_SERVER], { env: { ...process.env, HOPRIG_TOOL_URL: 'http://127.0.0.1:1', HOPRIG_TOOL_TOKEN: `hbt_${'a'.repeat(43)}`, ...(kinds ? { HOPRIG_TOOL_KINDS: kinds } : {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    await new Promise((r) => child.once('close', r));
    return JSON.parse(out.split('\n')[0]).result.tools.map((x) => x.name);
  };
  assert.deepEqual(await list(null), ['run_tests'], 'as before: the tests alone');
  assert.deepEqual(await list('tests,build,scripts'), ['run_tests', 'run_build', 'run_script']);
  assert.deepEqual(await list('build'), ['run_build']);
  assert.deepEqual(await list('build,shell,sudo'), ['run_build'], 'a name outside the closed set offers nothing');
  const tool = { url: 'http://127.0.0.1:1', token: `hbt_${'a'.repeat(43)}` };
  const files = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
  const args = aloneArgs({ restricted: files, tool: { ...tool, kinds: ['tests', 'build', 'scripts'] } });
  const at = (f) => args[args.indexOf(f) + 1];
  assert.deepEqual(at('--allowedTools').split(','), [...files, 'mcp__hoprig__run_tests', 'mcp__hoprig__run_build', 'mcp__hoprig__run_script']);
  assert.equal(at('--tools'), files.join(','), 'the coding tool\'s own tools: the file tools only, no shell');
  assert.equal(JSON.parse(at('--mcp-config')).mcpServers.hoprig.env.HOPRIG_TOOL_KINDS, 'tests,build,scripts');
  assert.ok(args.includes('--restricted'));
  const old = aloneArgs({ restricted: files, tool });
  assert.equal(JSON.stringify(aloneArgs({ restricted: files, tool: { ...tool, kinds: ['tests'] } })), JSON.stringify(old), 'the tests alone start as before, byte for byte');
  assert.deepEqual(aloneArgs({ restricted: files, tool: { ...tool, kinds: ['build', 'Bash'] } }), aloneArgs({ restricted: files }), 'a list outside the closed set gives no tool at all');
});

test('end to end over HTTP: the session\'s tool server calls run_build and run_script on the dashboard\'s own routes, with its token', async () => {
  const door = toolDoor(tools);
  const srv = http.createServer(async (req, res) => {
    if (!(await door.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const s = await session(['tests', 'build', 'scripts']);
    ran.length = 0;
    /** The real tool server of a session, asked the calls given, one JSON-RPC line each. → answers by id */
    const ask = async (token, kinds, calls) => {
      const child = spawn(process.execPath, [TOOL_SERVER], { env: { ...process.env, HOPRIG_TOOL_URL: url, HOPRIG_TOOL_TOKEN: token, HOPRIG_TOOL_KINDS: kinds }, stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      const lines = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ...calls.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } }))];
      child.stdin.end(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
      await new Promise((r) => child.once('close', r));
      const byId = new Map(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
      return calls.map((_, i) => byId.get(i + 1));
    };
    const text = (m) => (m.result ? m.result.content.map((c) => c.text).join('') : `error ${m.error.message}`);
    const [build, lint, deploy, extra] = await ask(s.tok.token, 'tests,build,scripts', [['run_build', {}], ['run_script', { name: 'lint' }], ['run_script', { name: 'deploy' }], ['run_build', { command: 'x' }]]);
    assert.match(text(build), /^The build ended well \(node build\.cjs, /);
    assert.equal(build.result.isError, false);
    assert.match(text(lint), /^The script "lint" ended well \(npm run lint, /);
    assert.match(text(deploy), /^Not run: Hoprig's wall holds "npm run deploy"/, 'the wall reads it on the dashboard, through the route');
    assert.equal(deploy.result.isError, true);
    assert.match(text(extra), /^Refused: the tool takes nothing; nothing ran\.$/, 'the relay sends nothing the tool does not take');
    assert.deepEqual(ran.map((r) => r.argv), [['node', 'build.cjs'], ['npm', 'run', 'lint']], 'only what the dashboard built ran, in that order');
    assert.deepEqual(ran.map((r) => r.cwd), [s.tree, s.tree]);
    // A session of the tests alone that asks the routes itself, past its tool server: refused there, nothing runs.
    const only = await session(['tests']);
    ran.length = 0;
    const post = (route, body, token = only.tok.token) => fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const r1 = await post('/api/mission-tool/run-build', {});
    assert.equal(r1.status, 200);
    assert.match((await r1.json()).text, /^Refused: this session may run only the project's tests; nothing ran\.$/);
    const r2 = await post('/api/mission-tool/run-script', { name: 'lint' });
    assert.match((await r2.json()).text, /^Refused: this session may run only the project's tests; nothing ran\.$/);
    // Each route takes its one field only, and only a live session's token.
    assert.equal((await post('/api/mission-tool/run-build', { command: ['sh'] }, s.tok.token)).status, 400);
    assert.equal((await post('/api/mission-tool/run-script', { name: 'lint', args: ['-x'] }, s.tok.token)).status, 400);
    assert.equal((await post('/api/mission-tool/run-build', {}, `hbt_${'b'.repeat(43)}`)).status, 401);
    assert.equal((await post('/api/mission-tool/run-anything', {}, s.tok.token)).status, 404);
    // Through its own tool server too: the tests-alone session is offered no run_build, so the call is unknown.
    const [none] = await ask(only.tok.token, 'tests', [['run_build', {}]]);
    assert.equal(none.error.message, 'unknown tool');
    assert.deepEqual(ran, [], 'nothing ran for the session of the tests alone');
    s.tok.drop();
    only.tok.drop();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
