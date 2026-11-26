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
 * Also added: `ownEndpoint`, an address in Claude Code's own settings file, and `ownBackup`, the copy a press on it
 * left (both null here: the home names none).
 */
function CHANGED(old) {
  // The gateway is installed and updated with the options its README names, and an install says in one line that two
  // of its parts build a helper (decided for 0.2.x: the README's own install line).
  const flags = '--allow-scripts=tls-client-node,koffi --loglevel=error';
  old.disk.npm = old.disk.npm.map((l) => l.replace(/^install -g /, `install -g ${flags} `));
  // A gateway Hoprig starts listens no wider than the dashboard: this home's dashboard is on this computer only (its
  // default), so each start by Hoprig also passes the definition's --host 127.0.0.1. The first and the fifth start are
  // the home's own (compat-home.mjs starts the program itself: one running before, one as 0.2.6 started it).
  old.disk.gatewayArgs = old.disk.gatewayArgs.map((l, i) => (i === 0 || i === 4 ? l : `${l} --host 127.0.0.1`));
  const install = old.commands.find((c) => c.args === 'addons install trouteai');
  const builds = 'Two of its parts (tls-client-node, koffi) build a helper program each on this computer while it installs.';
  install.stdout = `${builds}\n${install.stdout}`;
  // The page's list carries that line and the install command for its Install confirmation: two fields added, every
  // field 0.2.6 sent kept.
  Object.assign(old.routes.addons.gateway, { builds, installCommand: `npm install -g ${flags} trouteai` });
  // It is marked as a gateway, so the page asks before an install or update, naming the computer: one field added.
  old.routes.addons.gateway.gateway = true;
  // The owner's page reads what `hoprig gateways` says of each gateway (what it runs, why it waits) from GET
  // /api/gateways, so a missing program is explained on the page: two fields added there only, every field kept.
  for (const g of old.routes.gateways.json.gateways) Object.assign(g, { needsConfirm: null, runs: ['trouteai', '--port', '<PORT>', '--host', '127.0.0.1'] });
  for (const k of ['accounts', 'after']) {
    const j = old.routes[k].json;
    for (const a of j.accounts) a.viaGateway = a.viaTrouteai ? { id: 'trouteai', title: 'TRouteAI' } : null;
    const { baseUrl, ...state } = j.trouteai;
    j.gateways = [{ id: 'trouteai', title: 'TRouteAI', words: SHIPPED[0].words, page: state.url, installable: true, ...state, defaults: { ...j.defaults.trouteai, baseUrl } }];
    j.ownEndpoint = null;
    j.ownBackup = null;
    // Also added: `signedIn`, the loopback names this dashboard is signed in under (here the test's own sign-in on
    // 127.0.0.1), so the page links to a gateway's own page only by a name the sign-in is not set for. One field
    // added, every field 0.2.6 sent kept.
    j.signedIn = ['127.0.0.1'];
    // Also added: whether "Also use pay-per-use providers" is on, so a provider's page says before "Use in Auto mode"
    // that the press turns it on (off in this home). One field added, every field 0.2.6 sent kept.
    j.payPerUse = false;
  }
  return old;
}

test('a home as 0.2.6 leaves it: every command, route and file is as it was', { skip: process.platform === 'win32' && 'no home of Hoprig 0.2.6 exists on Windows: it did not run there, and the record this compares with was made on Linux', timeout: 120_000 }, async () => {
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
