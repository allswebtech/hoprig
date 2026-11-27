// Set up the shipped gateway (TRouteAI) with one press, and look after it afterwards. No request context here: the
// route (src/addons/gatewayhost.mjs) and the command (`hoprig addons setup trouteai`) only wrap these functions.
//
// setupShippedGateway: installs the gateway when it is missing (the add-on's own install), starts it (the add-on's own
// start), waits until its health route says ready, makes the key "Hoprig sessions (<computer>)" with the gateway's own
// command (`key create <name> --port <port> --data-dir <folder>`), writes the provider profile with it and runs the
// first provider check. A profile whose key the gateway accepts is left as it is; when its key is refused, the old key
// of exactly that name at the gateway is removed first, so presses never pile keys up. No long-lived management key is
// kept: the gateway's command token (a file in its data folder, read fresh) is sent in one header, only to a listener of
// this computer that runs as Hoprig's own user, at the literal address 127.0.0.1, and only for the keys' list and
// removal. Every failure ends in one plain sentence with the next step. The key itself is never in a line, an answer
// or a log: it goes from the gateway's command straight into the profile file.
import path from 'node:path';
import { readProfile, metaOf, writeProfile } from '../profiles.mjs';
import { stateDir } from '../paths.mjs';
import { capture, which } from '../setup/system.mjs';
import { startPlan } from '../addons/localgateway.mjs';

const HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-trouteai-cli-token';
const LOG_LINES = 100;

/** The one gateway Hoprig sets up and manages itself: the shipped TRouteAI, never one the owner defined. */
export const hasSetUp = (addon) => Boolean(addon) && addon.id === 'trouteai' && addon.defined !== true;

/** The name of the key Hoprig makes for the sessions of this computer. */
export const sessionKeyName = (computer) => `Hoprig sessions (${computer})`;

/** The three things of trouteaibase.mjs (the gateway's data folder rule, the listener's owner, the command token). */
async function realBase() {
  return import('./trouteaibase.mjs');
}

/** Wipe anything that looks like a key or a token out of a sentence taken from a program's output. */
export const scrub = (text) => String(text || '').replace(/[A-Za-z0-9_+/=-]{24,}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The words of the program that runs the gateway's own commands: the add-on's command line up to its first option
 * ([bin] or [node, entry]). A plain name is looked up on PATH.
 */
export function programWords(addon) {
  const line = typeof addon.command === 'function' ? addon.command() : [];
  const cut = line.findIndex((w, i) => i > 0 && String(w).startsWith('--'));
  const words = (cut < 0 ? line : line.slice(0, cut)).map(String);
  if (words.length && !path.isAbsolute(words[0])) words[0] = which(words[0]) || words[0];
  return words;
}

/**
 * A command of the gateway's own program (`key create`, `reset-password`) as the one start line names the program: for an
 * own copy node and its entry file, for a global copy its program. The data folder goes on it (`--data-dir`), the folder
 * the start line and the management client use, so a start, a key and a password always use one folder (the commands
 * themselves are of the gateway's version that has the option). → { command, args } for spawn, or null when the program
 * is not found.
 */
export function ownProgramCommand(addon, tail, folder) {
  const words = programWords(addon);
  if (!words.length) return null;
  return startPlan(words[0], [...words.slice(1), ...tail, '--data-dir', folder]);
}

/**
 * Set it up. `addon`: the gateway's add-on. `onLine(text)`: progress lines (plain sentences). `computer`: this computer's
 * name. `deps`: stand-ins for tests { base, fetchImpl, run, firstCheck, waitMs, pollMs, now }.
 * → { ok: true, kept, name, lines } or { ok: false, error } (one sentence with the next step).
 */
export async function setupShippedGateway({ addon, onLine = () => {}, computer, deps = {} } = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const run = deps.run || ((argv) => capture(argv, { timeout: 45_000 }));
  const waitMs = deps.waitMs ?? 60_000;
  const pollMs = deps.pollMs ?? 500;
  const title = addon.title;
  const no = (error) => ({ ok: false, error });
  const say = (text) => onLine(text);

  // 0. a program of another user on its port: nothing is installed or started over it, and it gets nothing
  const was = await Promise.resolve(addon.status({ version: false })).catch(() => ({}));
  if (was.note || was.foreign) return no(`${was.note || `Another program answers on port ${addon.gateway.port()}, so it is not ${title}.`} Next step: stop that program (as its own user), or give ${title} another port in config.json (addons.${addon.id}.port), then press Set up again.`);
  // 1. installed (a damaged copy is installed again)
  if (!was.installed || was.problem) {
    say(`Installing ${title}…${addon.builds ? ` ${addon.builds}` : ''}`);
    const r = await addon.install({ onLine });
    if (!r || !r.ok) return no(`${title} could not be installed. Next step: ${addon.installHint ? addon.installHint() : `npm install -g ${addon.id}`} in a terminal, then press Set up again.`);
  }
  // 2. started
  say(`Starting ${title}…`);
  const started = await addon.start();
  if (!started || !started.ok) return no(`${(started && started.error) || `${title} did not start.`} Next step: read the log under Providers → TRouteAI, then press Set up again.`);
  const port = Number(addon.gateway.port());
  const where = `http://${HOST}:${port}`;
  // 3. ready
  say(`Waiting until ${title} is ready…`);
  let ready = false;
  for (const end = Date.now() + waitMs; ; ) {
    try {
      const r = await fetchImpl(`${where}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!ready) return no(`${title} started but did not say ready within ${Math.round(waitMs / 1000)} seconds. Next step: wait a minute and press Set up again; if it repeats, read the log under Providers → TRouteAI.`);

  // 4. no credential goes to a program of another user
  const base = deps.base || (await realBase());
  if ((await base.sameUserListener(port)) !== 'own') return no(`The program that answers on port ${port} does not run as your user, so Hoprig sent it nothing. Next step: stop that program, or give ${title} another port, then press Set up again.`);
  const folder = base.dataFolder();
  const tokenOf = () => base.commandToken(folder);
  if (!tokenOf()) return no(`${title}'s command token could not be used (it is missing, or other users can read it). Next step: stop ${title}, start it again from Hoprig as your own user, then press Set up again.`);

  // 5. the profile's key, when there is one
  const prof = addon.profile();
  const varOf = (p) => (p.env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : p.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : prof.tokenVar);
  // A profile of that name is the gateway's own only when it points at this gateway; any other (an Anthropic key, another
  // gateway) is not touched, and the new one goes under a free name.
  const ours = (p) => {
    const b = String((p.env && p.env.ANTHROPIC_BASE_URL) || '').replace(/\/+$/, '');
    if (!b) return false;
    if (b === String(prof.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')) return true;
    try {
      const u = new URL(b);
      return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port) === port;
    } catch {
      return false;
    }
  };
  const found = readProfile(prof.name);
  const existing = found && ours(found) ? found : null;
  const have = existing ? existing.env[varOf(existing)] || '' : '';
  const accepted = async (key) => {
    try {
      const r = await fetchImpl(`${where}/v1/models`, { redirect: 'manual', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      return r.status !== 401 && r.status !== 403;
    } catch {
      return false;
    }
  };
  if (have && (await accepted(have))) {
    say(`The provider ${prof.name} already has a key ${title} accepts: it was left as it is.`);
    (deps.firstCheck || (await import('../providers/check.mjs')).firstCheck)(existing, { fetchImpl });
    return { ok: true, kept: true, name: prof.name, lines: [] };
  }

  // 6. the old key of exactly this name is removed, then the new one is made
  const name = sessionKeyName(computer);
  const call = async (method, urlPath) => {
    const token = tokenOf();
    if (!token) return null;
    try {
      return await fetchImpl(`${where}${urlPath}`, { method, redirect: 'manual', headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(15_000) });
    } catch {
      return null;
    }
  };
  const listed = await call('GET', '/api/keys');
  if (!listed || listed.status !== 200) return no(`${title} did not let Hoprig look at its keys (${listed ? `HTTP ${listed.status}` : 'no answer'}). Next step: stop ${title}, start it again from Hoprig as your own user, then press Set up again.`);
  const body = await listed.json().catch(() => ({}));
  const same = (Array.isArray(body.keys) ? body.keys : []).filter((k) => k && k.name === name && (typeof k.id === 'string' || typeof k.id === 'number'));
  for (const k of same) {
    const gone = await call('DELETE', `/api/keys/${encodeURIComponent(String(k.id))}`);
    if (!gone || ![200, 204, 404].includes(gone.status)) return no(`${title} did not remove its old key "${name}". Next step: remove it in ${title}'s own page (API keys), then press Set up again.`);
  }
  if (same.length) say(`Removed the old key "${name}", so keys do not pile up.`);
  say(`Making the key "${name}"…`);
  const plan = ownProgramCommand(addon, ['key', 'create', name, '--port', String(port)], folder);
  if (!plan) return no(`${title}'s program was not found. Next step: install it with Set up again, or run hoprig addons install ${addon.id}.`);
  const made = await run([plan.command, ...plan.args]);
  const key = String(made.stdout || '').trim();
  if (!made.ok || !/^[\x21-\x7e]{8,400}$/.test(key)) return no(`${title} could not make the key${made.stderr ? ` (${scrub(String(made.stderr).trim().split('\n').pop())})` : ''}. Next step: press Set up again; if it repeats, make a key in ${title}'s own page and paste it under Claude API key.`);

  // 7. the profile: a profile that exists keeps its name, label, models and start line; only its key changes
  const v = existing ? varOf(existing) : prof.tokenVar;
  const written = existing
    ? writeProfile(existing.name, { ...metaOf(existing), env: { ...existing.env, [v]: key } })
    : writeProfile(found ? freeProfileName(prof.name) : prof.name, { label: prof.label, prerun: prof.prerun, env: { ...prof.env, [v]: key } });
  say(`Saved the provider ${written.name} with the key "${name}".`);
  (deps.firstCheck || (await import('../providers/check.mjs')).firstCheck)(written, { fetchImpl });
  return { ok: true, kept: false, name: written.name, lines: [] };
}

/** The first free profile name: base2, base3 … */
function freeProfileName(base) {
  for (let i = 2; i < 100; i++) if (!readProfile(`${base}${i}`)) return `${base}${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// ---------- the log, how it listens, the first password ----------

// A line of the log that may hold a secret is never shown.
const SECRETISH = /pass(word|phrase)?|token|secret|\bkey\b|api[-_ ]?key|credential|authorization|bearer|cookie|set-cookie|sk-[\w-]{6,}|[A-Za-z0-9_=-]{32,}/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The gateway's log file as this computer keeps it: <state>/addons/<id>.log. */
export const logFileOf = (id) => path.join(stateDir(), 'addons', `${id}.log`);

/** The last 100 lines of a log text, lines that may hold a secret left out: { lines, left }. */
export function lastLines(text, max = LOG_LINES) {
  const all = String(text || '').replace(ANSI, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const tail = all.slice(-max);
  const lines = [];
  let left = 0;
  for (const l of tail) {
    if (SECRETISH.test(l)) left++;
    else lines.push(l.slice(0, 500));
  }
  // A line that comes again and again one after another is shown once, with how many more times it came.
  const folded = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    folded.push(lines[i]);
    if (j - i > 1) folded.push(`the line above came ${j - i - 1} more ${j - i === 2 ? 'time' : 'times'}`);
    i = j;
  }
  return { lines: folded, left };
}

/** The sentence for how a gateway listens, from its add-on's rule (localgateway.mjs listenRule): one line, nothing to set. */
export function listensSentence(addon) {
  let rule = null;
  try {
    rule = typeof addon.listen === 'function' ? addon.listen() : null;
  } catch {
    rule = null;
  }
  if (!rule) return null;
  const local = (rule.args || []).includes('127.0.0.1') || (rule.env && rule.env.HOST === '127.0.0.1');
  return local
    ? `When Hoprig starts ${addon.title}, it listens on this computer only (as your dashboard does), so other computers cannot reach it. There is nothing to set.`
    : `When Hoprig starts ${addon.title}, it adds no address of its own, because your dashboard is open to the network: ${addon.title} then keeps to its own HOST setting (this computer only, unless you changed it). A copy you started yourself keeps the setting you gave it.`;
}
