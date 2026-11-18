// Nothing changes for a user of today's gateway when gateways become data: the same steps on a home as 0.2.6 leaves
// it (compat-home.mjs: config, state, a provider and a gateway running on its port) give what 0.2.6 gave
// (test/fixtures/gateway-0.2.6.json, recorded with 0.2.6 itself): the add-on commands with their output and exit
// codes, the dashboard's routes, the files on disk. The only differences are the ones decided and listed in CHANGED.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const before = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'gateway-0.2.6.json'), 'utf8'));

const { SHIPPED } = await import('../../src/addons/gateways.mjs');

/**
 * The decided differences, applied to the 0.2.6 answer: what this version answers instead. Only GET /api/accounts
 * changed, and only by adding: each provider also has `viaGateway: { id, title }` beside its `viaTrouteai`, and the
 * gateway's state and defaults are also one entry of `gateways`, with the sentences the page shows for it. Every
 * field 0.2.6 sent is still there with its value, so a page of 0.2.6 left open across the update keeps working.
 */
function CHANGED(old) {
  for (const k of ['accounts', 'after']) {
    const j = old.routes[k].json;
    for (const a of j.accounts) a.viaGateway = a.viaTrouteai ? { id: 'trouteai', title: 'TRouteAI' } : null;
    const { baseUrl, ...state } = j.trouteai;
    j.gateways = [{ id: 'trouteai', title: 'TRouteAI', words: SHIPPED[0].words, page: state.url, installable: true, ...state, defaults: { ...j.defaults.trouteai, baseUrl } }];
  }
  return old;
}

test('a home as 0.2.6 leaves it: every command, route and file is as it was', { skip: process.platform === 'win32', timeout: 120_000 }, async () => {
  const text = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(here, 'compat-home.mjs'), root], { maxBuffer: 1 << 24, timeout: 110_000 }, (e, out, err) => (e ? reject(new Error(`${e.message}\n${err}`)) : resolve(out))));
  const now = JSON.parse(text);
  const want = CHANGED(structuredClone(before));
  // Every difference is collected and said at once (a run on another system shows all of them, not only the first).
  const differ = [];
  const check = (fn) => {
    try {
      fn();
    } catch (e) {
      differ.push(e.message);
    }
  };
  for (const [i, c] of want.commands.entries()) check(() => assert.deepEqual(now.commands[i], c, `hoprig ${c.args}`));
  check(() => assert.equal(now.commands.length, want.commands.length));
  for (const k of Object.keys(want.routes)) check(() => assert.deepEqual(now.routes[k], want.routes[k], `route: ${k}`));
  check(() => assert.deepEqual(Object.keys(now.routes), Object.keys(want.routes)));
  check(() => assert.deepEqual(now.disk, want.disk));
  assert.ok(!differ.length, `${differ.length} difference(s) on ${process.platform}:\n\n${differ.join('\n\n')}`);
});
