// An update never leaves Hoprig half updated: the running version is kept aside first, and a step that fails puts it
// back. Nothing here runs npm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const { selfUpdate } = await import('../../src/setup/selfupdate.mjs');
const { readUpdate } = await import('../../src/keeper/keep.mjs');

/** An npm install of a made-up Hoprig at `version`, as npm lays it out. */
function npmRoot(name, version) {
  const root = path.join(s.tmp, name, 'lib', 'node_modules', 'hoprig');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, 'src', 'main.mjs'), `// ${version}\n`);
  return root;
}
const out = () => {
  const lines = [];
  return { lines, write: (t) => lines.push(t) };
};

test('an update whose install step fails halfway leaves the old version in place and says so', async () => {
  const root = npmRoot('halfway', '0.3.5');
  const o = out();
  const run = async () => {
    // The install replaced half the files and then failed.
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.6' }));
    return { ok: false, code: 1 };
  };
  const code = await selfUpdate([], { ...o, run, root, lookup: async () => ({ version: '99.0.0' }) });
  assert.equal(code, 1);
  assert.match(o.lines.join(''), new RegExp(`The update did not work\\. Version ${appVersionOfFixture().replace(/\./g, '\\.')} is back\\.`));
  assert.equal(fs.readFileSync(path.join(root, 'src', 'main.mjs'), 'utf8'), '// 0.3.5\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.3.5');
  assert.equal(readUpdate().rolledBack, true);
});

test('an update that works keeps the old version until the new one has passed its start check', async () => {
  const root = npmRoot('works', '0.3.5');
  const o = out();
  const run = async () => (fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.6' })), { ok: true, code: 0 });
  const code = await selfUpdate([], { ...o, run, root, lookup: async () => ({ version: '99.0.0' }) });
  assert.equal(code, 0);
  const u = readUpdate();
  assert.equal(u.from, appVersionOfFixture(), 'the record names the version it came from');
  assert.equal(u.to, '99.0.0');
  assert.equal(u.verified, false);
  assert.ok(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'keeper', 'previous', 'tree', 'src', 'main.mjs')), 'the old version is kept');
});

test('a dry run keeps nothing aside', async () => {
  const root = npmRoot('dry', '0.3.5');
  fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'keeper'), { recursive: true, force: true });
  const o = out();
  assert.equal(await selfUpdate(['--dry-run'], { ...o, run: async () => assert.fail('nothing runs'), root, lookup: async () => ({ version: '99.0.0' }) }), 0);
  assert.equal(readUpdate(), null);
});

// What the running process calls its own version (the checks module reads the product's package file).
function appVersionOfFixture() {
  return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}
