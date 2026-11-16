// The one Public link switch: on or off, and one kind, Temporary (the default) or Custom, never both at once.
//
//   Temporary  Cloudflare's free quick tunnel (publiclink.mjs): nothing to set up, a new https address at each start.
//   Custom     a Cloudflare named tunnel on the owner's own domain (fixedlink.mjs): set up once, the same address.
//
// What the owner chose is config.json's publicLink = { on, kind } (absent: off, Temporary). It is remembered: a
// switch that was on comes back when the dashboard starts again, after a restart of the computer too, and a
// Temporary address that is new then is shown and sent to the owner's notifications. The command line
// (`hoprig public on`) only writes that choice; the running dashboard sees it within a few seconds (reconcile).
//
// One supervisor runs the one cloudflared (fixedlink.mjs makeSupervisor: started again when it ends, with backoff).
// While a link runs, server.trustProxy is on and its address is an allowed origin; the owner's own values are kept
// in the record file (addons/link.json, with the running state, for `hoprig public status` and reachableUrl) and
// put back when it ends, also after a crash: the next start puts them back before it takes them again.
//
// Turning it on needs a strong dashboard password (strength.mjs): a page that controls the whole computer is
// reachable from anywhere then. cloudflared is installed by the first switch-on.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { passwordState } from '../server/strength.mjs';
import { addonsDir, alive, cloudflaredEnv, dashboardPort, findBin, fixedDir, fixedStateFile, hasPassword, linkRecordFile, patchFor, quickStateFile, readFixed, readJsonFile, readQuick, restoreFor, writeAtomic } from './cloudflared.mjs';
import { customRun, customSteps, fixedCloseOpenedBy, fixedStatus, makeSupervisor, stopSignIn } from './fixedlink.mjs';
import { install, notifyNewAddress, parseTunnelUrl, serviceStatus, stopService, temporarySteps, tunnelArgv, closeServiceOpenedBy } from './publiclink.mjs';

export const KINDS = ['temporary', 'custom'];
export const recordFile = linkRecordFile;
const quickHome = () => path.join(addonsDir(), 'quick', 'home');
const quickEmpty = () => path.join(addonsDir(), 'quick', 'empty');
const RECONCILE_MS = 2000;
const PROGRESS_MAX = 40;
const RETRY_FIRST_MS = 15_000; // a start that failed by itself (no network at boot) is tried again, then less often
const RETRY_MAX_MS = 5 * 60_000;

/**
 * What the owner chose: { on, kind, at }. `at`: when it was last turned on (ms), so a turn-on asked again (the page,
 * `hoprig public on`) is a new request even when on and the kind were already so: a start that failed is tried again.
 */
export function readSwitch(cfg = loadConfig()) {
  const p = cfg.publicLink;
  return { on: !!(p && p.on === true), kind: p && p.kind === 'custom' ? 'custom' : 'temporary', at: (p && Number.isFinite(p.at) && p.at) || 0 };
}

export const readRecord = () => readJsonFile(recordFile()) || {};
const writeRecord = (patch) => writeAtomic(recordFile(), JSON.stringify({ ...readRecord(), ...patch }));

/** Plain words for each kind: what it is, what it needs, what it gives. The page shows these. */
export const KIND_WORDS = {
  temporary: {
    title: 'Temporary',
    text: 'A new address each time it starts. Nothing to set up.',
    needs: 'Nothing. Hoprig installs Cloudflare\'s free helper (cloudflared) the first time you turn it on.',
    gives: 'An https://….trycloudflare.com address through Cloudflare\'s free quick tunnel. It changes whenever Hoprig or the computer restarts (an update restarts Hoprig too); the new one is shown here and sent to your notifications.',
  },
  custom: {
    title: 'Custom',
    text: 'Your own address that stays the same, such as pc.example.com.',
    needs: 'A domain on a free Cloudflare account, set up once: sign in to Cloudflare, type the name, done.',
    gives: 'The same https address every time, so computers linked to this one stay linked.',
  },
};
export const VISITOR_WORDS = 'Someone who opens the address sees the sign-in page. They need your Hoprig password, or a sign-in QR made on a device that is already signed in.';

// ---- the in-process state of the one link ----
let sup = null;
let cur = null; // { kind, url, pending } while a link runs in this process
let phase = 'off'; // off | installing | starting | error | blocked (on / retrying come from the supervisor)
let lastError = null;
let blocked = null; // while on but held back: { need, error } (the password is not strong enough)
let failures = 0; // starts that failed in a row by themselves, for the wait before the next try
let retryAt = 0;
let progress = [];
let applied = null; // the choice the last reconcile acted on: "on:kind:at" or "off"
let nextOpener; // the token id of the turn-on being applied (undefined: keep what the record says)
let queue = Promise.resolve();
let timer = null;
let notify = notifyNewAddress;

const say = (l) => {
  progress.push(String(l).slice(0, 500));
  if (progress.length > PROGRESS_MAX) progress.shift();
};
const keyOf = (w) => (w.on ? `on:${w.kind}:${w.at}` : 'off');

const supervisor = () => (sup ||= makeSupervisor({
  onPid: (pid) => {
    if (cur) Object.assign(cur, { pending: null, connected: false }); // a new run of the quick tunnel gets a new address
    writeRecord({ pid, connected: false });
  },
  onLine: (l) => {
    if (!cur) return;
    if (cur.kind === 'temporary') cur.pending = parseTunnelUrl(l) || cur.pending;
    // Only a connected tunnel brings visitors: then a Temporary address is taken, and announced when it is new.
    if (!/Registered tunnel connection/.test(l)) return;
    if (cur.kind === 'temporary' && cur.pending && cur.pending !== cur.url) {
      cur.url = cur.pending;
      takeSettings(cur.url);
      writeRecord({ url: cur.url });
      say(`On: ${cur.url}`);
      Promise.resolve(notify(cur.url, 'this dashboard')).catch(() => {});
    }
    if (!cur.connected && cur.url) {
      cur.connected = true;
      writeRecord({ connected: true });
    }
  },
}));

/** The settings while `origin` is the link: the owner's own are recorded first, so a crash in between loses nothing. */
function takeSettings(origin) {
  const rec = readRecord();
  if (rec.restore && rec.restore.origin === origin) return;
  if (rec.restore) putBack();
  const { patch, restore } = patchFor(loadConfig().server, origin);
  writeRecord({ restore });
  saveConfig(patch);
}

/** trustProxy and the allowed origins exactly as the owner had them. */
function putBack() {
  const rec = readRecord();
  if (!rec.restore) return;
  saveConfig(restoreFor(loadConfig().server, rec.restore));
  writeRecord({ restore: null });
}

/** The command line of `pid` with its words joined by spaces, or null when it cannot be read here. */
function commandLine(pid) {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    if (process.platform === 'darwin') return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    /* gone, or not ours to read */
  }
  return null; // Windows and others: not checked, so never taken for ours
}

/**
 * Is `pid` a cloudflared tunnel of ours? Its command line must say so: after a restart of the computer the number in
 * an old record may belong to another program. Where the command line cannot be read, nothing is ours, so nothing is
 * ended or adopted on a number alone.
 */
export function ours(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return false;
  const cmd = commandLine(pid);
  return !!cmd && / tunnel /.test(` ${cmd} `) && (cmd.includes(fixedDir()) || cmd.includes('--url http://127.0.0.1:'));
}

// A cloudflared of ours still running from before (the dashboard ended without stopping it).
function killLeftover() {
  const { pid } = readRecord();
  if (ours(pid)) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}

async function stopRun() {
  if (sup) await sup.stop();
  killLeftover();
  putBack();
  cur = null;
  writeRecord({ kind: null, url: null, pid: null, connected: false });
}

/** Start `kind`. A failure is { error } and leaves nothing running; { cancelled } when the switch changed meanwhile. */
async function startRun(kind) {
  progress = [];
  lastError = null;
  writeRecord({ error: null, errorAt: null });
  let bin = findBin();
  if (!bin) {
    phase = 'installing';
    say('Installing cloudflared, Cloudflare\'s free helper…');
    // Its lines are shown on the page and to a linked hub: the folder it went to is left out.
    const r = await install({ onLine: (l) => say(/^installed: /.test(l) ? 'cloudflared is installed.' : l) });
    bin = findBin();
    // Turned off (or to the other kind) while it installed: the next step does what is chosen now.
    const now = readSwitch();
    if (!now.on || now.kind !== kind) return { cancelled: true };
    if (!r.ok || !bin) return { error: `cloudflared could not be installed${r.error ? `: ${r.error}` : ''}.` };
  }
  if (!hasPassword()) return { error: 'Set a dashboard password first (Settings → Security): the address leads to the sign-in page.' };
  let run;
  if (kind === 'custom') {
    run = customRun(bin);
    if (run.error) return { error: run.error };
    takeSettings(run.origin);
  } else {
    for (const d of [quickHome(), quickEmpty()]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    // Its own home and an empty PATH, as for the Custom address: it reads nothing of the owner's ~/.cloudflared.
    run = { argv: tunnelArgv(bin, dashboardPort()), env: cloudflaredEnv(quickHome(), quickEmpty()), origin: null };
  }
  phase = 'starting';
  say(kind === 'custom' ? `Starting ${run.origin}…` : 'Asking Cloudflare for a temporary address…');
  cur = { kind, url: run.origin, pending: null, connected: false };
  writeRecord({ kind, url: run.origin, connected: false, error: null, ...(nextOpener !== undefined ? { openedBy: nextOpener } : {}) });
  supervisor().run(run.argv, run.env);
  return {};
}

/**
 * Why the chosen `kind` may not run now (cannotTurnOn), checked at every look, so a link that is on never runs with a
 * weak password, also one turned on by an older version or from a file. One exception: a Custom link that already ran
 * before the strength check existed keeps running until the password is judged (at the owner's next sign-in), as
 * stopping it at an update could leave the owner with no way in from where he is. Judged weak, it stops too.
 */
function cannotRun(kind) {
  const no = cannotTurnOn(kind);
  if (no && no.need === 'check-password' && kind === 'custom' && readRecord().migratedCustom) return null;
  return no;
}

/** Stop the second temporary address (another local service) when the switch no longer allows it. */
async function stopExtra(want) {
  if (!(want.on && want.kind === 'temporary') && serviceStatus()) await stopService();
}

/**
 * Make what runs match what the owner chose. One at a time. `explicit`: a turn-on just asked for; when it cannot
 * start (cloudflared will not install, Custom is not set up) the switch goes back to off with the reason shown.
 * A start that fails by itself (at boot, from the command line) keeps the switch on and is tried again later.
 * `restart`: start what runs again (the Custom address's services changed).
 */
function reconcile({ force = false, explicit = false, restart = false } = {}) {
  const step = async () => {
    const want = readSwitch();
    const key = keyOf(want);
    const no = want.on ? cannotRun(want.kind) : null;
    const due = want.on && phase === 'error' && Date.now() >= retryAt;
    const holdChanged = (phase === 'blocked') !== !!no || (no && blocked && no.need !== blocked.need);
    if (!force && !restart && key === applied && !due && !holdChanged) return;
    applied = key;
    await stopExtra(want);
    if (!want.on) {
      if (cur || readRecord().restore) await stopRun();
      writeRecord({ openedBy: null, error: null, errorAt: null });
      phase = 'off';
      blocked = null;
      return;
    }
    if (no) {
      // On, but held back until the password is strong: nothing runs, the page asks for what is needed.
      if (cur || readRecord().restore) await stopRun();
      phase = 'blocked';
      blocked = { need: no.need, error: no.error };
      lastError = no.error;
      writeRecord({ error: no.error, errorAt: Date.now() });
      return;
    }
    blocked = null;
    if (cur && cur.kind === want.kind && phase !== 'error' && phase !== 'blocked' && !restart) return;
    if (cur || readRecord().restore) await stopRun();
    const r = await startRun(want.kind);
    nextOpener = undefined;
    if (r.cancelled) {
      phase = 'off';
      applied = null;
      return;
    }
    if (!r.error) {
      failures = 0;
      return;
    }
    phase = 'error';
    lastError = r.error;
    say(r.error);
    writeRecord({ error: r.error, errorAt: Date.now() });
    if (explicit) {
      saveConfig({ publicLink: { on: false, kind: want.kind } });
      applied = 'off';
      writeRecord({ openedBy: null });
    } else {
      failures += 1;
      retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
    }
  };
  queue = queue.then(step).catch((e) => {
    phase = 'error';
    lastError = e.message;
  });
  return queue;
}

/**
 * Why `kind` cannot be turned on now, as { need, error } in plain words, or null. `need`: what the page asks for in
 * place: 'password' (none set), 'check-password' (the stored one was never judged: type it once),
 * 'stronger-password', 'custom-setup'.
 */
export function cannotTurnOn(kind, cfg = loadConfig()) {
  if (!KINDS.includes(kind)) return { need: null, error: 'kind must be "temporary" or "custom"' };
  const pw = passwordState(cfg.server);
  if (pw.state === 'none') return { need: 'password', error: 'Set a dashboard password first: the address leads to the sign-in page.' };
  if (pw.state === 'unknown') return { need: 'check-password', error: 'Type your dashboard password once, so Hoprig can check that it is strong enough for a page anyone can reach.' };
  if (pw.state === 'weak') return { need: 'stronger-password', error: `Your dashboard password is too weak for a public link: ${pw.why}. Make a stronger one (at least 12 characters, or a generated one).` };
  if (kind === 'custom' && !readFixed()?.mode) return { need: 'custom-setup', error: 'Set up Custom first: sign in to Cloudflare and name the address.' };
  return null;
}

/**
 * Turn the link on as `kind` (the other kind stops first). `by`: the machine token that asked (a linked hub), null
 * for the owner; it is recorded, so revoking that token turns the link off. A link of the same kind that is on
 * already keeps its opener. Answers at once ({ ok, ...status }); the start goes on in the background.
 */
export async function turnOn(kind = readSwitch().kind, { by = null } = {}) {
  const no = cannotTurnOn(kind);
  if (no) return { ok: false, ...no };
  const now = readSwitch();
  if (now.on && now.kind === kind && cur) {
    // The owner's own turn-on of what a hub turned on makes it his: revoking the hub's token no longer ends it.
    if (!by) writeRecord({ openedBy: null });
  } else nextOpener = by || null;
  failures = 0;
  saveConfig({ publicLink: { on: true, kind, at: Date.now() } });
  reconcile({ explicit: true });
  await Promise.resolve();
  return { ok: true, ...status() };
}

/**
 * Turn it off (or keep it off). The kind stays chosen for the next time; `kind` chooses another one for then. Answers
 * once it stopped; during an install of cloudflared at once (the start is dropped when the install ends).
 */
export async function turnOff({ kind = readSwitch().kind } = {}) {
  const installing = phase === 'installing';
  saveConfig({ publicLink: { on: false, kind: KINDS.includes(kind) ? kind : 'temporary' } });
  const done = reconcile();
  if (!installing) await done;
  return { ok: true, ...status() };
}

/** Wait until a start has an answer: on, trying again, an error, or off. For the command line and the old routes. */
export async function settled({ timeoutMs = 90_000 } = {}) {
  await queue;
  for (let t = 0; t < timeoutMs; t += 250) {
    const s = status();
    if (s.state !== 'starting' && s.state !== 'installing' && !(s.state === 'on' && !s.url)) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  return status();
}

/** The address of the link while it is on: the Custom one at once, the Temporary one once Cloudflare gave it. */
function liveUrl() {
  if (!cur) return null;
  return cur.url || null;
}

/**
 * The state the page, Tia and `hoprig public status` show. Never a token, a certificate, a password or a file path.
 * `why`: say what makes the password weak; only the owner's own browser gets that (a hint for guessing otherwise).
 * `need` while it is on but held back (state 'blocked'): what the page asks for, as for a refused turn-on.
 */
export function status({ why = true } = {}) {
  const want = readSwitch();
  const r = sup && cur ? sup.state() : null;
  let state = phase;
  if (want.on && cur && phase !== 'error') state = r && r.connected && liveUrl() ? 'on' : r && r.nextTryAt ? 'retrying' : 'starting';
  if (want.on && !cur && phase === 'off') state = 'starting'; // chosen a moment ago; the start is queued
  if (!want.on && phase !== 'error') state = 'off';
  const pw = passwordState();
  const custom = fixedStatus();
  return {
    on: want.on,
    kind: want.kind,
    state,
    need: state === 'blocked' && blocked ? blocked.need : null,
    url: state === 'on' || (cur && cur.kind === 'custom') ? liveUrl() : null,
    error: phase === 'error' || state === 'blocked' ? lastError : (r && !r.connected && r.error) || null,
    nextTryAt: (r && r.nextTryAt) || null,
    restarts: (r && r.restarts) || 0,
    progress: [...progress],
    installed: Boolean(findBin()),
    password: { state: pw.state, why: why ? pw.why : null },
    kinds: KINDS.map((id) => ({ id, ...KIND_WORDS[id], ready: id === 'temporary' || custom.state === 'ready' })),
    visitor: VISITOR_WORDS,
    custom,
    service: serviceStatus(),
  };
}

/**
 * The first start of a version with this switch: the older one kept a detached Temporary tunnel and a Custom
 * address that could both run. Read once (only while publicLink is absent): Custom set up and running wins, else a
 * Temporary one that runs, else off. Their settings are put back, the old tunnel ends, and the switch starts what
 * was on again under its supervisor (a Temporary address is then new).
 */
export function migrate() {
  if (loadConfig().publicLink) return null;
  const fixed = readFixed();
  const quick = readQuick();
  if (!(fixed && fixed.mode) && !quick) return null;
  // The old tunnel counts as running only when its record says so AND that number is provably a tunnel of ours.
  const quickOn = !!(quick && !quick.restored && quick.url && ours(quick.pid));
  const fixedOn = !!(fixed && fixed.mode && fixed.enabled);
  // Each record holds the owner's own trustProxy (the second link took it from the first), and its own origin.
  for (const r of [quick && !quick.restored && quick.restore, fixed && fixed.enabled && !fixed.restored && fixed.restore]) {
    if (r) saveConfig(restoreFor(loadConfig().server, r));
  }
  if (quickOn) try { process.kill(quick.pid, 'SIGTERM'); } catch { /* gone */ }
  fs.rmSync(quickStateFile(), { force: true });
  if (fixed) {
    const { enabled, restore, restored, pid, openedBy, ...keep } = fixed;
    writeAtomic(fixedStateFile(), JSON.stringify(keep));
  }
  const choice = fixedOn ? { on: true, kind: 'custom' } : quickOn ? { on: true, kind: 'temporary' } : { on: false, kind: fixed && fixed.mode ? 'custom' : 'temporary' };
  saveConfig({ publicLink: choice });
  const opener = fixedOn ? fixed.openedBy : quickOn ? quick.openedBy : null;
  // A Custom link that ran before keeps running until the password is judged (cannotRun); a Temporary one gets a new
  // address anyway, so it is a new exposure and waits for a strong password like any turn-on.
  writeRecord({ openedBy: opener || null, migratedCustom: fixedOn });
  return choice;
}

/** When the dashboard starts: settings left by a crash go back, then what is on starts; a change by the CLI is seen. */
export function attach({ notifyFn = notifyNewAddress, everyMs = RECONCILE_MS } = {}) {
  notify = notifyFn;
  try {
    migrate();
  } catch (e) {
    console.error(`public link: ${e.message}`);
  }
  killLeftover();
  putBack();
  applied = null;
  phase = 'off';
  blocked = null;
  failures = 0;
  reconcile();
  clearInterval(timer);
  timer = setInterval(() => reconcile(), everyMs);
  timer.unref();
  return queue;
}

/** When the dashboard stops: the link stops with it and the settings go back; the choice stays for the next start. */
export async function detach() {
  clearInterval(timer);
  timer = null;
  stopSignIn();
  await queue;
  if (cur || readRecord().restore) await stopRun();
  applied = null;
  phase = 'off';
}

/** The Custom set-up steps, with what the switch does after them. → the step's result. */
export async function customStep(name, body, opts = {}) {
  const step = customSteps[name];
  if (!step) return { ok: false, error: 'no such step' };
  if (name === 'forget') {
    if (readSwitch().kind === 'custom') {
      saveConfig({ publicLink: { on: false, kind: 'temporary' } });
      await reconcile();
    }
    return step(body, opts);
  }
  const r = await step(body, opts);
  // Made (or made with a token): Custom is turned on at once, as the owner asked for it.
  if (r.ok && (name === 'create' || name === 'token')) {
    const on = await turnOn('custom', { by: opts.by || null });
    return on.ok ? { ...r, ok: true } : { ...r, ok: false, error: on.error, need: on.need };
  }
  if (r.ok && r.changed && cur && cur.kind === 'custom') await reconcile({ restart: true });
  return r;
}

/**
 * The Temporary kind's extra: a second temporary address for one more local service. It is part of the switch: only
 * while the link is on as Temporary, and it stops when the switch goes off or to Custom (reconcile).
 */
export function temporaryStep(name, body, opts = {}) {
  if (!temporarySteps[name]) return { ok: false, error: 'no such step' };
  const want = readSwitch();
  if (name === 'add-service' && !(want.on && want.kind === 'temporary')) return { ok: false, error: 'Turn the public link on as Temporary first: another service gets an address only while it is on.' };
  return temporarySteps[name](body, { notify, ...opts });
}

/**
 * A machine token was revoked (`gone(id)`): turn off the link when that token turned it on, and close what it added.
 * What the owner turned on stays. → [{ by, say(who) }] (feature.mjs).
 */
export async function closeOpenedBy(gone) {
  const out = [];
  const rec = readRecord();
  if (readSwitch().on && gone(rec.openedBy)) {
    await turnOff();
    out.push({ by: rec.openedBy, say: (who) => `The public link ${who} turned on was turned off: its token was revoked` });
  }
  const dropped = fixedCloseOpenedBy(gone);
  if (dropped.length && cur && cur.kind === 'custom') await reconcile({ restart: true });
  return [...out, ...dropped, ...(await closeServiceOpenedBy(gone))];
}

/** For tests: forget the in-process state. */
export async function resetForTests() {
  await detach();
  sup = null;
  progress = [];
  lastError = null;
  blocked = null;
  failures = 0;
  retryAt = 0;
  notify = notifyNewAddress;
}
