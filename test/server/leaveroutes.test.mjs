// The routes of "Before you format this computer" (src/workspace/leavefeature.mjs), on temporary homes with a local
// "git server" (gitfix.mjs): the owner's press pushes a branch that is not the default branch and never main; Tia's
// token is refused on both presses; a second press while one runs gets 409; a bad mark body gets 400; the whole
// check runs once for two starts and is polled to its report; and nothing a
// check keeps in memory (a token, a full path, a file inside the credentials folder) is in any answer.
// The server here runs in a made-up computer's home: reset() calls its use(), which makes that home the process's
// (test/workspace/gitfix.mjs). No HOPRIG_WORKSPACE_DIR is set, so the workspace is the default one inside that home.
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { closedGateways } from '../seal.mjs';
import { dropWorld, reset, serverHeads } from '../workspace/dropfix.mjs';

const w = await dropWorld('leave', { labels: ['desk'] });
test.after(() => w.cleanup());
const [D] = w.computers;
const { leaveFeature, BUSY, LAST_NOTHING } = await import('../../src/workspace/leavefeature.mjs');

const TIA = { authorization: 'Bearer tia_0123456789abcdef0123456789' };
const SECRET = 'ghp_MADEUPSECRETMARKER0123456789abcd';
const standIns = (more = {}) => ({
  marks: { setMark: async () => ({ ok: true, marks: { keep: [], ignore: [], outside: [], testData: [], label: 'desk' } }), unmark: async () => ({ ok: true, marks: {} }) },
  leaveCheck: async () => ({ at: '2026-11-24T00:00:00.000Z', cheap: false, items: [], asks: [], outside: [], notChecked: [], nothingOnlyHere: true }),
  ...more,
});
/** The feature called in-process, as the server calls a route: the owner's page unless `headers` say otherwise. */
const caller = (f) => async (method, p, body, headers = {}) => {
  const u = new URL(p, 'http://x');
  for (const [m, re, fn] of f.routes) {
    const match = re.exec(u.pathname);
    if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers }), match, u.searchParams);
  }
  throw new Error(`no route ${method} ${p}`);
};
const sctx = { caller: () => 'page', readJson: async (req) => req.body, config: () => ({}) };

test('the press on the owner\'s page pushes feature/x and never main', async () => {
  await reset(D);
  const api = path.join(D.shop, 'code', 'shop-api');
  const main0 = serverHeads(w, 'shop-api').main;
  w.sh(api, 'switch', '-q', '-c', 'feature/x');
  const x = w.commit(api, 'feature.txt', 'new\n');
  w.sh(api, 'switch', '-q', 'main');
  w.commit(api, 'release.txt', 'ship\n');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [D.home], backend: 'pty' }, addons: closedGateways() });
  const { pushBranches, ...rest } = standIns(); // the real push
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `leave-${process.pid}`, leave: rest });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = (p, body, h = {}) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, ...h }, body: JSON.stringify(body) });
    for (const p of ['/api/workspace/onlyhere/push', '/api/workspace/leave/mark']) {
      assert.ok([401, 403].includes((await post(p, { kind: 'keep', what: '~/.toolx' }, { Authorization: TIA.authorization })).status), `Tia's token over HTTP: ${p}`);
    }
    assert.equal(serverHeads(w, 'shop-api')['feature/x'], undefined, 'nothing pushed by a refused press');
    const r = await post('/api/workspace/onlyhere/push', {});
    assert.equal(r.status, 200);
    const body = await r.json();
    const shop = body.repos.find((e) => /shop-api/.test(e.label));
    assert.ok(shop && shop.pushed.includes('feature/x'), JSON.stringify(body));
    assert.equal(serverHeads(w, 'shop-api')['feature/x'], x, 'feature/x is on the server');
    assert.equal(serverHeads(w, 'shop-api').main, main0, 'main is not pushed');
  } finally {
    await app.close();
  }
});

test('Tia\'s token gets 403 on both presses', async () => {
  const call = caller(leaveFeature(sctx, standIns({ pushBranches: async () => assert.fail('not pushed') })));
  await assert.rejects(call('POST', '/api/workspace/onlyhere/push', {}, TIA), (e) => e.status === 403);
  await assert.rejects(call('POST', '/api/workspace/leave/mark', { kind: 'keep', what: '~/.toolx' }, TIA), (e) => e.status === 403);
  // Tia's door, in-process: refused the same.
  const self = caller(leaveFeature({ ...sctx, caller: () => 'self' }, standIns()));
  await assert.rejects(self('POST', '/api/workspace/onlyhere/push', {}), (e) => e.status === 403);
  await assert.rejects(self('POST', '/api/workspace/leave/mark', { unmark: '~/.toolx' }), (e) => e.status === 403);
});

test('a second press while one runs gets 409 with a sentence', async () => {
  let open;
  const held = new Promise((r) => (open = r));
  let pushes = 0;
  const call = caller(leaveFeature({ ...sctx, config: () => ({ workspaceDir: D.ws }) }, standIns({ pushBranches: async () => { pushes++; await held; return { repos: [{ label: 'shop', pushed: ['feature/x'], todo: [] }] }; } })));
  const first = call('POST', '/api/workspace/onlyhere/push', {});
  await new Promise((r) => setImmediate(r));
  await assert.rejects(call('POST', '/api/workspace/onlyhere/push', {}), (e) => e.status === 409 && e.message === BUSY);
  open();
  assert.deepEqual((await first).repos, [{ label: 'shop', pushed: ['feature/x'], todo: [] }]);
  assert.equal(pushes, 1);
  await call('POST', '/api/workspace/onlyhere/push', {}); // free again
  assert.equal(pushes, 2);
});

test('a mark body of a wrong shape gets 400; a right one goes to the marks', async () => {
  const seen = [];
  const call = caller(leaveFeature(sctx, standIns({ marks: {
    setMark: async (o) => (seen.push(['set', o.kind, o.what]), { ok: true, marks: { keep: [o.what], ignore: [], outside: [], testData: [], label: 'desk' } }),
    unmark: async (o) => (seen.push(['un', o.what]), { ok: true, marks: {} }),
  } })));
  const bad = [null, [], {}, { kind: 'keep' }, { what: '~/.x' }, { kind: 'delete', what: '~/.x' }, { kind: 'keep', what: 5 }, { kind: 'keep', what: '' },
    { kind: 'keep', what: 'a'.repeat(301) }, { kind: 'keep', what: '~/.x\nrm' }, { kind: 'keep', what: '~/.x\u0007' }, { unmark: '~/.x', kind: 'keep' },
    { unmark: 3 }, { kind: 'keep', what: '~/.x', force: true }];
  for (const b of bad) await assert.rejects(call('POST', '/api/workspace/leave/mark', b), (e) => e.status === 400 && /\w+ \w+/.test(e.message), JSON.stringify(b));
  assert.deepEqual(seen, [], 'nothing marked by a bad body');
  const ok = await call('POST', '/api/workspace/leave/mark', { kind: 'keep', what: '~/.toolx' });
  assert.deepEqual(ok.marks.keep, ['~/.toolx']);
  await call('POST', '/api/workspace/leave/mark', { kind: 'testData', what: 'postgres' });
  await call('POST', '/api/workspace/leave/mark', { unmark: '~/.toolx' });
  assert.deepEqual(seen, [['set', 'keep', '~/.toolx'], ['set', 'testData', 'postgres'], ['un', '~/.toolx']]);
  const refused = caller(leaveFeature(sctx, standIns({ marks: { setMark: async () => ({ ok: false, why: 'give this computer a label first: hoprig workspace label <name>' }) } })));
  await assert.rejects(refused('POST', '/api/workspace/leave/mark', { kind: 'keep', what: '~/.x' }), (e) => e.status === 400 && /label first/.test(e.message));
});

test('GET leave: two starts run the check once; polled to its report; the last line', async () => {
  let open;
  const held = new Promise((r) => (open = r));
  const asked = [];
  const call = caller(leaveFeature(sctx, standIns({ leaveCheck: async (o) => { asked.push(o.cheap); await held; return { at: 'x', cheap: false, items: [], asks: [], outside: [], notChecked: [], nothingOnlyHere: true }; } })));
  const a = await call('GET', '/api/workspace/leave');
  const b = await call('GET', '/api/workspace/leave');
  assert.equal(a.running, true);
  assert.equal(a.run, b.run, 'the second start answers the running one');
  assert.match(a.run, /^[0-9a-f]{24}$/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [false], 'one whole check, not the cheap one');
  assert.equal((await call('GET', `/api/workspace/leave?run=${a.run}`)).running, true);
  open();
  let p;
  for (let i = 0; i < 50; i++) {
    p = await call('GET', `/api/workspace/leave?run=${a.run}`);
    if (!p.running) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(p.running, false);
  assert.equal(p.report.last, LAST_NOTHING);
  await assert.rejects(call('GET', '/api/workspace/leave?run=../x'), (e) => e.status === 400);
  await assert.rejects(call('GET', `/api/workspace/leave?run=${'0'.repeat(24)}`), (e) => e.status === 404);
  await assert.rejects(call('GET', '/api/workspace/leave', undefined, TIA), (e) => e.status === 403);
});

test('a finished look is kept 15 minutes, then gone', async () => {
  let clock = 1_000_000;
  const call = caller(leaveFeature(sctx, { ...standIns(), now: () => clock }));
  const a = await call('GET', '/api/workspace/leave');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await call('GET', `/api/workspace/leave?run=${a.run}`)).running, false);
  clock += 15 * 60_000 + 1;
  await assert.rejects(call('GET', `/api/workspace/leave?run=${a.run}`), (e) => e.status === 404);
});

test('nothing the check keeps in memory reaches an answer', async () => {
  const report = {
    at: 'x', cheap: false, nothingOnlyHere: false,
    items: [
      { id: 'key:~/.ssh/id_x', kind: 'key', where: '~/.ssh/id_x', what: `a private key ${SECRET}`, size: 400, todo: 'copy it into the credentials folder', command: '', pushable: false, sha256: SECRET, content: `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET}\n-----END OPENSSH PRIVATE KEY-----` },
      { id: 'credentials:~/Workspace/credentials', kind: 'credentials', where: '~/Workspace/credentials', what: 'credentials/server.env changed', size: 10, todo: 'push it', command: 'git -C /srv/MADEUPPLACE/credentials push', pushable: false, files: ['server.env'] },
      { id: 'hoprig:~/.config/hoprig', kind: 'hoprig', where: '~/.config/hoprig', what: 'Hoprig\'s own settings', size: 100, todo: 'back it up', command: '', pushable: false, providers: { token: SECRET } },
    ],
    asks: [{ id: 'dotfolder:~/.toolx', kind: 'dotfolder', where: '~/.toolx', size: 40, question: 'keep or ignore?', env: SECRET }],
    outside: [], notChecked: [{ where: '/srv/MADEUPPLACE/old', why: 'unreadable' }],
  };
  const call = caller(leaveFeature(sctx, standIns({ leaveCheck: async () => report, pushBranches: async () => ({ repos: [{ label: 'shop', pushed: [], todo: [{ why: `token ${SECRET}`, command: 'git -C /srv/MADEUPPLACE/shop push', secret: SECRET }] }] }) })));
  const answers = [await call('POST', '/api/workspace/onlyhere/push', {})];
  const s = await call('GET', '/api/workspace/leave');
  await new Promise((r) => setTimeout(r, 20));
  answers.push(await call('GET', `/api/workspace/leave?run=${s.run}`));
  const text = JSON.stringify(answers);
  assert.ok(answers[1].report && answers[1].report.items.length === 3, 'the report came back');
  for (const no of [SECRET, 'MADEUPSECRETMARKER', 'BEGIN OPENSSH', 'server.env', '/srv/MADEUPPLACE']) assert.ok(!text.includes(no), `${no} is in an answer`);
  assert.match(answers[1].report.last, /^5 things exist only on this computer \(above\)\.$/);
});
