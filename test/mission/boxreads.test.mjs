// What the wall reads before the box runs a package runner's script (src/mission/boxrun.mjs readsOf): npm runs the text
// of the script in the task's branch's package.json, and its pre and post scripts, not the line it was given. The
// session may have written those, so the wall reads them all, on every path (the tests, the build, a named script);
// what Hoprig cannot read with certainty is held. The box is a stand-in that records what it was asked; the wall is
// the real one; the line it holds here is the project's own deploy script, called from another script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { missionHome } from './helpers.mjs';

const t = missionHome('mission-boxreads');
test.after(() => t.cleanup());
const { treeFor } = await import('../../src/work/alonegit.mjs');
const { boxTools } = await import('../../src/mission/boxtool.mjs');

const shop = path.join(t.projects, 'shop');
const scripts = { test: 'node t.cjs', build: 'node b.cjs', lint: 'node lint.cjs', deploy: 'node ship.cjs' };
const json = (s) => `${JSON.stringify({ name: 'shop', scripts: s }, null, 2)}\n`;
t.repo(shop, { 'README.md': '# shop\n', 'package.json': json(scripts) });
t.arm();
const settings = { projects: { shop: { on: true, test: ['npm', 'test'], build: ['npm', 'run', 'build'] } } };
const ran = [];
const box = { check: async () => ({ ok: true }), run: async (argv) => (ran.push(argv), { ok: true, code: 0, out: 'ok\n', timedOut: false }) };
const tools = boxTools({ settings: () => settings, box: () => box, on: () => true });
let n = 0;
/** A session whose branch's package.json is `pkg` as the session left it (a string as it is, or the scripts). */
async function session(pkg) {
  n += 1;
  const branch = `work/reads-${n}`;
  const { dir: tree } = await treeFor(shop, branch);
  if (pkg === null) fs.rmSync(path.join(tree, 'package.json'));
  else if (pkg !== undefined) fs.writeFileSync(path.join(tree, 'package.json'), typeof pkg === 'string' ? pkg : json(pkg));
  const tok = tools.make({ mission: 'm-20261124-bbbbbb', task: `reads-${n}`, project: 'shop', top: shop, branch, kinds: ['tests', 'build', 'scripts'] });
  return { tok, call: (given, kind) => tools.call(tok.rec, given, kind) };
}
const HELD = /^Not run: Hoprig's wall holds "npm run deploy" \(A deploy\): it stays the owner's\. Nothing ran\.$/;

test('the tests: npm test runs as before, but a test or posttest script the session wrote to deploy is held, and nothing runs', async () => {
  const ok = await session();
  ran.length = 0;
  assert.equal((await ok.call([], 'tests')).isError, false, 'the branch\'s own test script is read and runs');
  assert.deepEqual(ran, [['npm', 'test']]);
  ok.tok.drop();
  for (const own of [{ ...scripts, test: 'node t.cjs && npm run deploy' }, { ...scripts, posttest: 'npm run deploy' }, { ...scripts, pretest: 'npm run deploy' }]) {
    const s = await session(own);
    ran.length = 0;
    const r = await s.call([], 'tests');
    assert.match(r.text, HELD, JSON.stringify(own));
    assert.equal(r.isError, true);
    assert.deepEqual(ran, [], 'nothing held was run');
    s.tok.drop();
  }
});

test('the build: npm run build with a prebuild or postbuild script that deploys is held, and nothing runs', async () => {
  for (const own of [{ ...scripts, prebuild: 'npm run deploy' }, { ...scripts, postbuild: 'npm run deploy' }, { ...scripts, build: 'npm run deploy' }]) {
    const s = await session(own);
    ran.length = 0;
    const r = await s.call(undefined, 'build');
    assert.match(r.text, HELD, JSON.stringify(own));
    assert.deepEqual(ran, []);
    s.tok.drop();
  }
  const ok = await session({ ...scripts, prebuild: 'node gen.cjs' });
  ran.length = 0;
  assert.equal((await ok.call(undefined, 'build')).isError, false, 'a prebuild the wall does not hold runs');
  assert.deepEqual(ran, [['npm', 'run', 'build']]);
  ok.tok.drop();
});

test('a named script: its pre and post scripts are read too, and one that deploys is held', async () => {
  for (const own of [{ ...scripts, prelint: 'npm run deploy' }, { ...scripts, postlint: 'npm run deploy' }]) {
    const s = await session(own);
    ran.length = 0;
    const r = await s.call('lint', 'scripts');
    assert.match(r.text, HELD, JSON.stringify(own));
    assert.deepEqual(ran, []);
    s.tok.drop();
  }
});

test('what Hoprig cannot read with certainty is held in one line: no package.json, one that does not parse, an option, a variable, another form', async () => {
  const cannot = /^Not run: Hoprig cannot read what "[^"]*" runs \([^)]+\), so its wall holds it: it stays the owner's\. Nothing ran\.$/;
  const cases = [
    [null, ['npm', 'test']],
    ['{ "scripts": ', ['npm', 'test']],
    ['{ "scripts": ["test"] }\n', ['npm', 'test']],
    [undefined, ['npm', '--prefix', 'other', 'test']],
    [undefined, ['npm', 'run', '$NAME']],
    [undefined, ['npm', 'install']],
    [undefined, ['npm', 'run', 'missing']],
    [undefined, ['yarn', 'build']],
    [undefined, ['env', 'npm', 'test']],
    [{ ...scripts, test: 'cd sub && npm test' }, ['npm', 'test']],
  ];
  const was = settings.projects.shop.test;
  try {
    for (const [pkg, cmd] of cases) {
      settings.projects.shop.test = cmd;
      const s = await session(pkg);
      ran.length = 0;
      const r = await s.call([], 'tests');
      assert.match(r.text, cannot, `${JSON.stringify(pkg)} ${cmd.join(' ')}`);
      assert.equal(r.text.split('\n').length, 1);
      assert.deepEqual(ran, [], cmd.join(' '));
      s.tok.drop();
    }
  } finally {
    settings.projects.shop.test = was;
  }
});
