// The Task manager's processes: every process with the CPU it uses now, and ending one.
//
// "Now" needs two readings: ps's own CPU column is the average since the process started (Linux) or a decaying
// average (macOS), so each OS part gives the CPU time a process has used so far, and the share is the difference
// between two readings divided by the time between them and the number of cores (0–100 % of the whole computer, as
// the Performance panel shows it). The first reading of a burst takes a second one shortly after.

/** Readings closer together than this give no usable share; the last answer is given again instead. */
const MIN_GAP_MS = 300;
/** A first reading (or one after a long pause) waits this long for its second one. */
const FIRST_GAP_MS = 500;
const STALE_MS = 30_000;

/**
 * A sampler over `read()` (the OS part's processes()). `cores()` the number of cores; `now()` and `sleep()` for tests.
 * Returns sample() → [{ …process, cpu: % of the computer | null }].
 */
export function processSampler(read, { cores = () => 1, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = null; // { at, list, times: Map(pid → { t: cpuTime, age }), result }
  let pending = null;
  const take = async () => {
    const list = await read();
    const times = new Map();
    for (const p of list) if (p.cpuTime !== null && p.cpuTime !== undefined) times.set(p.pid, { t: p.cpuTime, age: p.age });
    return { at: now(), list, times };
  };
  const share = (prev, cur) => {
    const secs = (cur.at - prev.at) / 1000;
    const n = Math.max(1, cores());
    return cur.list.map((p) => {
      const a = prev.times.get(p.pid);
      const b = cur.times.get(p.pid);
      // A pid used again by a new process is younger than the one read before: no share for it yet.
      const same = a && b && b.age >= a.age && b.t >= a.t;
      const cpu = same && secs > 0 ? Math.min(100, ((b.t - a.t) / secs / n) * 100) : null;
      return { ...p, cpu: cpu === null ? null : Math.round(cpu * 10) / 10 };
    });
  };
  async function sample() {
    if (pending) return pending;
    pending = (async () => {
      if (last && now() - last.at < MIN_GAP_MS && last.result) return last.result;
      let prev = last && now() - last.at < STALE_MS ? last : null;
      if (!prev) {
        prev = await take();
        await sleep(FIRST_GAP_MS);
      }
      const cur = await take();
      cur.result = share(prev, cur);
      last = cur;
      return cur.result;
    })().finally(() => (pending = null));
    return pending;
  }
  return { sample };
}

/**
 * The pids that may never be ended from the page: this dashboard and every process above it (its service manager,
 * its terminal, its tmux server), up to the first process of the system. `parentOf(pid)` → parent pid or null.
 */
export function guardedPids(self, parentOf) {
  const out = new Set([self, 0, 1]);
  let p = self;
  for (let i = 0; i < 64; i++) {
    const next = parentOf(p);
    if (!Number.isInteger(next) || next <= 1 || out.has(next)) break;
    out.add(next);
    p = next;
  }
  return out;
}

/**
 * End process `pid` (SIGTERM; `force`: SIGKILL). Refused: not a pid, this dashboard or a process above it, and a
 * process of another user (the OS part checks that). Resolves { ok } or { ok: false, error }.
 */
export async function endProcess(pid, { force = false, self = process.pid, parentLookup, kill }) {
  if (!Number.isInteger(pid) || pid <= 1 || pid >= 2 ** 31) return { ok: false, error: 'no such process' };
  const guarded = guardedPids(self, await parentLookup());
  if (guarded.has(pid)) return { ok: false, error: 'that is this dashboard, or a program it runs inside: it is not ended from here' };
  return kill(pid, force ? 'SIGKILL' : 'SIGTERM');
}
