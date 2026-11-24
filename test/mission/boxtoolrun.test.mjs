// A mission session's one tool (src/mission/boxtool.mjs) in the REAL box: a throw-away project in this test's own
// temporary home with one made-up dependency, a real git worktree of a task's branch, and the owner's test command.
// What the session gives is checked on the dashboard; each refusal runs nothing; every limit answers in one line.
// Every "secret" is a made-up file here, every listener one this test opened. A computer without a box skips these.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { missionHome } from './helpers.mjs';

const t = missionHome('mission-boxtoolrun');
test.after(() => t.cleanup());
const { treeFor } = await import('../../src/work/alonegit.mjs');
const { box } = await import('../../src/mission/seam.mjs');
const { gate } = await import('../../src/mission/gate.mjs');
const { DEPS, recordedLinks } = await import('../../src/mission/boxed.mjs');
const { boxTools, RUNS_MAX, TOTAL_MS, PATHS_MAX } = await import('../../src/mission/boxtool.mjs');
const { boxCheck } = await import('../../src/box/box.mjs');
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

// The owner's test command: node run.cjs, which says the arguments it got, uses the dependency, and runs each test
// file it is given (or all under test/).
const RUN = `const fs = require('fs');
const path = require('path');
const add = require('tiny');
console.log('args:', JSON.stringify(process.argv.slice(2)));
console.log('tiny says', add(2, 3));
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync('test').map((f) => path.join('test', f));
let failed = 0;
for (const f of files) {
  const st = fs.statSync(f);
  for (const g of st.isDirectory() ? fs.readdirSync(f).map((x) => path.join(f, x)) : [f]) {
    try { require(path.resolve(g)); console.log('ok', g); } catch (e) { failed += 1; console.log('not ok', g, e.message); }
  }
}
process.exitCode = failed ? 1 : 0; // not exit(): a test's own connection still says how it ended
`;
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'run.cjs': RUN, 'test/sum.test.js': "if (require('tiny')(1, 1) !== 2) throw new Error('sum');\n", '.gitignore': 'node_modules\n' });
fs.mkdirSync(path.join(shop, DEPS, 'tiny'), { recursive: true });
fs.writeFileSync(path.join(shop, DEPS, 'tiny', 'package.json'), '{ "name": "tiny", "main": "index.js" }\n');
fs.writeFileSync(path.join(shop, DEPS, 'tiny', 'index.js'), 'module.exports = (a, b) => a + b;\n');
const base = t.git(shop, 'rev-parse', 'HEAD');
const SECRET = path.join(t.home, '.made-up-keys', 'key.txt');
fs.mkdirSync(path.dirname(SECRET), { recursive: true });
fs.writeFileSync(SECRET, 'made-up secret\n');

let test1 = [process.execPath, 'run.cjs'];
let on = true;
const ran = []; // what the box was asked to run, through a spy around the real box
const realBox = box();
const spy = { check: realBox.check, run: (argv, opts) => (ran.push(argv), realBox.run(argv, opts)) };
const counted = [];
const limited = [];
const tools = boxTools({ settings: () => ({ projects: { shop: { on, test: test1 } } }), box: () => spy, on: () => on, onRun: (rec, end) => counted.push(end), onLimit: (rec, which) => limited.push(which) });

let n = 0;
/** A task's real worktree with the session's files, and a token of its session. → { tree, tok, branch } */
async function task(files = {}) {
  n += 1;
  const branch = `work/tool-${n}`;
  const { dir: tree } = await treeFor(shop, branch);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tree, f)), { recursive: true });
    fs.writeFileSync(path.join(tree, f), c);
  }
  t.git(tree, 'add', '-A');
  if (Object.keys(files).length) t.git(tree, 'commit', '-q', '-m', 'The task');
  const tok = tools.make({ mission: 'm-20261120-aaaaaa', task: `tool-${n}`, project: 'shop', top: shop, branch });
  return { tree, tok, branch };
}
const call = (x, paths) => tools.call(x.tok.rec, paths);

test('in the real box: a session\'s call runs the owner\'s test command and gets its last lines, with the project\'s dependency', { skip, timeout: 60_000 }, async () => {
  const x = await task({ 'test/cart.test.js': "if (require('tiny')(2, 2) !== 4) throw new Error('cart');\n" });
  ran.length = 0;
  const all = await call(x);
  assert.equal(all.isError, false, all.text);
  assert.match(all.text, /^The tests passed \(node run\.cjs, /);
  assert.match(all.text, /args: \[\]\ntiny says 5\nok test\/cart\.test\.js\nok test\/sum\.test\.js/);
  const one = await call(x, ['test/cart.test.js']);
  assert.match(one.text, /args: \["test\/cart\.test\.js"\]\ntiny says 5\nok test\/cart\.test\.js$/);
  assert.match(one.text, /Run 2 of at most 12/);
  // The answer uses the brief's own words ("the tests are run again after you end"), never "gate" or "Tia", which
  // the session's brief never names.
  assert.match(one.text, /The tests are run again after you end; that run is the one that counts\./);
  assert.doesNotMatch(one.text, /\bgate\b|\bTia\b/);
  const folder = await call(x, ['test']);
  assert.match(folder.text, /ok test\/cart\.test\.js\nok test\/sum\.test\.js$/);
  assert.deepEqual(ran, [test1, [...test1, 'test/cart.test.js'], [...test1, 'test']]);
  assert.equal(all.text.includes(x.tree) || all.text.includes(t.root), false, 'no path of this computer comes back');
  assert.equal(fs.existsSync(path.join(x.tree, DEPS)), false, 'the link to the dependencies is taken away after each run');
  assert.equal(recordedLinks()[x.tree], undefined);
  assert.deepEqual(counted.splice(0), ['passed', 'passed', 'passed']);
  x.tok.drop();
});

test('in the real box: a failing test says so, with its last lines', { skip, timeout: 60_000 }, async () => {
  const x = await task({ 'test/broken.test.js': "throw new Error('the cart total is wrong');\n" });
  const r = await call(x, ['test/broken.test.js']);
  assert.equal(r.isError, true);
  assert.match(r.text, /^The tests failed: exit code 1 \(node run\.cjs test\/broken\.test\.js, /);
  assert.match(r.text, /not ok test\/broken\.test\.js the cart total is wrong/);
  x.tok.drop();
});

test('a path outside the worktree, a link that leads out, an option and a second command after a separator are refused, and nothing ran', { skip, timeout: 60_000 }, async () => {
  const x = await task({ 'test/a.test.js': '\n' });
  fs.symlinkSync(path.dirname(SECRET), path.join(x.tree, 'keys'));
  fs.symlinkSync(SECRET, path.join(x.tree, 'test', 'key.js'));
  fs.mkdirSync(path.join(x.tree, 'inner'));
  ran.length = 0;
  const cases = [
    [[SECRET], /give a path inside this folder/],
    [['../../home/.made-up-keys/key.txt'], /"\.\." is not taken/],
    [['test/../../x'], /"\.\." is not taken/],
    [['keys/key.txt'], /reached through a link/],
    [['test/key.js'], /reached through a link/],
    [['keys'], /reached through a link/],
    [['--require=./keys/key.txt'], /starts with "-"/],
    [['-e'], /starts with "-"/],
    [['test/a.test.js;', 'id'], /only letters, digits/],
    [['test/a.test.js', '&&', 'id'], /only letters, digits/],
    [['test/a.test.js|id'], /only letters, digits/],
    [['$(id)'], /only letters, digits/],
    [['test/a.test.js id'], /only letters, digits/],
    [['test/a.test.js\nid'], /control character/],
    [['test/missing.test.js'], /it is not there/],
    [['a'.repeat(401)], /longer than 400/],
    [Array.from({ length: PATHS_MAX + 1 }, () => 'test'), /at most 20 paths/],
    ['test', /a list of paths/],
    [[42], /a word of text/],
  ];
  for (const [paths, why] of cases) {
    const r = await call(x, paths);
    assert.equal(r.isError, true, JSON.stringify(paths));
    assert.match(r.text, why, JSON.stringify(paths));
    assert.equal(r.text.split('\n').length, 1, 'one line');
  }
  assert.deepEqual(ran, [], 'nothing ran');
  assert.equal(x.tok.rec.runs, 0, 'a refusal is not a run');
  x.tok.drop();
});

test('in the real box: a made-up secret in a made-up home cannot be read through the tool, and a listener outside cannot be reached', { skip, timeout: 60_000 }, async (tt) => {
  let reached = 0;
  const srv = net.createServer((s) => {
    reached += 1;
    s.end('hello');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  tt.after(() => srv.close());
  const port = srv.address().port;
  const x = await task({
    'test/secret.test.js': `const fs = require('fs');\nlet got;\ntry { got = fs.readFileSync(${JSON.stringify(SECRET)}, 'utf8'); } catch (e) { got = e.code; }\nconsole.log('home file:', got);\nif (got.includes('made-up secret')) throw new Error('READ');\n`,
    'test/net.test.js': `const s = require('net').connect(${port}, '127.0.0.1');\ns.on('connect', () => { console.log('REACHED'); process.exit(9); });\ns.on('error', (e) => console.log('net:', e.code));\n`,
  });
  const r = await call(x, ['test/secret.test.js', 'test/net.test.js']);
  assert.match(r.text, /home file: ENOENT/);
  assert.doesNotMatch(r.text, /made-up secret|REACHED/);
  assert.match(r.text, /net: (ECONNREFUSED|ENETUNREACH)/);
  assert.equal(reached, 0, 'nothing reached the listener');
  x.tok.drop();
});

test('past each limit the tool answers in one line and nothing runs', { skip, timeout: 60_000 }, async () => {
  const x = await task({ 'test/a.test.js': '\n' });
  ran.length = 0;
  limited.length = 0;
  x.tok.rec.runs = RUNS_MAX;
  const many = await call(x);
  assert.match(many.text, /^This session ran the tests 12 times, its limit: go on without the tool/);
  assert.equal(x.tok.rec.limit, 'runs', 'the run limit is noted on the record');
  await call(x); // a second refused call in the loop does not signal the limit again
  assert.deepEqual(limited, ['runs'], 'the limit is signalled once, not on every refused call');
  x.tok.rec.runs = 0;
  x.tok.rec.limit = undefined; // a fresh session to reach the other limit
  x.tok.rec.ms = TOTAL_MS;
  const long = await call(x);
  assert.match(long.text, /^This session's runs took 30 min in all, its limit/);
  assert.deepEqual(limited, ['runs', 'time'], 'the time limit is signalled too');
  x.tok.rec.ms = 0;
  x.tok.rec.limit = undefined;
  on = false;
  const off = await call(x);
  on = true;
  assert.match(off.text, /^Missions are off for this project now/);
  const was = test1;
  test1 = null;
  const none = await call(x);
  test1 = was;
  assert.match(none.text, /no test command any more/);
  for (const r of [many, long, off, none]) {
    assert.equal(r.isError, true);
    assert.equal(r.text.split('\n').length, 1, r.text);
  }
  assert.deepEqual(ran, [], 'nothing ran past a limit');
  x.tok.drop();
});

test('in the real box: a run under way is told to a second call; a session that ended while its run goes on gets no answer, and the gate waits for that run', { skip, timeout: 60_000 }, async () => {
  const slow = "const t = Date.now(); while (Date.now() - t < 1500) {}\nrequire('fs').appendFileSync('done.txt', 'x');\n";
  const x = await task({ 'test/slow.test.js': slow, '.gitignore': 'node_modules\ndone.txt\n' });
  ran.length = 0;
  const first = call(x, ['test/slow.test.js']);
  await new Promise((r) => setTimeout(r, 200));
  const second = await call(x, ['test/slow.test.js']);
  assert.match(second.text, /^A run of these tests is under way/);
  // The session ends: its token is dead at once, the answer is dropped, and the gate waits for the run to end.
  x.tok.drop();
  assert.equal(tools.find(x.tok.token), null, 'the token is dead at once');
  const g = gate({ check: 'tests', top: shop, tree: x.tree, base, branch: x.branch, brief: '', test: [process.execPath, 'run.cjs', 'test/slow.test.js'], box: box() });
  const r = await first;
  assert.equal(r.text, 'The session ended: this answer was dropped.');
  const gg = await g;
  assert.equal(gg.testsNotRun, undefined, gg.words.join('; '));
  assert.equal(gg.ok, true, gg.words.join('; '));
  assert.equal(fs.readFileSync(path.join(x.tree, 'done.txt'), 'utf8'), 'xx', 'the tool\'s run, then the gate\'s own');
  assert.equal(ran.length, 1, 'the second call ran nothing');
});

test('each run is one audit line; a loop of refusals does not flood it, they are one line on drop', { skip, timeout: 60_000 }, async () => {
  const x = await task({ 'test/a.test.js': "console.log('PRINTED-MARK');\n" });
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-box-runs.jsonl');
  const mineNow = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.task === `tool-${n}`);
  await call(x, ['test/a.test.js']); // one run
  for (let i = 0; i < 50; i += 1) await call(x, ['-x']); // 50 refused calls (an option is refused): none ran
  const during = mineNow();
  assert.deepEqual(during.map((l) => l.end), ['passed'], 'while the session lives, only the run is in the audit, not the refusals');
  for (const l of during) assert.deepEqual(Object.keys(l).sort(), ['at', 'end', 'mission', 'ms', 'runs', 'task']);
  x.tok.drop();
  const after = mineNow();
  assert.deepEqual(after.map((l) => l.end), ['passed', 'refused'], 'the refusals are one summary line on drop');
  assert.equal(after.find((l) => l.end === 'refused').refused, 50, 'the count of refusals');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRINTED-MARK|tiny says/, 'never what was printed');
});
