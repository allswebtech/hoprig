// What is known about the providers, for everyone to read: where the router listens, which account serves which
// session right now, how much of each account's plan limits is used (as last seen, with the time), and whether the
// stored Claude sign-in is there. Small JSON files in the state folder; the router, the launcher and the checks
// write them, the launcher menus and the dashboard read them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { stateDir } from './paths.mjs';

export const DEFAULT_ROUTER_PORT = 7434;

const file = (name) => path.join(stateDir(), name);

function readJson(name, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

/**
 * The router's address. The key is part of the URL Claude Code is given: only this user's processes can read
 * it, so other users of the same computer cannot spend the accounts through the port. Key and port stay the
 * same across router restarts, because running sessions keep using the URL they were started with.
 */
export function routerAddress() {
  let saved = readJson('router-key.json', null);
  if (!saved || typeof saved.key !== 'string' || saved.key.length < 32) {
    saved = { key: crypto.randomBytes(24).toString('hex') };
    writeJson('router-key.json', saved);
  }
  const port = Number(loadConfig().router?.port) || DEFAULT_ROUTER_PORT;
  return { port, key: saved.key, url: `http://127.0.0.1:${port}/${saved.key}` };
}

/** Which account served each session last: { sessionId: { profile, at } }. Entries older than a day are dropped. */
export function routerSessions(now = Date.now()) {
  const all = readJson('router-sessions.json', {});
  const out = {};
  for (const [id, s] of Object.entries(all)) if (s && typeof s.profile === 'string' && now - s.at < 24 * 3600 * 1000) out[id] = s;
  return out;
}

export function saveRouterSessions(map) {
  writeJson('router-sessions.json', map);
}

// ---- plan usage: one store for both ways it is learnt ----------------------------------------------------------
// The router reads it from Anthropic's answers (usageFromHeaders below); a session that runs on one provider gets it
// from Claude Code's status data (runs.mjs: readUsage). Both end up here, the last figures per provider with the
// time they were seen (`at`), so they are still known when no session of that provider runs.

const usageStore = () => readJson('usage.json', {});

// A window whose reset time is not known cannot be shown for ever: it is dropped once it is older than itself.
const WINDOW_MS = { fiveHour: 5 * 3600 * 1000, week: 7 * 24 * 3600 * 1000 };

/**
 * Plan usage per provider as last seen: { name: { fiveHour?: { pct, resetsAt }, week?: { pct, resetsAt }, status?,
 * at } }. `at` is when the figures were seen (epoch ms). A window whose reset time has passed is left out (what it
 * said is no longer true), and with it the router's `status`; a provider with no window left has no entry. API
 * providers never have one.
 */
export function profileUsage(now = Date.now()) {
  const out = {};
  for (const [name, e] of Object.entries(usageStore())) {
    if (!e || typeof e !== 'object' || !Number.isFinite(e.at)) continue;
    const entry = { at: e.at };
    let dropped = false;
    for (const win of ['fiveHour', 'week']) {
      const w = e[win];
      if (!w || typeof w !== 'object') continue;
      if (w.resetsAt ? w.resetsAt <= now : now - e.at > WINDOW_MS[win]) dropped = true;
      else entry[win] = w;
    }
    if (!entry.fiveHour && !entry.week) continue;
    if (typeof e.status === 'string' && !dropped) entry.status = e.status;
    out[name] = entry;
  }
  return out;
}

// ---- figures of an account that is no longer signed in ----
// When another account signs in (claudecode.mjs: a sign-in check that sees another account), the provider's figures
// are forgotten. A session that still runs keeps writing the last figures it saw (Claude Code hands them to its
// status line again and again), and those are the earlier account's until its next answer. They are told apart by
// their reset times, which belong to an account: figures with the forgotten reset times are never taken up again.

const resetOf = (w) => (w && Number.isFinite(w.resetsAt) ? w.resetsAt : null);

/** The forgotten reset times that still lie ahead ({ fiveHour?, week? }), or null. */
function keptForgot(entry, now) {
  const f = entry && entry.forgot && typeof entry.forgot === 'object' ? entry.forgot : null;
  if (!f) return null;
  const out = {};
  for (const win of ['fiveHour', 'week']) if (Number.isFinite(f[win]) && f[win] > now) out[win] = f[win];
  return Object.keys(out).length ? out : null;
}

function isForgotten(entry, usage, now) {
  const f = keptForgot(entry, now);
  if (!f || !usage) return false;
  let same = false;
  for (const win of ['fiveHour', 'week']) {
    const r = resetOf(usage[win]);
    if (r === null) continue; // no reset time: it says nothing about whose figures these are
    if (!Number.isFinite(f[win]) || Math.abs(r - f[win]) > 60_000) return false;
    same = true;
  }
  return same;
}

/** True when `usage` are figures of the account that was signed in before (runs.mjs leaves them out of a card). */
export function usageForgotten(name, usage, now = Date.now()) {
  return isForgotten(usageStore()[name], usage, now);
}

/** The router's figures for one provider (they carry their own `at`). */
export function saveProfileUsage(name, entry, now = Date.now()) {
  const all = usageStore();
  const forgot = keptForgot(all[name], now);
  writeJson('usage.json', { ...all, [name]: forgot ? { ...entry, forgot } : entry });
}

/**
 * Forget a provider's figures: they belong to an account that is no longer the one signed in. What stays is the
 * time and the reset times of what was forgotten (see above), no figures.
 */
export function forgetUsage(name, now = Date.now()) {
  if (typeof name !== 'string' || !name || name === 'auto') return;
  const all = usageStore();
  const prev = all[name] && typeof all[name] === 'object' ? all[name] : {};
  const forgot = { ...(keptForgot(prev, now) || {}) };
  for (const win of ['fiveHour', 'week']) if (resetOf(prev[win]) !== null && resetOf(prev[win]) > now) forgot[win] = resetOf(prev[win]);
  writeJson('usage.json', { ...all, [name]: Object.keys(forgot).length ? { at: now, forgot } : { at: now } });
}

/**
 * Figures from a session's status data: kept when they are newer than what is stored. `at` is when Claude Code
 * wrote them. Nothing is written for the same figures within a minute, never for "auto" (not a provider: the
 * router keeps the figures of the accounts behind it), and never for figures of an account that is no longer signed
 * in. Returns whether the store changed.
 */
export function rememberUsage(name, usage, at = Date.now()) {
  if (typeof name !== 'string' || !name || name === 'auto' || !usage || !(usage.fiveHour || usage.week)) return false;
  const all = usageStore();
  const prev = all[name];
  if (isForgotten(prev, usage, at)) return false;
  const forgot = keptForgot(prev, at);
  const entry = { ...(usage.fiveHour ? { fiveHour: usage.fiveHour } : {}), ...(usage.week ? { week: usage.week } : {}), at, ...(forgot ? { forgot } : {}) };
  if (prev && Number.isFinite(prev.at)) {
    if (prev.at >= at) return false;
    const same = JSON.stringify([prev.fiveHour, prev.week]) === JSON.stringify([entry.fiveHour, entry.week]);
    if (same && at - prev.at < 60_000) return false;
  }
  writeJson('usage.json', { ...all, [name]: entry });
  return true;
}

// ---- the stored Claude sign-in, as last checked -----------------------------------------------------------------
// `claude auth status` is a program start, too slow for every page load. Whoever runs that check (doctor, setup,
// the Get started list, the launcher) leaves its answer here, and the page reads this.

/**
 * { loggedIn: true | false | null, plan: "pro" | "max" | "team" | … | null, at, accountAt } or null when never
 * checked. `accountAt` is when another account was last seen signed in (null: never since this was first kept).
 */
export function loginSeen() {
  const l = readJson('claude-login.json', null);
  if (!l || !Number.isFinite(l.at)) return null;
  return {
    loggedIn: typeof l.loggedIn === 'boolean' ? l.loggedIn : null, plan: typeof l.plan === 'string' ? l.plan : null, at: l.at,
    accountAt: Number.isFinite(l.accountAt) ? l.accountAt : null,
  };
}

/**
 * Keep the answer of a sign-in check (claudecode.mjs: claudeLoginStatus). Only when it differs or is a minute old.
 * `account` tells who is signed in (claudecode.mjs: parseAuthAccount). It is never stored: what is kept is a
 * fingerprint made with a random value of this computer, which says nothing about the account to anyone else. The
 * last one known stays, also while nobody is signed in, so it shows when ANOTHER account signs in, by the page or
 * by /login in a terminal. Returns { changed }: true when the account is another one than the last one known.
 */
export function rememberLogin({ loggedIn = null, plan = null, account = null } = {}, now = Date.now()) {
  const raw = readJson('claude-login.json', null) || {};
  const salt = typeof raw.salt === 'string' && raw.salt.length >= 16 ? raw.salt : crypto.randomBytes(12).toString('hex');
  const before = typeof raw.account === 'string' && raw.account ? raw.account : null;
  const key = loggedIn === true && typeof account === 'string' && account ? crypto.createHash('sha256').update(`${salt}\n${account}`).digest('hex').slice(0, 16) : null;
  const changed = Boolean(before && key && before !== key);
  const next = {
    loggedIn: typeof loggedIn === 'boolean' ? loggedIn : null, plan: loggedIn === true && typeof plan === 'string' && plan ? plan : null, at: now,
    salt, account: key || before,
    accountAt: changed ? now : Number.isFinite(raw.accountAt) ? raw.accountAt : null,
  };
  const prev = loginSeen();
  if (prev && prev.loggedIn === next.loggedIn && prev.plan === next.plan && next.account === before && now - prev.at < 60_000) return { changed };
  try {
    writeJson('claude-login.json', next);
  } catch {
    /* a state folder that cannot be written must not break a check */
  }
  return { changed };
}

// Claude Code gives the 5-hour and weekly figures to these sign-ins only ("rate_limits: appears only for claude.ai
// Pro, Max, and Ultra subscribers", https://code.claude.com/docs/en/statusline, read 14 Nov 2026). A Team or
// Enterprise seat signs in the same way and reports none.
const PLANS_WITH_USAGE = new Set(['pro', 'max', 'ultra']);

/**
 * What the page shows of a provider that signs in, beyond the public profile (an API key has none of these):
 *   signedIn       "login": the stored sign-in as last checked: true, false, or null when nobody checked yet.
 *                  "subscription": true (it carries its own token; whether Anthropic still takes it shows at use)
 *   plan           "login": the plan Claude Code names for the sign-in ("pro", "max", "team", …), else null
 *   usageReported  true: figures were seen for this provider, or its plan reports them; false: its plan does not
 *                  report them (the page says so instead of showing nothing); null: not known yet
 *   accountAt      "login": when another account was last signed in (epoch ms), else null
 */
export function providerFacts(profile) {
  if (!profile || (profile.kind !== 'login' && profile.kind !== 'subscription')) return {};
  const kept = usageStore()[profile.name];
  const seen = Boolean(kept && (kept.fiveHour || kept.week)); // not what forgetUsage left
  if (profile.kind === 'subscription') return { signedIn: true, plan: null, usageReported: seen ? true : null };
  const login = loginSeen();
  const plan = login && login.loggedIn ? login.plan : null;
  return {
    signedIn: login ? login.loggedIn : null, plan, usageReported: seen ? true : plan ? PLANS_WITH_USAGE.has(plan.toLowerCase()) : null,
    // when another account was last signed in here: a limit seen before that moment was the earlier account's
    accountAt: login ? login.accountAt : null,
  };
}

// Anthropic's plan-limit headers → our usage entry (null when the answer carries none).
export function usageFromHeaders(headers, now = Date.now()) {
  const h = (k) => headers[`anthropic-ratelimit-unified-${k}`];
  const win = (prefix) => {
    const u = Number(h(`${prefix}-utilization`));
    if (!Number.isFinite(u)) return null;
    const reset = Number(h(`${prefix}-reset`));
    return { pct: Math.max(0, Math.min(100, Math.round(u * 100))), resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
  };
  const fiveHour = win('5h');
  const week = win('7d');
  const status = h('status');
  if (!fiveHour && !week && !status) return null;
  const out = { at: now };
  if (fiveHour) out.fiveHour = fiveHour;
  if (week) out.week = week;
  if (typeof status === 'string') out.status = status;
  return out;
}
