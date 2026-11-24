// A Work token on a real dashboard over HTTP (src/work/tokenfeature.mjs, accessfeature.mjs): made on the page only,
// with a question first; it adds a task and reads the tasks it added and nothing else: every other route of the
// dashboard (the whole route table, the WebSocket and the page's files) refuses it; its limits; a revoke ends it at once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-tokens');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const machineTokens = await import('../../src/machines/tokens.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { accessFile } = await import('../../src/work/access.mjs');

assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] }, work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } });

let app;
let origin;
let cookie;
// Set up before the first test by a top-level await, not an async root before(): below Node 22.2 such a hook is not
// awaited by the tests (nodejs/node#52791), so they ran before it ended.
await (async () => {
  app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
})();
test.after(async () => {
  await app?.close();
  t.cleanup();
});

const page = async (p, body) => {
  const r = await fetch(origin + p, body === undefined ? { headers: { Cookie: cookie } } : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const script = async (p, token, body, headers = {}) => {
  const r = await fetch(origin + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => null), retry: r.headers.get('retry-after') };
};
async function makeToken(name) {
  const ask = await page('/api/work/access/tokens', { name });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.match(ask.body.confirm, new RegExp(`named "${name}"`));
  assert.equal('secret' in ask.body, false, 'nothing is made before the yes');
  const made = await page('/api/work/access/tokens', { name, confirmed: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return { id: made.body.token.id, token: made.body.secret };
}

test('the token is made on the page after a question, shown once, listed with made and last used, never its hash', async () => {
  const before = (await page('/api/work/access')).body.tokens.length;
  const { id, token } = await makeToken('Shop script');
  assert.match(token, /^hwt_/);
  const list = await page('/api/work/access');
  assert.equal(list.body.tokens.length, before + 1);
  const row = list.body.tokens.find((x) => x.id === id);
  assert.equal(row.name, 'Shop script');
  assert.equal(typeof row.created, 'number');
  assert.equal(JSON.stringify(list.body).includes(token), false, 'the list never shows the token again');
  assert.equal(JSON.stringify(list.body).includes('hash'), false);
  await script('/api/work/token/tasks', token);
  assert.equal(typeof (await page('/api/work/access')).body.tokens.find((x) => x.id === id).lastUsed, 'number');
  assert.equal(fs.readFileSync(accessFile(), 'utf8').includes(token), false);
});

test('only the page makes, lists and revokes: Tia\'s door, another computer\'s token and a Work token are refused', async () => {
  for (const [m, p] of [['GET', '/api/work/access'], ['POST', '/api/work/access/tokens'], ['POST', '/api/work/access/tokens/revoke'], ['POST', '/api/work/access/webhooks'], ['POST', '/api/work/access/limits'], ['POST', '/api/work/token/tasks'], ['GET', '/api/work/token/tasks']]) {
    assert.throws(() => checkRoute(m, p, {}, {}), (e) => e.status === 403, `Tia's door refuses ${m} ${p}`);
  }
  const hub = machineTokens.createToken('box2');
  try {
    for (const [p, body] of [['/api/work/access', undefined], ['/api/work/access/tokens', { name: 'From a hub', confirmed: true }], ['/api/work/access/limits', { perDay: 5000 }]]) {
      const r = await script(p, hub.token, body);
      assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
    }
  } finally {
    machineTokens.revokeToken(hub.id, { log: false });
  }
  const { token } = await makeToken('Not an owner');
  assert.equal((await script('/api/work/access', token)).status, 403);
  assert.equal((await script('/api/work/access/tokens', token, { name: 'Another', confirmed: true })).status, 403);
  assert.equal((await page('/api/work/access')).body.tokens.some((x) => x.name === 'Another'), false);
});

test('a token adds a task (title, note, project, date) and reads only the tasks it added, with their runs', async () => {
  const a = await makeToken('Alpha app');
  const b = await makeToken('Beta app');
  const add = await script('/api/work/token/tasks', a.token, { title: 'Check the shop prices', note: 'From alpha', project: 'shop', date: '2026-12-01' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.task.from, 'Alpha app');
  assert.equal(add.body.task.status, 'open');
  const id = add.body.task.id;
  const own = await page('/api/work/items', { title: 'The owner\'s own task', project: 'shop' });
  const mine = await script('/api/work/token/tasks', a.token);
  assert.deepEqual(mine.body.tasks.map((x) => x.id), [id]);
  const one = await script(`/api/work/token/tasks/${id}`, a.token);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.runs, []);
  assert.equal((await script(`/api/work/token/tasks/${id}`, b.token)).status, 404, 'another token\'s task');
  assert.equal((await script(`/api/work/token/tasks/${own.body.item.id}`, a.token)).status, 404, 'the owner\'s task');
  assert.deepEqual((await script('/api/work/token/tasks', b.token)).body.tasks, []);
  // the page shows who added it
  const w = await page('/api/work');
  assert.equal(w.body.items.find((x) => x.id === id).from.name, 'Alpha app');
  for (const extra of [{ repeat: { kind: 'daily' } }, { runAt: { time: '07:30' } }, { provider: 'sub' }, { mode: 'bypassPermissions' }, { by: 'ai' }, { status: 'done' }]) {
    const r = await script('/api/work/token/tasks', a.token, { title: 'Something more', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal((await script('/api/work/token/tasks', a.token, { title: 'In a project not there', project: 'nope' })).status, 400);
  assert.equal((await script('/api/work/token/tasks', a.token, { title: 'Hidden\u200bcharacter here' })).status, 400, 'a character nobody can see, as in a brief');
  assert.equal((await script('/api/work/token/tasks', a.token, { title: 'Tagged note', note: 'ok\u{E0041}' })).status, 400);
  assert.equal((await script('/api/work/token/tasks', a.token, { title: 'Turned‮round' })).status, 400);
});

test('the token is taken only from its header: not from the address, a cookie, another scheme; a machine token is not one', async () => {
  const { token } = await makeToken('Header only');
  assert.equal((await script(`/api/work/token/tasks?token=${token}`, null)).status, 400);
  assert.equal((await script('/api/work/token/tasks', null, undefined, { Cookie: cookie })).status, 401, 'the owner\'s cookie is not a Work token');
  assert.equal((await script('/api/work/token/tasks', null, undefined, { Authorization: `Basic ${token}` })).status, 401);
  assert.equal((await script('/api/work/token/tasks', null, undefined, { Authorization: `bearer ${token}` })).status, 401, 'the exact scheme only');
  assert.equal((await script('/api/work/token/tasks', `${token}x`)).status, 401);
  const hub = machineTokens.createToken('box3');
  try {
    assert.equal((await script('/api/work/token/tasks', hub.token)).status, 401, 'a machine token on the Work routes');
    assert.equal((await script('/api/machine', token)).status, 403, 'a Work token on the machine routes');
    assert.equal((await script('/api/sessions', token)).status, 403);
  } finally {
    machineTokens.revokeToken(hub.id, { log: false });
  }
});

/** One sample path that `re` matches, made from its source: each class by a character of it, each group by its first choice. */
function samplePath(re) {
  const countOf = (q) => {
    const m = /^\{(\d+)(?:,(\d*))?\}$/.exec(q || '');
    return m ? Math.max(Number(m[1]), 1) : 1;
  };
  const charOf = (neg, cls) => {
    if (neg) return 'x';
    if (cls.startsWith('\\')) return cls[1] === 'd' ? '1' : cls[1] === 'w' ? 'a' : cls[1];
    return cls[0];
  };
  let s = re.source.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\[(\^?)((?:\\.|[^\]])+)\](\{\d+(?:,\d*)?\}|[+*?])?/g, (m, neg, cls, q) => charOf(neg, cls).repeat(countOf(q)));
  s = s.replace(/\\d(\{\d+(?:,\d*)?\}|[+*?])?/g, (m, q) => '1'.repeat(countOf(q))).replace(/\.[+*]|\\[Sw][+*]/g, 'x');
  for (let i = 0; i < 50 && /\([^()]*\)/.test(s); i++) {
    s = s.replace(/\((\?[:!=]|\?<[a-z]+>)?([^()]*)\)([?*+]|\{\d+(?:,\d*)?\})?/gi, (m, kind, inner) => (kind === '?!' || kind === '?=' ? '' : inner.split('|')[0]));
  }
  return s.replace(/\$/g, '').replace(/\\(.)/g, '$1');
}

test('the whole route table, the page\'s files and the WebSocket refuse a Work token; only its own routes take it', async () => {
  const { token } = await makeToken('Route walker');
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'server', 'server.mjs'), 'utf8');
  const core = [...src.matchAll(/\[\s*'(GET|POST|PUT|DELETE|PATCH)'\s*,\s*\/(\^.*?\$)\/[a-z]*\s*,/g)].map(([, m, s]) => [m, new RegExp(s)]);
  const fromFeatures = app.features.flatMap((f) => (f.routes || []).map(([m, re]) => [m, re]));
  const all = [...core, ...fromFeatures];
  assert.ok(core.length > 30 && fromFeatures.length > 100, `${core.length} core routes, ${fromFeatures.length} of features`);
  let walked = 0;
  const unmatched = [];
  for (const [m, re] of all) {
    const p = samplePath(re);
    if (!re.test(p)) {
      unmatched.push(re.source);
      continue;
    }
    walked++;
    const r = await script(p, token, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'token-scope', `${m} ${p}`);
  }
  assert.deepEqual(unmatched, [], `walked ${walked} of ${all.length}`);
  for (const p of ['/', '/index.html', '/app.js', '/style.css', '/login', '/api/login', '/api/me', '/m/box2/api/sessions', '/gateway/x', '/api/assistant/call', '/vendor/monaco.json']) {
    const r = await script(p, token, p === '/api/login' || p === '/api/assistant/call' ? {} : undefined);
    assert.equal(r.status, 403, p);
  }
  for (const p of ['/ws/term?name=x', '/api/link', '/m/box2/ws/term', '/api/work/token/tasks']) {
    const answer = await new Promise((resolve) => {
      const sock = net.connect(Number(new URL(origin).port), '127.0.0.1', () => sock.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`));
      let got = '';
      sock.on('data', (c) => (got += c));
      sock.on('close', () => resolve(got));
      sock.setTimeout(3000, () => sock.destroy());
    });
    assert.match(answer, /^HTTP\/1\.1 403/, `upgrade ${p}`);
  }
  assert.equal((await script('/api/work/token/tasks', token)).status, 200, 'its own route takes it');
});

test('limits per token: requests a minute and tasks a day, a plain 429 with Retry-After; one token\'s never another\'s', async () => {
  assert.equal((await page('/api/work/access/limits', { perMinute: 3, perDay: 2 })).status, 200);
  try {
    const a = await makeToken('Busy script');
    const b = await makeToken('Quiet script');
    for (let i = 0; i < 2; i++) assert.equal((await script('/api/work/token/tasks', a.token, { title: `Busy task ${i}` })).status, 200);
    const day = await script('/api/work/token/tasks', a.token, { title: 'Busy task 2' });
    assert.equal(day.status, 429);
    assert.match(day.body.error, /tasks today, its limit/);
    assert.ok(Number(day.retry) > 0);
    const minute = await script('/api/work/token/tasks', a.token);
    assert.equal(minute.status, 429);
    assert.match(minute.body.error, /requests in the last minute/);
    assert.ok(Number(minute.retry) >= 1 && Number(minute.retry) <= 60);
    assert.equal((await script('/api/work/token/tasks', b.token)).status, 200, 'another token is not held back');
    // in parallel: never more than the limit gets through
    const c = await makeToken('Parallel script');
    const many = await Promise.all(Array.from({ length: 10 }, () => script('/api/work/token/tasks', c.token)));
    assert.equal(many.filter((r) => r.status === 200).length, 3);
  } finally {
    await page('/api/work/access/limits', { perMinute: 60, perDay: 100 });
  }
});

test('the day limit is counted by Work\'s day: Retry-After counts to midnight in Work\'s time zone', async () => {
  // Pacific/Kiritimati is UTC+14 all year: its midnight is never the computer's (the suite runs in another zone).
  assert.equal((await page('/api/work/settings', { timeZone: 'Pacific/Kiritimati' })).status, 200);
  assert.equal((await page('/api/work/access/limits', { perDay: 1 })).status, 200);
  try {
    const a = await makeToken('Zone script');
    assert.equal((await script('/api/work/token/tasks', a.token, { title: 'Zone task one' })).status, 200);
    const day = await script('/api/work/token/tasks', a.token, { title: 'Zone task two' });
    assert.equal(day.status, 429);
    assert.equal(day.body.code, 'day-limit');
    const want = 86_400 - ((Math.floor(Date.now() / 1000) + 14 * 3600) % 86_400);
    assert.ok(Math.abs(Number(day.retry) - want) <= 5, `Retry-After ${day.retry}, midnight in Work's zone in ${want} s`);
  } finally {
    await page('/api/work/access/limits', { perDay: 100 });
    await page('/api/work/settings', { timeZone: '' });
  }
});

test('a revoke on the page ends the token at once, and its tasks keep who added them', async () => {
  const { id, token } = await makeToken('Short lived');
  const add = await script('/api/work/token/tasks', token, { title: 'Before the revoke' });
  assert.equal(add.status, 200);
  const r = await page('/api/work/access/tokens/revoke', { id });
  assert.equal(r.status, 200);
  assert.equal((await script('/api/work/token/tasks', token)).status, 401);
  assert.equal((await script('/api/work/token/tasks', token, { title: 'After the revoke' })).status, 401);
  const w = await page('/api/work');
  assert.equal(w.body.items.find((x) => x.id === add.body.task.id).from.name, 'Short lived');
});

test('the 51st token and the 51st webhook are refused before the question, not after the yes', async () => {
  const access = await import('../../src/work/access.mjs');
  const made = [];
  try {
    for (let i = access.listWorkTokens().length; i < 50; i++) made.push(access.createWorkToken(`Filler script ${i}`).id);
    const ask = await page('/api/work/access/tokens', { name: 'One more' });
    assert.equal(ask.status, 409, JSON.stringify(ask.body));
    assert.equal(ask.body.code, 'too-many');
    assert.equal('confirm' in ask.body, false, 'no question to say yes to');
    const owner = access.listWorkTokens()[0].id;
    for (let i = access.listWebhooks().length; i < 50; i++) access.addWebhook({ token: owner, url: `https://hooks.example.com/in${i}`, events: ['result'] });
    const hook = await page('/api/work/access/webhooks', { token: owner, url: 'https://hooks.example.com/more', events: ['result'] });
    assert.equal(hook.status, 409, JSON.stringify(hook.body));
    assert.equal(hook.body.code, 'too-many');
  } finally {
    for (const id of made) access.revokeWorkToken(id);
    for (const w of access.listWebhooks()) if (/\/in\d+$/.test(w.url)) access.removeWebhook(w.id);
  }
});

test('a refusal that carries its own code (the Work file\'s lock: busy) reaches the program with that code', async () => {
  const { tokenDoor } = await import('../../src/work/tokenfeature.mjs');
  const a = await makeToken('Lock wait script');
  // What withLock throws when another change holds the Work file past its wait (lock.mjs fileBusy).
  const busy = () => Object.assign(new Error('another change to the Work file is still being written; try again in a moment'), { status: 409, code: 'busy' });
  const door = tokenDoor({ place: () => null, store: () => ({ addFrom: async () => { throw busy(); } }), readJson: async () => ({ title: 'A task while busy' }), resume: async () => ({}), log: () => {}, clientIp: () => '192.168.1.20' });
  const out = {};
  const res = { writeHead: (status) => (out.status = status), end: (b) => (out.body = JSON.parse(b)) };
  assert.equal(await door.handle({ method: 'POST', url: '/api/work/token/tasks', headers: { authorization: `Bearer ${a.token}` } }, res), true);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'busy', JSON.stringify(out.body));
});

test('wrong tokens from one address never hold back a right one: only the wrong tries are limited', async () => {
  const { token } = await makeToken('Steady script');
  // A stranger behind the same address (the public link's tunnel is one address for every visitor) sends wrong tokens.
  for (let i = 0; i < 31; i++) await script('/api/work/token/tasks', `hwt_${String(i).padStart(43, 'Z')}`);
  const wrong = await script('/api/work/token/tasks', `hwt_${'Y'.repeat(43)}`);
  assert.equal(wrong.status, 429, 'the wrong tries are limited');
  assert.ok(Number(wrong.retry) > 0);
  const right = await script('/api/work/token/tasks', token);
  assert.equal(right.status, 200, `the right token still works: ${JSON.stringify(right.body)}`);
});
