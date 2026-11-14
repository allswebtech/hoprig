// Joining the same hub again replaces this computer's entry there instead of adding a second one: proven by the link
// secret it holds (sent only after the code is accepted), never by the name it claims. The old secret and the old
// token stop working, the label the owner gave stays; another computer with the same name gets an entry of its own.
import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-link-rejoin');
const { createMachines } = await import('../../src/machines/index.mjs');
const join = await import('../../src/machines/join.mjs');
const link = await import('../../src/machines/link.mjs');
const { loadMachines } = await import('../../src/machines/store.mjs');
const { storedTokens, verifyToken } = await import('../../src/machines/tokens.mjs');
const { RateLimiter } = await import('../../src/server/auth.mjs');

const fast = { claudeVersion: async () => null, relayIdleMs: 5000 };
const me = await miniDashboard({ createMachines, opts: { ...fast, join: { link: { minDelayMs: 200, maxDelayMs: 400, pingMs: 1000 }, syncMs: 200 } }, sessions: [{ name: 'home-session' }] }).listen();
const hub = await miniDashboard({ createMachines, opts: { ...fast, hub: { probeTimeoutMs: 1500, hubName: 'the-hub', link: { limiter: new RateLimiter({ perIp: 50 }), pingMs: 1000 } } }, sessions: [{ name: 'hub-session' }] }).listen();
saveConfig({ server: { host: '127.0.0.1', port: me.port, machineLabel: 'Home PC' } });
const keeper = me.machines.joins;
keeper.start();
const browser = asBrowser(hub.base);
const code = async () => (await browser('/api/links/code', { body: {} })).json;
const links = () => loadMachines().filter((m) => m.via === 'link');
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};
const online = async (name) => ((await browser('/api/machines?fresh=1')).json.machines.find((m) => m.name === name) || {}).state === 'online';
/** What the hub answers a link socket opened with `secret`: 'open' or the HTTP status. */
const socketWith = (secret) => new Promise((resolve) => {
  const w = new WebSocket(link.linkSocketUrl(hub.base), { headers: { [link.LINK_HEADER]: secret } });
  w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
  w.on('open', () => {
    w.close();
    resolve('open');
  });
  w.on('error', () => resolve('error'));
});

test.after(async () => {
  keeper.close();
  await me.close();
  await hub.close();
  box.cleanup();
});

test('joining again replaces the entry: same name, the owner\'s label kept, old secret and token dead, said once', async () => {
  const first = await join.joinByAddress(hub.base, (await code()).code, { keeper });
  assert.equal(first.replaced, undefined);
  const [m1] = links();
  await until('online', () => online(m1.name));
  // The owner renamed it on the hub.
  assert.equal((await browser(`/api/machines/${m1.name}/rename`, { body: { label: 'Study PC' } })).status, 200);
  const oldSecret = join.loadJoined().find((h) => h.id === first.id).secret;
  const oldTokenOnHub = links()[0].token;

  const again = await join.joinByAddress(hub.base, (await code()).code, { keeper });
  assert.equal(again.replaced, true, 'said once');
  assert.equal(join.loadJoined().find((h) => h.id === again.id).replaced, undefined, 'not kept in joined.json');
  const list = links();
  assert.equal(list.length, 1, 'one entry, not two');
  assert.equal(list[0].name, m1.name);
  assert.equal(list[0].label, 'Study PC');
  assert.equal(list[0].port, m1.port);
  assert.equal(list[0].added, m1.added);
  assert.notEqual(list[0].linkId, m1.linkId);
  // The old credentials: the secret is refused by the hub; the token the hub held is revoked on this computer.
  assert.equal(await socketWith(oldSecret), 401);
  assert.notEqual(list[0].token, oldTokenOnHub);
  assert.equal(verifyToken(oldTokenOnHub), null, 'the old token no longer opens this computer');
  assert.equal(storedTokens().some((t) => t.id === first.tokenId), false);
  await until('online again under the new link', () => online(m1.name));
});

test('another computer with the same name gets its own entry and cannot take over this one', async () => {
  const [mine] = links();
  const before = { ...mine };
  const info = { hostname: mine.info.hostname, platform: 'linux', version: '0.1.0', label: mine.label };
  const claim = async (extra) => (await fetch(`${hub.base}/api/link/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: (await code()).code, token: `hop_${'S'.repeat(43)}`, tokenId: 'abcdefabcdef', info, ...extra }),
  })).json();
  // Same host name and label, no proof; then a made-up secret as "proof".
  const a = await claim({});
  const b = await claim({ replaces: `ccl_${'Z'.repeat(43)}` });
  for (const r of [a, b]) {
    assert.equal(r.ok, true);
    assert.equal(r.replaced, false);
    assert.notEqual(r.name, mine.name);
  }
  const now = loadMachines().find((m) => m.name === mine.name);
  assert.deepEqual({ linkHash: now.linkHash, token: now.token, linkId: now.linkId, label: now.label }, { linkHash: before.linkHash, token: before.token, linkId: before.linkId, label: before.label }, 'untouched');
  assert.equal(links().length, 3);
  assert.equal(await online(mine.name), true, 'the real computer stays connected');
});
