// Everything that depends on the operating system, behind one module: the PC tab (load, memory, disks, processes,
// listening ports), killing a process, power off / reboot, and process ancestry for matching run records to
// terminals. One implementation per OS in ./platform/ (linux, darwin, win32), all returning the same shape;
// a value an OS cannot give is null, never made up (Windows has no load average, so `load` is null there).
import * as darwin from './platform/darwin.mjs';
import * as linux from './platform/linux.mjs';
import * as win32 from './platform/win32.mjs';
import { descendsFrom as walk } from './platform/common.mjs';

const impl = { darwin, win32 }[process.platform] || linux;

export { redact } from './platform/common.mjs';
export { parseDf, parseMeminfo, parsePs, parseSs } from './platform/linux.mjs';

/**
 * { host, platform, uptime, load: [1, 5, 15 min] | null, cpus, mem: { total, available, swapTotal, swapFree },
 *   disks: [{ fs, mount, size, used, avail }], topCpu / topMem: [{ pid, uid, cpu, rss, age, name, args, mine }],
 *   ports: [{ addr, port, process, pid }], errors: [string] }
 */
export const snapshot = () => impl.snapshot();

/** Kill one of the user's own processes. Never this server itself. Synchronous: callers use the result at once. */
export function killProcess(pid, signal = 'SIGTERM') {
  if (pid === process.pid) return { ok: false, error: 'that is this dashboard itself' };
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'no such process' };
  return impl.killOwn(pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
}

/** Reboot or power off. Returns the real error text when the system refuses. */
export async function power(action) {
  if (action !== 'reboot' && action !== 'poweroff') return { ok: false, error: 'unknown action' };
  return impl.power(action);
}

/** Parent pid of one process, or null where it cannot be told cheaply (only Linux can: /proc). */
export const procParent = (pid) => impl.procParent(pid);

/**
 * A parentOf(pid) function for a burst of lookups: Linux reads /proc as it goes; macOS and Windows take one
 * process table snapshot.
 */
export const parentLookup = () => impl.parentLookup();

/**
 * True when `pid` is `ancestor` or runs below it. When the very first lookup fails (nothing known about the
 * process tree) the answer is true, so callers fall back to trusting the terminal id alone.
 */
export const descendsFrom = (pid, ancestor, parentOf = procParent) => walk(pid, ancestor, parentOf);
