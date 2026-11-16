// The Task manager's Performance and Network panels: the CPU of the whole computer and of each core, and the
// bytes each network interface moves per second. Both are differences between two readings (the same code on every
// OS for the CPU: os.cpus(); the counters come from the OS part), so each reader keeps its last reading; the first
// reading of a burst takes a second one shortly after.
import os from 'node:os';

const FIRST_GAP_MS = 400;
const STALE_MS = 30_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** os.cpus() → [{ busy, total }] in milliseconds of each core so far. */
export const cpuTimes = (cpus = os.cpus()) => cpus.map((c) => {
  const t = c.times;
  const total = t.user + t.nice + t.sys + t.idle + t.irq;
  return { busy: total - t.idle, total };
});

/** Two cpuTimes() readings → { total, cores } in % (one decimal). */
export function cpuShare(a, b) {
  const cores = b.map((x, i) => {
    const y = a[i];
    const dt = y ? x.total - y.total : 0;
    return dt > 0 ? Math.max(0, Math.min(100, ((x.busy - y.busy) / dt) * 100)) : 0;
  });
  const round = (n) => Math.round(n * 10) / 10;
  return { total: round(cores.length ? cores.reduce((s, n) => s + n, 0) / cores.length : 0), cores: cores.map(round) };
}

/** A reader of something that only means anything as a difference: read() → reading, diff(prev, cur, secs) → answer. */
export function differ(read, diff, { now = Date.now, sleep = sleepMs, gap = FIRST_GAP_MS } = {}) {
  let last = null;
  let pending = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      let prev = last && now() - last.at < STALE_MS ? last : null;
      if (!prev) {
        prev = { at: now(), v: await read() };
        await sleep(gap);
      }
      const cur = { at: now(), v: await read() };
      // Two calls at nearly the same moment: the second is measured against the reading before the first.
      if (cur.at - prev.at < 200 && last && last.prev) prev = last.prev;
      last = { ...cur, prev };
      return diff(prev.v, cur.v, Math.max(0.001, (cur.at - prev.at) / 1000));
    })().finally(() => (pending = null));
    return pending;
  };
}

/** Two counter readings [{ name, rx, tx }] → [{ name, rx, tx, rxRate, txRate }] (bytes per second; null for a new one). */
export function netRates(a, b, secs) {
  const before = new Map(a.map((x) => [x.name, x]));
  return b.map((x) => {
    const y = before.get(x.name);
    const rate = (k) => (y && x[k] >= y[k] ? Math.round((x[k] - y[k]) / secs) : null);
    return { ...x, rxRate: rate('rx'), txRate: rate('tx') };
  });
}

/** os.networkInterfaces() → Map(name → [{ address, family, internal }]). MAC addresses are left out. */
export function addressesOf(ifaces = os.networkInterfaces()) {
  const map = new Map();
  for (const [name, list] of Object.entries(ifaces || {})) {
    map.set(name, (list || []).map((a) => ({ address: a.address, family: a.family === 6 || a.family === 'IPv6' ? 'IPv6' : 'IPv4', internal: !!a.internal })));
  }
  return map;
}
