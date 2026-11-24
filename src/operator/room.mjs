// Room: whether a computer can take new work now, in one word. Pure over what it is handed: a reading of the computer
// (what its Health gives: processors, load, available memory, the disk its workspace is on), the time THIS dashboard
// received that reading, and what the computer's own dashboard knows (sessions that work now, Work's runs against its
// limit, a "Start nothing new" hold). Nothing here reads this computer, a file or the network.
//
//   roomOf({ reading, at, now, own }) → { room: 'free' | 'busy' | 'full' | 'unknown', why, facts: [≤ 5 lines] }
//
// Another computer's reading is data (pickHealth already typed it): a number that cannot be true makes the room
// 'unknown', never 'free', so a computer that answers nonsense never pulls new work to itself.

import { DISK_PCT, LOAD_PER_CPU, MEM_FREE_PCT } from './detect/machine.mjs';

/** One row: the room it gives, what it measures, the line, and why the line is there. */
const row = (room, measure, at, reason) => Object.freeze({ room, measure, at, reason });

// The thresholds, relative to the computer (load per processor, memory and disk in percent), strongest first. "full"
// takes the detector's own load and memory lines (detect/machine.mjs), so "overloaded" there and "full" here never
// disagree.
export const ROOM_ROWS = Object.freeze([
  row('full', 'hold', true, 'a "Start nothing new" hold is in place: nothing new starts there until it ends'),
  row('full', 'loadPerCpu', LOAD_PER_CPU, 'above it every task waits for a processor (the Operator calls it overloaded)'),
  row('full', 'memFreePct', MEM_FREE_PCT, 'under it the computer swaps and every small task crawls'),
  row('full', 'diskPct', 95, 'a nearly full disk makes builds, checkouts and logs fail'),
  row('busy', 'loadPerCpu', 0.75, 'from here on one more build makes everything slower'),
  row('busy', 'memFreePct', 25, 'one more coding tool with its build can use what is left'),
  row('busy', 'diskPct', DISK_PCT, 'the line where the Operator already warns about a disk'),
  row('busy', 'runsAtLimit', true, 'Work runs as many runs by themselves as it may: a new one would wait'),
]);

/** An answer older than this (by this dashboard's clock at receipt) says nothing about now. */
export const MAX_AGE_MS = 6 * 60_000;

// What can be true at all (decided: anything outside is "could not be read").
const BOUNDS = Object.freeze({ cpus: [1, 1024], load: [0, 1000], memTotal: [1, 2 ** 52], pct: [0, 100] });

const GiB = 1024 ** 3;
const gb = (b) => `${(b / GiB).toFixed(1)} GB`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inside = (v, [lo, hi]) => isNum(v) && v >= lo && v <= hi;
const mins = (ms) => Math.max(1, Math.round(ms / 60_000));

/**
 * The reading from a Health answer (pickHealth's shape: load [1, 5, 15], cpus, memory { total, available }, disks
 * [{ mount, size, used }], own.mount). `workspace`: the folder the workspace is in, when known (this computer), else the
 * answer's own.mount (another computer); its disk is the one with the longest mount that holds it, else (not known) the
 * fullest disk of 1 GB or more, so a full disk is never missed.
 */
/** The mount (of `mounts`) of the disk that holds folder `dir`: the longest one it is in, or null. A mount holds itself. */
export function mountHolding(dir, mounts = []) {
  if (typeof dir !== 'string' || !dir) return null;
  const holds = mounts.filter((m) => typeof m === 'string' && m && (dir === m || dir.startsWith(/[\\/]$/.test(m) ? m : `${m}/`) || dir.startsWith(`${m}\\`)));
  return holds.sort((a, b) => b.length - a.length)[0] || null;
}

export function readingOfHealth(h, workspace = null) {
  if (!h || typeof h !== 'object') return null;
  const disks = (Array.isArray(h.disks) ? h.disks : []).filter((d) => d && isNum(d.size) && d.size > 0);
  const pct = (d) => (isNum(d.used) ? (d.used / d.size) * 100 : NaN);
  // A disk whose use is not a number sorts first: the fullest disk is then one that cannot be read, never a guess.
  const sortPct = (d) => (Number.isNaN(pct(d)) ? Infinity : pct(d));
  // Another computer names the workspace's disk by its mount only (own.mount, health.mjs); a mount holds itself.
  const where = typeof workspace === 'string' && workspace ? workspace : h.own && typeof h.own.mount === 'string' ? h.own.mount : null;
  const at = mountHolding(where, disks.map((d) => d.mount));
  let disk = at ? disks.find((d) => d.mount === at) || null : null;
  if (!disk) disk = disks.filter((d) => d.size >= GiB).sort((a, b) => sortPct(b) - sortPct(a))[0] || null;
  return {
    cpus: h.cpus,
    load1: Array.isArray(h.load) ? h.load[0] : null,
    memTotal: h.memory ? h.memory.total : null,
    memAvailable: h.memory ? h.memory.available : null,
    disk: disk ? { mount: String(disk.mount || '').slice(0, 60), usedPct: pct(disk) } : null,
  };
}

/** The reading from the board's own `machine` source (sources.mjs machineCheck): this computer. */
export function readingOfMachine(m, workspaceMount = null) {
  if (!m || typeof m !== 'object') return null;
  const disks = Array.isArray(m.disks) ? m.disks : [];
  const disk = (workspaceMount && disks.find((d) => d.mount === workspaceMount)) || [...disks].sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0] || null;
  return { cpus: m.cpus, load1: m.load1, memTotal: m.memTotal, memAvailable: m.memAvailable, disk: disk ? { mount: String(disk.mount || '').slice(0, 60), usedPct: disk.usedPct } : null };
}

/** Whether every number of a reading can be true; the disk may be absent (a computer that names none). */
export function readable(r) {
  if (!r || !inside(r.cpus, BOUNDS.cpus) || !Number.isInteger(r.cpus)) return false;
  if (!inside(r.load1, BOUNDS.load)) return false;
  if (!inside(r.memTotal, BOUNDS.memTotal) || !isNum(r.memAvailable) || r.memAvailable < 0 || r.memAvailable > r.memTotal) return false;
  if (r.disk != null && !inside(r.disk.usedPct, BOUNDS.pct)) return false;
  return true;
}

const unknown = (why, facts = []) => ({ room: 'unknown', why, facts: facts.slice(0, 5) });

/**
 * The room of one computer. `reading`: readingOfHealth / readingOfMachine, or null when it was not reached; `at`: when
 * this dashboard received it (its own clock); `own`: { working (sessions that work now), runs: { running, atOnce },
 * hold: { until } | null }, what that computer's dashboard knows (absent: not known, never counted as room).
 */
export function roomOf({ reading, at, now = Date.now(), own = {}, maxAgeMs = MAX_AGE_MS } = {}) {
  if (!reading) return unknown('it was not reached');
  if (!isNum(at)) return unknown('it is not known when it last answered');
  const age = now - at;
  // A receipt time in the future is a fault of the record, never a fresh answer.
  if (age < -60_000) return unknown('it is not known when it last answered');
  if (age > maxAgeMs) return unknown(`its last answer is ${mins(age)} minutes old`);
  if (!readable(reading)) return unknown('its answer could not be read');

  const { cpus, load1, memTotal, memAvailable, disk } = reading;
  const m = {
    hold: !!(own.hold && isNum(own.hold.until) && own.hold.until > now),
    loadPerCpu: load1 / cpus,
    memFreePct: (memAvailable / memTotal) * 100,
    diskPct: disk ? disk.usedPct : null,
    runsAtLimit: !!(own.runs && isNum(own.runs.running) && isNum(own.runs.atOnce) && own.runs.atOnce > 0 && own.runs.running >= own.runs.atOnce),
  };
  const hits = (r) => {
    const v = m[r.measure];
    if (r.measure === 'hold' || r.measure === 'runsAtLimit') return v === true;
    if (v == null) return false;
    if (r.measure === 'loadPerCpu') return r.room === 'full' ? v > r.at : v >= r.at;
    if (r.measure === 'memFreePct') return v < r.at;
    return v >= r.at; // diskPct
  };
  const facts = [
    `load ${load1.toFixed(1)} on ${cpus} CPU${cpus === 1 ? '' : 's'} (${m.loadPerCpu.toFixed(2)} per CPU)`,
    `${gb(memAvailable)} of ${gb(memTotal)} memory available (${Math.round(m.memFreePct)} %)`,
    disk ? `disk ${disk.mount || '?'} ${Math.round(disk.usedPct)} % full` : null,
    isNum(own.working) ? `${own.working} session${own.working === 1 ? '' : 's'} working` : null,
    own.runs && isNum(own.runs.running) && isNum(own.runs.atOnce) ? `Work: ${own.runs.running} of ${own.runs.atOnce} runs by themselves` : null,
    m.hold ? `"Start nothing new" until ${new Date(own.hold.until).toISOString().slice(11, 16)} UTC` : null,
  ].filter(Boolean);
  const hit = ROOM_ROWS.find(hits);
  if (!hit) return { room: 'free', why: 'it has room for new work', facts: facts.slice(0, 5) };
  const said = {
    hold: 'a "Start nothing new" hold is in place',
    loadPerCpu: `its load is ${m.loadPerCpu.toFixed(1)} per CPU`,
    memFreePct: `only ${Math.round(m.memFreePct)} % of its memory is free`,
    diskPct: `its disk is ${Math.round(m.diskPct ?? 0)} % full`,
    runsAtLimit: 'Work runs as many runs as it may there',
  }[hit.measure];
  const why = hit.room === 'full' ? `It is full: ${said}.` : `It is busy: ${said}.`;
  // The hold's line first when it is the cause, so the five lines always show the why.
  const ordered = hit.measure === 'hold' ? [facts[facts.length - 1], ...facts.slice(0, -1)] : facts;
  return { room: hit.room, why, facts: ordered.slice(0, 5) };
}
