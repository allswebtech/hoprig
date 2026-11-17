// The lowest Node.js Hoprig runs on (src/nodeguard.mjs): one plain sentence and exit code 1 on an older one, checked
// before any other module of the command runs; the installers and the package say the same number.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_MAJOR, guard, tooOld } from '../../src/nodeguard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('an older Node.js: a plain sentence and exit code 1; 22 and newer pass', () => {
  assert.equal(MIN_NODE_MAJOR, 22);
  for (const v of ['22.0.0', 'v22.11.0', '24.1.0', '26.13.0']) assert.equal(tooOld(v), null, v);
  for (const v of ['20.20.2', 'v20.11.1', '18.19.1', '21.7.3']) {
    const out = [];
    const codes = [];
    assert.equal(guard(v, { write: (s) => out.push(s), exit: (c) => codes.push(c) }), false, v);
    assert.deepEqual(codes, [1], v);
    assert.equal(out.join(''), `Hoprig needs Node.js 22 or newer; this is Node.js ${v.replace(/^v/, '')}. Install Node.js 22 or newer (https://nodejs.org), then run hoprig again.\n`);
  }
  assert.ok(tooOld('not a version'), 'what cannot be read is not taken for new enough');
});

test('the command checks first: its first import is the guard, and on this Node.js it runs', () => {
  const bin = fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8');
  assert.match(bin.split('\n').find((l) => l.startsWith('import ')), /^import '\.\.\/src\/nodeguard\.mjs';/);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'hoprig.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The guard as the command would meet an older Node.js: loaded first, with the version handed in.
  const old = spawnSync(process.execPath, ['--input-type=module', '-e', `import { guard } from ${JSON.stringify(path.join(ROOT, 'src', 'nodeguard.mjs'))}; guard('20.20.2'); console.log('went on');`], { encoding: 'utf8' });
  assert.equal(old.status, 1);
  assert.equal(old.stdout, '', 'nothing after the check ran');
  assert.match(old.stderr, /^Hoprig needs Node\.js 22 or newer; this is Node\.js 20\.20\.2\./);
});

test('the package, the installers and the workflows name the same lowest Node.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, `>=${MIN_NODE_MAJOR}`);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].engines.node, `>=${MIN_NODE_MAJOR}`);
  assert.match(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'), new RegExp(`\\n  MIN_NODE=${MIN_NODE_MAJOR} `));
  assert.match(fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8'), new RegExp(`\\n\\$MinNode = ${MIN_NODE_MAJOR} `));
  for (const wf of ['test.yml', 'windows.yml']) {
    const m = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8').match(/node: \[(\d+)/);
    assert.equal(Number(m[1]), MIN_NODE_MAJOR, wf);
  }
});
