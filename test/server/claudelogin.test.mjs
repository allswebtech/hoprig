// Claude Code's own sign-in from the page (src/server/claudelogin.mjs): which way a browser gets (same computer or
// not, from its address and headers), the links taken from the BROWSER helper and from the text, the code typed in,
// the sign-in on this computer finishing by itself, refusals, cancel, the time limits — against a fake `claude`
// (fixtures/fake-claude-login.mjs) over real HTTP. Nothing of the account may appear in any response.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeReq, sandbox } from './helpers.mjs';

const box = sandbox('claude-login');
test.after(() => box.cleanup());
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-login.mjs');
const ENV_FILE = path.join(box.root, 'fake-claude-env.json');
const MARK = path.join(box.claude, 'fake-signed-in');
// What a session's shell carries: none of it may reach `claude auth login`.
Object.assign(process.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'provider-key-should-not-leak', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shouldnotleak000000000000', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', HOPRIG_PROFILE: 'api', HOPRIG_RUN_FILE: '/x/run.json' });

const L = await import('../../src/server/claudelogin.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { loginSeen } = await import('../../src/routerstate.mjs');
const { createServer } = await import('../../src/server/server.mjs');

// The server and its login come first: a test() before a top-level await runs during it, and when the queue is empty
// node:test ends the root early and runs test.after (the sandbox's cleanup) before the rest is even declared.

saveConfig({ claudeBin: FAKE, server: { passwordHash: await hashPassword('right-password') } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const TIMES = { link: 4000, browser: 2000, done: 4000, verify: 4000, ttl: 60_000 };
const app = createServer({ backend, watch: false, claudeLogin: { times: TIMES } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const loginRes = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = loginRes.headers.get('set-cookie').split(';')[0];
const bodies = [];
// `remote`: the browser as seen through a tunnel (a forwarding header), so the code way.
async function call(p, body, { remote = false, auth = true } = {}) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(auth ? { Cookie: cookie } : {}), ...(remote ? { 'CF-Connecting-IP': '203.0.113.9' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
}
const helperDirs = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('hoprig-login-'));
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = await fn();
    if (v) return v;
  }
  return null;
}
const signOut = () => fs.rmSync(MARK, { force: true });

// ---------- the parts ----------

test('same computer: loopback or an own address, and nothing forwarded it', () => {
  const own = new Set(['192.168.1.20', 'fe80::1']);
  const at = (ip, headers = {}) => L.sameComputer(fakeReq(headers, { remoteAddress: ip }), { addresses: own });
  assert.equal(at('127.0.0.1'), true);
  assert.equal(at('::1'), true);
  assert.equal(at('::ffff:127.0.0.1'), true);
  assert.equal(at('192.168.1.20'), true, "this computer's own address");
  assert.equal(at('::ffff:192.168.1.20'), true);
  assert.equal(at('fe80::1%eth0'), true);
  assert.equal(at('192.168.1.30'), false, 'another computer on the network');
  assert.equal(at('100.64.0.7'), false);
  assert.equal(at(undefined), false);
  // a tunnel (cloudflared, a reverse proxy) arrives from loopback but says so in its headers
  for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-proto': 'https' }, { 'cf-connecting-ip': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { via: '1.1 caddy' }, { 'x-real-ip': '203.0.113.9' }])
    assert.equal(at('127.0.0.1', h), false, JSON.stringify(h));
  // relayed from another computer: the hub's bearer token, or the direct link
  assert.equal(at('127.0.0.1', { authorization: 'Bearer abc' }), false);
  assert.equal(at('127.0.0.1', { 'x-hoprig-link': 'abc' }), false);
  assert.equal(L.ownAddresses({ lo: [{ address: '127.0.0.1' }], eth0: [{ address: '::ffff:10.0.0.2' }] }).has('10.0.0.2'), true);
});

const link = (redirect) => `https://claude.com/cai/oauth/authorize?code=true&client_id=c1&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&state=s1`;

test('the two links: the one handed to BROWSER (localhost) and the printed one (a code to paste)', () => {
  const local = link('http://localhost:41234/callback');
  const code = link('https://platform.claude.com/oauth/code/callback');
  assert.equal(L.localLink(`${local}\n`), local);
  assert.equal(L.localLink(code), null, 'not a localhost redirect');
  assert.equal(L.localLink(link('http://evil.example/callback')), null);
  assert.equal(L.localLink('https://evil.example/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback'), null, 'only the sign-in hosts');
  assert.equal(L.localLink(''), null);
  // what Claude Code 2.1.325 prints: an OSC 8 hyperlink and the same address as text
  const out = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${code}\x07\x1b[94m${code}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;
  assert.equal(L.codeLink(out), code);
  assert.equal(L.codeLink(`visit: ${local}`), null);
});

test('the environment: no provider, no session variables, the real Claude folder, BROWSER the helper', () => {
  const env = L.loginEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_SSE_PORT: '1', CLAUDECODE: '1', HOPRIG_PROFILE: 'p', HOPRIG_RUN_FILE: 'f' }, '/tmp/x/browser');
  assert.deepEqual(Object.keys(env).sort(), ['BROWSER', 'CLAUDE_CONFIG_DIR', 'PATH', 'TERM']);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/c');
  assert.equal(env.BROWSER, '/tmp/x/browser');
  assert.notEqual(L.loginEnv({}, null).BROWSER, undefined, 'without a helper, a program that opens nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-'));
  try {
    assert.equal(L.browserHelper(dir, 'win32'), null);
    assert.equal(L.browserHelper(path.join(dir, "it's"), 'linux'), null, 'a name the script could not hold safely');
    if (process.platform !== 'win32') {
      const file = L.browserHelper(dir);
      assert.equal((fs.statSync(file).mode & 0o777).toString(8), '700');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- over HTTP ----------

test('behind the login', async () => {
  assert.equal((await call('/api/accounts/claude-login', undefined, { auth: false })).status, 401);
  assert.equal((await call('/api/accounts/claude-login/start', {}, { auth: false })).status, 401);
  assert.deepEqual((await call('/api/accounts/claude-login')).json, { state: 'none' });
});

test('from another computer: the printed link, a code typed in, confirmed by `claude auth status`', async () => {
  signOut();
  process.env.FAKE_CLAUDE_ENV_FILE = ENV_FILE;
  const before = new Set(helperDirs());
  let r = await call('/api/accounts/claude-login/start', {}, { remote: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.state, 'link');
  assert.equal(r.json.way, 'code');
  assert.match(r.json.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&.*redirect_uri=https%3A%2F%2Fplatform\.claude\.com/);
  assert.equal(r.json.codeUrl, r.json.url);
  assert.equal((await call('/api/accounts/claude-login/start', {})).status, 409, 'one at a time');
  const env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
  delete process.env.FAKE_CLAUDE_ENV_FILE;
  assert.deepEqual(env.keys, [], 'no provider or session variable reached claude');
  assert.equal(env.configDir, box.claude, "Claude Code's own folder: the sign-in goes where Claude Code keeps it");
  assert.match(env.browser, /hoprig-login-[^/]+\/browser$/, 'BROWSER is the helper');

  for (const bad of ['x', 'no-hash-in-it-at-all', '#only', 'a#b', 'code#with space', 42]) assert.equal((await call('/api/accounts/claude-login/code', { code: bad })).status, 400, String(bad));
  assert.equal((await call('/api/accounts/claude-login')).json.state, 'link', 'a malformed code changes nothing');
  r = await call('/api/accounts/claude-login/code', { code: 'good#st4te789' });
  assert.deepEqual(r.json, { state: 'done', plan: 'max' });
  assert.ok(fs.existsSync(MARK), 'Claude Code itself stored the sign-in');
  assert.equal(loginSeen().loggedIn, true, 'the answer is kept for Providers and Get started');
  assert.deepEqual((await call('/api/accounts/claude-login')).json, { state: 'done', plan: 'max' });
  assert.deepEqual(helperDirs().filter((d) => !before.has(d)), [], 'the helper folder is removed');
  assert.equal((await call('/api/accounts/claude-login/code', { code: 'good#again000' })).status, 409);
});

test('on this computer: the BROWSER link, and approving finishes the sign-in by itself', async () => {
  signOut();
  const r = await call('/api/accounts/claude-login/start', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.way, 'local');
  const redirect = new URL(new URL(r.json.url).searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, 'localhost');
  assert.match(r.json.codeUrl, /redirect_uri=https%3A%2F%2Fplatform/, 'the code way stays open too');
  // what the sign-in page does after "Authorize": the browser goes to Claude Code's own port
  assert.equal((await fetch(`http://127.0.0.1:${redirect.port}/callback?code=abc&state=st4te789`)).status, 200);
  const done = await until(async () => ((await call('/api/accounts/claude-login')).json.state === 'done' ? true : null));
  assert.ok(done, 'done without a code');
  assert.ok(fs.existsSync(MARK));
});

test('a refused code ends it with a plain message; cancel; a sign-in that Claude Code does not confirm', async () => {
  signOut();
  const before = new Set(helperDirs());
  await call('/api/accounts/claude-login/start', {}, { remote: true });
  let r = await call('/api/accounts/claude-login/code', { code: 'expired#st4te789' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /code was not accepted \(Login failed: Request failed with status code 400\)\. Start again/);
  assert.equal((await call('/api/accounts/claude-login')).json.state, 'error');
  assert.deepEqual(helperDirs().filter((d) => !before.has(d)), []);
  assert.equal(fs.existsSync(MARK), false);

  r = await call('/api/accounts/claude-login/start', {}, { remote: true });
  assert.equal(r.json.state, 'link', 'an ended sign-in does not block the next');
  assert.equal((await call('/api/accounts/claude-login/cancel', {})).status, 200);
  assert.deepEqual((await call('/api/accounts/claude-login')).json, { state: 'none' });
  assert.deepEqual(helperDirs().filter((d) => !before.has(d)), []);

  // "Login successful" but `auth status` says otherwise: not reported as done
  const app2 = createServer({ backend, watch: false, claudeLogin: { times: TIMES, status: async () => ({ loggedIn: false }) } });
  const { port: p2 } = await app2.listen(0, '127.0.0.1');
  try {
    const b2 = `http://127.0.0.1:${p2}`;
    const l = await fetch(`${b2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify({ password: 'right-password' }) });
    const c2 = l.headers.get('set-cookie').split(';')[0];
    const go = (p, body) => fetch(b2 + p, { method: 'POST', headers: { Origin: b2, Cookie: c2, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, json: await x.json() }));
    assert.equal((await go('/api/accounts/claude-login/start', {})).json.way, 'code');
    const res = await go('/api/accounts/claude-login/code', { code: 'good#st4te789' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /does not report a sign-in/);
  } finally {
    await app2.close();
  }
  signOut();
});

test('no link, Claude Code ending at once, not installed, and the 10-minute limit', async () => {
  process.env.FAKE_CLAUDE_MODE = 'nolink';
  const t0 = Date.now();
  let r = await call('/api/accounts/claude-login/start', {});
  assert.equal(r.status, 502);
  assert.match(r.json.error, /showed no sign-in link\. Use the terminal instead/);
  assert.ok(Date.now() - t0 < 8000);
  process.env.FAKE_CLAUDE_MODE = 'exit';
  r = await call('/api/accounts/claude-login/start', {});
  assert.equal(r.status, 502);
  assert.match(r.json.error, /terminal instead/);
  delete process.env.FAKE_CLAUDE_MODE;

  saveConfig({ claudeBin: path.join(box.root, 'no-such-claude') });
  r = await call('/api/accounts/claude-login/start', {});
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not installed/);
  saveConfig({ claudeBin: FAKE });

  const app2 = createServer({ backend, watch: false, claudeLogin: { times: { ...TIMES, ttl: 3000 } } });
  const { port: p2 } = await app2.listen(0, '127.0.0.1');
  try {
    const b2 = `http://127.0.0.1:${p2}`;
    const l = await fetch(`${b2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify({ password: 'right-password' }) });
    const c2 = l.headers.get('set-cookie').split(';')[0];
    const go = (p, body) => fetch(b2 + p, { method: body ? 'POST' : 'GET', headers: { Origin: b2, Cookie: c2, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((x) => x.json());
    assert.equal((await go('/api/accounts/claude-login/start', {})).state, 'link');
    const st = await until(async () => {
      const s = await go('/api/accounts/claude-login');
      return s.state === 'error' ? s : null;
    }, 15_000);
    assert.match(st.error, /longer than 10 minutes/);
  } finally {
    await app2.close();
  }
});

test('nothing of the account or a key in any response', () => {
  const all = bodies.join('\n');
  for (const secret of ['someone@example.invalid', 'Example Org', 'provider-key-should-not-leak', 'shouldnotleak', 'sk-ant-']) assert.equal(all.includes(secret), false, secret);
});
