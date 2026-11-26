// Settings → Tia → "Improve Tia", as a server feature: { name, routes, start, close }. A round (improve.mjs) starts only
// by the owner's press on his own page, or by the weekly switch he turned on (off by default).
//
//   GET  /api/assistant/improve            the settings, the providers, the estimate, the round now or the last one
//   POST /api/assistant/improve/start      { provider, cap }   one round, in the background; 409 while one runs
//   POST /api/assistant/improve/stop       the round now: its eval's process ends by its pid
//   POST /api/assistant/improve/settings   { weekly?, provider?, cap? }
//
// Tia's token, her door (the server's own requests) and another dashboard's token are refused on every route: money
// and her own texts are the owner's. One round at a time, also across two dashboards on one state folder (a lock file
// with the round's pid). A round that was running when the dashboard stopped is marked stopped at the next start, and
// its holds count whole (what it ran is not known).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { freshAfter, sameProcess, startOf, system } from '../procid.mjs';
import { listProfiles, publicProfile } from '../profiles.mjs';
import { BUSY, patiently, replaceFile } from '../replacefile.mjs';
import { billedLogin } from '../routerstate.mjs';
import { claudeTurn } from '../skillhub/learnlook.mjs';
import { estimate, Round } from './improve.mjs';
import { isPaid, SpendLedger } from './spend.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const dir = () => path.join(stateDir(), 'assistant');
const stateFile = () => path.join(dir(), 'improve.json');
const settingsFile = () => path.join(dir(), 'improve-settings.json');
const lockFile = () => path.join(dir(), 'improve.lock');
export const WEEK_MS = 7 * 24 * 3600_000;
export const CAP_DEFAULT = 6;
export const RESTART_WHY = 'the dashboard stopped while it ran';

function readJsonFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}
function writeJsonFile(file, v, platform = process.platform) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  replaceFile(tmp, file, { platform }); // the page reads it while a round writes it
}

export function readSettings() {
  const s = readJsonFile(settingsFile()) || {};
  return { weekly: s.weekly === true, provider: typeof s.provider === 'string' ? s.provider : null, cap: Number.isFinite(s.cap) ? s.cap : CAP_DEFAULT };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Windows: a name whose removal is not through yet (another program, a virus scan, still holds the file a moment)
// refuses a new file there, and a removal of it, with EPERM (or EACCES, EBUSY): something is there, as EEXIST says,
// and it is waited for and looked at again, for up to PENDING_MS. Elsewhere those errors are refusals, as before.
const PENDING_MS = 1000;
const heldAt = (e, platform = process.platform) => e.code === 'EEXIST' || (platform === 'win32' && BUSY.has(e.code));
const nap = new Int32Array(new SharedArrayBuffer(4));

/** For the tests: a state file written as a round writes it. */
export const writeStateForTest = (file, v, platform) => writeJsonFile(file, v, platform);

/**
 * Is the round of lock `held` ({ pid, proc?, id }) still running? Its pid alive, and, when the lock carries the process
 * identity (procid.mjs: pid and start), that very process: a pid another process has now (Windows hands one out again
 * at once) is a round that ended. An identity that cannot be told counts as running (never take a live round's lock).
 * A lock of an older version (no identity): its pid alive, as before; a round has no fixed length to bound its age by.
 * The identity is asked only here, when a round starts and meets a lock: an answer the system gave at most FRESH_MS ago
 * (procid.mjs freshAfter). In the dashboard, which never waits for the system, the press asks it and counts as running;
 * the next press (or tick, on Windows within 5 minutes) has that answer.
 */
function roundRuns(held, ident) {
  if (!held || !Number.isInteger(held.pid) || !alive(held.pid)) return false;
  if (typeof held.proc !== 'string') return true;
  return sameProcess(held.proc, ident.of([held.pid], { after: freshAfter(), born: startOf(held.proc) }).get(held.pid)) !== false; // a fresh identity (procid.mjs freshAfter)
}

/**
 * The lock of one round: taken with 'wx', holding this process's identity; one whose round's process ended is taken
 * over (roundRuns). → true when taken. A lock a live round holds: false at once, as before. A name still held a moment
 * (heldAt, not EEXIST): looked at again for up to PENDING_MS. `platform`, `ident`: for the tests.
 */
export function takeLock(id, { platform = process.platform, ident = system } = {}) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const until = Date.now() + PENDING_MS;
  let pending = false;
  for (let i = 0; i < 2 || (pending && Date.now() < until); i++) {
    if (i >= 2) Atomics.wait(nap, 0, 0, 20);
    try {
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, proc: ident.self() || undefined, id }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (!heldAt(e, platform)) throw e;
      if (e.code !== 'EEXIST') {
        pending = true;
        continue;
      }
      if (roundRuns(readJsonFile(lockFile()), ident)) return false;
      try {
        fs.rmSync(lockFile(), { force: true });
      } catch (e2) {
        if (!heldAt(e2, platform)) throw e2;
        pending = true;
      }
    }
  }
  return false;
}
const dropLock = (id) => {
  const held = readJsonFile(lockFile());
  if (held && held.id === id) patiently(() => fs.rmSync(lockFile(), { force: true }));
};

/** `opts`: { turn (a stand-in for the model call), runner (a stand-in eval), env, now, ledger, demo (why no round runs), ident (procid.mjs system, for the tests) }. */
export function improveFeature(sctx, opts = {}) {
  const cfg = () => (sctx.config ? sctx.config() : {});
  const now = opts.now || Date.now;
  const ledger = () => opts.ledger || new SpendLedger({ now });
  let current = null;
  let timer = null;

  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'Improve Tia is the owner\'s only');
    if (sctx.caller && sctx.caller(req) !== 'page') throw fail(403, 'a round of Improve Tia starts only by your press on this dashboard\'s own page');
  };

  // Billed by use as the dashboard's own list says it (accounts.mjs): a key paid per use, or a stored sign-in on a
  // Console account's key (routerstate.mjs billedLogin), whose profile file holds no key.
  // Each with its own estimate: the model its key sends the eval's "haiku" to, and whether it is a gateway.
  const providers = () => {
    const last = lastMeasured();
    return listProfiles().map((p) => {
      const v = publicProfile(p);
      const key = p.kind === 'api';
      const smallModel = key ? p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || p.env.ANTHROPIC_SMALL_FAST_MODEL || null : null;
      return {
        name: p.name, label: v.label || p.name, paid: isPaid(v) || billedLogin(p), claude: v.tools.includes('claude'),
        estimate: estimate(last, { provider: p.name, smallModel, gateway: key && !p.paid }),
      };
    }).filter((p) => p.claude);
  };
  const dailyCap = () => {
    const c = (cfg().assistant || {}).dailyCapUsd;
    return Number.isFinite(c) && c > 0 ? c : null;
  };

  /** A round that was running when the dashboard stopped: marked stopped, its open holds counted whole. */
  function settleLeftOver() {
    const s = readJsonFile(stateFile());
    if (!s || s.running !== true || (current && current.state.id === s.id)) return;
    // Another dashboard runs it: judged as its lock is (roundRuns), so a pid that another process has now is a round
    // that ended. A state an older Hoprig wrote (no identity): its pid alive, as before.
    if (Number.isInteger(s.pid) && s.pid !== process.pid && roundRuns({ pid: s.pid, proc: s.proc }, opts.ident || system)) return;
    const l = ledger();
    for (const id of Array.isArray(s.holds) ? s.holds : []) if (typeof id === 'string' && /^improve-[0-9a-f]{12}$/.test(id)) l.spent(l.heldFor(id), 'Improve Tia (stopped by a restart)', id);
    writeJsonFile(stateFile(), { ...s, running: false, holds: [], stopped: RESTART_WHY, endedAt: new Date(now()).toISOString() });
    dropLock(s.id);
  }

  /** Start a round on `provider` with `cap`. → its state at once; the round runs on. */
  function begin({ provider, cap, by = 'you' }) {
    if (opts.demo) throw fail(409, opts.demo, 'demo');
    if (current) throw fail(409, 'a round runs already', 'running');
    settleLeftOver();
    const p = providers().find((x) => x.name === provider);
    if (!p) throw fail(400, 'choose one of your providers that runs Claude Code');
    const daily = dailyCap();
    if (p.paid && !daily) throw fail(409, `${p.label} is billed by use, and Tia has no daily limit for paid use: set one in Settings → Tia first`, 'no-limit');
    const round = new Round({
      provider, paid: p.paid, cap, dailyCap: daily, ledger: ledger(), by, now,
      turn: opts.turn || claudeTurn, runner: opts.runner, env: opts.env || process.env, perCaseUsd: p.estimate.perCaseUsd,
      save: (st) => writeJsonFile(stateFile(), st),
    });
    // A lock of this very dashboard (its pid and identity) while no round of its own runs is one whose removal at the
    // end of a round failed (below): it is taken over, never answered "another dashboard".
    const held = readJsonFile(lockFile());
    if (held && held.pid === process.pid && typeof held.proc === 'string' && held.proc === system.self()) {
      try {
        patiently(() => fs.rmSync(lockFile(), { force: true }));
      } catch {
        /* takeLock says why */
      }
    }
    if (!takeLock(round.state.id)) throw fail(409, 'a round runs already on another dashboard of this computer', 'running');
    current = round;
    round.save();
    // Nothing may leave this chain: no handler follows it, and a rejection there would end the dashboard. A state that
    // cannot be written, or a lock that cannot be removed, is left: the next start settles the state (settleLeftOver)
    // and takes over a lock of this dashboard's own (above).
    round.run().catch((e) => {
      round.state.failed = String(e && e.message).slice(0, 300);
      try {
        round.end();
      } catch {
        /* its state stays "running": the next start marks it stopped */
      }
    }).finally(() => {
      if (current === round) current = null;
      try {
        dropLock(round.state.id);
      } catch {
        /* the next start takes over this dashboard's own lock */
      }
    });
    return round.state;
  }

  const lastMeasured = () => (readJsonFile(stateFile()) || {}).measured || null;

  /** The weekly round, when he switched it on: once a week at most, on his chosen provider and cap. */
  function tick() {
    const s = readSettings();
    if (!s.weekly || !s.provider || current || opts.demo) return null;
    const last = readJsonFile(stateFile());
    if (last && Date.parse(last.startedAt) > now() - WEEK_MS) return null;
    try {
      return begin({ provider: s.provider, cap: s.cap, by: 'weekly' });
    } catch {
      return null; // said on the page by the settings (no limit, no such provider)
    }
  }

  const view = () => {
    const s = readSettings();
    const st = current ? current.state : readJsonFile(stateFile());
    const list = providers();
    // The estimate of the weekly round's provider, else of the last round's (each provider has its own in the list).
    const of = list.find((p) => p.name === (s.provider || (st && st.provider)));
    return { settings: s, providers: list, dailyCapUsd: dailyCap(), estimate: of ? of.estimate : estimate(lastMeasured()), round: st, ...(opts.demo ? { demo: opts.demo } : {}) };
  };

  const capOf = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 100) throw fail(400, 'the cap of a round is an amount from 0.5 to 100 US dollars');
    return Math.round(v * 100) / 100;
  };

  const routes = [
    ['GET', /^\/api\/assistant\/improve$/, async (req) => {
      ownerOnly(req);
      settleLeftOver();
      return view();
    }],
    ['POST', /^\/api\/assistant\/improve\/(start|stop|settings)$/, async (req, m) => {
      ownerOnly(req);
      const b = (await sctx.readJson(req)) || {};
      if (typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'the body must be a JSON object');
      if (m[1] === 'stop') {
        if (!current) throw fail(409, 'no round runs now', 'not-running');
        current.stop();
        return { ok: true };
      }
      if (m[1] === 'start') {
        if (typeof b.provider !== 'string') throw fail(400, 'say which provider');
        begin({ provider: b.provider, cap: capOf(b.cap) });
        return view();
      }
      const s = readSettings();
      for (const k of Object.keys(b)) if (!['weekly', 'provider', 'cap'].includes(k)) throw fail(400, `"${k}" is not a setting of Improve Tia`);
      if (b.weekly !== undefined && typeof b.weekly !== 'boolean') throw fail(400, 'weekly is true or false');
      if (b.provider !== undefined && !providers().some((p) => p.name === b.provider)) throw fail(400, 'choose one of your providers that runs Claude Code');
      const next = { ...s, ...(b.weekly !== undefined ? { weekly: b.weekly } : {}), ...(b.provider !== undefined ? { provider: b.provider } : {}), ...(b.cap !== undefined ? { cap: capOf(b.cap) } : {}) };
      if (next.weekly && !next.provider) throw fail(400, 'choose the provider of the weekly round first');
      writeJsonFile(settingsFile(), next);
      return view();
    }],
  ];

  return {
    name: 'improve',
    routes,
    tick,
    current: () => current,
    start() {
      // The timer first: a state or lock file refused for a moment (Windows) must not leave the weekly round unset.
      timer = setInterval(tick, 3600_000);
      timer.unref?.();
      try {
        settleLeftOver();
      } catch {
        /* settled at the next look: every read of the round runs it again */
      }
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      current?.stop('the dashboard stopped');
    },
  };
}
