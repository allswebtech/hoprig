// The lowest Node.js Hoprig runs on (src/nodeguard.mjs): one plain sentence and exit code 1 on an older one, checked
// before any other module of the command runs; the installers and the package say the same number.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_NODE, MIN_NODE_MAJOR, MIN_NODE_TEXT, guard, tooOld } from '../../src/nodeguard.mjs';
import { KNOWN } from '../../src/field/learn.mjs';
import { fakeBin, scratch } from './helpers.mjs';
import { sealed, sealedPath } from '../seal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const s = scratch();
test.after(s.cleanup);
// Made-up versions on both sides of the floor (22.11.0, the first long-term-support release of Node 22).
const NEW_ENOUGH = ['22.11.0', 'v22.11.0', '22.12.1', '23.0.0', '24.1.0', '26.13.0'];
const TOO_OLD = ['22.0.0', '22.10.9', 'v22.5.1', '21.7.3', '20.20.2', '18.19.1'];

test('an older Node.js: a plain sentence and exit code 1; 22.11 and newer pass', () => {
  assert.equal(MIN_NODE, '22.11.0');
  assert.equal(MIN_NODE_TEXT, '22.11');
  assert.equal(MIN_NODE_MAJOR, 22);
  for (const v of NEW_ENOUGH) assert.equal(tooOld(v), null, v);
  for (const v of TOO_OLD) {
    const out = [];
    const codes = [];
    assert.equal(guard(v, { write: (s) => out.push(s), exit: (c) => codes.push(c) }), false, v);
    assert.deepEqual(codes, [1], v);
    assert.equal(out.join(''), `Hoprig needs Node.js 22.11 or newer; this is Node.js ${v.replace(/^v/, '')}. Install Node.js 22.11 or newer (https://nodejs.org), then run hoprig again.\n`);
  }
  assert.ok(tooOld('not a version'), 'what cannot be read is not taken for new enough');
  assert.ok(tooOld('22'), 'a version without its minor and patch is not taken for new enough');
  assert.match(KNOWN['node-too-old'].help, /^Install Node\.js 22\.11 or newer /, 'the help a field report gives says the same floor');
});

test('the command checks first: its first import is the guard, and on this Node.js it runs', () => {
  const bin = fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8');
  assert.match(bin.split('\n').find((l) => l.startsWith('import ')), /^import '\.\.\/src\/nodeguard\.mjs';/);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'hoprig.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The guard as the command would meet an older Node.js: loaded first, with the version handed in.
  const old = spawnSync(process.execPath, ['--input-type=module', '-e', `import { guard } from ${JSON.stringify(path.join(ROOT, 'src', 'nodeguard.mjs'))}; guard('22.10.9'); console.log('went on');`], { encoding: 'utf8' });
  assert.equal(old.status, 1);
  assert.equal(old.stdout, '', 'nothing after the check ran');
  assert.match(old.stderr, /^Hoprig needs Node\.js 22\.11 or newer; this is Node\.js 22\.10\.9\./);
});

// The pages cannot import src/nodefloor.mjs (the dashboard serves only web/): the words there are held here.
test('the Computers pages say the same lowest Node.js for a computer Hoprig is installed on', () => {
  for (const file of ['computers.js', 'sshkey.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    const said = [...text.matchAll(/Node\.js (\d+(?:\.\d+)?) or newer/g)].map((m) => m[1]);
    assert.ok(said.length > 0, `web/${file} names the lowest Node.js`);
    assert.deepEqual([...new Set(said)], [MIN_NODE_TEXT], `web/${file}`);
  }
});

test('the package, the installers and the workflows name the same lowest Node.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, `>=${MIN_NODE_TEXT}`);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].engines.node, `>=${MIN_NODE_TEXT}`);
  const skill = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'hoprig-skill', 'package.json'), 'utf8'));
  assert.equal(skill.engines.node, `>=${MIN_NODE_TEXT}`);
  assert.match(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'), new RegExp(`\\n  MIN_NODE=${MIN_NODE_TEXT.replace('.', '\\.')} `));
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(ps, new RegExp(`\\n\\$MinNode = '${MIN_NODE_TEXT.replace('.', '\\.')}' `));
  // PowerShell cannot run here: its check compares the whole version, never the major alone.
  assert.match(ps, /\(\$v -ge \[version\]\$MinNode\)/);
  assert.doesNotMatch(ps, /split\('\.'\)\[0\]/, 'no check of the major alone is left');
  for (const wf of ['test.yml', 'windows.yml']) {
    const m = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8').match(/node: \[(\d+)/);
    assert.equal(Number(m[1]), MIN_NODE_MAJOR, wf);
  }
});

test('install.sh: its check of the node on PATH takes the minor into account, run for real with made-up versions', { skip: process.platform === 'win32' && 'install.sh is for macOS and Linux' }, () => {
  // The installer's own function, taken from its text and run in sh with a node that reports a made-up version
  // (this Node, with test/fixtures/runner/node-version.mjs loaded first).
  const text = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const floor = /\n  MIN_NODE=(\S+) /.exec(text)[1];
  const fn = /\n  (node_ok\(\) \{\n[\s\S]*?\n  \})\n/.exec(text)[1];
  const fixture = path.join(ROOT, 'test', 'fixtures', 'runner', 'node-version.mjs');
  const bin = fakeBin(path.join(s.tmp, 'node-bin'), { node: `exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(fixture)} "$@"` });
  const ok = (v) => spawnSync('sh', ['-c', `MIN_NODE=${floor}\n${fn}\nnode_ok`], { env: sealed({ PATH: sealedPath(`${bin}:/usr/bin:/bin`), HOME: s.env.HOME, SEAL_FAKE_NODE: v }) }).status === 0;
  for (const v of NEW_ENOUGH.filter((x) => !x.startsWith('v'))) assert.equal(ok(v), true, v);
  for (const v of TOO_OLD.filter((x) => !x.startsWith('v'))) assert.equal(ok(v), false, v);
});
