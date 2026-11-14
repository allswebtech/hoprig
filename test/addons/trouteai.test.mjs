// The TRouteAI add-on against a stand-in "trouteai" program: found, started in the background, seen as running,
// stopped; and the profile it proposes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-addon-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A free port, and a fake `trouteai` on PATH that listens on the port it is given.
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'trouteai'), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('TRouteAI 9.8.7'); process.exit(0); }
const i = process.argv.indexOf('--port');
require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[i + 1]), '127.0.0.1');
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { saveConfig } = await import('../../src/config.mjs');
saveConfig({ addons: { trouteai: { port } } });
const { listAddons, findAddon } = await import('../../src/addons/index.mjs');
const { binFile } = await import('../../src/paths.mjs');
const T = findAddon('trouteai');

test('status, start, stop', { skip: process.platform === 'win32' }, async () => {
  let s = await T.status();
  assert.deepEqual([s.installed, s.version, s.running, s.url], [true, '9.8.7', false, `http://localhost:${port}`]);
  const started = await T.start();
  assert.deepEqual([started.ok, started.already], [true, false]);
  assert.equal((await T.status()).running, true);
  assert.equal((await T.start()).already, true, 'starting again is harmless');
  assert.equal((await listAddons())[0].running, true);
  assert.equal((await T.stop()).ok, true);
  assert.equal((await T.status()).running, false);
  assert.equal((await T.stop()).already, true);
});

test('the proposed profile starts the gateway on demand and never holds a key', () => {
  const p = T.profile();
  assert.equal(p.env.ANTHROPIC_BASE_URL, `http://localhost:${port}`);
  assert.equal(p.tokenVar, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(Object.keys(p.env).length, 1);
  assert.ok(p.prerun.includes(binFile()) && p.prerun.endsWith(' addons start trouteai'));
});

test('command line: list, an unknown add-on, start printing nothing on stdout', { skip: process.platform === 'win32' }, () => {
  const run = (...a) => spawnSync(process.execPath, [binFile(), 'addons', ...a], { env: process.env, encoding: 'utf8' });
  assert.match(run().stdout, /^trouteai  TRouteAI 9\.8\.7 · installed, not running/m);
  assert.equal(run('start', 'nope').status, 2);
  const started = run('start', 'trouteai');
  assert.deepEqual([started.status, started.stdout], [0, ''], 'stdout stays empty: this is used as a PRERUN');
  assert.match(started.stderr, /TRouteAI started/);
  assert.match(run('status', 'trouteai').stdout, /running at http:\/\/localhost:/);
  assert.match(run('stop', 'trouteai').stdout, /TRouteAI stopped/);
});
