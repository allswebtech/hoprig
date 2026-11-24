// A computer reached through a main computer on an older build: that build names "no longer lets this dashboard in"
// by its old code, not-authorised (403 with { code: 'not-authorised' }); this build says computer-not-allowed. Both
// are the one state, so the Computers page reads "Not allowed any more" with its link, never "offline".
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-oldcode');
const { createMachines } = await import('../../src/machines/index.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { classifyRefusal, errorBody } = await import('../../src/machines/relay.mjs');

// The stand-in: what an older build's relay answered for a computer that refused its token (errorBody at 347809ac).
const OLD = { error: 'box no longer lets this dashboard in (it was revoked there). Allow it again in Settings → Computers.', code: 'not-authorised', machine: 'box' };
const old = http.createServer((req, res) => {
  req.resume();
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(OLD));
});
await new Promise((r) => old.listen(0, '127.0.0.1', r));
const oldBase = `http://127.0.0.1:${old.address().port}`;
const hub = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null, hub: { probeTimeoutMs: 1000, tunnelWaitMs: 1000 } } }).listen();
const browser = asBrowser(hub.base);
putMachine({ name: 'oldbox', label: 'Old box', via: 'url', url: oldBase, token: 'hop_made-up', tokenId: null, added: 1 });
test.after(async () => {
  await hub.close();
  old.closeAllConnections();
  await new Promise((r) => old.close(r));
  box.cleanup();
});

test('the old code not-authorised is read as computer-not-allowed, with the sentence that names the Computers page', () => {
  const e = classifyRefusal('box', 403, OLD);
  assert.equal(e.code, 'computer-not-allowed');
  const { status, body } = errorBody('box', e);
  assert.equal(status, 403);
  assert.equal(body.code, 'computer-not-allowed');
  assert.match(body.error, /Add it again here: Computers → Add a computer\./);
});

test('a computer that answers the old code is "unauthorised" in the list, not offline', async () => {
  const r = await browser('/api/machines/oldbox/test', { body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.machine.state, 'unauthorised');
  const list = await browser('/api/machines?fresh=1');
  assert.equal(list.json.machines.find((m) => m.name === 'oldbox').state, 'unauthorised');
});

test('a relayed call to it answers 403 with the new code, so the page draws the button to Computers', async () => {
  const r = await browser('/m/oldbox/api/state');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'computer-not-allowed');
});
