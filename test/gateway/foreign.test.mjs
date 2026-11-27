// A gateway the owner defined is only the process its add-on started (src/addons/localgateway.mjs). When another
// program holds its port, neither sharing (/gateway/<id>/…) nor Auto mode's router passes it a request: the provider's
// key would go to that program. The add-on's own judgement decides, not "something listens on the port".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

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

test('another program on a defined gateway\'s port gets nothing through sharing or the router', async () => {
  const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: prog, port: PORT });
  assert.equal(r.ok, true, r.error);
  const { findAddon } = await import('../../src/addons/index.mjs');
  const profile = findAddon('relay').profile();
  writeProfile('relay', { label: 'Example relay', prerun: profile.prerun, env: { ...profile.env, ANTHROPIC_AUTH_TOKEN: PROVIDER_KEY } });
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
    // The provider by its label, as the pages name it (not its file name "relay").
    assert.match(text, /hoprig router: Example relay: another program answers on the port of Relay: Hoprig did not start it/);
  } finally {
    router.close();
  }
  assert.deepEqual(seen, [], 'the program Hoprig did not start was sent nothing, least of all the provider\'s key');
});

// The shipped gateway: a program of another user (or one whose owner cannot be told) on its port gets no key either; a
// program of the same user is the gateway, however it was started.
test('the router sends no key to a program of another user on the shipped gateway\'s port, and does to the same user\'s', async () => {
  const R = await import('../../src/router.mjs');
  const seenKeys = [];
  const srv = http.createServer((q, s) => {
    seenKeys.push(String(q.headers.authorization || '(none)'));
    q.resume();
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"type":"message","content":[]}');
  });
  const p = await freePort();
  await new Promise((res) => srv.listen(p, '127.0.0.1', res));
  writeProfile('shipped', { label: 'Via the shipped one', prerun: 'node hoprig addons start trouteai', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${p}`, ANTHROPIC_AUTH_TOKEN: 'shipped-key' } });
  let judged = { up: true, mine: false, otherUser: true };
  const gatewayOf = () => ({ title: 'TRouteAI', defined: false, answering: async () => judged });
  let clock = 1000;
  const router = R.createRouter({ key: 'k'.repeat(48), gatewayOf, now: () => clock });
  const rPort = await new Promise((res) => router.listen(0, '127.0.0.1', () => res(router.address().port)));
  const post = () => fetch(`http://127.0.0.1:${rPort}/${'k'.repeat(48)}/as/shipped/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","max_tokens":1,"messages":[]}' });
  try {
    const no = await post();
    const text = await no.text();
    assert.equal(no.status, 502, text);
    assert.match(text, /hoprig router: Via the shipped one: the program on the port of TRouteAI belongs to another user: Hoprig leaves it alone and sends it no key/);
    assert.deepEqual(seenKeys, [], 'nothing was sent to it');
    judged = { up: true, mine: true };
    clock += 31_000; // the router remembers a judgement for 30 seconds
    const yes = await post();
    assert.equal(yes.status, 200, await yes.text());
    assert.equal(seenKeys.length, 1, 'the same user\'s program was passed the request');
  } finally {
    router.close();
    srv.close();
  }
});

// The judgement of the shipped gateway costs a program start on macOS and Windows: the router keeps it for 30 seconds
// (by clock time), looks afresh after a refused connection, and judges a gateway the owner defined on every request.
test('the router remembers the shipped gateway\'s judgement for 30 seconds, and only that one', async () => {
  const R = await import('../../src/router.mjs');
  const srv = http.createServer((q, s) => {
    q.resume();
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"type":"message","content":[]}');
  });
  const p = await freePort();
  await new Promise((res) => srv.listen(p, '127.0.0.1', res));
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${p}`, ANTHROPIC_AUTH_TOKEN: 'k' };
  writeProfile('remembered', { label: 'Remembered', prerun: 'node hoprig addons start trouteai', env });
  let clock = 1_000_000;
  let looks = 0;
  let judged = { up: true, mine: true };
  let defined = false;
  const gatewayOf = () => ({ title: 'TRouteAI', defined, answering: async () => { looks++; return judged; } });
  const router = R.createRouter({ key: 'k'.repeat(48), gatewayOf, now: () => clock });
  const rPort = await new Promise((res) => router.listen(0, '127.0.0.1', () => res(router.address().port)));
  const post = () => fetch(`http://127.0.0.1:${rPort}/${'k'.repeat(48)}/as/remembered/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","max_tokens":1,"messages":[]}' });
  try {
    for (let i = 0; i < 20; i++) { clock += 500; assert.equal((await post()).status, 200); }
    assert.equal(looks, 1, 'twenty requests inside the window make one look');
    clock += 31_000;
    assert.equal((await post()).status, 200);
    assert.equal(looks, 2, 'a request after the window looks again');
    // Another user's program: remembered for the window at most, and it still sends nothing.
    clock += 31_000;
    judged = { up: true, mine: false, otherUser: true };
    const no = await post();
    assert.equal(no.status, 502);
    assert.match(await no.text(), /belongs to another user/);
    assert.equal(looks, 3);
    const again = await post();
    assert.equal(again.status, 502);
    await again.text();
    assert.equal(looks, 3, 'the refusal is remembered inside the window');
    clock += 31_000;
    judged = { up: true, mine: true };
    assert.equal((await post()).status, 200);
    assert.equal(looks, 4, 'and not beyond it');
    // A gateway the owner defined: a look at every request.
    defined = true;
    const before = looks;
    for (let i = 0; i < 3; i++) { clock += 10; assert.equal((await post()).status, 200); }
    assert.equal(looks - before, 3, 'a defined gateway is looked at every time');
  } finally {
    router.close();
    srv.close();
  }
});

test('after a refused connection the router looks at the shipped gateway afresh', async () => {
  const R = await import('../../src/router.mjs');
  const p = await freePort(); // nothing listens: the connection is refused
  writeProfile('refused', { label: 'Refused', prerun: 'node hoprig addons start trouteai', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${p}`, ANTHROPIC_AUTH_TOKEN: 'k' } });
  let looks = 0;
  const gatewayOf = () => ({ title: 'TRouteAI', defined: false, answering: async () => { looks++; return { up: false, mine: false }; } });
  const router = R.createRouter({ key: 'k'.repeat(48), gatewayOf, now: () => 5_000_000 });
  const rPort = await new Promise((res) => router.listen(0, '127.0.0.1', () => res(router.address().port)));
  try {
    const r = await fetch(`http://127.0.0.1:${rPort}/${'k'.repeat(48)}/as/refused/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","max_tokens":1,"messages":[]}' });
    await r.text();
    assert.equal(looks, 2, 'one look before the send, a fresh one after the refusal (same clock time)');
  } finally {
    router.close();
  }
});
