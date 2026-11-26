// The direct link over a real WebSocket on localhost: a computer joins by address + code, the hub reaches its API,
// terminal and uploads through the link, a second socket replaces the first, a dropped link comes back on the same
// port, wrong secrets are rate-limited, secrets never appear in a URL or a log, plain http to another computer is
// refused without --insecure, and Leave / Remove end it on both sides.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { COOKIE, asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-link');
// On Windows the link's flow is written down (mux.mjs HOPRIG_MUX_DEBUG, read when the file is loaded, so before the
// imports below): the hub and the computer run in this process, and their lines are kept here, not printed. An upload
// that does not end says in its message every stream's opening, purpose and end, each stream's totals, the state of
// every stream still open on both sides, and the last 80 lines.
const muxLines = [];
const muxKey = []; // every line of a stream's life: opened, what it is for, ended, reset, dropped, closed, an error
const muxTotals = new Map(); // "<role> <stream>" -> { sent, got }
if (process.platform === 'win32') {
  process.env.HOPRIG_MUX_DEBUG = '1';
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (!text.startsWith('mux ')) return write(chunk, ...rest);
    for (const l of text.split('\n').filter(Boolean)) {
      muxLines.push(l);
      const [, role, , id, words] = /^mux (\S+) (\d+) (\d+) (.*)$/.exec(l) || [];
      if (/^(open|for |answer |first bytes|end|reset|drop|socket (closed|ended|error))/.test(words || '')) muxKey.push(l);
      const n = /^(send|recv) \d+ \(total (\d+)\)/.exec(words || '');
      if (n) {
        const t = muxTotals.get(`${role} ${id}`) || { sent: 0, got: 0 };
        t[n[1] === 'send' ? 'sent' : 'got'] = Number(n[2]);
        muxTotals.set(`${role} ${id}`, t);
      }
    }
    if (muxLines.length > 2000) muxLines.splice(0, muxLines.length - 2000);
    return true;
  };
}
const { createMachines } = await import('../../src/machines/index.mjs');
const join = await import('../../src/machines/join.mjs');
const link = await import('../../src/machines/link.mjs');
const { loadMachines } = await import('../../src/machines/store.mjs');
const { storedTokens } = await import('../../src/machines/tokens.mjs');
const { RateLimiter } = await import('../../src/server/auth.mjs');

// Everything printed while the link is used is collected: no secret may show up in it.
const printed = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => {
    printed.push(a.join(' '));
    orig(...a);
  };
}

const fast = { claudeVersion: async () => null, relayIdleMs: 5000, hub: { probeTimeoutMs: 1500, hubName: 'the-hub', link: { limiter: new RateLimiter({ perIp: 4 }), pingMs: 1000 } } };
const me = await miniDashboard({ createMachines, opts: { ...fast, join: { link: { minDelayMs: 200, pingMs: 1000 }, syncMs: 200 } }, sessions: [{ name: 'home-session' }] }).listen();
const hub = await miniDashboard({ createMachines, opts: fast, sessions: [{ name: 'hub-session' }] }).listen();
saveConfig({ server: { host: '127.0.0.1', port: me.port, machineLabel: 'Home PC' } });
const keeper = me.machines.joins;
keeper.start();
const browser = asBrowser(hub.base);
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};
/** `p`, or a failure that names the step when it has not ended within `ms`: a hang says where it hangs. */
const step = (what, p, ms = 30_000) => {
  let timer;
  return Promise.race([p, new Promise((_, j) => (timer = setTimeout(() => j(new Error(`no end within ${ms / 1000} s: ${what}`)), ms)))]).finally(() => clearTimeout(timer));
};
const linked = () => loadMachines().find((m) => m.via === 'link');
const stateOnHub = async () => ((await browser('/api/machines?fresh=1')).json.machines.find((m) => m.via === 'link') || {}).state;
const code = async () => (await browser('/api/links/code', { body: {} })).json;

test.after(async () => {
  keeper.close();
  await me.close();
  await hub.close();
  box.cleanup();
});

test('join by address + code: the hub reaches the computer\'s API, terminal and uploads through the link', async () => {
  const c = await step('the code', code());
  const h = await step('the join by address', join.joinByAddress(hub.base, c.code, { keeper }));
  assert.equal(h.via, 'link');
  const m = linked();
  assert.equal(m.label, 'Home PC');
  assert.equal(m.linkId, h.id);
  assert.deepEqual((await browser(`/api/links/code?id=${c.id}`)).json, { status: 'claimed', by: 'Home PC' });
  assert.equal(await stateOnHub(), 'online');
  assert.deepEqual((await step('the computer\'s API through the link', browser(`/m/${m.name}/api/state`))).json.sessions, [{ name: 'home-session' }]);
  // The terminal: a WebSocket inside the link's WebSocket.
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/m/${m.name}/ws/term?name=home-session`, { headers: { Origin: hub.base, Cookie: COOKIE } });
  const got = [];
  ws.on('message', (d) => got.push(d.toString()));
  await step('the terminal socket through the link opens', new Promise((r, j) => (ws.on('open', r), ws.on('error', j))));
  await until('hello', async () => got.includes('hello home-session cookie=no origin=no'));
  ws.send('ls');
  await until('echo', async () => got.includes('echo ls'));
  ws.close();
  // 5 MB upload, streamed, intact.
  const data = crypto.randomBytes(5 * 1024 * 1024);
  const res = await step('the 5 MB upload through the link', new Promise((resolve, reject) => {
    const rq = http.request(`${hub.base}/m/${m.name}/api/sessions/home-session/upload`, { method: 'POST', headers: { Origin: hub.base, Cookie: COOKIE, 'Content-Type': 'application/octet-stream' } }, (r) => {
      let d = '';
      r.on('data', (x) => (d += x));
      r.on('end', () => resolve(JSON.parse(d)));
    });
    rq.on('error', reject);
    rq.end(data);
  }), 60_000).catch((e) => {
    if (process.platform === 'win32') {
      const muxes = [...hub.machines.links.sessions.values()].map((x) => x.mux).concat([...keeper.map.values()].map((x) => x.tunnel.mux)).filter(Boolean);
      const last = muxLines.slice(-80);
      e.message += `\nthe link's streams, opened to closed (mux.mjs HOPRIG_MUX_DEBUG):\n${muxKey.join('\n')}`
        + `\ntheir totals: ${[...muxTotals].map(([k, v]) => `${k} sent ${v.sent}, got ${v.got}`).join('; ')}`
        + `\nstill open now:\n${muxes.flatMap((x) => x.describe()).join('\n') || '(none)'}`
        + `\nthe last ${last.length} flow lines:\n${last.join('\n')}`;
    }
    throw e;
  });
  assert.equal(res.bytes, data.length, 'all 5 MB arrived (the byte-exact hash check is in integration.test.mjs)');
});

test('secrets: hashed on the hub, never in a URL, never printed', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  const m = linked();
  assert.equal(JSON.stringify(loadMachines()).includes(h.secret), false, 'the hub keeps only a hash');
  assert.equal(m.linkHash, crypto.createHash('sha256').update(h.secret).digest('hex'));
  assert.equal(link.linkSocketUrl(h.url).includes('ccl_'), false);
  assert.equal(link.linkSocketUrl(h.url), `${hub.base.replace('http', 'ws')}/api/link`);
  assert.equal(printed.some((l) => /ccl_|hop_/.test(l)), false);
  assert.equal(JSON.stringify(join.publicJoined(h)).includes('ccl_'), false, 'the page never sees it');
  assert.equal(JSON.stringify((await asBrowser(me.base)('/api/joins')).json).includes('ccl_'), false);
});

test('a second socket with the same secret replaces the first; the link stays usable', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  const first = hub.machines.links.sessions.get(h.id).ws;
  const closed = new Promise((r) => first.once('close', (code) => r(code)));
  const second = new WebSocket(link.linkSocketUrl(h.url), { headers: { [link.LINK_HEADER]: h.secret } });
  await new Promise((r, j) => (second.on('open', r), second.on('error', j)));
  assert.equal(await closed, 4001);
  second.close();
  // The joined computer's own client reconnects and takes over again.
  await until('back online', async () => (await stateOnHub()) === 'online' && (await browser(`/m/${linked().name}/api/state`)).status === 200);
});

test('the link drops: offline on the hub, then back by itself on the same port', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  const port = linked().port;
  hub.machines.links.sessions.get(h.id).ws.terminate();
  await until('offline', async () => (await stateOnHub()) === 'offline');
  await until('online again', async () => (await stateOnHub()) === 'online');
  assert.equal(linked().port, port);
  const st = (await asBrowser(me.base)('/api/joins')).json.joined.find((x) => x.via === 'link');
  assert.equal(st.state, 'up');
});

test('wrong secrets are refused and rate-limited; the secret travels only in a header', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push(await new Promise((resolve) => {
      const w = new WebSocket(`${hub.base.replace('http', 'ws')}/api/link`, { headers: { [link.LINK_HEADER]: `ccl_${'A'.repeat(43)}` } });
      w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
      w.on('open', () => resolve('open'));
      w.on('error', () => resolve('error'));
    }));
  }
  assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401]);
  assert.equal(statuses.at(-1), 429);
  // A secret in the query string is not a credential.
  const h = join.loadJoined().find((x) => x.via === 'link');
  const q = await new Promise((resolve) => {
    const w = new WebSocket(`${link.linkSocketUrl(h.url)}?secret=${h.secret}`);
    w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
    w.on('open', () => resolve('open'));
  });
  assert.notEqual(q, 'open');
  hub.machines.links.limiter.byIp.clear();
  hub.machines.links.limiter.all.length = 0;
});

test('plain http to another computer is refused without --insecure, and the reason is said', async () => {
  await assert.rejects(link.claimLink('http://192.0.2.1:7433', 'K7QM-4XP2'), (e) => e.code === 'insecure' && /not encrypted/.test(e.message) && /--insecure/.test(e.message));
  // With --insecure it goes on (to a closed port on this computer's own network address: refused at once).
  const lan = join.networkAddresses().find((a) => !a.includes(':'));
  if (lan) await assert.rejects(link.claimLink(`http://${lan}:1`, 'K7QM-4XP2', { insecure: true }), (e) => e.code !== 'insecure');
  await assert.rejects(link.claimLink('https://hub.example', 'nope'), (e) => e.code === 'bad-code');
  const bad = await (await fetch(`${hub.base}/api/link/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ZZZZ-ZZZZ', token: `hop_${'A'.repeat(43)}` }) })).json();
  assert.equal(bad.code, 'bad-code');
  hub.machines.links.limiter.byIp.clear();
  hub.machines.links.limiter.all.length = 0;
});

test('a hub token cannot reach the link routes; a linked computer got no token for the hub', async () => {
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const t = createToken('someone');
  for (const p of ['/api/links/code', '/api/link/claim', '/api/link/leave']) {
    const r = await fetch(hub.base + p, { method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, p);
  }
  const h = join.loadJoined().find((x) => x.via === 'link');
  assert.equal(Object.keys(h).includes('token'), false);
});

test('Leave from the computer: the hub forgets it, its port closes, the token is revoked', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  const r = await join.leaveHub(h.url, { keeper });
  assert.equal(r.hubForgot, true);
  assert.equal(linked(), undefined);
  assert.equal(hub.machines.links.sessions.size, 0);
  assert.equal(storedTokens().some((x) => x.id === h.tokenId), false);
  assert.equal(join.loadJoined().length, 0);
});

test('Remove on the hub: the link is dropped and the computer stops connecting', async () => {
  const c = await code();
  const h = await join.joinByAddress(hub.base, c.code, { keeper });
  // The join returns when the link is up on the computer's side; the hub's own end of it (the local port its calls
  // go through) may open a moment later. A Remove in that moment cannot reach the computer and says so (revoked:
  // false, with the note to remove it there): true, and not what this test is about. So wait until the hub reaches it.
  // (This wait covers only that. A revoked: false seen on macOS after it came from the computer's keeper cutting the
  // link while the answer was on its way: the next test.)
  await until('online on the hub', async () => (await stateOnHub()) === 'online');
  const rm = await browser(`/api/machines/${linked().name}/remove`, { body: { confirm: linked().name } });
  assert.equal(rm.json.revoked, true);
  assert.equal(hub.machines.links.sessions.size, 0);
  await until('forgotten here', async () => join.loadJoined().length === 0 && !keeper.map.has(h.id));
});

test('Remove on the hub, with the computer\'s keeper forgetting the hub between the revoke and its answer: the answer still arrives', async () => {
  // The computer's keeper forgets a hub whose token is gone, every few seconds. Here its tick comes exactly when the
  // token was revoked and the answer saying so is about to go back over the link (on a slow runner it did by itself).
  const c = await code();
  const h = await join.joinByAddress(hub.base, c.code, { keeper });
  await until('online on the hub', async () => (await stateOnHub()) === 'online');
  const end = http.ServerResponse.prototype.end;
  let ticked = false;
  http.ServerResponse.prototype.end = function (chunk, ...rest) {
    if (!ticked && typeof chunk === 'string' && chunk.startsWith('{"revoked":')) {
      ticked = true;
      keeper.sync();
    }
    return end.call(this, chunk, ...rest);
  };
  let rm;
  try {
    rm = await browser(`/api/machines/${linked().name}/remove`, { body: { confirm: linked().name } });
  } finally {
    http.ServerResponse.prototype.end = end;
  }
  assert.ok(ticked, 'the keeper ran between the revoke and the answer');
  assert.equal(rm.json.revoked, true, JSON.stringify(rm.json));
  await until('forgotten here', async () => join.loadJoined().length === 0 && !keeper.map.has(h.id));
  await until('the link is closed here', async () => !keeper.map.has(h.id) && hub.machines.links.sessions.size === 0);
});

test('"Link to my main": the one pasted line (address#join=CODE) links this computer; a line of another shape is refused', async () => {
  const { joinLine } = await import('../../src/machines/joinline.mjs');
  const here = asBrowser(me.base);
  const bad = await here('/api/joins', { body: { line: 'K7QM-4XP2' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /paste the whole line/);
  const c = await code();
  const r = await here('/api/joins', { body: { line: `  ${joinLine(`${hub.base}/`, c.code)}\n` } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.joined.via, 'link');
  assert.deepEqual((await browser(`/api/links/code?id=${c.id}`)).json, { status: 'claimed', by: 'Home PC' });
  await until('online on the hub', async () => (await stateOnHub()) === 'online');
  // The code worked once: the same line again is refused by the hub.
  const again = await here('/api/joins', { body: { line: joinLine(hub.base, c.code) } });
  assert.notEqual(again.status, 200);
  const h = join.loadJoined().find((x) => x.via === 'link');
  await join.leaveHub(h.url, { keeper });
  assert.equal(join.loadJoined().length, 0);
});
