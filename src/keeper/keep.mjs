// The keeper: the part that looks after Hoprig while the dashboard itself is dead. No dashboard runs, no model is
// called, nothing is spent. `hoprig keep` is started by the service manager when the dashboard is down:
//   systemd   OnFailure= of the dashboard unit (after 5 failed starts within 60 s)
//   launchd   a watcher job every minute      Windows   a task every minute
// What it does, each at most once for one stretch of being down (an "episode": it ends when the dashboard answers):
//   1. rewrites the service files from the installed product when they differ, then starts again
//   2. when an update less than a day old never passed its start check: goes back to the kept previous version
//   3. when nothing was tried yet: one plain start
//   then it stops, says so in the keeper log, sends one push when a push address is set, and leaves a note.
// Never while the owner stopped Hoprig himself (`hoprig stop`: the marker file). Only Hoprig's own files and state.
//
// The note (note.json) is read at the next start of the dashboard: one Activity line, and for a rollback or a give up
// one row in Home's Needs you (src/operator/detect/machine.mjs reads it through readNote).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { writeAtomic } from '../automation/store.mjs';

export const DAY = 24 * 3600 * 1000;
export const NOTE_KEEP = 7 * DAY;
const LOG_MAX = 256 * 1024;
// The start check of an update: the new dashboard must answer within this, or the old one is put back.
export const START_CHECK_MS = 60_000;

export const keeperDir = (state = stateDir()) => path.join(state, 'keeper');
const file = (state, name) => path.join(keeperDir(state), name);
const readJson = (f, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};

// ---------- the owner's own stop ----------

/** `hoprig stop` leaves this; the keeper does nothing while it is there. A start (any) removes it. */
export function markStopped(state = stateDir(), now = Date.now) {
  writeAtomic(file(state, 'stopped'), { at: new Date(now()).toISOString() });
}
export function clearStopped(state = stateDir()) {
  fs.rmSync(file(state, 'stopped'), { force: true });
}
export const isStopped = (state = stateDir()) => fs.existsSync(file(state, 'stopped'));

// ---------- the keeper log ----------

export function logLine(state, text, now = Date.now) {
  try {
    const f = file(state, 'keeper.log');
    fs.mkdirSync(keeperDir(state), { recursive: true, mode: 0o700 });
    let old = '';
    try {
      old = fs.readFileSync(f, 'utf8');
    } catch {
      /* none yet */
    }
    if (old.length > LOG_MAX) old = old.slice(-Math.floor(LOG_MAX / 2));
    fs.writeFileSync(f, `${old}${new Date(now()).toISOString()} ${String(text).replace(/\s+/g, ' ').slice(0, 300)}\n`, { mode: 0o600 });
  } catch {
    /* a log that cannot be written never stops a mend */
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- is the dashboard up ----------

/** Whether the dashboard of this state folder answers its health address. */
let lastWhy = '';
/** Why the last look at the dashboard said no, in a few words (for the keeper log). */
export const answersWhy = () => lastWhy;
export async function dashboardAnswers({ state = stateDir(), fetchImpl = globalThis.fetch, ms = 3000 } = {}) {
  const rec = readJson(path.join(state, 'dashboard.json'));
  if (!rec || !Number.isInteger(rec.port)) {
    lastWhy = `no record of a running dashboard in ${state}`;
    return false;
  }
  const host = !rec.host || rec.host === '0.0.0.0' ? '127.0.0.1' : rec.host === '::' ? '::1' : rec.host;
  try {
    const r = await fetchImpl(`http://${host.includes(':') ? `[${host}]` : host}:${rec.port}/healthz`, { signal: AbortSignal.timeout(ms) });
    lastWhy = r.ok ? '' : `/healthz answered ${r.status}`;
    return r.ok;
  } catch (e) {
    lastWhy = `${host}:${rec.port} did not answer (${String(e?.cause?.code || e?.name || e).slice(0, 40)})`;
    return false;
  }
}

// ---------- the kept previous version ----------

const previousDir = (state) => file(state, 'previous');

/**
 * Before an update replaces the installed folder `root`: keep a copy of it (the last one only) and write the record of
 * the update. { ok } false when the copy could not be made (the update then does not start).
 */
export function prepareUpdate({ root, version, state = stateDir(), now = Date.now, copy = fs.cpSync } = {}) {
  try {
    fs.rmSync(previousDir(state), { recursive: true, force: true });
    fs.mkdirSync(previousDir(state), { recursive: true, mode: 0o700 });
    copy(root, path.join(previousDir(state), 'tree'), { recursive: true, verbatimSymlinks: true });
    writeAtomic(file(state, 'update.json'), { from: version, to: null, root, at: now(), verified: false, rolledBack: false });
    return { ok: true };
  } catch (e) {
    fs.rmSync(previousDir(state), { recursive: true, force: true });
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * The start of an update of an npm install (a git checkout is the developer's own and is never swapped): the running
 * version is kept aside and the update is recorded. → { kept, error? }; `kept: false, error` means do not update.
 */
export function beginUpdate({ kind, root, version, to = null, state = stateDir(), now = Date.now, copy } = {}) {
  if (kind !== 'npm') return { kept: false };
  const p = prepareUpdate({ root, version, state, now, ...(copy ? { copy } : {}) });
  if (!p.ok) return { kept: false, error: p.error };
  if (to) recordUpdated({ to, state });
  return { kept: true };
}

/** An update step failed: the kept version is put back at once. → one plain sentence. */
export function undoUpdate({ state = stateDir(), now = Date.now } = {}) {
  const rb = rollBack({ state, now });
  return rb.ok ? `The update did not work. Version ${rb.to} is back.` : `The update did not work, and the old version could not be put back (${rb.error}).`;
}

/** The update ran: which version it brought. */
export function recordUpdated({ to, state = stateDir() } = {}) {
  const u = readJson(file(state, 'update.json'));
  if (u) writeAtomic(file(state, 'update.json'), { ...u, to });
}

export const readUpdate = (state = stateDir()) => readJson(file(state, 'update.json'));

/** The new version passed its start check: the kept copy is no longer needed. */
export function markVerified({ state = stateDir() } = {}) {
  const u = readUpdate(state);
  if (!u || u.verified) return false;
  writeAtomic(file(state, 'update.json'), { ...u, verified: true });
  fs.rmSync(previousDir(state), { recursive: true, force: true });
  const n = readNote(state, { all: true });
  if (n && n.kind === 'rollback') clearNote(state);
  return true;
}

/** Whether a rollback is possible now: an update under a day old, never verified, not put back yet, a copy kept. */
export function canRollBack({ state = stateDir(), now = Date.now } = {}) {
  const u = readUpdate(state);
  return !!u && !u.verified && !u.rolledBack && now() - u.at < DAY && fs.existsSync(path.join(previousDir(state), 'tree'));
}

/**
 * Put the kept version back in the folder of the update. The failed folder is set aside first and removed only when the
 * old one is in place; when the copy fails it is set back. → { ok, from, to } or { ok: false, error }.
 */
export function rollBack({ state = stateDir(), now = Date.now } = {}) {
  if (!canRollBack({ state, now })) return { ok: false, error: 'no kept version to go back to' };
  const u = readUpdate(state);
  const root = u.root;
  const failed = readJson(path.join(root, 'package.json'), {}).version || u.to || 'the new version';
  const aside = `${root}.failed`;
  try {
    fs.rmSync(aside, { recursive: true, force: true });
    fs.renameSync(root, aside);
  } catch (e) {
    return { ok: false, error: `could not set the failed version aside: ${String(e?.message || e).slice(0, 120)}` };
  }
  try {
    fs.cpSync(path.join(previousDir(state), 'tree'), root, { recursive: true, verbatimSymlinks: true });
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(aside, root);
    return { ok: false, error: `could not put the kept version back: ${String(e?.message || e).slice(0, 120)}` };
  }
  fs.rmSync(aside, { recursive: true, force: true });
  fs.rmSync(previousDir(state), { recursive: true, force: true });
  writeAtomic(file(state, 'update.json'), { ...u, rolledBack: true });
  return { ok: true, from: failed, to: u.from };
}

// ---------- the note ----------

/**
 * Leave a note for the next start. kind: 'rollback' | 'gaveup' (an Activity line and a row) | 'mended' (an Activity line
 * only). `text` is one plain sentence.
 */
export function writeNote({ kind, text, state = stateDir(), now = Date.now } = {}) {
  writeAtomic(file(state, 'note.json'), { kind, text: String(text).slice(0, 200), at: now(), told: false });
}

/** The note a row is made of (rollback and gaveup, at most a week old), or null. `all`: any note, told or not. */
export function readNote(state = stateDir(), { all = false, now = Date.now } = {}) {
  const n = readJson(file(state, 'note.json'));
  if (!n || typeof n.text !== 'string') return null;
  if (all) return n;
  return (n.kind === 'rollback' || n.kind === 'gaveup') && now() - n.at < NOTE_KEEP ? n : null;
}
export const clearNote = (state = stateDir()) => fs.rmSync(file(state, 'note.json'), { force: true });

/**
 * The dashboard has started: the note becomes one Activity line (once). A note that only said what was mended is then
 * removed; one that needs the owner stays as his row until an update passes its start check or a week is over.
 * `activity(entry)` is the automation log's add.
 */
export function announceNote({ state = stateDir(), activity, now = Date.now } = {}) {
  const n = readNote(state, { all: true });
  if (!n || n.told) return null;
  activity?.({ automation: 'keeper', did: n.text, outcome: n.kind === 'mended' ? 'ok' : 'needs you' });
  if (n.kind === 'mended') clearNote(state);
  else writeAtomic(file(state, 'note.json'), { ...n, told: true });
  return n;
}

/**
 * At a start of the dashboard: the service files of an install made by an older version are written again, so the
 * newer rules (restart on every exit, the keeper) apply from this start on and not only after `service install`. Only
 * when they differ; `reload` is handed in only where the service manager can read files without ending the running
 * dashboard (systemd's daemon-reload; not launchd's bootout). → the files written.
 */
export async function refreshFiles({ files = () => [], reload = null } = {}) {
  const written = [];
  for (const f of files()) {
    let same = false;
    try {
      same = fs.readFileSync(f.file, 'utf8') === f.text;
    } catch {
      /* not there: written below */
    }
    if (same) continue;
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(f.file, f.text, { mode: 0o644 });
    written.push(f.file);
  }
  if (written.length && reload) await reload();
  return written;
}

/** The dashboard started and stayed up: the stop marker and the episode are over, a new version is verified. */
export function confirmStart({ state = stateDir(), version, verify = false } = {}) {
  clearStopped(state);
  fs.rmSync(file(state, 'episode.json'), { force: true });
  const u = readUpdate(state);
  // A version other than the one before the update, still up after a minute, has passed its start check.
  if (verify && u && !u.verified && !u.rolledBack && version && version !== u.from) markVerified({ state });
}

/**
 * The start check right after an update's restart: the new dashboard must answer within START_CHECK_MS, or the kept
 * version is put back and started (and the owner told: a note, and a push when an address is set).
 * → { did: 'none' | 'ok' | 'rolledback' | 'failed', text? }. `restart()` starts the service again.
 */
export async function startCheck({
  state = stateDir(), now = Date.now, sleep = defaultSleep, restart = async () => {}, answers = () => dashboardAnswers({ state }),
  push = defaultPush, waitMs = START_CHECK_MS, step = 1000,
} = {}) {
  if (!canRollBack({ state, now })) return { did: 'none' };
  const waitUp = async () => {
    for (let spent = 0; spent <= waitMs; spent += step) {
      if (await answers()) return true;
      await sleep(step);
    }
    return false;
  };
  if (await waitUp()) return { did: 'ok' };
  const rb = rollBack({ state, now });
  if (!rb.ok) {
    logLine(state, `the new version did not answer in time and could not be put back: ${rb.error}`, now);
    return { did: 'failed', text: rb.error };
  }
  logLine(state, `went back to ${rb.to}: ${rb.from} did not answer within ${Math.round(waitMs / 1000)} seconds`, now);
  const text = `Hoprig went back to ${rb.to} because ${rb.from} did not start.`;
  writeNote({ kind: 'rollback', text, state, now }); // before the restart: the new dashboard reads it as it comes up
  await restart();
  await push(text);
  return { did: 'rolledback', text };
}

// ---------- the keeper itself ----------

const readEpisode = (state) => readJson(file(state, 'episode.json'));
const saveEpisode = (state, ep) => writeAtomic(file(state, 'episode.json'), ep);

async function defaultPush(text) {
  try {
    const { loadConfig } = await import('../config.mjs');
    const { sendNotification } = await import('../server/notify.mjs');
    return await sendNotification(loadConfig().server?.notify, { title: 'Hoprig keeper', message: text, status: 'automation', force: true });
  } catch {
    return { sent: false };
  }
}

/**
 * One look of the keeper. Everything it touches is handed in, so a test never reaches a real service:
 *   files()            [{ file, text }] the service files the installed product would write now
 *   reload()           the service manager reads the files again
 *   start()            start the dashboard service (failed state cleared first)
 *   answers()          whether the dashboard answers
 *   push(text)         one push (only when an address is set)
 *   failed             started because the service manager gave up (no waiting)
 * → { did: 'stopped' | 'up' | 'waiting' | 'rewrote' | 'rolledback' | 'started' | 'gaveup' | 'quiet', ... }
 */
export async function keep({
  state = stateDir(), now = Date.now, sleep = defaultSleep, files = () => [], reload = async () => {}, start = async () => {},
  answers = () => dashboardAnswers({ state }), push = defaultPush, failed = false, grace = 20_000, settle = 10_000, waitMs = 30_000, step = 500,
} = {}) {
  if (isStopped(state)) return { did: 'stopped' };
  if (await answers()) {
    if (readEpisode(state)) {
      fs.rmSync(file(state, 'episode.json'), { force: true });
      logLine(state, 'the dashboard answers again', now);
    }
    return { did: 'up' };
  }
  const ep = readEpisode(state) || { downSince: now(), rewrites: 0, rollbacks: 0, started: 0, gaveUp: false };
  saveEpisode(state, ep);
  if (ep.gaveUp) return { did: 'quiet' };
  if (!failed && now() - ep.downSince < grace) return { did: 'waiting' };

  const waitUp = async (limit = waitMs) => {
    for (let spent = 0; spent <= limit; spent += step) {
      if (await answers()) return true;
      await sleep(step);
    }
    return false;
  };
  const tryStart = async () => {
    const t0 = now();
    try {
      const a = await reload();
      const t1 = now();
      const b = await start();
      // What the service manager answered and how long it took, so a slow or refused start is in the log.
      logLine(state, `reload ${a ?? 'done'} in ${t1 - t0} ms, start ${b ?? 'done'} in ${now() - t1} ms`, now);
    } catch (e) {
      logLine(state, `start did not work: ${String(e?.message || e).slice(0, 120)}`, now);
    }
    const up = await waitUp();
    logLine(state, up ? `the dashboard answers ${now() - t0} ms after the start` : `the dashboard did not answer in ${now() - t0} ms${answersWhy() ? `: ${answersWhy()}` : ''}`, now);
    return up;
  };
  // The service manager runs the keeper at a failure, and it starts the dashboard again by itself 3 seconds later: a
  // dashboard that was only crashing once is not touched. Only one that is still down after `settle` is looked after.
  if (failed && settle > 0 && (await waitUp(settle))) {
    fs.rmSync(file(state, 'episode.json'), { force: true });
    logLine(state, 'the dashboard answers again by itself', now);
    return { did: 'up' };
  }
  let tried = false;

  // 1. the service files
  if (ep.rewrites < 1) {
    const differ = files().filter((f) => {
      try {
        return fs.readFileSync(f.file, 'utf8') !== f.text;
      } catch {
        return true;
      }
    });
    if (differ.length) {
      ep.rewrites = 1;
      saveEpisode(state, ep);
      for (const f of differ) {
        fs.mkdirSync(path.dirname(f.file), { recursive: true });
        fs.writeFileSync(f.file, f.text, { mode: 0o644 });
      }
      logLine(state, `wrote the service file again (${differ.length} of them differed)`, now);
      tried = true;
      // The note is written BEFORE the start: the dashboard reads it as it comes up (announceNote); written after, it
      // would wait for the next start. A start that does not work replaces it with the give-up note below.
      writeNote({ kind: 'mended', text: 'Hoprig started again: its service file was wrong and was written again.', state, now });
      if (await tryStart()) {
        logLine(state, 'the dashboard answers after the service file was written again', now);
        return { did: 'rewrote' };
      }
    }
  }

  // 2. an update that never passed its start check
  if (ep.rollbacks < 1 && canRollBack({ state, now })) {
    ep.rollbacks = 1;
    saveEpisode(state, ep);
    const rb = rollBack({ state, now });
    if (rb.ok) {
      logLine(state, `went back to ${rb.to}: ${rb.from} did not start`, now);
      tried = true;
      const text = `Hoprig went back to ${rb.to} because ${rb.from} did not start.`;
      writeNote({ kind: 'rollback', text, state, now });
      if (await tryStart()) {
        await push(text);
        return { did: 'rolledback', from: rb.from, to: rb.to };
      }
    } else logLine(state, `could not go back: ${rb.error}`, now);
  }

  // 3. one plain start, when nothing else started it
  if (!tried && ep.started < 1) {
    ep.started = 1;
    saveEpisode(state, ep);
    tried = true;
    writeNote({ kind: 'mended', text: 'Hoprig started again after it had stopped.', state, now });
    if (await tryStart()) {
      logLine(state, 'the dashboard answers after a start', now);
      return { did: 'started' };
    }
  }

  // Nothing helped: say so once and leave it alone.
  ep.gaveUp = true;
  saveEpisode(state, ep);
  const what = [ep.rewrites ? 'wrote the service file again' : null, ep.rollbacks ? 'went back to the kept version' : null, tried ? 'started it' : null].filter(Boolean).join(', ') || 'looked at it';
  const text = `Hoprig does not start. The keeper ${what}; it did not help.`;
  writeNote({ kind: 'gaveup', text, state, now });
  logLine(state, `${text} (log: ${path.join(keeperDir(state), 'keeper.log')})`, now);
  await push(text);
  return { did: 'gaveup' };
}

/** `hoprig keep [--failed]`: the service manager's call. The real service files and start, from the installed product. */
export async function main(args = [], deps = {}) {
  const unknown = args.filter((a) => a !== '--failed');
  if (unknown.length) {
    console.error('usage: hoprig keep [--failed]');
    return 2;
  }
  const { serviceFiles, serviceInstalled, service } = await import('../server/service/index.mjs');
  const quiet = async (sub) => {
    const { log: out, error } = console;
    console.log = console.error = () => {};
    try {
      return await service(sub, process.platform, deps.serviceOpts || {});
    } finally {
      Object.assign(console, { log: out, error });
    }
  };
  const r = await keep({
    // A keeper never makes a service the owner does not have.
    files: () => (serviceInstalled(process.platform) ? serviceFiles(process.platform) : []),
    reload: () => quiet('reload'),
    start: () => quiet('start'),
    failed: args.includes('--failed'),
    ...deps.keep,
  });
  console.log(`keeper: ${r.did}`);
  return 0;
}
