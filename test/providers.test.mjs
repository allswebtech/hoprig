// What the Providers page is told about each provider beyond its name: the last known plan usage with its time
// (kept after the session that showed it ended), whether the stored sign-in is there, its plan, and whether that
// plan reports usage at all. Files in a scratch state folder; the last test reads them through the real server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('providers');
test.after(() => box.cleanup());
const S = await import('../src/routerstate.mjs');
const R = await import('../src/runs.mjs');
const P = await import('../src/profiles.mjs');
const C = await import('../src/claudecode.mjs');

const HOUR = 3600 * 1000;
const usageFileOfStore = () => path.join(box.state, 'usage.json');

test('usage is kept per provider with the time it was seen; a window whose reset has passed is left out', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  // the router's figures (as it saves them), seen two hours ago
  S.saveProfileUsage('sub', { at: now - 2 * HOUR, fiveHour: { pct: 84, resetsAt: now + HOUR }, week: { pct: 30, resetsAt: now + 3 * 24 * HOUR }, status: 'allowed' });
  assert.deepEqual(S.profileUsage(now).sub, { at: now - 2 * HOUR, fiveHour: { pct: 84, resetsAt: now + HOUR }, week: { pct: 30, resetsAt: now + 3 * 24 * HOUR }, status: 'allowed' });
  // two hours later the 5-hour window has reset: it goes, and with it the router's status (it was about that moment)
  const later = S.profileUsage(now + 2 * HOUR).sub;
  assert.deepEqual(later, { at: now - 2 * HOUR, week: { pct: 30, resetsAt: now + 3 * 24 * HOUR } });
  // after the weekly reset nothing is left to show
  assert.equal(S.profileUsage(now + 4 * 24 * HOUR).sub, undefined);
  // a window without a reset time is believed only as long as such a window lasts
  S.saveProfileUsage('other', { at: now, fiveHour: { pct: 10, resetsAt: null }, week: { pct: 20, resetsAt: null } });
  assert.deepEqual(Object.keys(S.profileUsage(now + 6 * HOUR).other), ['at', 'week']);
  assert.equal(S.profileUsage(now + 8 * 24 * HOUR).other, undefined);
});

test('figures from a session are kept when they are newer; never for "auto"; the same figures are not rewritten within a minute', () => {
  const t = Date.now();
  const u = { fiveHour: { pct: 40, resetsAt: t + HOUR } };
  assert.equal(S.rememberUsage('work', u, t), true);
  assert.equal(S.rememberUsage('work', u, t + 5000), false, 'same figures, seconds later');
  assert.equal(S.rememberUsage('work', { fiveHour: { pct: 41, resetsAt: t + HOUR } }, t + 6000), true, 'new figures');
  assert.equal(S.rememberUsage('work', { fiveHour: { pct: 1, resetsAt: t + HOUR } }, t - 1000), false, 'older than what is stored');
  assert.equal(S.rememberUsage('auto', u, t + 9000), false);
  assert.equal(S.rememberUsage('work', {}, t + 9000), false);
  assert.deepEqual(S.profileUsage(t + 7000).work, { at: t + 6000, fiveHour: { pct: 41, resetsAt: t + HOUR } });
  assert.equal(S.profileUsage(t).auto, undefined);
});

test('a run\'s usage outlives the run: listed with its time while it runs, still known for its provider afterwards', () => {
  P.writeProfile('max1', { label: 'Max' });
  const { file, run } = R.createRun({ profile: 'max1', cwd: box.root });
  const resets = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(R.usageFile(file), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 61.6, resets_at: resets }, seven_day: { used_percentage: 12, resets_at: resets + 86400 } } }));
  const written = Math.round(fs.statSync(R.usageFile(file)).mtimeMs);
  const listed = R.listRuns().find((r) => r.runId === run.runId);
  assert.deepEqual(listed.usage, { fiveHour: { pct: 62, resetsAt: resets * 1000 }, week: { pct: 12, resetsAt: (resets + 86400) * 1000 }, at: written });
  R.removeRun(file);
  assert.equal(R.listRuns().some((r) => r.runId === run.runId), false);
  assert.deepEqual(S.profileUsage().max1, { at: written, fiveHour: { pct: 62, resetsAt: resets * 1000 }, week: { pct: 12, resetsAt: (resets + 86400) * 1000 } });
  // a plan that reports nothing leaves no entry
  const quiet = R.createRun({ profile: 'team1', cwd: box.root });
  fs.writeFileSync(R.usageFile(quiet.file), JSON.stringify({ model: { id: 'x' } }));
  assert.equal(R.listRuns().find((r) => r.runId === quiet.run.runId).usage, undefined);
  R.removeRun(quiet.file);
  assert.equal(S.profileUsage().team1, undefined);
});

test('the sign-in check leaves its answer for the page: signedIn, plan, and whether that plan reports usage', async () => {
  const login = { name: 'sub', kind: 'login' };
  fs.rmSync(path.join(box.state, 'claude-login.json'), { force: true });
  fs.rmSync(usageFileOfStore(), { force: true });
  assert.deepEqual(S.providerFacts(login), { signedIn: null, plan: null, usageReported: null, accountAt: null }, 'nobody checked yet');
  // the real check, against a stand-in Claude Code: not signed in
  const bin = path.join(box.root, 'bin');
  fs.mkdirSync(bin);
  const claude = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  claude(`echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`);
  await C.claudeLoginStatus({ env });
  assert.deepEqual(S.providerFacts(login), { signedIn: false, plan: null, usageReported: null, accountAt: null });
  // signed in on a Team plan: Claude Code gives no usage figures to that plan, and the page can say so
  claude(`echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"someone@example.com","orgName":"Org"}'`);
  await C.claudeLoginStatus({ env });
  assert.deepEqual(S.providerFacts(login), { signedIn: true, plan: 'team', usageReported: false, accountAt: null });
  const kept = fs.readFileSync(path.join(box.state, 'claude-login.json'), 'utf8');
  assert.doesNotMatch(kept, /someone@example\.com|someone|example|Org/i, 'nothing personal is kept');
  // who it is stays a fingerprint made with a random value of this computer: 16 hex characters that name nobody
  assert.deepEqual(Object.keys(JSON.parse(kept)).sort(), ['account', 'accountAt', 'at', 'loggedIn', 'plan', 'salt']);
  assert.match(JSON.parse(kept).account, /^[0-9a-f]{16}$/);
  assert.equal(JSON.parse(kept).accountAt, null, 'the first account seen is no change');
  // a check that may change nothing leaves the answer alone
  claude(`echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`);
  await C.claudeLoginStatus({ env, remember: false });
  assert.equal(S.providerFacts(login).signedIn, true);
  // Pro, Max and Ultra report usage
  for (const plan of ['pro', 'max', 'ultra']) {
    S.rememberLogin({ loggedIn: true, plan }, Date.now() + 120_000);
    assert.deepEqual(S.providerFacts(login), { signedIn: true, plan, usageReported: true, accountAt: null });
  }
  // figures that were seen settle it, whatever the plan says (the router reads them from Anthropic's answers)
  S.rememberLogin({ loggedIn: true, plan: 'team' }, Date.now() + 240_000);
  S.rememberUsage('sub', { week: { pct: 5, resetsAt: Date.now() + HOUR } });
  assert.equal(S.providerFacts(login).usageReported, true);
  // a provider with its own token is signed in by what it is; an API key has none of these fields
  assert.deepEqual(S.providerFacts({ name: 'second', kind: 'subscription' }), { signedIn: true, plan: null, usageReported: null });
  assert.deepEqual(S.providerFacts({ name: 'api', kind: 'api' }), {});
});

test('another account signs in: the limit marks and figures of the providers on the stored sign-in go; nothing else does', async () => {
  const A = await import('../src/autoswitch.mjs');
  for (const f of ['claude-login.json', 'usage.json', 'limits.json']) fs.rmSync(path.join(box.state, f), { force: true });
  for (const p of P.listProfiles()) P.deleteProfile(p.name);
  P.writeProfile('sub', { label: 'Stored sign-in' });
  P.writeProfile('second', { label: 'Own token', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-not-a-real-token-000000000000' } });
  const bin = path.join(box.root, 'bin2');
  fs.mkdirSync(bin);
  const signedInAs = (email, org) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho '${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email, orgId: org, orgName: 'Org' })}'\n`, { mode: 0o755 });
  const signedOut = () => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho '{"loggedIn":false,"authMethod":"none"}'; exit 1\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  const atLimit = () => {
    const now = Date.now();
    A.markLimited('sub', { until: now + 2 * HOUR, text: "You've hit your 5-hour limit" });
    A.markLimited('second', { until: now + 2 * HOUR, text: "You've hit your 5-hour limit" });
    for (const n of ['sub', 'second']) S.saveProfileUsage(n, { at: now - 1000, fiveHour: { pct: 100, resetsAt: now + 2 * HOUR }, week: { pct: 60, resetsAt: now + 50 * HOUR } });
  };
  signedInAs('first@example.invalid', 'org-1');
  let a = await C.claudeAccount({ env });
  assert.deepEqual([a.loggedIn, a.plan, a.email, a.org, a.changed], [true, 'max', 'first@example.invalid', 'Org', false]);
  assert.equal((await C.claudeLoginStatus({ env })).email, undefined, 'the plain check names nobody');
  atLimit();
  // the same account again (a new sign-in of it, a refreshed token): nothing is forgotten
  a = await C.claudeAccount({ env });
  assert.equal(a.changed, false);
  assert.deepEqual(Object.keys(A.limitedProfiles()).sort(), ['second', 'sub']);
  assert.equal(S.profileUsage().sub.fiveHour.pct, 100);
  // signed out, and the same account back: still the same account
  signedOut();
  assert.deepEqual([(a = await C.claudeAccount({ env })).loggedIn, a.email, a.changed], [false, null, false]);
  signedInAs('first@example.invalid', 'org-1');
  assert.equal((await C.claudeAccount({ env })).changed, false);
  assert.deepEqual(Object.keys(A.limitedProfiles()).sort(), ['second', 'sub']);
  // another account: the stored sign-in's provider starts fresh; the provider with its own token is not touched
  signedInAs('second@example.invalid', 'org-1');
  a = await C.claudeAccount({ env });
  assert.deepEqual([a.email, a.changed], ['second@example.invalid', true]);
  assert.deepEqual(Object.keys(A.limitedProfiles()), ['second']);
  assert.equal(S.profileUsage().sub, undefined, 'the earlier account\'s figures are gone');
  assert.equal(S.profileUsage().second.fiveHour.pct, 100);
  const facts = S.providerFacts({ name: 'sub', kind: 'login' });
  assert.ok(facts.accountAt > Date.now() - 5000, 'when another account was last signed in');
  assert.equal(facts.usageReported, true, 'Max reports usage; the forgotten figures do not count as seen');
  // the same address in another organisation is another account too (its limits are that organisation's)
  signedInAs('second@example.invalid', 'org-2');
  assert.equal((await C.claudeAccount({ env })).changed, true);
  // nothing of who it is in the state folder
  for (const f of fs.readdirSync(box.state)) {
    if (!fs.statSync(path.join(box.state, f)).isFile()) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(box.state, f), 'utf8'), /example\.invalid|org-1|org-2/, f);
  }
});

test('a session that still shows the earlier account\'s figures does not bring them back', () => {
  for (const f of ['usage.json']) fs.rmSync(path.join(box.state, f), { force: true });
  const now = Date.now();
  const old = { fiveHour: { pct: 100, resetsAt: now + 2 * HOUR }, week: { pct: 60, resetsAt: now + 50 * HOUR } };
  S.rememberUsage('sub', old, now - 60_000);
  S.forgetUsage('sub', now);
  assert.equal(S.profileUsage().sub, undefined);
  // Claude Code hands its status line the last figures again, with a new time: still the earlier account's
  assert.equal(S.usageForgotten('sub', old), true);
  assert.equal(S.rememberUsage('sub', old, now + 5000), false);
  assert.equal(S.rememberUsage('sub', { fiveHour: old.fiveHour }, now + 6000), false, 'one window of it alone, too');
  const run = R.createRun({ profile: 'sub', cwd: box.root });
  fs.writeFileSync(R.usageFile(run.file), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 100, resets_at: Math.round((now + 2 * HOUR) / 1000) }, seven_day: { used_percentage: 60, resets_at: Math.round((now + 50 * HOUR) / 1000) } } }));
  assert.equal(R.listRuns().find((r) => r.runId === run.run.runId).usage, undefined, 'not on the session\'s card either');
  // the new account's first figures (other reset times) are taken up, and the old ones still cannot replace them
  const fresh = { fiveHour: { pct: 4, resetsAt: now + 5 * HOUR }, week: { pct: 1, resetsAt: now + 160 * HOUR } };
  assert.equal(S.usageForgotten('sub', fresh), false);
  assert.equal(S.rememberUsage('sub', fresh, now + 7000), true);
  assert.equal(S.rememberUsage('sub', old, now + 90_000), false);
  assert.equal(S.profileUsage().sub.fiveHour.pct, 4);
  // the router's own figures (read from Anthropic's answers) keep the memory of what was forgotten
  S.saveProfileUsage('sub', { at: now + 100_000, fiveHour: { pct: 6, resetsAt: now + 5 * HOUR } });
  assert.equal(S.rememberUsage('sub', old, now + 200_000), false);
  assert.equal(S.profileUsage().sub.fiveHour.pct, 6);
  // figures without a reset time say nothing about whose they are: the time decides, as before
  assert.equal(S.usageForgotten('sub', { fiveHour: { pct: 50, resetsAt: null } }), false);
  // once the forgotten windows have reset, nothing is remembered about them
  assert.equal(S.usageForgotten('sub', old, now + 60 * HOUR), false);
  R.removeRun(run.file);
});

test('the state the page reads carries them: profiles[].signedIn, .plan, .usageReported and .usage.at', async () => {
  const { saveConfig } = await import('../src/config.mjs');
  const { hashPassword } = await import('../src/server/auth.mjs');
  const { createServer } = await import('../src/server/server.mjs');
  for (const f of ['claude-login.json', 'usage.json']) fs.rmSync(path.join(box.state, f), { force: true });
  for (const p of P.listProfiles()) P.deleteProfile(p.name);
  P.writeProfile('sub', { label: 'Claude account (stored login)' });
  P.writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  saveConfig({ server: { backend: 'pty', roots: [box.root], passwordHash: await hashPassword('pw-for-tests') } });
  // The Providers list asks whether the gateway add-on answers on its port: a free port, so the answer never depends on
  // a gateway running on the computer that runs the tests (its default port is a real one's).
  saveConfig({ addons: { trouteai: { port: await (await import('../src/machines/tunnels.mjs')).freePort() } } });
  const seen = Date.now() - 2 * HOUR;
  S.rememberLogin({ loggedIn: false });
  const app = createServer({ watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'pw-for-tests' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => (await fetch(base + p, { headers: { Cookie: cookie } })).json();
    // nobody is signed in: the page can say "Not signed in" instead of "Available"
    let sub = (await get('/api/state')).profiles.find((p) => p.name === 'sub');
    assert.deepEqual([sub.signedIn, sub.plan, sub.usageReported, sub.usage], [false, null, null, null]);
    // signed in on Max, figures seen two hours ago by a session that has ended since
    S.rememberLogin({ loggedIn: true, plan: 'max' }, Date.now() + 120_000);
    S.saveProfileUsage('sub', { at: seen, fiveHour: { pct: 70, resetsAt: Date.now() + HOUR }, week: { pct: 20, resetsAt: Date.now() + 48 * HOUR } });
    const state = await get('/api/state');
    sub = state.profiles.find((p) => p.name === 'sub');
    assert.deepEqual([sub.signedIn, sub.plan, sub.usageReported], [true, 'max', true]);
    assert.equal(sub.usage.at, seen);
    assert.equal(sub.usage.fiveHour.pct, 70);
    // an API key has no sign-in fields
    const api = state.profiles.find((p) => p.name === 'api');
    assert.equal('signedIn' in api, false);
    assert.equal(api.usage, null);
    // the Providers list (GET /api/accounts) passes the same on
    const accounts = (await get('/api/accounts')).accounts;
    const a = accounts.find((x) => x.name === 'sub');
    assert.deepEqual([a.signedIn, a.plan, a.usageReported, a.usage.at], [true, 'max', true, seen]);
    assert.equal('signedIn' in accounts.find((x) => x.name === 'api'), false);
  } finally {
    await app.close();
  }
});
