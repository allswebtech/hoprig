// A gateway the owner defined is only the process its add-on started (src/addons/localgateway.mjs). When another
// program holds its port, neither sharing (/gateway/<id>/…) nor Auto mode's router passes it a request: the provider's
// key would go to that program. The add-on's own judgement decides, not "something listens on the port".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const POSIX = { skip: process.platform === 'win32' }; // the stand-in program is a script started by its "#!" line
const box = sandbox('gateway-foreign');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { freePort } = await import('../../src/machines/tunnels.mjs');
const G = await import('../../src/addons/gateways.mjs');
const K = await import('../../src/gateway/keys.mjs');

const PROVIDER_KEY = 'provider-key-of-relay';
const PORT = await freePort();
saveConfig({ server: { passwordHash: await hashPassword('right-password') }, addons: { trouteai: { port: await freePort() } } });
const prog = path.join(box.root, 'relay');
fs.writeFileSync(prog, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// The owner's own server, not started by Hoprig, on the gateway's port: it writes down every credential it is sent.
const seen = [];
const other = http.createServer((q, s) => {
  seen.push(String(q.headers.authorization || q.headers['x-api-key'] || '(none)'));
  q.resume();
  s.writeHead(200, { 'content-type': 'application/json' });
  s.end('{"type":"message","content":[]}');
});
test.after(() => {
  other.close();
  box.cleanup();
});

test('another program on a defined gateway\'s port gets nothing through sharing or the router', POSIX, async () => {
  const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: prog, port: PORT });
  assert.equal(r.ok, true, r.error);
  const { findAddon } = await import('../../src/addons/index.mjs');
  const profile = findAddon('relay').profile();
  writeProfile('relay', { label: profile.label, prerun: profile.prerun, env: { ...profile.env, ANTHROPIC_AUTH_TOKEN: PROVIDER_KEY } });
  K.setShared('relay', 'relay');
  const key = K.createKey('relay', 'laptop').key;
  await new Promise((res) => other.listen(PORT, '127.0.0.1', res));

  // Sharing, through a dashboard of this test.
  const { createServer } = await import('../../src/server/server.mjs');
  const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
  const app = createServer({ backend, watch: false, dashboardFile: false, accounts: { gateways: [] } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const sent = await fetch(`http://127.0.0.1:${port}/gateway/relay/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{"model":"x","max_tokens":1,"messages":[]}' });
    const text = await sent.text();
    assert.equal(sent.status, 503, text);
    assert.match(text, /Another program answers on Relay's port on [^:]+: Hoprig did not start it, so nothing is passed on to it/);
    const st = await (await fetch(`http://127.0.0.1:${port}/gateway/relay/__status`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(st.running, false, 'its status check does not call it running');
  } finally {
    await app.close();
  }

  // Auto mode's router, for a session on the gateway's provider.
  const R = await import('../../src/router.mjs');
  const router = R.createRouter({ key: 'k'.repeat(48) });
  const rPort = await new Promise((res) => router.listen(0, '127.0.0.1', () => res(router.address().port)));
  try {
    const sent = await fetch(`http://127.0.0.1:${rPort}/${'k'.repeat(48)}/as/relay/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","max_tokens":1,"messages":[]}' });
    const text = await sent.text();
    assert.equal(sent.status, 502, text);
    assert.match(text, /another program answers on the port of Relay: Hoprig did not start it/);
  } finally {
    router.close();
  }
  assert.deepEqual(seen, [], 'the program Hoprig did not start was sent nothing, least of all the provider\'s key');
});
