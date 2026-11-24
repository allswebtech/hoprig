// The inner runner: starts the means (bwrap, sandbox-exec) with its arguments and gives back what came of it. Used by
// runBoxed and by the self-test alike, so the self-test tries the very box a command gets. The means writes its own
// status as JSON documents to fd 3 (bwrap's --json-status-fd); the command's exit code counts only when that status
// says the command was started. Small inputs the means reads (a passwd file of the box) go in on fds 4, 5, ...
import { spawn } from 'node:child_process';

/** End the process group `pid` leads (the means and every process it started), by its number, never by a name. */
function endGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Runs `file` with `args`. `data` are buffers handed to the means on fds 4, 5, ... (the args name those numbers).
 * `statusFd` says whether the means writes its status to fd 3 (bwrap does, sandbox-exec does not). Output past
 * `maxOut` bytes is counted in `dropped`, not kept. `env` is the means' whole environment (bwrap: none, it builds the
 * box's own) and `cwd` its folder.
 * → { started, code, signal, out, dropped, timedOut, failure }
 */
export function runMeans(file, args, { timeoutMs, maxOut = 1 << 20, data = [], statusFd = true, env = {}, cwd = '/', onStart } = {}) {
  return new Promise((resolve) => {
    // stdin is /dev/null; stdout and stderr are pipes, read into one stream in the order they come.
    const stdio = ['ignore', 'pipe', 'pipe', statusFd ? 'pipe' : 'ignore', ...data.map(() => 'pipe')];
    let child;
    try {
      // Nothing of the caller's environment reaches the means: only the plan's closed list. Detached: a process group
      // of its own, which the timeout ends whole, and no terminal of the caller's.
      child = spawn(file, args, { cwd, env, stdio, detached: true });
    } catch (e) {
      resolve({ started: false, code: null, signal: null, out: '', dropped: 0, timedOut: false, failure: e.message });
      return;
    }
    // The detached child leads its own process group (child.pid === its pgid): the caller is told it, so a run left
    // behind by a dashboard that died can be found alive and ended by that group id, never by a name.
    try { onStart?.({ group: child.pid }); } catch { /* the caller's note failed: not the run's concern */ }
    const chunks = [];
    let kept = 0;
    let dropped = 0;
    let status = '';
    let timedOut = false;
    let failure = '';
    let boxPid = null;
    let boxEnded = false; // bwrap reported pid 1's exit code: it reaped pid 1, so that number is free again
    child.on('error', (e) => (failure = e.message));
    const take = (d) => {
      const room = maxOut - kept;
      if (room > 0) {
        const part = d.length > room ? d.subarray(0, room) : d;
        chunks.push(part);
        kept += part.length;
      }
      dropped += Math.max(0, d.length - Math.max(0, room));
    };
    for (const s of [child.stdout, child.stderr]) s?.on('data', take);
    // bwrap reports, on the status fd, the pid (as seen out here) of the process it makes pid 1 of the box's own pid
    // space. It is kept so the timeout and the close can end that one directly.
    if (statusFd)
      child.stdio[3].on('data', (d) => {
        status += d;
        if (boxPid == null) {
          const m = /"child-pid"\s*:\s*(\d+)/.exec(status);
          if (m) boxPid = Number(m[1]);
        }
        if (!boxEnded && /"exit-code"\s*:/.test(status)) boxEnded = true;
      });
    data.forEach((buf, i) => {
      const w = child.stdio[4 + i];
      w.on('error', () => {}); // the means ended before it read this: its own message says why
      w.end(buf);
    });
    // End the box whole: its process group (the means and all it started out here), and the box's own pid 1 by its
    // number. That pid 1 leads a NEW session (bwrap's --new-session), so the group kill above does not reach it;
    // ending pid 1 of a pid space ends every process left in that space. Never by a name. Only while bwrap has not
    // reported pid 1's end: after that the number may already be another process's, outside the box.
    const endBox = () => {
      if (child.pid) endGroup(child.pid);
      if (boxPid != null && !boxEnded) {
        try {
          process.kill(boxPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      endBox();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      endBox(); // a process of the group that left the box's pid space early goes too
      const docs = status.split('\n').flatMap((l) => {
        try {
          return l.trim() ? [JSON.parse(l)] : [];
        } catch {
          return [];
        }
      });
      const exit = docs.find((d) => Object.hasOwn(d, 'exit-code'));
      const started = statusFd ? docs.some((d) => Object.hasOwn(d, 'child-pid')) && !failure && (!!exit || timedOut) : !failure;
      resolve({ started, code: statusFd ? (exit ? exit['exit-code'] : null) : code, signal, out: Buffer.concat(chunks).toString('utf8'), dropped, timedOut, failure });
    });
  });
}
