// The check of a merged tree (src/ship/check.mjs): it runs only after the owner confirmed those commands for that
// project here (a task branch that changes them asks again), never while the computer is overloaded, through his
// confirmed limiter; its last lines are kept masked with the home folder as ~; a tree that failed once and passed once
// is shown as exactly that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip, write } from './helpers.mjs';

const t = tempShip('ship-check');
test.after(() => t.cleanup());
const { runCheck, readChecks, verdict, treeIdOf } = await import('../../src/ship/check.mjs');
const { allow, setLimiter } = await import('../../src/ship/allow.mjs');
const { readCheck } = await import('../../src/ship/project.mjs');
const shop = path.join(t.projects, 'shop');
const counter = path.join(t.root, 'runs.txt');
// Fails at its first run, passes after: a flaky test file once lost its results like this.
const flaky = `const fs = require('node:fs'); const f = ${JSON.stringify(counter)}; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); console.log('home is ' + require('node:os').homedir() + '/x'); console.log('API_TOKEN=abcd1234efgh5678ijkl'); process.exit(n === 0 ? 1 : 0);`;
t.repo(shop, { 'project.json': JSON.stringify({ check: [{ run: ['node', '-e', flaky], minutes: 1 }] }) });
const idle = () => ({ over: false, why: null });

test('not confirmed: refused, nothing runs', async () => {
  await assert.rejects(runCheck(shop, shop, { busy: idle }), (e) => e.details.code === 'not-confirmed');
  assert.equal(fs.existsSync(counter), false);
});

test('overloaded: it waits and says why', async () => {
  allow(shop, 'check', readCheck(shop).check);
  await assert.rejects(runCheck(shop, shop, { busy: () => ({ over: true, why: 'the computer is busy (load 9.0 on 2 CPUs)' }) }), (e) => e.details.code === 'overloaded' && /busy/.test(e.message));
  assert.equal(fs.existsSync(counter), false);
});

test('failed once, passed once: shown as both; the lines are masked', async () => {
  const one = await runCheck(shop, shop, { busy: idle });
  assert.equal(verdict(one).state, 'failed');
  const c = one.runs[0].commands[0];
  assert.equal(c.code, 1);
  assert.equal(c.ended, 'ended with code 1');
  assert.match(c.last, /home is ~\/x/);
  assert.equal(c.last.includes(t.home), false);
  assert.equal(c.last.includes('abcd1234efgh5678ijkl'), false);
  const two = await runCheck(shop, shop, { busy: idle });
  const v = verdict(two);
  assert.deepEqual([v.state, v.passed, v.failed], ['mixed', 1, 1]);
  const { tree } = await treeIdOf(shop);
  assert.equal(verdict(readChecks(tree)).state, 'mixed', 'kept per tree id');
  assert.equal(fs.statSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'checks', `${tree}.json`)).mode & 0o777, 0o600);
});

test('a branch that changed the check commands asks again', async () => {
  t.git(shop, 'checkout', '-q', '-b', 'work/sneaky');
  write(shop, { 'project.json': JSON.stringify({ check: [{ run: ['node', '-e', 'require("node:fs").writeFileSync("ran", "1")'], minutes: 1 }] }) });
  t.git(shop, 'commit', '-q', '-am', 'Change the check');
  await assert.rejects(runCheck(shop, shop, { busy: idle }), (e) => e.details.code === 'not-confirmed');
  assert.equal(fs.existsSync(path.join(shop, 'ran')), false);
  t.git(shop, 'checkout', '-q', 'main');
});

test('the confirmed limiter goes first; one changed by hand stops the check', async () => {
  write(t.root, { 'limit.sh': `#!/bin/sh\necho limited >> '${path.join(t.root, 'limited.txt')}'\nexec "$@"\n` });
  setLimiter([path.join(t.root, 'limit.sh')]);
  await runCheck(shop, shop, { busy: idle });
  assert.equal(fs.readFileSync(path.join(t.root, 'limited.txt'), 'utf8'), 'limited\n');
  const { loadConfig, saveConfig } = await import('../../src/config.mjs');
  const s = loadConfig().ship;
  saveConfig({ ship: { ...s, limiter: { ...s.limiter, run: ['node', '-e', 'process.exit(0)'] } } });
  await assert.rejects(runCheck(shop, shop, { busy: idle }), (e) => e.details.code === 'limiter-changed' && e.message === 'the words before each check command in Settings → Go live changed after you confirmed them: confirm them again there first');
  assert.deepEqual(t.trapped(), []);
});

test('the check runs on the committed files only: a change, an untracked or an ignored file in the folder is not used', async () => {
  // The check is kept for HEAD's tree: a broken commit must never pass on files a session left beside it.
  setLimiter(null); // the test before left a limiter changed by hand
  const cafe = path.join(t.projects, 'cafe');
  t.repo(cafe, { 'project.json': JSON.stringify({ check: [['node', 'test.mjs']] }), '.gitignore': 'local.mjs\n', 'test.mjs': "import fs from 'node:fs'; process.exit(fs.existsSync('local.mjs') || fs.existsSync('helper.mjs') ? 0 : 1);\n" });
  allow(cafe, 'check', readCheck(cafe).check);
  write(cafe, { 'local.mjs': 'export default 1;\n' }); // ignored by git: a build, an .env, a cache a session left
  let v = verdict(await runCheck(cafe, cafe, { busy: idle }));
  assert.deepEqual([v.state, v.passed, v.failed], ['failed', 0, 1], 'an ignored file decides nothing');
  fs.rmSync(path.join(cafe, 'local.mjs'));
  write(cafe, { 'helper.mjs': '\n', 'test.mjs': 'process.exit(0)\n' }); // untracked, and a committed file changed
  v = verdict(await runCheck(cafe, cafe, { busy: idle }));
  assert.deepEqual([v.state, v.passed, v.failed], ['failed', 0, 2], 'neither does a change or an untracked file');
  assert.equal(fs.readFileSync(path.join(cafe, 'test.mjs'), 'utf8'), 'process.exit(0)\n', 'the folder itself is left as it is');
  fs.rmSync(path.join(cafe, 'helper.mjs'));
  t.git(cafe, 'checkout', '--', 'test.mjs');
});

test('a check that writes files (a log, a committed file) is counted each time, and leaves nothing behind', async () => {
  const deli = path.join(t.projects, 'cake');
  const writes = "import fs from 'node:fs'; fs.writeFileSync('out.log', 'x'); fs.mkdirSync('coverage', { recursive: true }); fs.writeFileSync('coverage/a.json', '{}'); fs.writeFileSync('test.mjs', 'changed');\n";
  t.repo(deli, { 'project.json': JSON.stringify({ check: [['node', 'test.mjs']] }), 'test.mjs': writes });
  allow(deli, 'check', readCheck(deli).check);
  let rec;
  for (let i = 0; i < 2; i++) rec = await runCheck(deli, deli, { busy: idle });
  const v = verdict(rec);
  assert.deepEqual([v.state, v.passed, v.failed, v.notCounted], ['ready', 2, 0, null], 'not "not counted", never refused');
  assert.equal(fs.existsSync(path.join(deli, 'out.log')), false, 'it ran in a folder of its own');
  assert.equal(fs.readFileSync(path.join(deli, 'test.mjs'), 'utf8'), writes);
  assert.deepEqual(fs.readdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'checkruns')), [], 'its folder went');
  assert.equal(t.git(deli, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'and git forgot it');
});

test('a tree that failed once stays "passed and failed" after more passes than the runs kept in detail', async () => {
  const { RUNS_KEPT } = await import('../../src/ship/check.mjs');
  const deli = path.join(t.projects, 'deli');
  const count = path.join(t.root, 'deli-runs.txt');
  const once = `const fs = require('node:fs'); const f = ${JSON.stringify(count)}; const n = fs.existsSync(f) ? 1 : 0; fs.writeFileSync(f, '1'); process.exit(n ? 0 : 1);`;
  t.repo(deli, { 'project.json': JSON.stringify({ check: [['node', '-e', once]] }) });
  allow(deli, 'check', readCheck(deli).check);
  let rec;
  for (let i = 0; i <= RUNS_KEPT; i++) rec = await runCheck(deli, deli, { busy: idle });
  assert.equal(rec.runs.length, RUNS_KEPT, 'only the last runs are kept in detail');
  assert.equal(rec.runs.some((r) => r.ok === false), false, 'the failed run is no longer among them');
  const v = verdict(rec);
  assert.deepEqual([v.state, v.passed, v.failed], ['mixed', RUNS_KEPT, 1]);
  const { tree } = await treeIdOf(deli);
  assert.equal(verdict(readChecks(tree)).state, 'mixed', 'as kept');
});
