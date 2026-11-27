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
//   runsOn       null (default: Automatic) or the profile Tia's own engine runs on (one that serves Claude Code);
//                Automatic: the first ticked subscription that is signed in and not at its limit; with no such
//                subscription at all, "auto" when on, else the first allowed account that serves Claude Code
//   maxSteps     answers Tia may give per job                                default 20
//   maxMinutes   how long one job may run                                    default 240
//   model        null (default: the account's own) or the model her engine uses, e.g. "haiku"

import path from 'node:path';
import { leftOutOfOrder } from '../autoswitch.mjs';
import { nothingUsable } from '../router.mjs';
import { ACCOUNT, toolName } from './toolkit.mjs';

/** One constant for the name, so a fork can rename her. */
export const ASSISTANT_NAME = 'Tia';

export const LEVELS = ['ask', 'work', 'handsoff'];
// Off until the owner turns her on: an assistant that drives sessions is the most powerful part of Hoprig, and
// still experimental.
export const DEFAULTS = Object.freeze({ enabled: false, level: 'work', accounts: null, runsOn: null, maxSteps: 20, maxMinutes: 240, model: null, dailyCapUsd: null, actAlone: false, decides: false, answersHers: false });
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/; // as src/server/endpoint.mjs
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Plain sentences shown under every option in Settings → Tia. */
export const HELP = {
  enabled: `Turn ${ASSISTANT_NAME} on or off (off at first; she is experimental). Off hides her tab and stops everything she watches.`,
  level: `How far ${ASSISTANT_NAME} may go on her own: "Ask me" — you tap OK for everything she types into a session; "Do the work" — she runs the job herself; in a Claude Code chat she started she allows by herself only looking and running the project's own tests (a short list); changing files, everything else and every OK of another coding tool come to you; in a terminal session she started she still answers its ordinary permission prompts, judged only by the text on its screen against a list of risky things (best effort), and sends you the risky ones; "Hands off" — as "Do the work", and she may also use the paid API providers you allowed without asking, within the daily limit for paid use (none at first, so each of those still asks you); only at this level, and within the same limit, do her limit rule and "Tia decides" move a session onto such a provider, type into a session on one, or think on one. On the Work page she always asks you first, at every level: starting a session on a task, accepting or sending back its result, dropping and removing a task.`,
  // One short line per level, shown above the full texts (those stay under "More").
  levelShort: {
    ask: 'She asks you before everything she types into a session.',
    work: 'She does the job herself and asks you before anything risky.',
    handsoff: 'As "Do the work", and she may also use the paid providers you allowed, within your daily limit.',
  },
  levelAsk: 'You tap OK for everything she types into a session.',
  levelWork: 'She runs the job herself: starts the session, picks the provider, answers its questions, checks the result. On the Work page she always asks you first, at every level: starting a session on a task, accepting or sending back its result, dropping and removing a task. In a Claude Code chat she started she allows by herself only looking and running the project\'s own tests (a short list); changing files, everything else and every OK of another coding tool come to you. In a terminal session she started she still answers its ordinary permission prompts, judged only by the text on its screen against a list of risky things (best effort), and sends you the risky ones.',
  levelHandsoff: 'As "Do the work", and she may also start or move sessions on the paid API providers you allowed, without asking, within the daily limit for paid use (none at first: then each of those asks you). Only at this level, and within the same limit, do her limit rule and "Tia decides" move a session onto such a provider, type into a session on one, or think on one; each counts against the limit. On the Work page she always asks you first, at every level: starting a session on a task, accepting or sending back its result, dropping and removing a task.',
  answersHers: `When the session of a Work task that ${ASSISTANT_NAME} started for you asks for an OK, she answers it herself, as she does in the other sessions she runs for a job: only to let it look inside the project or run the project's own checks, and never at "Ask me". Each answer is a line in Activity. Every other OK stays your card: changing files, money, a sign-in, a push or merge into a main branch, a release, anything sent out, a delete outside the project and administrator rights. Off until you turn it on; turning it off stops it at once.`,
  accounts: `The providers ${ASSISTANT_NAME} may start or move sessions on. She never uses one that is not ticked.`,
  computers: `The computers ${ASSISTANT_NAME} may start new work on. When you do not name one, she starts it on this computer, and on a ticked one only while this computer is full and that one has room; she says where and why. None ticked: only where you name it, else on this computer.`,
  runsOn: `The provider ${ASSISTANT_NAME} herself thinks on (her own chat).`,
  maxSteps: `How many times ${ASSISTANT_NAME} may answer a session in one job before she asks you.`,
  maxMinutes: `How long one job may run before ${ASSISTANT_NAME} stops and tells you.`,
  dailyCapUsd: `What ${ASSISTANT_NAME} may use a day on providers billed by use (an API key) without asking you. Her own thinking counts what it really cost, and a turn stops at what is left. Starting, moving or writing to a session or chat on such a provider counts $0.50 each until its real cost is known: for a chat she started on this computer, what it reported it cost takes that place; a terminal session's cost is not measured. What you confirm on a card counts too. The Operator counts here too: a move of a session or a mission's task onto such a provider by the limit rule or "Tia decides", and a nudge or an answer typed into a session on one, count $0.50 each; a call of "Tia decides" or a look there holds $0.50 and then counts what it reported (a look that reported nothing counts its whole budget). Your own tap on "Continue on the next provider" is not counted. Empty: no limit, so each of those asks you first or is left to you, and neither she nor the Operator thinks on such a provider at all. Once it is reached, she asks again until midnight.`,
  model: `The model ${ASSISTANT_NAME} herself thinks with. Empty: the provider's own default. A small model ("haiku") is cheaper and enough for most jobs.`,
  usage: `What ${ASSISTANT_NAME}'s own thinking used (not the sessions she runs). Cost is as Claude Code reports it; on a subscription it is an estimate, not a bill.`,
  client: `Lets your own Claude Code (or another MCP client) use ${ASSISTANT_NAME}'s tools, with the same checks and cards. The token is shown once.`,
};

/**
 * Validate a Settings → Tia patch from the owner's browser. Throws Error with a plain message. `knownAccounts`: the
 * providers she may be allowed (those that serve a coding tool of this version: tiaChoices); `runsOnAccounts`: the
 * ones she can think on (Claude Code's).
 */
export function cleanTiaPatch(p, knownAccounts = [], runsOnAccounts = knownAccounts, knownComputers = []) {
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
    } else if (k === 'dailyCapUsd') {
      // What she may spend a day on providers billed by use without his tap (spend.mjs); null: none, every paid act asks.
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 10_000)) throw new Error('dailyCapUsd must be an amount from 0.5 to 10000 US dollars, or null for none');
      out.dailyCapUsd = v === null ? null : Math.round(v * 100) / 100;
    } else if (k === 'others') {
      // "Use other providers" for her Lead chats: only providers she may be allowed (knownAccounts).
      if (!Array.isArray(v) || v.length > 10 || v.some((n) => typeof n !== 'string' || !NAME_RE.test(n) || !knownAccounts.includes(n))) throw new Error('others must be a list of providers she can use');
      out.others = [...new Set(v)];
    } else if (k === 'answersHers') {
      // "She answers the OKs of her Work runs" (policy.mjs, jobs.mjs): off until the owner turns it on, on this page only (her door
      // cannot send it: door.mjs SETTINGS_KEYS has no assistant key).
      if (typeof v !== 'boolean') throw new Error('answersHers must be true or false');
      out.answersHers = v;
    } else if (k === 'decides') {
      // "Tia decides" (off at first): her own right, so only his page sets it. Her small acts on Hoprig itself follow the one
      // switch "Tia acts by herself" (ops.mjs assistantSettings), not a key of their own.
      if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
      out[k] = v;
    } else if (k === 'lead') {
      // "Lead model" for the chats she starts (src/models/lead.mjs): off unless the owner turns it on.
      if (typeof v !== 'boolean') throw new Error('lead must be true or false');
      out.lead = v;
    } else if (k === 'computers') {
      // The computers she may start work on (src/operator/where.mjs): this one ("this") and the hub's, by name. Null or
      // an empty list: none chosen, she starts where she does without it (where he names, else here).
      if (v === null) out.computers = null;
      else {
        if (!Array.isArray(v) || v.length > 40 || v.some((n) => typeof n !== 'string' || (n !== 'this' && !knownComputers.includes(n)))) throw new Error('computers must be a list of your computers by name');
        out.computers = v.length ? [...new Set(['this', ...v])] : null;
      }
    } else if (k === 'maxMinutes') {
      if (!Number.isInteger(v) || v < 5 || v > 7 * 24 * 60) throw new Error('maxMinutes must be a whole number from 5 to 10080');
      out.maxMinutes = v;
    } else throw new Error(`"${k}" is not a ${ASSISTANT_NAME} setting`);
  }
  return out;
}

const isSub = (p) => p.kind === 'subscription' || p.kind === 'login';

/**
 * A provider at its limit, as Auto mode passes one over: marked limited (until a time still ahead, or with none known),
 * or a plan window of its usage full and not reset yet.
 */
function atLimit(p, now = Date.now()) {
  if (p.limited && !(Number.isFinite(p.limited.until) && p.limited.until <= now)) return true;
  return fullWindows(p, now).length > 0;
}
const fullWindows = (p, now) => (p.usage ? [p.usage.fiveHour, p.usage.week] : []).filter((w) => w && w.pct >= 100 && !(Number.isFinite(w.resetsAt) && w.resetsAt <= now));
/** When a provider at its limit is usable again, as far as Hoprig knows: the latest of its known times, or null. */
function usableAt(p, now) {
  const times = [p.limited && p.limited.until, ...fullWindows(p, now).map((w) => w.resetsAt)];
  if ((p.limited && !Number.isFinite(p.limited.until)) || fullWindows(p, now).some((w) => !Number.isFinite(w.resetsAt))) return null;
  const known = times.filter((t) => Number.isFinite(t) && t > now);
  return known.length ? Math.max(...known) : null;
}

/**
 * The settings with defaults filled in, against the accounts that exist now.
 * accounts: { profiles: [{ name, kind, ... }], autoSwitch: { enabled, order } } (get_computer_status providers' source).
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
  // Automatic (the saved value null): the first subscription that can answer now, in the order of his providers; one at
  // its limit is passed over. Auto mode's rule only when he has no subscription she can think on: what costs money
  // stays behind the daily limit for paid use. Every subscription at its limit: none (readiness says so and when the first is back), never
  // a provider billed by use by herself. His own choice (a provider, or "auto") is kept as it is.
  // A subscription here is one she may use (his ticks under "Providers she may use": she never thinks on one he left
  // out), whose sign-in is not known to be gone (she would answer nothing on it), and that is not billed by use (a
  // stored sign-in the facts mark as paid stays behind that limit like any key).
  const subs = real.filter((p) => isSub(p) && p.paid !== true && p.signedIn !== false && servesTool(p, 'claude') && allowed.includes(p.name));
  const now = Date.now();
  const firstFree = subs.find((p) => !atLimit(p, now));
  const chosen = r.runsOn && (r.runsOn === 'auto' ? autoOn : thinks.includes(r.runsOn)) ? r.runsOn : null;
  // With no subscription: Auto mode or another provider, but only one she may use (his ticks); none of them: none
  // (readiness says so), never a provider he left out.
  const runsOn = chosen || (firstFree ? firstFree.name : subs.length ? null
    : autoOn && allowed.includes('auto') ? 'auto' : allowed.find((n) => thinks.includes(n)) || null);
  // No provider she may use can run her, while one he left out could: readiness names the place to tick one.
  const noneAllowed = !runsOn && !subs.length && thinks.length > 0;
  // When every subscription is at its limit: the one usable again first and when, as far as Hoprig knows (null: none
  // known).
  let subsLimited = null;
  if (!chosen && subs.length && !firstFree) {
    const back = subs.map((p) => ({ name: p.name, at: usableAt(p, now) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
    // other: he allowed a provider she can think on that is not one of these subscriptions (Auto mode, a key): the line
    // ends with the way to "Tia runs on", his own choice; she never takes it herself.
    const other = allowed.some((n) => (n === 'auto' ? autoOn : thinks.includes(n) && !subs.some((p) => p.name === n)));
    subsLimited = { names: subs.map((p) => p.name), first: back.length ? back[0].name : null, until: back.length ? back[0].at : null, other };
  }
  // His own choice is a subscription at its limit (also one set by "Use …" on a notice): she stays on his choice, and
  // readiness says so with the time it is usable again; nothing moves to a provider billed by use.
  const mine = chosen && chosen !== 'auto' ? real.find((p) => p.name === chosen) : null;
  const chosenLimited = mine && isSub(mine) && atLimit(mine, now) ? { name: mine.name, until: usableAt(mine, now) } : null;
  const model = typeof r.model === 'string' && MODEL_RE.test(r.model) ? r.model : null;
  // null: he chose no computers (as before this setting: where he names, else here); else the list, this one always in it.
  const computers = Array.isArray(r.computers) && r.computers.length ? [...new Set(['this', ...r.computers.filter((n) => typeof n === 'string')])] : null;
  const dailyCapUsd = typeof r.dailyCapUsd === 'number' && Number.isFinite(r.dailyCapUsd) && r.dailyCapUsd > 0 ? r.dailyCapUsd : null;
  return { enabled: r.enabled !== false, level: r.level, allowed, computers, accountsDefault: !Array.isArray(r.accounts), runsOn, maxSteps: r.maxSteps, maxMinutes: r.maxMinutes, model, lead: r.lead === true, answersHers: r.answersHers === true, actAlone: r.actAlone === true, decides: r.decides === true, others: Array.isArray(r.others) ? r.others.filter((n) => allowed.includes(n)) : [], dailyCapUsd, subscription: firstFree ? firstFree.name : null, subsLimited, chosenLimited, noneAllowed };
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
 * empty `tools` list: another coding tool's sign-in, a key only Codex could use) is never offered to her. Nor is one
 * whose name is not of a provider name's form: a provider's name goes into her summaries and refusals (outside the
 * fence), so a linked computer cannot put its own sentence there by naming a provider with it.
 */
export const tiaChoices = (accounts) => ((accounts && accounts.profiles) || [])
  .filter((p) => p && ACCOUNT.test(String(p.name)) && !p.virtual && p.name !== 'auto' && !p.unusable && (!Array.isArray(p.tools) || p.tools.length > 0));

/**
 * Whether a provider (as get_computer_status providers lists it: `tools` = the coding tools it serves; absent on older computers, which
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
  // Auto mode only while its order holds a provider it may use (autoLeftOut, the rule pickProvider asks too): else the
  // next provider she may use, and with none the reason Auto mode can serve nothing.
  const autoOut = tool === 'claude' && tia.allowed.includes('auto') ? autoLeftOut(accounts) : null;
  if (tool === 'claude' && tia.allowed.includes('auto') && !autoOut) return { account: 'auto', kind: 'auto', why: 'Auto mode is on and allowed: the router moves the session to the next provider at a limit' };
  const allowed = autoOut ? tia.allowed.filter((n) => n !== 'auto') : tia.allowed;
  const order = [...((accounts.autoSwitch && accounts.autoSwitch.order) || []), ...allowed];
  const rank = (n) => {
    const i = order.indexOf(n);
    return i < 0 ? 999 : i;
  };
  const candidates = allowed.map((n) => profiles.find((p) => p.name === n)).filter((p) => servesTool(p, tool));
  const free = candidates.filter((p) => !p.limited);
  const autoToo = autoOut ? `; ${autoOut}` : '';
  if (!candidates.length) return { error: autoOut || (tool === 'claude' ? `no provider is allowed for ${ASSISTANT_NAME}` : `no provider ${ASSISTANT_NAME} may use serves ${toolName(tool)}`) };
  if (!free.length) {
    const soonest = candidates.map((p) => p.limited && p.limited.until).filter(Boolean).sort((a, b) => a - b)[0];
    return { error: `every provider ${ASSISTANT_NAME} may use is at its limit${soonest ? ` (the first frees up at ${new Date(soonest).toISOString()})` : ''}${autoToo}` };
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
    why: (candidates.length === 1
      ? `the only provider ${ASSISTANT_NAME} may use; ${usage}`
      : `${pct === null ? 'its usage is not reported (counted as half used)' : `${pct}% of its quota free`}, the best of the allowed providers${limitedNames.length ? `; ${limitedNames.join(', ')} at a limit` : ''}`) + autoToo,
  };
}

/**
 * Why Auto mode can serve nothing, by the accounts list (autoswitch.mjs leftOutOfOrder: each provider of its order gone,
 * not serving Claude Code, or billed by use while "Also use pay-per-use providers" is off), or null while one is left.
 * The one rule of her own starts (chooseAccount) and of her own calls (decider.mjs pickProvider).
 */
export function autoLeftOut(acc) {
  const order = new Set(Array.isArray(acc.autoSwitch?.order) ? acc.autoSwitch.order : []);
  const left = leftOutOfOrder(acc);
  if (order.size > left.length) return null;
  return nothingUsable(left) || 'Auto mode has no providers in its order';
}

// Permission prompts Tia never answers by herself, whatever the level: what the session wants to run looks like
// fetching and running code, deleting widely, reading secrets or touching the system. The text is the session's
// own notification (untrusted), so this is a deny-list on top of "only within the goal", not a guarantee: for a
// terminal session, which has only its screen to judge, it is best effort; a chat does not rest on it (she allows a
// chat's OK only from the short allow-list of allowlist.mjs, and this list runs after it as a second look).
/**
 * Files that may hold secrets, by their names: keys and key stores (SSH, TLS, Android, Java, PKCS#12, Apple's .p8,
 * PuTTY's, armored PGP), sign-ins and settings with tokens (a .env and its kin, the package managers' (Composer's
 * auth.json among them), databases', clouds', Vault's, Kubernetes', Docker's, a repository's own config, a WordPress
 * config, Gradle's properties), infrastructure state, secrets files and service accounts (Firebase's too), a file or folder named cred or creds, Claude
 * Code's and Hoprig's own settings. The one list of the deny-list below and of the allow-list (allowlist.mjs: every
 * reader of its table, a file tool's path, a command's file words and git's "HEAD:path" forms).
 *
 * A list of names is still a list of names: it is not a wall around secrets. Inside the chat's folder the coding tool's
 * own Read reads without asking in its default mode, and a file can hold a key under any name. The list only keeps HER
 * from saying yes, by herself, to the obvious ones.
 */
export const SECRET_FILES = new RegExp([
  /\.ssh|\.aws|\.gnupg|\.netrc|\.pgpass|\.kube\/|\.docker\/config\.json|\.git\/config\b|\.claude\/|\.config\/hoprig/,
  /\.env\b|\.envrc|\.dev\.vars\b|\.npmrc|\.yarnrc|\.pypirc|\.htpasswd|\.my\.cnf|\.vault-token|\.s3cfg|\.boto\b|kubeconfig/,
  /\.(?:pem|key)(?![\w.-])|\.(?:keystore|jks|p12|pfx|p8|ppk|asc|tfstate|tfvars)\b|(?<![A-Za-z0-9])(?:key|keystore|gradle)\.properties/,
  /id_(?:rsa|dsa|ecdsa|ed25519)|credentials|keychain|secrets?\.(?:json|ya?ml|toml)\b|service[-_]?account[^/]*\.json|adminsdk[^/]*\.json/,
  /(?<![\w.-])(?:auth\.json|wp-config\.php)(?![\w.-])/,
  /(?:^|\/)creds?(?:\/|$)/,
].map((r) => r.source).join('|'), 'i');
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
