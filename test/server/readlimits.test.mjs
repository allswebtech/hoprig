// Refresh on the Providers page: ONE smallest question per subscription, asked by Claude Code itself (a stand-in program
// here) through the router's pass-through, pinned to that provider. The figures and the refused sign-in are what the
// router keeps of the answer. The read sends no request of its own (fetch is never called). A run leaves no trace, is
// ended after its time, and at most three run at once. One read in flight, a 30 second share, the page's own press only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('readlimits');
process.env.HOPRIG_RUN_FILE = 'a-session-run-record'; // a session's own variables must not reach a read
test.after(() => { delete process.env.HOPRIG_RUN_FILE; box.cleanup(); });

const { saveConfig } = await import('../../src/config.mjs');
const P = await import('../../src/profiles.mjs');
const RS = await import('../../src/routerstate.mjs');
const AS = await import('../../src/autoswitch.mjs');
const { createRouter, serveProbe } = await import('../../src/router.mjs');
const { createLimitReader, READ_ARGS, READ_LIMIT_MS, AT_ONCE } = await import('../../src/providers/readlimits.mjs');
const { accountsFeature } = await import('../../src/server/accounts.mjs');

const up = [];
const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    up.push({ url: req.url, token, apiKey: req.headers['x-api-key'] || null, bytes: body.length, text: body.toString('utf8'), headers: req.headers });
    const h = (o) => ({ 'content-type': 'application/json', ...o });
    if (token.endsWith('revoked')) return (res.writeHead(401, h({})), res.end('{}'));
    if (token.endsWith('limited')) return (res.writeHead(429, h({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset), 'anthropic-ratelimit-unified-5h-utilization': '1', 'anthropic-ratelimit-unified-5h-reset': String(reset), 'anthropic-ratelimit-unified-7d-utilization': '0.2', 'anthropic-ratelimit-unified-7d-reset': String(reset + 86400) })), res.end('{}'));
    if (token.endsWith('good') || token.startsWith('stored-')) return (res.writeHead(200, h({ 'anthropic-ratelimit-unified-5h-utilization': '0.41', 'anthropic-ratelimit-unified-5h-reset': String(reset), 'anthropic-ratelimit-unified-7d-utilization': '0.33', 'anthropic-ratelimit-unified-7d-reset': String(reset + 86400) })), res.end('{}'));
    return (res.writeHead(200, h({})), res.end('{}'));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
process.env.HOPRIG_ANTHROPIC_URL = `http://127.0.0.1:${upstream.address().port}`;
test.after(() => { upstream.close(); });
// The long-lived router that sessions use: it must never know the probe path.
const rkey = 'k'.repeat(32);
const routerServer = createRouter({ key: rkey });
await new Promise((r) => routerServer.listen(0, '127.0.0.1', r));
test.after(() => { routerServer.close(); });

// The stand-in for Claude Code: it makes the request Claude Code makes (its own credentials, the base address it was given)
// and writes down what it was started with. A token ending in "hang" never answers and has a child of its own.
const marks = path.join(box.root, 'marks');
fs.mkdirSync(marks);
const standIn = path.join(box.root, 'standin-claude.mjs');
fs.writeFileSync(standIn, `
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || 'stored-' + process.env.HOPRIG_PROFILE;
const log = ${JSON.stringify(marks)} + '/' + process.env.HOPRIG_PROFILE + '.json';
fs.writeFileSync(log, JSON.stringify({ args, cwd: process.cwd(), cwdFiles: fs.readdirSync('.'), runFile: process.env.HOPRIG_RUN_FILE || null, base: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY || null, noMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS || null, quiet: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || null, start: Date.now(), pid: process.pid }));
if (token.endsWith('hang')) {
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(log + '.kid', String(kid.pid));
  setInterval(() => {}, 1000);
} else {
  const u = new URL(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true');
  const body = JSON.stringify({ model: args[args.indexOf('--model') + 1], max_tokens: 1, messages: [{ role: 'user', content: args[1] }] });
  const wait = token.endsWith('slow') ? 500 : 0;
  setTimeout(() => {
    const req = http.request(u, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-claude-code-session-id': '0123456789abcdef0123456789abcdef0123' } }, (res) => {
      res.resume();
      res.on('end', () => { fs.appendFileSync(log + '.end', String(Date.now())); process.exit(res.statusCode < 300 ? 0 : 1); });
    });
    req.end(body);
  }, wait);
}
`);
const command = { command: process.execPath, args: [standIn] };
const marked = (name) => JSON.parse(fs.readFileSync(path.join(marks, `${name}.json`), 'utf8'));

P.writeProfile('good', { label: 'Good', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-good' } });
P.writeProfile('revoked', { label: 'Revoked', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-revoked' } });
P.writeProfile('quiet', { label: 'Quiet', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-quiet' } });
P.writeProfile('limited', { label: 'Limited', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-limited' } });
P.writeProfile('stored', { label: 'Stored', env: {} }); // the stored sign-in: no key of its own
P.writeProfile('apik', { label: 'Api', env: { ANTHROPIC_API_KEY: 'made-up-key-apik' } });
saveConfig({ autoSwitch: { enabled: true, order: ['limited', 'apik', 'good', 'revoked', 'quiet', 'stored'] } });
RS.saveProfileUsage('quiet', { at: 5, fiveHour: { pct: 10, resetsAt: Date.now() + 3600_000 } });
RS.noteRefused('good', 'Claude answered 401'); // a good answer takes the refusal away

let t = Date.now();
const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { fetchCalls.push(String(a[0])); return realFetch(...a); };
test.after(() => { globalThis.fetch = realFetch; });
const loginSeen = [];
const reader = (extra = {}) => createLimitReader({ now: () => t, command, loginStatus: async () => { loginSeen.push(1); return { loggedIn: true }; }, limitMs: 20_000, ...extra });

test('each subscription is read by one run of Claude Code through the router; figures and refusal are what the router kept', async () => {
  const r = await reader().read();
  const by = Object.fromEntries(r.results.map((x) => [x.name, x]));
  assert.equal(by.good.read, 'figures');
  assert.equal(by.limited.read, 'figures');
  assert.equal(by.stored.read, 'figures', 'the stored sign-in is read now');
  assert.equal(by.revoked.ok, false);
  assert.equal(by.revoked.read, 'signin');
  assert.equal(by.quiet.read, 'none');
  assert.equal(by.apik.read, 'none');
  assert.equal(by.apik.ok, true);
  assert.equal(RS.profileUsage().good.fiveHour.pct, 41);
  assert.equal(RS.profileUsage().good.week.pct, 33);
  assert.equal(RS.refusedOf('good'), null, 'a good answer clears the refusal');
  assert.ok(RS.refusedOf('revoked'));
  assert.equal(RS.profileUsage().quiet.fiveHour.pct, 10, 'no headers: the old figures stay');
  assert.equal(RS.providerFacts(P.readProfile('revoked')).signedIn, false);
  // five runs, one request each: the stand-in's own credentials, passed on untouched; nothing for the API key
  assert.equal(up.length, 5);
  assert.deepEqual(up.map((x) => x.token).sort(), ['made-up-key-good', 'made-up-key-limited', 'made-up-key-quiet', 'made-up-key-revoked', 'stored-stored']);
  assert.ok(up.every((x) => x.apiKey === null && x.url.startsWith('/v1/messages')));
  assert.deepEqual(fetchCalls, [], 'the read sends no request of its own');
  assert.equal(loginSeen.length, 1, 'the stored sign-in is checked once, only by Claude Code own status');
});

test('the run is the smallest question, with nothing a person could see or resume', () => {
  const m = marked('good');
  assert.deepEqual(m.args, READ_ARGS);
  assert.deepEqual(m.args.slice(0, 4), ['-p', '.', '--model', 'haiku']);
  assert.ok(!m.args.some((a) => /\d{8}/.test(a)), 'no dated model name');
  for (const a of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(m.args.includes(a), a);
  assert.equal(m.args[m.args.indexOf('--tools') + 1], '');
  assert.equal(m.runFile, null, 'no run record of a session reaches it');
  assert.deepEqual(m.cwdFiles, [], 'an empty folder');
  assert.ok(m.cwd.startsWith(box.state) || fs.realpathSync(m.cwd).startsWith(fs.realpathSync(box.state)), 'a folder of Hoprig own state');
  assert.ok(m.base.includes('/probe/good'), 'pinned to its provider');
  assert.equal(m.apiKey, null);
  assert.equal(m.noMds, '1');
  assert.equal(m.quiet, '1');
});

test('it is no session and no stop of work: no record, no session of the router', async () => {
  const { listRuns } = await import('../../src/runs.mjs');
  assert.deepEqual(listRuns().map((x) => x.profile || x.name), []);
  assert.deepEqual(RS.routerSessions(), {});
});

test('an account at its limit is learnt as at its limit, with its time back; Auto mode moves nothing', () => {
  const l = AS.limitedProfiles();
  assert.ok(l.limited, 'marked at its limit');
  assert.equal(Math.round(l.limited.until / 1000), reset);
  assert.equal(RS.profileUsage().limited.status, 'rejected');
  assert.ok(!('good' in l) && !('revoked' in l), 'a refused sign-in is not a limit and only the limited one is marked');
  // the request of the limited account went to it alone, never to the API key that follows it in the order
  assert.deepEqual(up.filter((x) => x.token === 'made-up-key-limited').length, 1);
  assert.ok(up.every((x) => x.token !== 'made-up-key-apik' && x.apiKey !== 'made-up-key-apik'));
});

test('a second press within 30 seconds gets the same answer; later it asks again; one account alone', async () => {
  const r = reader();
  t += 100_000;
  const a = await r.read();
  const n = up.length;
  const again = await r.read();
  assert.equal(up.length, n);
  assert.equal(again, a);
  t += 31_000;
  const alone = await r.read({ name: 'good' });
  assert.equal(up.length, n + 1);
  assert.deepEqual(alone.results.map((x) => x.name), ['good']);
});

test('one read in flight: a press while it runs gets that read', async () => {
  t += 100_000;
  const r = reader();
  const n = up.length;
  const [a, b] = await Promise.all([r.read({ name: 'quiet' }), r.read({ name: 'quiet' })]);
  assert.equal(a, b);
  assert.equal(up.length, n + 1);
});

test('at most three runs at once', async () => {
  for (const n of ['s1', 's2', 's3', 's4', 's5']) P.writeProfile(n, { label: n, env: { CLAUDE_CODE_OAUTH_TOKEN: `made-up-key-${n}slow` } });
  t += 100_000;
  await reader().read();
  const spans = ['s1', 's2', 's3', 's4', 's5'].map((n) => [marked(n).start, Number(fs.readFileSync(path.join(marks, `${n}.json.end`), 'utf8'))]);
  let peak = 0;
  for (const [s] of spans) peak = Math.max(peak, spans.filter(([a, b]) => a <= s && s < b).length);
  assert.ok(peak <= 3, `peak ${peak}`);
  for (const n of ['s1', 's2', 's3', 's4', 's5']) P.deleteProfile(n);
});

test('a run that does not answer is ended with its whole process group and reported as no answer', async () => {
  P.writeProfile('stuck', { label: 'Stuck', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-hang' } });
  t += 100_000;
  const r = await reader({ limitMs: 1500 }).read({ name: 'stuck' });
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /did not answer/);
  const m = marked('stuck');
  const kid = Number(fs.readFileSync(path.join(marks, 'stuck.json.kid'), 'utf8'));
  await new Promise((x) => setTimeout(x, 2500));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(m.pid), false);
  assert.equal(alive(kid), false, 'the child of the run is ended too');
  P.deleteProfile('stuck');
});

test('on Windows the run is ended as a tree and its slot is freed only after that', async () => {
  const { EventEmitter } = await import('node:events');
  P.writeProfile('winr', { label: 'Winr', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-good' } });
  const calls = [];
  let freed = false;
  const spawnImpl = (cmd, args) => {
    calls.push([cmd, args]);
    const c = new EventEmitter();
    c.pid = 4242;
    c.kill = () => true;
    if (cmd === 'taskkill') setTimeout(() => { freed = true; c.emit('exit', 0); }, 150);
    return c;
  };
  t += 100_000;
  const r = await reader({ spawnImpl, platform: 'win32', limitMs: 200 }).read({ name: 'winr' });
  P.deleteProfile('winr');
  assert.equal(r.results[0].read, 'none');
  assert.match(r.results[0].error, /did not answer/);
  assert.deepEqual(calls.filter(([c]) => c === 'taskkill').map(([, a]) => a), [['/PID', '4242', '/T', '/F']]);
  assert.equal(freed, true, 'the slot came back only after the tree was ended');
});

test('a pass-through that cannot be served is said, not hidden; no run is started', async () => {
  const before = fs.existsSync(path.join(marks, 'good.json')) ? marked('good').start : null;
  t += 100_000;
  const r = await reader({ probe: async () => { throw new Error('no free port'); } }).read({ name: 'good' });
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /no free port/);
  assert.equal(fs.existsSync(path.join(marks, 'good.json')) ? marked('good').start : null, before, 'no run was started');
});

test('a stored sign-in that is signed out, or billed by use, starts no run', async () => {
  const n = up.length;
  t += 100_000;
  const out = await reader({ loginStatus: async () => ({ loggedIn: false }) }).read({ name: 'stored' });
  assert.equal(out.results[0].read, 'signin');
  t += 100_000;
  const paid = await reader({ loginStatus: async () => ({ loggedIn: true, method: 'api_key' }) }).read({ name: 'stored' });
  assert.equal(paid.results[0].read, 'none');
  assert.match(paid.results[0].error, /billed by use/);
  // the check of an earlier moment said so (billedLogin): the answer of this one does not undo it
  RS.rememberLogin({ loggedIn: true, method: 'api_key', account: 'acct-made-up' });
  t += 100_000;
  const seen = await reader({ loginStatus: async () => ({ loggedIn: true }) }).read({ name: 'stored' });
  RS.rememberLogin({ loggedIn: true, method: 'claude.ai', account: 'acct-made-up' });
  assert.equal(seen.results[0].read, 'none');
  assert.match(seen.results[0].error, /billed by use/);
  assert.equal(up.length, n, 'nothing was asked of Anthropic for any of the three');
});

test('a good read takes away the ten-minute pause of an earlier refusal, and only that kind', async () => {
  AS.markLimited('good', { reason: 'auth', text: 'refused' });
  AS.markLimited('quiet', { reason: 'auth', text: 'refused' }); // its read has no figures but is a 200 too
  t += 100_000;
  await reader().read({ name: 'good' });
  assert.ok(!('good' in AS.limitedProfiles()), 'proved to work: the pause is gone');
  AS.markLimited('good', { reason: 'rate_limit', text: 'limit' });
  t += 100_000;
  await reader().read({ name: 'good' });
  assert.ok('good' in AS.limitedProfiles(), 'a limit is not an auth pause: it stays');
  AS.clearLimited('good');
  AS.clearLimited('quiet');
});

// ---- the pass-through the read brings itself ----

const readOnce = async (name, probe) => { t += 100_000; return reader({ probe }).read({ name }); };
const refusedConnect = async (url) => { try { await realFetch(url, { method: 'POST', body: '{}' }); return false; } catch { return true; } };

test('the pass-through is served for the read only: it is closed when the read ends, and also when the read fails', async () => {
  const urls = [];
  const watched = async () => { const s = await serveProbe(); urls.push(s.url); return s; };
  const ok = await readOnce('good', watched);
  assert.equal(ok.results[0].read, 'figures');
  assert.equal(await refusedConnect(`${urls[0]}/probe/good/v1/messages`), true, 'closed after a read that was answered');
  const bad = await reader({ probe: watched, command: { command: path.join(box.root, 'no-such-program'), args: [] } }).read({ name: 'quiet' });
  assert.equal(bad.results[0].ok, false);
  assert.equal(await refusedConnect(`${urls[1]}/probe/quiet/v1/messages`), true, 'closed after a read that failed');
});

test('the pass-through answers only its own secret and /probe/<a subscription of this computer>/; anything else is 404 and nothing is passed on', async () => {
  const s = await serveProbe();
  const n = up.length;
  const post = (url) => realFetch(url, { method: 'POST', headers: { authorization: 'Bearer made-up-key-good', 'content-type': 'application/json' }, body: '{"model":"x"}' });
  const base = s.url;
  const origin = new URL(base).origin;
  const secret = new URL(base).pathname;
  try {
    for (const url of [
      `${origin}/probe/good/v1/messages`, // no secret
      `${origin}/${'0'.repeat(32)}/probe/good/v1/messages`, // another secret
      `${base}/as/good/v1/messages`, // a session's path
      `${base}/v1/messages`, // an automatic choice
      `${base}/__router`,
      `${base}/probe/apik/v1/messages`, // a key billed by use is no subscription
      `${base}/probe/nobody/v1/messages`,
      `${origin}${secret}x/probe/good/v1/messages`,
    ]) assert.equal((await post(url)).status, 404, url.replace(secret, '/<secret>'));
    assert.equal(up.length, n, 'nothing was passed on');
    assert.equal((await post(`${base}/probe/good/v1/messages`)).status, 200, 'its own path works');
  } finally { await s.close(); }
});

test('the long-lived router does not know the probe path any more: 404, nothing passed on, and it says nothing of it', async () => {
  const n = up.length;
  const res = await realFetch(`http://127.0.0.1:${routerServer.address().port}/${rkey}/probe/good/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer made-up-key-good' }, body: '{}' });
  assert.equal(res.status, 404);
  assert.equal(up.length, n);
  const j = await (await realFetch(`http://127.0.0.1:${routerServer.address().port}/${rkey}/__router`)).json();
  assert.ok(!('probe' in j));
});

test('the read changes no header and no body of the request Claude Code made, and applies no model map', async () => {
  P.writeProfile('mapped', { label: 'Mapped', models: '*=some-other-model', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-good' } });
  const s = await serveProbe();
  const body = '{"model":"claude-haiku-made-up","max_tokens":1,"messages":[{"role":"user","content":"."}]}';
  const n = up.length;
  try {
    const res = await realFetch(`${s.url}/probe/mapped/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer made-up-key-good', 'content-type': 'application/json', 'anthropic-beta': 'oauth-made-up,claude-code-made-up', 'x-app': 'cli' }, body });
    assert.equal(res.status, 200);
  } finally { await s.close(); P.deleteProfile('mapped'); }
  const got = up[n];
  assert.equal(got.text, body, 'the body is exactly what was sent: the model map of the provider is not applied');
  assert.equal(got.headers['anthropic-beta'], 'oauth-made-up,claude-code-made-up');
  assert.equal(got.headers['x-app'], 'cli');
  assert.equal(got.token, 'made-up-key-good');
});

test('a refused sign-in is asked once by the read and Claude Code is told not to ask again', async () => {
  const s = await serveProbe();
  const n = up.length;
  try {
    const res = await realFetch(`${s.url}/probe/revoked/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer made-up-key-revoked' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-should-retry'), 'false');
  } finally { await s.close(); }
  assert.equal(up.length, n + 1, 'one request upstream');
});

test('what a read keeps is in files: a process made separately sees the figures, the refusal and the limit mark', async () => {
  t += 100_000;
  await reader().read();
  const { execFileSync } = await import('node:child_process');
  const here = path.resolve(import.meta.dirname, '..', '..', 'src');
  const script = `const RS = await import(${JSON.stringify(path.join(here, 'routerstate.mjs'))});
const AS = await import(${JSON.stringify(path.join(here, 'autoswitch.mjs'))});
const u = RS.profileUsage(Date.now());
console.log(JSON.stringify({ good: u.good && u.good.fiveHour && u.good.fiveHour.pct, limited: u.limited && u.limited.status, refused: Boolean(RS.refusedOf('revoked')), mark: Boolean(AS.limitedProfiles().limited) }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' }));
  assert.deepEqual(out, { good: 41, limited: 'rejected', refused: true, mark: true });
});

const feature = accountsFeature({ readJson: async (req) => req.body, state: async () => ({ profiles: [] }), caller: () => who, clientIp: () => '127.0.0.1', config: () => ({}) }, { gateways: [], now: () => t, readLimits: { command, limitMs: 20_000, loginStatus: async () => ({ loggedIn: true }) } });
let who = 'page';
const route = (method, url) => {
  const r = feature.routes.find(([m, re]) => m === method && re.test(url));
  return (body) => r[2]({ body }, url.match(r[1]));
};

test('the route answers its shape and tells when the limits were read', async () => {
  t += 100_000;
  const r = await route('POST', '/api/accounts/limits/read')({ name: 'good' });
  assert.deepEqual(r.results.map((x) => x.name), ['good']);
  assert.equal((await route('GET', '/api/accounts')()).limitsReadAt, r.at);
});

test('only the page may press it', async () => {
  who = 'token';
  await assert.rejects(() => route('POST', '/api/accounts/limits/read')({}), (e) => e.status === 403);
  who = 'page';
});

test('one run is ended after 25 seconds: eight accounts, three at a time, stay under the 100 seconds a public proxy allows', () => {
  assert.equal(READ_LIMIT_MS, 25_000);
  assert.equal(AT_ONCE, 3);
  assert.ok(Math.ceil(8 / AT_ONCE) * READ_LIMIT_MS <= 100_000 - 25_000, 'at most about 75 seconds');
});

test('the dashboard stopping during a read ends the run and its pass-through', async () => {
  const { spawn } = await import('node:child_process');
  P.writeProfile('closing', { label: 'Closing', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-key-good' } });
  let kid = null;
  let served = null;
  const spawnImpl = (cmd, args, opts) => {
    kid = spawn('sleep', ['60'], { ...opts, stdio: 'ignore' }); // a run that never ends by itself
    return kid;
  };
  const probe = async () => { served = await serveProbe(); return served; };
  const f = accountsFeature({ readJson: async (req) => req.body, state: async () => ({ profiles: [] }), caller: () => 'page', clientIp: () => '127.0.0.1', config: () => ({}) }, { gateways: [], now: () => t, readLimits: { command, limitMs: 60_000, spawnImpl, probe, loginStatus: async () => ({ loggedIn: true }) } });
  t += 100_000;
  const r = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/accounts/limits/read'));
  const reading = r[2]({ body: { name: 'closing' } }, '/api/accounts/limits/read'.match(r[1]));
  for (let i = 0; i < 50 && !kid; i++) await new Promise((x) => setTimeout(x, 50));
  assert.ok(kid && kid.pid, 'the run started');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(kid.pid), true);
  f.close();
  for (let i = 0; i < 50 && alive(kid.pid); i++) await new Promise((x) => setTimeout(x, 50));
  assert.equal(alive(kid.pid), false, 'the run was ended with the dashboard');
  await reading;
  const gone = await new Promise((res) => http.get(served.url, () => res(false)).on('error', () => res(true)));
  assert.equal(gone, true, 'the pass-through is closed');
  P.deleteProfile('closing');
});
