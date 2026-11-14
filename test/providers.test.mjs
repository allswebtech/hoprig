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
  assert.deepEqual(S.providerFacts(login), { signedIn: null, plan: null, usageReported: null }, 'nobody checked yet');
  // the real check, against a stand-in Claude Code: not signed in
  const bin = path.join(box.root, 'bin');
  fs.mkdirSync(bin);
  const claude = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  claude(`echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`);
  await C.claudeLoginStatus({ env });
  assert.deepEqual(S.providerFacts(login), { signedIn: false, plan: null, usageReported: null });
  // signed in on a Team plan: Claude Code gives no usage figures to that plan, and the page can say so
  claude(`echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"someone@example.com","orgName":"Org"}'`);
  await C.claudeLoginStatus({ env });
  assert.deepEqual(S.providerFacts(login), { signedIn: true, plan: 'team', usageReported: false });
  const kept = fs.readFileSync(path.join(box.state, 'claude-login.json'), 'utf8');
  assert.doesNotMatch(kept, /someone@example\.com|Org/, 'nothing personal is kept');
  assert.deepEqual(Object.keys(JSON.parse(kept)).sort(), ['at', 'loggedIn', 'plan']);
  // a check that may change nothing leaves the answer alone
  claude(`echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`);
  await C.claudeLoginStatus({ env, remember: false });
  assert.equal(S.providerFacts(login).signedIn, true);
  // Pro, Max and Ultra report usage
  for (const plan of ['pro', 'max', 'ultra']) {
    S.rememberLogin({ loggedIn: true, plan }, Date.now() + 120_000);
    assert.deepEqual(S.providerFacts(login), { signedIn: true, plan, usageReported: true });
  }
  // figures that were seen settle it, whatever the plan says (the router reads them from Anthropic's answers)
  S.rememberLogin({ loggedIn: true, plan: 'team' }, Date.now() + 240_000);
  S.rememberUsage('sub', { week: { pct: 5, resetsAt: Date.now() + HOUR } });
  assert.equal(S.providerFacts(login).usageReported, true);
  // a provider with its own token is signed in by what it is; an API key has none of these fields
  assert.deepEqual(S.providerFacts({ name: 'second', kind: 'subscription' }), { signedIn: true, plan: null, usageReported: null });
  assert.deepEqual(S.providerFacts({ name: 'api', kind: 'api' }), {});
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
