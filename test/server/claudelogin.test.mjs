// Claude Code's own sign-in from the page (src/server/claudelogin.mjs): which way a browser gets (same computer or
// not, from its address and headers), the links taken from the BROWSER helper and from the text, the code typed in,
// the sign-in on this computer finishing by itself, refusals, cancel, the time limits; who is signed in, a sign-in
// with another account (the limit marks and figures of the stored sign-in's providers start again) and the sign-out
// — against a fake `claude` (fixtures/fake-claude-login.mjs) over real HTTP. Who is signed in appears in one answer
// only, the account route's, and only for the owner's cookie.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeReq, sandbox } from './helpers.mjs';

const box = sandbox('claude-login');
test.after(() => box.cleanup());
// A temp folder of its own: the helper folders ("hoprig-login-*") are counted there, and another test run on this
// computer at the same moment makes its own in the shared one. os.tmpdir() reads the variables at every call: TMPDIR
// on Linux and macOS, TEMP and TMP on Windows.
const ownTmp = path.join(box.root, 'tmp');
fs.mkdirSync(ownTmp);
Object.assign(process.env, { TMPDIR: ownTmp, TEMP: ownTmp, TMP: ownTmp });
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
// The Providers list asks whether the gateway add-on answers on its port: a free port, so the answer never depends on
// a gateway running on the computer that runs the tests (its default port is a real one's).
saveConfig({ addons: { trouteai: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const TIMES = { link: 4000, browser: 2000, done: 4000, verify: 4000, ttl: 60_000 };
const app = createServer({ backend, watch: false, claudeLogin: { times: TIMES } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const loginRes = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = loginRes.headers.get('set-cookie').split(';')[0];
const bodies = []; // every answer but the account route's: none of them may name the account
const accountBodies = [];
// `remote`: the browser as seen through a tunnel (a forwarding header), so the code way.
async function call(p, body, { remote = false, auth = true } = {}) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(auth ? { Cookie: cookie } : {}), ...(remote ? { 'CF-Connecting-IP': '203.0.113.9' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  (p.startsWith('/api/accounts/claude-login/account') && auth ? accountBodies : bodies).push(text);
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

const { writeProfile } = await import('../../src/profiles.mjs');
const { limitedProfiles, markLimited } = await import('../../src/autoswitch.mjs');
const { profileUsage, saveProfileUsage } = await import('../../src/routerstate.mjs');

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
  const env = L.loginEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_SSE_PORT: '1', CLAUDECODE: '1', HOPRIG_PROFILE: 'p', HOPRIG_RUN_FILE: 'f' }, '/tmp/x/browser'); // seal: a value no program is started with
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
  assert.deepEqual(env.args, [], 'a plain sign-in: claude auth login and nothing more');
  assert.equal(env.configDir, box.claude, "Claude Code's own folder: the sign-in goes where Claude Code keeps it");
  assert.match(env.browser, /hoprig-login-[^/]+\/browser$/, 'BROWSER is the helper');

  for (const bad of ['x', 'no-hash-in-it-at-all', '#only', 'a#b', 'code#with space', 42]) assert.equal((await call('/api/accounts/claude-login/code', { code: bad })).status, 400, String(bad));
  assert.equal((await call('/api/accounts/claude-login')).json.state, 'link', 'a malformed code changes nothing');
  r = await call('/api/accounts/claude-login/code', { code: 'good#st4te789' });
  assert.deepEqual(r.json, { state: 'done', plan: 'max', changed: false }, 'the first account seen is no change');
  assert.ok(fs.existsSync(MARK), 'Claude Code itself stored the sign-in');
  assert.equal(loginSeen().loggedIn, true, 'the answer is kept for Providers and Get started');
  assert.deepEqual((await call('/api/accounts/claude-login')).json, { state: 'done', plan: 'max', changed: false });
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

test('a helper folder that cannot be removed at once does not fail the end: it is tried again a moment later, and never throws', () => {
  // Claude Code, just told to end, may still write into the folder while it is removed ("directory not empty").
  const dir = fs.mkdtempSync(path.join(ownTmp, 'helper-test-'));
  fs.writeFileSync(path.join(dir, 'link'), 'x');
  const refused = () => Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir"), { code: 'ENOTEMPTY' });
  let tries = 0;
  const laters = [];
  const rm = (d, o) => {
    tries++;
    if (tries === 1) throw refused();
    fs.rmSync(d, o);
  };
  assert.doesNotThrow(() => L.removeHelper(dir, { rm, later: (fn) => laters.push(fn) }));
  assert.equal(fs.existsSync(dir), true, 'the refused try left it');
  assert.equal(laters.length, 1, 'one more try is set for later');
  laters[0]();
  assert.equal(fs.existsSync(dir), false, 'the later try removed it');
  // A folder that never goes: still no throw, at the first try or at the later one.
  let n = 0;
  assert.doesNotThrow(() => L.removeHelper(dir, { rm: () => { n++; throw refused(); }, later: (fn) => fn() }));
  assert.equal(n, 2);
  // The real removal, with nothing in the way: gone at once, nothing set for later.
  const plain = fs.mkdtempSync(path.join(ownTmp, 'helper-test-'));
  const none = [];
  L.removeHelper(plain, { later: (fn) => none.push(fn) });
  assert.equal(fs.existsSync(plain), false);
  assert.equal(none.length, 0);
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

// ---------- who is signed in, another account, sign out ----------

const HOUR = 3600 * 1000;
// Sign in over the code way as the stand-in's first or second account; `email` goes to the sign-in page.
async function signInAs(code, email) {
  const start = await call('/api/accounts/claude-login/start', email === undefined ? {} : { email }, { remote: true });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  return { start, done: await call('/api/accounts/claude-login/code', { code: `${code}#st4te789` }) };
}

test('who is signed in: for the owner\'s page only, asked from Claude Code, in no other answer', async () => {
  signOut();
  assert.equal((await call('/api/accounts/claude-login/account', undefined, { auth: false })).status, 401);
  assert.equal((await call('/api/accounts/claude-login/logout', {}, { auth: false })).status, 401);
  assert.deepEqual((await call('/api/accounts/claude-login/account?fresh=1')).json, { loggedIn: false, plan: null, email: null, org: null });
  await signInAs('good');
  assert.deepEqual((await call('/api/accounts/claude-login/account')).json, { loggedIn: true, plan: 'max', email: 'someone@example.invalid', org: 'Example Org' });
  // the pages every part reads name nobody
  for (const p of ['/api/state', '/api/accounts', '/api/profiles', '/api/accounts/claude-login']) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
    assert.doesNotMatch(JSON.stringify(r.json), /example\.invalid|Example Org/, p);
  }
  // nor does the state folder
  for (const f of fs.readdirSync(box.state)) {
    const file = path.join(box.state, f);
    if (fs.statSync(file).isFile()) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /example\.invalid|Example Org/, f);
  }
});

test('sign in with another account: one step, no sign-out first; the provider starts again; the same account changes nothing', async () => {
  writeProfile('sub', { label: 'Stored sign-in' });
  writeProfile('second', { label: 'Own token', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-not-a-real-token-000000000000' } });
  const atLimit = () => {
    for (const n of ['sub', 'second']) {
      markLimited(n, { until: Date.now() + 2 * HOUR, text: "You've hit your 5-hour limit" });
      saveProfileUsage(n, { at: Date.now() - 1000, fiveHour: { pct: 100, resetsAt: Date.now() + 2 * HOUR } });
    }
  };
  const sub = async () => (await call('/api/state')).json.profiles.find((p) => p.name === 'sub');
  signOut();
  await signInAs('good');
  atLimit();
  assert.equal((await sub()).limited.text, "You've hit your 5-hour limit");

  // a sign-in that is started and cancelled: the account of before stays, and so does what is known about it
  process.env.FAKE_CLAUDE_ENV_FILE = ENV_FILE;
  let r = await call('/api/accounts/claude-login/start', { email: 'other@example.invalid' }, { remote: true });
  assert.equal(r.json.state, 'link');
  assert.match(r.json.url, /&login_hint=other%40example\.invalid$/, 'the address fills in the sign-in page');
  assert.deepEqual(JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')).args, ['--email', 'other@example.invalid'], 'one argument each, no sign-out before');
  delete process.env.FAKE_CLAUDE_ENV_FILE;
  assert.ok(fs.existsSync(MARK), 'still signed in while the new sign-in is open');
  await call('/api/accounts/claude-login/cancel', {});
  assert.equal((await call('/api/accounts/claude-login/account?fresh=1')).json.email, 'someone@example.invalid');
  assert.deepEqual(Object.keys(limitedProfiles()).sort(), ['second', 'sub']);

  // the same account comes back (the browser was signed in as it): said as such, nothing cleared
  r = (await signInAs('good')).done;
  assert.deepEqual(r.json, { state: 'done', plan: 'max', changed: false });
  assert.deepEqual(Object.keys(limitedProfiles()).sort(), ['second', 'sub']);
  assert.equal(profileUsage().sub.fiveHour.pct, 100);

  // another account: the provider on the stored sign-in has no limit mark and no figures any more
  r = (await signInAs('other')).done;
  assert.deepEqual(r.json, { state: 'done', plan: 'pro', changed: true });
  assert.deepEqual((await call('/api/accounts/claude-login/account')).json, { loggedIn: true, plan: 'pro', email: 'other@example.invalid', org: 'Other Org' }, 'asked again, not the answer of before');
  assert.deepEqual(Object.keys(limitedProfiles()), ['second'], 'a provider with its own token is another account: not touched');
  const now = await sub();
  assert.deepEqual([now.limited, now.usage, now.plan, now.signedIn], [null, null, 'pro', true]);
  assert.ok(now.accountAt > Date.now() - 10_000, 'the page knows since when: a limit seen before is the earlier account\'s');
  assert.equal(profileUsage().second.fiveHour.pct, 100);

  for (const bad of ['not-an-address', '-x@example.invalid', 'a b@example.invalid', 'a@b', `${'x'.repeat(70)}@example.invalid`, 42, ['a@example.invalid']]) {
    assert.equal((await call('/api/accounts/claude-login/start', { email: bad })).status, 400, String(bad));
  }
  assert.equal((await call('/api/accounts/claude-login')).json.state, 'done', 'a bad address starts nothing');
});

test('sign out: Claude Code forgets the sign-in, Providers says so; a failure is said, not hidden', async () => {
  await signInAs('good');
  let r = await call('/api/accounts/claude-login/logout', {});
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(fs.existsSync(MARK), false, 'Claude Code itself removed the sign-in');
  assert.equal(loginSeen().loggedIn, false);
  assert.equal((await call('/api/state')).json.profiles.find((p) => p.name === 'sub').signedIn, false);
  assert.deepEqual((await call('/api/accounts/claude-login/account')).json, { loggedIn: false, plan: null, email: null, org: null });
  assert.equal((await call('/api/accounts/claude-login/logout', {})).status, 200, 'signed out already: the same answer as Claude Code gives');

  // while a sign-in is open, no sign-out underneath it
  await call('/api/accounts/claude-login/start', {}, { remote: true });
  r = await call('/api/accounts/claude-login/logout', {});
  assert.equal(r.status, 409);
  assert.match(r.json.error, /sign-in is in progress/);
  await call('/api/accounts/claude-login/code', { code: 'good#st4te789' });

  // Claude Code refuses
  process.env.FAKE_CLAUDE_MODE = 'exit';
  r = await call('/api/accounts/claude-login/logout', {});
  delete process.env.FAKE_CLAUDE_MODE;
  assert.equal(r.status, 502);
  assert.match(r.json.error, /did not sign out \(Logout failed: could not save the config file\)/);
  assert.ok(fs.existsSync(MARK));

  // it says it signed out, but still reports a sign-in
  const app2 = createServer({ backend, watch: false, claudeLogin: { times: TIMES, logout: async () => ({ ok: true }) } });
  const { port: p2 } = await app2.listen(0, '127.0.0.1');
  try {
    const b2 = `http://127.0.0.1:${p2}`;
    const l = await fetch(`${b2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify({ password: 'right-password' }) });
    const res = await fetch(`${b2}/api/accounts/claude-login/logout`, { method: 'POST', headers: { Origin: b2, Cookie: l.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /still reports a sign-in/);
  } finally {
    await app2.close();
  }
  signOut();
});

test('another account signed in with /login in a terminal: noticed at the next look, not at the half-hourly check', async () => {
  const { signInWatch } = await import('../../src/claudecode.mjs');
  signOut();
  await signInAs('good');
  markLimited('sub', { until: Date.now() + 2 * HOUR, text: "You've hit your 5-hour limit" });
  saveProfileUsage('sub', { at: Date.now() - 1000, fiveHour: { pct: 100, resetsAt: Date.now() + 2 * HOUR } });
  // the stand-in keeps its sign-in in MARK, as Claude Code keeps it in .credentials.json; `ask` is the real check
  const w = signInWatch({ file: MARK, platform: 'linux' });
  await w.check();
  assert.ok(limitedProfiles().sub, 'nothing changed: the mark stays');
  await w.check();
  assert.ok(limitedProfiles().sub);
  // /login in a terminal: Claude Code writes the new sign-in
  fs.writeFileSync(MARK, 'other');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(MARK, t, t);
  await w.check();
  assert.equal(limitedProfiles().sub, undefined, 'the earlier account\'s limit mark is gone');
  assert.equal(profileUsage().sub, undefined, 'and its figures');
  const sub = (await call('/api/state')).json.profiles.find((p) => p.name === 'sub');
  assert.deepEqual([sub.limited, sub.plan], [null, 'pro']);
  signOut();
});

test('the sign-in watch: one check per change, none for its own write; blind (Keychain) only while a mark stands', async () => {
  const { signInWatch } = await import('../../src/claudecode.mjs');
  const file = path.join(box.root, 'creds-watch');
  let clock = 1_000_000;
  let asks = 0;
  let marked = false;
  let touchOnAsk = false;
  const touch = (s) => {
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, s, s);
  };
  const make = (platform) =>
    signInWatch({
      file,
      platform,
      now: () => clock,
      marked: () => marked,
      ask: async () => {
        asks++;
        if (touchOnAsk) touch(clock / 1000 + 77); // `claude auth status` refreshed the token
      },
    });
  // Linux, a file: only a change asks, and only once
  touch(100);
  let w = make('linux');
  await w.check();
  await w.check();
  assert.equal(asks, 0);
  touch(200);
  const a = w.check();
  assert.equal(w.check(), a, 'one check at a time');
  await a;
  assert.equal(asks, 1);
  await w.check();
  assert.equal(asks, 1, 'seen once');
  touchOnAsk = true;
  touch(300);
  await w.check();
  await w.check();
  assert.equal(asks, 2, 'what the check itself wrote is no new change');
  touchOnAsk = false;
  // a file is trustworthy: no asking on a timer, mark or not
  marked = true;
  clock += 3600_000;
  await w.check();
  assert.equal(asks, 2);
  // removed (signed out in a terminal): a change too
  fs.rmSync(file);
  await w.check();
  assert.equal(asks, 3);
  // no file (signed out, or the Keychain): every 5 minutes while a provider on the stored sign-in has a mark
  clock += 60_000;
  await w.check();
  assert.equal(asks, 3, 'not before 5 minutes');
  clock += 4 * 60_000;
  await w.check();
  assert.equal(asks, 4);
  marked = false;
  clock += 10 * 60_000;
  await w.check();
  assert.equal(asks, 4, 'no mark: nothing to set right');
  // macOS keeps the sign-in in the Keychain: a file there may be a stale fallback, so the timer applies as well
  touch(400);
  marked = true;
  w = make('darwin');
  await w.check();
  assert.equal(asks, 4, 'not at once: the server asks at start anyway');
  clock += 5 * 60_000;
  await w.check();
  assert.equal(asks, 5);
  // a failing check is not fatal and is tried again at the next change
  w = signInWatch({ file, platform: 'linux', now: () => clock, marked: () => false, ask: async () => { asks++; throw new Error('no'); } });
  await w.check();
  touch(500);
  await w.check();
  touch(600);
  await w.check();
  assert.equal(asks, 7);
});

test('nothing of the account or a key in any response but the account route\'s', () => {
  const all = bodies.join('\n');
  for (const secret of ['someone@example.invalid', 'other@example.invalid', 'Example Org', 'Other Org', 'provider-key-should-not-leak', 'shouldnotleak', 'sk-ant-']) assert.equal(all.includes(secret), false, secret);
  assert.ok(accountBodies.some((b) => b.includes('someone@example.invalid')), 'the account route is where the owner reads it');
  for (const secret of ['provider-key-should-not-leak', 'shouldnotleak', 'sk-ant-']) assert.equal(accountBodies.join('\n').includes(secret), false, secret);
});
