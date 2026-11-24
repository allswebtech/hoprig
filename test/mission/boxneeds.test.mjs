// A project's needs in the REAL box, through the real gate: a throw-away workspace (test/workspace/needsfix.mjs) whose
// project `shop` needs `kits/parts` and `blog`. `blog` holds nothing a session of shop is denied to read, so the box
// gets it; `kits/parts` holds a private folder and a file its own rules deny, so the box does not get it at all (the
// box has no deny rules: it gets whole folders). Every "secret" is a made-up file of this test's own home.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { needsWorld } from '../workspace/needsfix.mjs';

const w = needsWorld('boxneeds', { shopNeeds: ['kits/parts', 'blog'] });
process.env.HOPRIG_WORKSPACE_DIR = w.ws;
test.after(() => w.cleanup());
const { gate } = await import('../../src/mission/gate.mjs');
const { box } = await import('../../src/mission/seam.mjs');
const { boxCheck } = await import('../../src/box/box.mjs');
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

test('in the real box: a need folder with nothing denied is read; one with denied files is not given at all', { skip, timeout: 60_000 }, async () => {
  const top = w.shop;
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  git(top, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(top, '.gitignore'), 'node_modules\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'base');
  const base = git(top, 'rev-parse', 'HEAD').trim();
  const tree = path.join(w.root, 'trees', 'shop');
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git(top, 'worktree', 'add', '-q', '-b', 'work/needs', tree, 'HEAD');
  const files = {
    blog: path.join(w.projects, 'blog', 'README.md'),
    parts: path.join(w.parts, 'README.md'),
    hidden: path.join(w.parts, 'hidden', 'x.txt'), // denied by the need's own .claude rules
    private: path.join(w.parts, 'ai-ignore-dir', 'secret.txt'), // a private folder
  };
  fs.writeFileSync(path.join(tree, 'check.cjs'), `const fs = require('fs');\nconst f = ${JSON.stringify(files)};\nconst seen = {};\nfor (const [k, p] of Object.entries(f)) { try { seen[k] = fs.readFileSync(p, 'utf8').trim(); } catch (e) { seen[k] = e.code; } }\nconsole.log(JSON.stringify(seen));\nprocess.exit(seen.blog === 'blog' && seen.parts === 'ENOENT' && seen.hidden === 'ENOENT' && seen.private === 'ENOENT' ? 0 : 9);\n`);
  git(tree, 'add', '-A');
  git(tree, 'commit', '-qm', 'the task');
  const g = await gate({ check: 'tests', top: fs.realpathSync(top), tree: fs.realpathSync(tree), base, branch: 'work/needs', brief: 'Files: check.cjs', test: [process.execPath, 'check.cjs'], box: box() });
  const said = g.words.join('; ');
  assert.equal(g.testsNotRun, undefined, said);
  assert.equal(g.ok, true, `${said}\n${g.printed}`);
  assert.match(said, /the tests passed/);
  assert.match(said, /left out of the box, as its session may not read all of it: kits\/parts: it holds a private folder/);
  assert.match(g.printed, /"blog":"blog"/, 'the need folder with nothing denied was read');
  assert.ok(!/blue-falcon|green-lynx|red-otter/.test(g.printed), `nothing of the denied folder reached what the tests printed: ${g.printed}`);
});
