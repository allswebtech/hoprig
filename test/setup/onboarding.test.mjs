// "Get started" as data: each step done or not, owner only, the slow parts cached, terminal commands fixed here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const ON = await import('../../src/setup/onboarding.mjs');

const empty = {
  claude: { installed: null, loggedIn: null }, tools: { missing: ['git', 'Node.js'] }, rules: { installed: false }, projects: [], skills: [],
  profiles: [], machines: [], sessions: 1,
};
const full = {
  claude: { installed: '2.1.300', loggedIn: true }, tools: { missing: [] }, rules: { installed: true, edited: false }, projects: ['demo'], skills: ['hoprig'],
  profiles: [{ name: 'sub', kind: 'login' }, { name: 'api', kind: 'api' }], machines: [{ name: 'box2' }], sessions: 2,
};
const byId = (steps) => Object.fromEntries(steps.map((x) => [x.id, x]));

test('each step done or not, with what to open', () => {
  const e = byId(ON.onboardingSteps(empty));
  assert.deepEqual(Object.keys(e), ['claude', 'tools', 'rules', 'project', 'skills', 'phone', 'account2', 'computer']);
  for (const x of Object.values(e)) assert.equal(x.done, false, x.id);
  // The rules and the skills are every coding tool's (the brain links them to each); only the first step is Claude Code's.
  assert.deepEqual([e.claude.title, e.rules.title, e.skills.title], ['Claude Code installed and signed in', 'Working rules', 'Skills']);
  assert.deepEqual(e.claude.action, { kind: 'install-claude', label: 'Install Claude Code' });
  assert.deepEqual(e.tools.action, { kind: 'page', target: 'pc/setup' });
  assert.deepEqual(e.rules.action, { kind: 'request', method: 'POST', path: '/api/pcsetup/rules', body: { action: 'add' } });
  assert.deepEqual(e.project.action, { kind: 'page', target: 'pc/projects' });
  assert.deepEqual(e.skills.action, { kind: 'page', target: 'settings/skills' });
  assert.deepEqual(e.phone.action, { kind: 'page', target: 'settings/signin-device' });
  assert.equal(e.account2.optional, true);
  assert.equal(e.computer.optional, true);
  const f = byId(ON.onboardingSteps(full));
  for (const x of Object.values(f)) {
    assert.equal(x.done, true, x.id);
    assert.equal(x.action, null, x.id);
  }
  // installed but not signed in: the sign-in; an API account counts as signed in
  // installed but not signed in: the page's own sign-in (no terminal)
  assert.deepEqual(byId(ON.onboardingSteps({ ...empty, claude: { installed: '2.1.300', loggedIn: false } })).claude.action, { kind: 'claude-login', label: 'Sign in to Claude' });
  assert.equal(byId(ON.onboardingSteps({ ...empty, claude: { installed: '2.1.300', loggedIn: false }, profiles: [{ name: 'api', kind: 'api' }] })).claude.done, true);
});

test('browser sessions are counted from the file, expired ones not', () => {
  const f = path.join(s.tmp, 'web-sessions.json');
  fs.writeFileSync(f, JSON.stringify({ a: { expires: 2000 }, b: { expires: 500 }, c: { expires: 3000 } }));
  assert.equal(ON.browserSessions(f, 1000), 2);
  assert.equal(ON.browserSessions(path.join(s.tmp, 'none.json')), 0);
});

function harness({ authed = true, facts = full, seen = null, installClaude } = {}) {
  const calls = { claude: 0, tools: 0 };
  const created = [];
  let clock = 1_000_000;
  const src = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, async () => {
    if (k in calls) calls[k]++;
    return v;
  }]));
  const f = ON.onboardingFeature({
    authed: () => authed,
    readJson: async (req) => req.body || {},
    backend: { list: async () => [] },
    deck: { launcher: () => ['node', '/app/bin/hoprig.mjs'], terminal: async (o) => created.push(o) },
  }, { facts: src, now: () => clock, loginSeen: () => (typeof seen === 'function' ? seen(clock) : seen), installClaude });
  const call = (method, p, body) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) if (m === method && re.test(u.pathname)) return fn({ body, headers: {} }, null, u.searchParams);
    throw new Error('no route');
  };
  return { call, calls, created, tick: (ms) => (clock += ms) };
}

test('GET /api/onboarding: the shape, the counts; the slow parts cached for a minute', async () => {
  const h = harness();
  const r = await h.call('GET', '/api/onboarding');
  assert.deepEqual(Object.keys(r), ['steps', 'done', 'total', 'checkedAt']);
  assert.deepEqual([r.done, r.total], [6, 6]);
  for (const st of r.steps) assert.deepEqual(Object.keys(st).sort(), ['action', 'detail', 'done', 'id', 'optional', 'title']);
  await h.call('GET', '/api/onboarding');
  assert.deepEqual(h.calls, { claude: 1, tools: 1 }, 'cached');
  h.tick(61_000);
  await h.call('GET', '/api/onboarding');
  assert.deepEqual(h.calls, { claude: 2, tools: 2 });
  const none = await harness({ facts: empty }).call('GET', '/api/onboarding');
  assert.deepEqual([none.done, none.total], [0, 6]);
});

test('owner only: without the login cookie (another dashboard\'s token, say) it is refused', async () => {
  const h = harness({ authed: false });
  await assert.rejects(h.call('GET', '/api/onboarding'), (e) => e.status === 403);
  await assert.rejects(h.call('POST', '/api/onboarding/run', { run: 'setup' }), (e) => e.status === 403);
});

test('run: only Claude Code\'s own sign-in is a terminal; installing runs in the page; anything else refused', async () => {
  const h = harness();
  await h.call('POST', '/api/onboarding/run', { run: 'claude-login' });
  assert.deepEqual(h.created[0].argv, ['claude', 'auth', 'login']);
  for (const bad of ['setup', 'pc-setup', 'rm -rf ~', '__proto__', 1, null]) await assert.rejects(h.call('POST', '/api/onboarding/run', { run: bad }), (e) => e.status === 400);
  assert.equal(h.created.length, 1);
});

test('install Claude Code: a job in the page with its lines and result; owner only; one at a time', async () => {
  let release;
  const h = harness({ installClaude: async ({ onLine }) => {
    onLine('Downloading the installer');
    await new Promise((r) => (release = r));
    return { ok: true, version: '2.1.330' };
  } });
  assert.deepEqual(await h.call('POST', '/api/onboarding/install-claude', {}), { started: true });
  await assert.rejects(h.call('POST', '/api/onboarding/install-claude', {}), (e) => e.status === 409);
  let j = await h.call('GET', '/api/onboarding/job?from=0');
  assert.deepEqual([j.running, j.lines], [true, ['Downloading the installer']]);
  release();
  await new Promise((r) => setTimeout(r, 10));
  j = await h.call('GET', '/api/onboarding/job?from=1');
  assert.deepEqual([j.running, j.lines, j.result], [false, [], { ok: true, version: '2.1.330' }]);
  assert.equal(h.created.length, 0, 'no terminal');
  await assert.rejects(harness({ authed: false }).call('POST', '/api/onboarding/install-claude', {}), (e) => e.status === 403);
});

test('a sign-in checked after the cached answer (the page signed Claude Code in) counts at once', async () => {
  const out = { ...full, claude: { installed: '2.1.300', loggedIn: false }, profiles: [{ name: 'sub', kind: 'login' }] };
  let at = 0;
  const h = harness({ facts: out, seen: () => (at ? { loggedIn: true, plan: 'max', at } : null) });
  const step = async () => (await h.call('GET', '/api/onboarding')).steps.find((x) => x.id === 'claude');
  assert.equal((await step()).done, false);
  at = 999_999; // older than the cached answer: ignored
  assert.equal((await step()).done, false);
  at = 1_000_001;
  assert.equal((await step()).done, true);
  assert.deepEqual(h.calls, { claude: 1, tools: 1 }, 'without asking Claude Code again');
});

test('nothing secret in the answer', async () => {
  const secretFacts = { ...full, profiles: [{ name: 'api', kind: 'api', env: { ANTHROPIC_API_KEY: 'sk-ant-secret-123' } }, { name: 'sub', kind: 'login' }] };
  const r = await harness({ facts: secretFacts }).call('GET', '/api/onboarding');
  assert.doesNotMatch(JSON.stringify(r), /sk-ant-secret/);
});

test('in the real server: behind the login, and refused for a bearer token', async () => {
  const { createServer } = await import('../../src/server/server.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { saveConfig } = await import('../../src/config.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  saveConfig({ server: { passwordHash: await hashPassword('correct horse battery') } });
  const { token } = createToken('a hub');
  const app = createServer({ host: '127.0.0.1', port: 0, backend: { kind: 'none', capabilities: {}, list: async () => [], close: async () => {}, validName: () => true }, watch: false, dashboardFile: false, onboarding: { facts: Object.fromEntries(Object.entries(full).map(([k, v]) => [k, async () => v])) } });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/onboarding`)).status, 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base}/api/onboarding`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).total, 6);
    assert.equal((await fetch(`${base}/api/onboarding`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  } finally {
    await app.close();
  }
});

test('sign-in links for another address: only one this dashboard is reached at', async () => {
  const { createServer } = await import('../../src/server/server.mjs');
  const { saveConfig } = await import('../../src/config.mjs');
  saveConfig({ server: { allowedOrigins: ['https://quiet-river-1234.trycloudflare.com'] } });
  const app = createServer({ host: '127.0.0.1', port: 0, backend: { kind: 'none', capabilities: {}, list: async () => [], close: async () => {}, validName: () => true }, watch: false, dashboardFile: false });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const H = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base, 'Content-Type': 'application/json' };
    const post = (body) => fetch(`${base}/api/login/links`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const pubLink = await post({ base: 'https://quiet-river-1234.trycloudflare.com/some/path' });
    assert.equal(pubLink.status, 200);
    assert.match((await pubLink.json()).url, /^https:\/\/quiet-river-1234\.trycloudflare\.com\/login#link=/);
    const own = await post({ base });
    assert.match((await own.json()).url, new RegExp(`^${base}/login#link=`));
    assert.match((await (await post({})).json()).url, new RegExp(`^${base}/`), 'no base: as before');
    for (const bad of ['https://evil.example', 'javascript:alert(1)', 'not a url', 42]) assert.equal((await post({ base: bad })).status, 400, String(bad));
  } finally {
    await app.close();
  }
});
