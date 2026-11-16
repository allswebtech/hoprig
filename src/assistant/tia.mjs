// Tia's settings and the pure rules that decide how far she may go on her own. The owner sets them in
// Settings → Tia (config.json key "assistant"); the assistant itself can never change them (change_setting has no
// key for them).
//
//   enabled      true | false        off: no Tia tab, every tool call refused, watchers stopped
//   level        "ask" | "work" | "handsoff"                                  default "work"
//     ask        Tia proposes; every action that types into a session is a card the owner taps.
//     work       Tia gets the job done: starts sessions, picks the account, sends the task, answers Claude
//                Code's questions within the goal (never another coding tool's OKs), carries on after a limit,
//                checks the result, reports.
//     handsoff   as "work", and the actions that only cost money within the owner's bounds (start on or move
//                to an API account he allowed) need no card either.
//     In every level the destructive or system-changing actions stay cards (stop a session she did not start,
//     run_command, ending a process, installing, updating or switching a coding tool, setting up a computer, settings,
//     schedules, skills, power), and secrets stay out (L3).
//   accounts     null (default) or a list of account names Tia may use (may include "auto")
//                default: "auto" when Auto mode is on, then every subscription/login account; never an API
//                account unless the owner lists it; only providers that serve a coding tool of this version
//   runsOn       null (default) or the profile Tia's own engine runs on (one that serves Claude Code); default
//                "auto" when on, else the first allowed account that serves Claude Code
//   maxSteps     answers Tia may give per job                                default 20
//   maxMinutes   how long one job may run                                    default 240
//   model        null (default: the account's own) or the model her engine uses, e.g. "haiku"

import path from 'node:path';
import { toolName } from './toolkit.mjs';

/** One constant for the name, so a fork can rename her. */
export const ASSISTANT_NAME = 'Tia';

export const LEVELS = ['ask', 'work', 'handsoff'];
// Off until the owner turns her on: an assistant that drives sessions is the most powerful part of Hoprig, and
// still experimental.
export const DEFAULTS = Object.freeze({ enabled: false, level: 'work', accounts: null, runsOn: null, maxSteps: 20, maxMinutes: 240, model: null });
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Plain sentences shown under every option in Settings → Tia. */
export const HELP = {
  enabled: `Turn ${ASSISTANT_NAME} on or off (off at first; she is experimental). Off hides her tab and stops everything she watches.`,
  level: `How far ${ASSISTANT_NAME} may go on her own: "Ask me" — you tap OK for everything she types into a session; "Do the work" — she runs the job herself; in a Claude Code chat she started she allows by herself only looking and running the project's own tests (a short list); changing files, everything else and every OK of another coding tool come to you; in a terminal session she started she still answers its ordinary permission prompts, judged only by the text on its screen against a list of risky things (best effort), and sends you the risky ones; "Hands off" — as "Do the work", and she may also use the paid API providers you allowed without asking.`,
  levelAsk: 'You tap OK for everything she types into a session.',
  levelWork: 'She runs the job herself: starts the session, picks the provider, answers its questions, checks the result. In a Claude Code chat she started she allows by herself only looking and running the project\'s own tests (a short list); changing files, everything else and every OK of another coding tool come to you. In a terminal session she started she still answers its ordinary permission prompts, judged only by the text on its screen against a list of risky things (best effort), and sends you the risky ones.',
  levelHandsoff: 'As "Do the work", and she may also start or move sessions on the paid API providers you allowed, without asking.',
  accounts: `The providers ${ASSISTANT_NAME} may start or move sessions on. She never uses one that is not ticked.`,
  runsOn: `The provider ${ASSISTANT_NAME} herself thinks on (her own chat).`,
  maxSteps: `How many times ${ASSISTANT_NAME} may answer a session in one job before she asks you.`,
  maxMinutes: `How long one job may run before ${ASSISTANT_NAME} stops and tells you.`,
  model: `The model ${ASSISTANT_NAME} herself thinks with. Empty: the provider's own default. A small model ("haiku") is cheaper and enough for most jobs.`,
  usage: `What ${ASSISTANT_NAME}'s own thinking used (not the sessions she runs). Cost is as Claude Code reports it; on a subscription it is an estimate, not a bill.`,
  client: `Lets your own Claude Code (or another MCP client) use ${ASSISTANT_NAME}'s tools, with the same checks and cards. The token is shown once.`,
};

/**
 * Validate a Settings → Tia patch from the owner's browser. Throws Error with a plain message. `knownAccounts`: the
 * providers she may be allowed (those that serve a coding tool of this version: tiaChoices); `runsOnAccounts`: the
 * ones she can think on (Claude Code's).
 */
export function cleanTiaPatch(p, knownAccounts = [], runsOnAccounts = knownAccounts) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('send an object');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'enabled') {
      if (typeof v !== 'boolean') throw new Error('enabled must be true or false');
      out.enabled = v;
    } else if (k === 'level') {
      if (!LEVELS.includes(v)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
      out.level = v;
    } else if (k === 'accounts') {
      if (v === null) out.accounts = null;
      else {
        if (!Array.isArray(v) || v.length > 20 || v.some((n) => typeof n !== 'string' || !NAME_RE.test(n))) throw new Error('accounts must be a list of provider names');
        for (const n of v) if (n !== 'auto' && !knownAccounts.includes(n)) throw new Error(`there is no provider "${n}" she can use`);
        out.accounts = [...new Set(v)];
      }
    } else if (k === 'runsOn') {
      if (v !== null && (typeof v !== 'string' || (v !== 'auto' && !runsOnAccounts.includes(v)))) throw new Error(`runsOn must be a provider that serves Claude Code, or null`);
      out.runsOn = v;
    } else if (k === 'maxSteps') {
      if (!Number.isInteger(v) || v < 1 || v > 200) throw new Error('maxSteps must be a whole number from 1 to 200');
      out.maxSteps = v;
    } else if (k === 'model') {
      if (v !== null && v !== '' && (typeof v !== 'string' || !MODEL_RE.test(v))) throw new Error('model must be a model name like haiku, or empty');
      out.model = v || null;
    } else if (k === 'maxMinutes') {
      if (!Number.isInteger(v) || v < 5 || v > 7 * 24 * 60) throw new Error('maxMinutes must be a whole number from 5 to 10080');
      out.maxMinutes = v;
    } else throw new Error(`"${k}" is not a ${ASSISTANT_NAME} setting`);
  }
  return out;
}

const isSub = (p) => p.kind === 'subscription' || p.kind === 'login';

/**
 * The settings with defaults filled in, against the accounts that exist now.
 * accounts: { profiles: [{ name, kind, ... }], autoSwitch: { enabled, order } } (get_accounts' source).
 */
export function resolveTia(raw, accounts) {
  const r = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!LEVELS.includes(r.level)) r.level = DEFAULTS.level;
  const real = tiaChoices(accounts);
  const autoOn = !!(accounts.autoSwitch && accounts.autoSwitch.enabled);
  let allowed;
  if (Array.isArray(r.accounts)) allowed = r.accounts.filter((n) => (n === 'auto' ? autoOn : real.some((p) => p.name === n)));
  else allowed = [...(autoOn ? ['auto'] : []), ...real.filter(isSub).map((p) => p.name)];
  // She thinks through Claude Code: only a provider that serves it can be the one she runs on.
  const thinks = real.filter((p) => servesTool(p, 'claude')).map((p) => p.name);
  const runsOn = r.runsOn && (r.runsOn === 'auto' ? autoOn : thinks.includes(r.runsOn)) ? r.runsOn
    : autoOn ? 'auto' : allowed.find((n) => thinks.includes(n)) || thinks[0] || null;
  const model = typeof r.model === 'string' && MODEL_RE.test(r.model) ? r.model : null;
  return { enabled: r.enabled !== false, level: r.level, allowed, accountsDefault: !Array.isArray(r.accounts), runsOn, maxSteps: r.maxSteps, maxMinutes: r.maxMinutes, model };
}

/**
 * The owner's saved choice as Settings → Tia shows it and sends it back with Save: only names cleanTiaPatch accepts
 * now. A list saved earlier can name a provider that was removed since, or one she may no longer use (another coding
 * tool's sign-in, a key only that tool could use); the page has no box for it, so it could neither be unticked nor
 * saved. Dropping it here changes nothing she does: resolveTia ignores such names too.
 */
export function savedTiaChoice(raw, accounts) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const real = tiaChoices(accounts);
  const known = new Set(real.map((p) => p.name));
  const thinks = new Set(real.filter((p) => servesTool(p, 'claude')).map((p) => p.name));
  return {
    accounts: Array.isArray(r.accounts) ? r.accounts.filter((n) => n === 'auto' || known.has(n)) : null,
    runsOnSet: r.runsOn === 'auto' || thinks.has(r.runsOn) ? r.runsOn : null,
  };
}

/** How much of an account's quota is left, 0–100, or null when unknown (API accounts have no plan windows). */
export function freePct(p) {
  const u = p.usage;
  if (!u) return null;
  const used = Math.max(u.fiveHour ? u.fiveHour.pct : 0, u.week ? u.week.pct : 0);
  return Math.max(0, 100 - used);
}

/**
 * The real providers Tia may be allowed to use: the ones that serve a coding tool of this version (she starts Claude
 * Code sessions and chats, and moves a session within its coding tool). One that serves none (`unusable`, or an
 * empty `tools` list: another coding tool's sign-in, a key only Codex could use) is never offered to her.
 */
export const tiaChoices = (accounts) => ((accounts && accounts.profiles) || [])
  .filter((p) => !p.virtual && p.name !== 'auto' && !p.unusable && (!Array.isArray(p.tools) || p.tools.length > 0));

/**
 * Whether a provider (as get_accounts lists it: `tools` = the coding tools it serves; absent on older computers, which
 * know Claude Code only) serves coding tool `tool`. Auto mode serves Claude Code only.
 */
export const servesTool = (p, tool = 'claude') => Boolean(p) && (p.name === 'auto' || p.virtual ? tool === 'claude' : !Array.isArray(p.tools) ? tool === 'claude' : p.tools.includes(tool));

/**
 * Tia's choice of account for a new session (a terminal or a chat: both run Claude Code) or for a session that moves
 * (`tool`: its coding tool), only among the providers that serve that tool: "auto" when allowed (the router then picks
 * per request; Claude Code only); else the allowed account with the most free quota, never one at its limit; unknown
 * usage counts as half full; ties go to the owner's order (Auto mode's order, then the allowed list). Returns
 * { account, kind, why } or { error }.
 */
export function chooseAccount(tia, accounts, tool = 'claude') {
  const profiles = accounts.profiles || [];
  if (tool === 'claude' && tia.allowed.includes('auto')) return { account: 'auto', kind: 'auto', why: 'Auto mode is on and allowed: the router moves the session to the next provider at a limit' };
  const order = [...((accounts.autoSwitch && accounts.autoSwitch.order) || []), ...tia.allowed];
  const rank = (n) => {
    const i = order.indexOf(n);
    return i < 0 ? 999 : i;
  };
  const candidates = tia.allowed.map((n) => profiles.find((p) => p.name === n)).filter((p) => servesTool(p, tool));
  const free = candidates.filter((p) => !p.limited);
  if (!candidates.length) return { error: tool === 'claude' ? `no provider is allowed for ${ASSISTANT_NAME}` : `no provider ${ASSISTANT_NAME} may use serves ${toolName(tool)}` };
  if (!free.length) {
    const soonest = candidates.map((p) => p.limited && p.limited.until).filter(Boolean).sort((a, b) => a - b)[0];
    return { error: `every provider ${ASSISTANT_NAME} may use is at its limit${soonest ? ` (the first frees up at ${new Date(soonest).toISOString()})` : ''}` };
  }
  const score = (p) => (freePct(p) ?? 50);
  free.sort((a, b) => score(b) - score(a) || rank(a.name) - rank(b.name));
  const best = free[0];
  const pct = freePct(best);
  const limitedNames = candidates.filter((p) => p.limited).map((p) => p.name);
  const usage = pct === null ? 'its usage is not reported' : `${pct}% of its quota free`;
  return {
    account: best.name,
    kind: best.kind,
    why: candidates.length === 1
      ? `the only provider ${ASSISTANT_NAME} may use; ${usage}`
      : `${pct === null ? 'its usage is not reported (counted as half used)' : `${pct}% of its quota free`}, the best of the allowed providers${limitedNames.length ? `; ${limitedNames.join(', ')} at a limit` : ''}`,
  };
}

// Permission prompts Tia never answers by herself, whatever the level: what the session wants to run looks like
// fetching and running code, deleting widely, reading secrets or touching the system. The text is the session's
// own notification (untrusted), so this is a deny-list on top of "only within the goal", not a guarantee: for a
// terminal session, which has only its screen to judge, it is best effort; a chat does not rest on it (she allows a
// chat's OK only from the short allow-list of allowlist.mjs, and this list runs after it as a second look).
/** Files that may hold secrets: keys, sign-ins, a .env, the package managers' and databases' sign-in files, Claude Code's
 * and Hoprig's own settings. The one list of the deny-list below and of the allow-list (allowlist.mjs). */
export const SECRET_FILES = /(\.ssh|\.aws|\.gnupg|\.netrc|\.env\b|\.envrc|\.npmrc|\.pypirc|\.pgpass|\.docker\/config\.json|\.(?:pem|key)(?![\w.-])|id_rsa|id_ed25519|credentials|keychain|\.claude\/|\.config\/hoprig)/i;
const RISKY = [
  /\b(curl|wget|fetch|iwr|invoke-webrequest)\b[^\n|]*\|\s*(ba|z|da|k)?sh\b/i,
  /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(ba|z)?sh\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)(\s|$)/i,
  /\b(sudo|su|doas|chmod\s+777|chown|mkfs|dd\s+if=|shutdown|reboot|systemctl|launchctl|crontab)\b/i,
  SECRET_FILES,
  /\b(printenv|env[ \t]*$|export\s+\w*(KEY|TOKEN|SECRET))/im, // `env` alone at the end of any line, not only the last
  /\b(ssh|scp|rsync|nc|ncat|netcat|socat|telnet)\s/i,
  /\bgit\s+push\b[^\n]*(--force|-f\b)|\bgit\s+push\b/i,
];
// A path that leaves whatever folder it starts in: a ".." segment anywhere in a word (../x, a/../../b, /p/../q), or
// the home folder itself (~, $HOME) as a word of its own.
const LEAVES_FOLDER = [
  /(?:^|[\s'"`=(/])\.\.(?=$|[/\s'"`);|&])/m,
  /(?:^|[\s'"`=(])(?:~|\$HOME|\$\{HOME\})(?=$|[/\s'"`);|&])/m,
];
/**
 * `text`: the session's notification and the bottom of its screen (where Claude Code shows what it wants to run).
 * `cwd`: the session's folder — a path outside it (absolute after normalising, ~/…, or any path through "..") is
 * risky too: a job works in its own folder.
 */
export function riskyPermission(text, cwd = null) {
  const s = String(text || '');
  if (RISKY.some((re) => re.test(s))) return true;
  if (LEAVES_FOLDER.some((re) => re.test(s))) return true;
  if (!cwd) return false;
  const root = path.posix.normalize(String(cwd)).replace(/\/+$/, '');
  for (const m of s.matchAll(/(?:^|[\s'"`=(])(~\/[^\s'"`)]*|\/+(?:[A-Za-z0-9._@+-]+\/*)+)/g)) {
    if (m[1].startsWith('~')) return true;
    const p = path.posix.normalize(m[1]).replace(/(.)\/+$/, '$1');
    if (p === '/dev/null') continue;
    if (!(p === root || p.startsWith(`${root}/`))) return true;
  }
  return false;
}
