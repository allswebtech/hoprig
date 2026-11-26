// The lowest Node.js Hoprig runs on (src/nodeguard.mjs): one plain sentence and exit code 1 on an older one, checked
// before any other module of the command runs; the installers and the package say the same number.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIN_NODE, MIN_NODE_MAJOR, MIN_NODE_TEXT, guard, tooOld } from '../../src/nodeguard.mjs';
import { installLine } from '../../src/nodefloor.mjs';
import { KNOWN } from '../../src/field/learn.mjs';
import { fakeBin, scratch } from './helpers.mjs';
import { sealed, sealedPath } from '../seal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const s = scratch();
test.after(s.cleanup);
// Made-up versions on both sides of the floor (24.13.1: on every 24 before it a link to a folder cannot be removed).
const NEW_ENOUGH = ['24.13.1', 'v24.13.1', '24.14.0', '25.0.0', '26.13.0'];
const TOO_OLD = ['24.13.0', '24.0.0', 'v22.11.0', '22.23.5', '20.20.2', '18.19.1'];

test('an older Node.js: one plain sentence with the version needed, the one that runs and the line that updates it; exit code 1', () => {
  assert.equal(MIN_NODE, '24.13.1');
  assert.equal(MIN_NODE_TEXT, '24.13.1');
  assert.equal(MIN_NODE_MAJOR, 24);
  for (const v of NEW_ENOUGH) assert.equal(tooOld(v), null, v);
  for (const v of TOO_OLD) {
    const out = [];
    const codes = [];
    assert.equal(guard(v, { write: (s) => out.push(s), exit: (c) => codes.push(c) }), false, v);
    assert.deepEqual(codes, [1], v);
    const said = out.join('');
    assert.equal(said, `Hoprig needs Node.js 24.13.1 or newer, and this computer runs Node.js ${v.replace(/^v/, '')}; to update it, run this line, which installs the newest long-term release of Node.js and Hoprig with it:  ${installLine()}\n`);
    assert.equal(said.trim().split('\n').length, 1, 'one line, no stack trace');
  }
  // The line is the installer of the system the command runs on.
  assert.match(tooOld('22.11.0', 'linux'), /run this line, [^:]+: {2}curl -fsSL https:\/\/raw\.githubusercontent\.com\/allswebtech\/hoprig\/main\/install\.sh \| sh$/);
  assert.match(tooOld('22.11.0', 'darwin'), /\/install\.sh \| sh$/);
  assert.match(tooOld('22.11.0', 'win32'), /: {2}irm https:\/\/raw\.githubusercontent\.com\/allswebtech\/hoprig\/main\/install\.ps1 \| iex$/);
  assert.ok(tooOld('not a version'), 'what cannot be read is not taken for new enough');
  assert.ok(tooOld('24'), 'a version without its minor and patch is not taken for new enough');
  assert.match(KNOWN['node-too-old'].help, new RegExp(`^Install Node\\.js ${esc(MIN_NODE_TEXT)} or newer `), 'the help a field report gives says the same floor');
});

test('the command checks first: its first import is the guard, and on this Node.js it runs', () => {
  const bin = fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8');
  assert.match(bin.split('\n').find((l) => l.startsWith('import ')), /^import '\.\.\/src\/nodeguard\.mjs';/);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'hoprig.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The guard as the command would meet an older Node.js: loaded first, with the version handed in.
  const old = spawnSync(process.execPath, ['--input-type=module', '-e', `import { guard } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'nodeguard.mjs')).href)}; guard('22.11.0'); console.log('went on');`], { encoding: 'utf8' });
  assert.equal(old.status, 1);
  assert.equal(old.stdout, '', 'nothing after the check ran');
  assert.match(old.stderr, /^Hoprig needs Node\.js 24\.13\.1 or newer, and this computer runs Node\.js 22\.11\.0; to update it, run this line/);
});

// The pages cannot import src/nodefloor.mjs (the dashboard serves only web/): the words there are held here.
test('the Computers pages say the same lowest Node.js for a computer Hoprig is installed on', () => {
  for (const file of ['computers.js', 'sshkey.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    const said = [...text.matchAll(/Node\.js (\d+(?:\.\d+)*) or newer/g)].map((m) => m[1]);
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
  assert.match(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'), new RegExp(`\\n  MIN_NODE=${esc(MIN_NODE_TEXT)} `));
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(ps, new RegExp(`\\n\\$MinNode = '${esc(MIN_NODE_TEXT)}' `));
  // PowerShell cannot run here: its check compares the whole version, never the major alone.
  assert.match(ps, /\(\$v -ge \[version\]\$MinNode\)/);
  assert.doesNotMatch(ps, /split\('\.'\)\[0\]/, 'no check of the major alone is left');
  // Every workflow that runs the tests or the packed package runs it on the floor's major first, and on no older one.
  for (const wf of ['test.yml', 'windows.yml', 'pack-smoke.yml']) {
    const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8');
    const lists = [...text.matchAll(/node: \[([\d, ]+)\]/g)].map((m) => m[1].split(/,\s*/).map(Number));
    assert.ok(lists.length > 0, wf);
    for (const l of lists) assert.equal(l[0], MIN_NODE_MAJOR, wf);
  }
  for (const wf of ['release.yml', 'site.yml']) {
    const named = [...fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8').matchAll(/node-version: (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(named.length > 0 && named.every((n) => n >= MIN_NODE_MAJOR), `${wf}: ${named}`);
  }
});

test('install.sh: its check of the node on PATH takes minor and patch into account, run for real with made-up versions', { skip: process.platform === 'win32' && 'install.sh is for macOS and Linux' }, () => {
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
