// The board: one small, current picture of what the product already knows, built from sources passed in (so it is
// pure over its inputs and a test gives it made-up ones). A look never fetches, never asks a model and never waits
// long: every source has a time limit, and one that fails or is too slow is said as "could not be read: <cause>",
// never left empty as if all were fine. The board is kept for at most 5 seconds.
//
// The full board stays on the server, where the detectors read it. What a page or Tia gets is `publicBoard`: counts
// and short lists, names, states, numbers and times, cut to a size budget.

/** Every source, in the order the panel lists them, with the plain name it is shown under. */
export const SOURCES = Object.freeze([
  ['sessions', 'Sessions and their agents'],
  ['work', 'Work: tasks, plans and runs'],
  ['providers', 'Providers: usage and limits'],
  ['gateways', 'Gateways'],
  ['live', 'The login page and the public link'],
  ['computers', 'Computers of the main computer'],
  ['repos', 'Repositories of the workspace'],
  ['changes', 'Changes made by automations'],
  ['schedules', 'Schedules'],
  ['machine', 'This computer'],
  ['leftovers', 'Left-over processes'],
]);
const NAMES = SOURCES.map(([n]) => n);

export const SOURCE_TIMEOUT_MS = 2000;
export const CACHE_MS = 5000;

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

// A cause in plain words, short, without a path or an address that could say more than it should.
const cause = (e) => String(e?.message || e || 'unknown error').split('\n')[0].replace(/(?:[a-z]+:\/\/|\/)[^\s'"]+/gi, '…').slice(0, 120);

/**
 * Builds the board. `sources` maps a source's name to a function that returns its value (or a promise of it).
 * `extra` holds plain values that are not sources (the configured port, the owner's last look).
 */
export async function buildBoard(sources, { now = Date.now(), timeoutMs = SOURCE_TIMEOUT_MS, extra = {} } = {}) {
  const board = { at: new Date(now).toISOString(), ...extra, watched: [] };
  await Promise.all(NAMES.filter((n) => typeof sources[n] === 'function').map(async (name) => {
    try {
      board[name] = await within(Promise.resolve().then(() => sources[name]()), timeoutMs);
      board.watched.push({ source: name, ok: true, at: new Date(now).toISOString() });
    } catch (e) {
      board[name] = null;
      board.watched.push({ source: name, ok: false, at: new Date(now).toISOString(), error: `could not be read: ${cause(e)}` });
    }
  }));
  for (const name of NAMES) {
    if (typeof sources[name] !== 'function') board.watched.push({ source: name, ok: false, at: null, error: 'could not be read: not on this computer' });
  }
  board.watched.sort((a, b) => NAMES.indexOf(a.source) - NAMES.indexOf(b.source));
  for (const w of board.watched) {
    w.label = SOURCES[NAMES.indexOf(w.source)][1];
    if (!w.ok) continue;
    try { w.summary = summary(w.source, board[w.source]); } catch (e) { w.summary = `read, but not summed up: ${cause(e)}`; }
  }
  return board;
}

const count = (list, f) => (Array.isArray(list) ? list.filter(f).length : 0);
const len = (list) => (Array.isArray(list) ? list.length : 0);
/** "1 session", "3 sessions". */
const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** One short line per source for "Watched". */
export function summary(name, v) {
  switch (name) {
    case 'sessions': return `${n(len(v), 'session')}, ${count(v, (s) => s.state === 'working')} working, ${count(v, (s) => s.asks?.length)} asking`;
    case 'work': return `${n(v?.open ?? 0, 'open task')}, ${n(v?.plans ?? 0, 'plan')}, ${n(count(v?.runs, (r) => r.state === 'running'), 'run')} going`;
    case 'providers': return n(len(v), 'provider');
    case 'gateways': return `${n(len(v), 'gateway')}, ${count(v, (g) => g.running)} running`;
    case 'live': return `login page ${v?.local?.status ?? 'not checked yet'}; public link ${v?.link?.on ? (v.link.status ?? 'not checked yet') : 'off'}`;
    case 'computers': return count(v, (c) => typeof c.online === 'boolean') ? `${n(len(v), 'computer')}, ${count(v, (c) => c.online)} online` : `${n(len(v), 'computer')}, online not known`;
    case 'repos': return `${n(len(v), 'repository', 'repositories')}, ${count(v, (r) => r.behind || r.ahead || r.dirty || (r.branch && !r.upstream))} not in step`;
    case 'changes': return `${n(len(v), 'recent commit')} by automations`;
    case 'schedules': return `${n(len(v), 'schedule')}, ${count(v, (s) => s.on)} on`;
    case 'machine': return v ? `load ${Number(v.load1 ?? 0).toFixed(1)} on ${v.cpus ?? '?'} CPUs` : '';
    case 'leftovers': return `${n(len(v), 'process', 'processes')} found`;
    default: return '';
  }
}

/** Keeps the board for `ttlMs`; looks within that time share one build (and one read of every source). */
export function boardCache(build, { ttlMs = CACHE_MS, clock = Date.now } = {}) {
  let kept = null;
  return {
    get() {
      const now = clock();
      if (kept && now - kept.at < ttlMs) return kept.board;
      const board = build(now);
      kept = { at: now, board };
      board.catch(() => { if (kept?.board === board) kept = null; });
      return board;
    },
    forget() { kept = null; },
  };
}

const LIST_MAX = 40;
const cut = (list, map, keep = () => true) => {
  const all = Array.isArray(list) ? list.filter(keep) : [];
  const out = { count: Array.isArray(list) ? list.length : 0, list: all.slice(0, LIST_MAX).map(map) };
  if (all.length > LIST_MAX) out.more = all.length - LIST_MAX;
  return out;
};
const notInStep = (r) => r.behind || r.ahead || r.dirty || (r.branch && !r.upstream);

/**
 * The board as a page or Tia sees it: every source's state, then per source its count and a short list (at most
 * 40, with how many more). Sessions in a few fields, repositories only when not in step.
 */
export function publicBoard(board) {
  const out = { at: board.at, watched: board.watched.map(({ source, label, ok, at, error, summary: s }) => (ok ? { source, label, ok, at, summary: s } : { source, label, ok, at, error })) };
  if (board.sessions) out.sessions = cut(board.sessions, (s) => [s.name, s.state, s.provider || null, s.agents?.length || 0]);
  if (board.work) out.work = { open: board.work.open ?? 0, plans: board.work.plans ?? 0, runs: cut(board.work.runs, (r) => [r.id, r.state]) };
  if (board.providers) out.providers = cut(board.providers, (p) => [p.name, p.usage?.fiveHour?.pct ?? null, p.usage?.week?.pct ?? null, p.signedIn ?? null]);
  if (board.gateways) out.gateways = cut(board.gateways, (g) => [g.name, g.running, g.answers ?? null]);
  if (board.live) out.live = { local: board.live.local?.status ?? null, link: board.live.link?.on ? board.live.link.status ?? null : 'off' };
  // A computer with its room: its name, the word, its load per processor and its free memory in percent (rooms.mjs).
  if (board.computers) out.computers = cut(board.computers, (c) => (c.room ? [c.name, c.room, c.cpus && c.load1 != null ? Math.round((c.load1 / c.cpus) * 100) / 100 : null, c.memFreePct ?? null] : [c.name, c.online]));
  if (board.repos) out.repos = cut(board.repos, (r) => [r.name, r.behind || 0, r.ahead || 0, r.dirty || 0], notInStep);
  if (board.changes) out.changes = cut(board.changes, (c) => [c.where, String(c.commit).slice(0, 7), c.at]);
  if (board.schedules) out.schedules = cut(board.schedules, (s) => [s.name, s.on]);
  if (board.machine) {
    const m = board.machine;
    out.machine = { cpus: m.cpus ?? null, load1: m.load1 ?? null, memAvailablePct: m.memTotal ? Math.round((m.memAvailable / m.memTotal) * 100) : null, tmpPct: m.tmp?.usedPct ?? null, disks: (m.disks ?? []).slice(0, 8).map((d) => [d.mount, d.usedPct]) };
  }
  if (board.leftovers) out.leftovers = { count: board.leftovers.length };
  return out;
}
