// The processes a terminal runs, for the backends that end them (pty.mjs, tmux.mjs). POSIX only.
import { execFile } from 'node:child_process';
import { alive, sameProcess, system } from '../../procid.mjs';
import { parseParents } from '../platform/common.mjs';

/** How long the programs of a terminal get to end by themselves after SIGHUP (Claude Code saves on its way out). */
export const STOP_WAIT_MS = 2000;
/**
 * How long a move waits for the one process that holds its conversation (the launcher, which ends after its coding
 * tool): while it runs, the new launcher on the same conversation refuses to start. A tool that saves slowly gets
 * this long; whatever else ignores SIGHUP (a nohup job) still costs only STOP_WAIT_MS.
 */
export const HOLD_WAIT_MS = 10_000;
// Not unref'd: nothing else may hold the process while a caller waits for these to end (STOP_WAIT_MS at most, or
// HOLD_WAIT_MS for the one process that holds a conversation being moved).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every descendant of `root` (by `ps`), so nothing a session started outlives a kill. */
export function descendants(root) {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      const kids = new Map();
      for (const [pid, ppid] of parseParents(stdout)) kids.set(ppid, [...(kids.get(ppid) || []), pid]);
      const out = [];
      const todo = [root];
      while (todo.length && out.length < 10_000) for (const k of kids.get(todo.pop()) || []) out.push(k), todo.push(k);
      resolve(out);
    });
  });
}

/**
 * SIGHUP to each of `pids`, as when a terminal window closes, then SIGCONT, as the kernel and the shell send on a
 * hang-up: a stopped program (Ctrl-Z) gets its SIGHUP only once it runs again. Then wait until all have ended (at most
 * `waitMs`; the one of them that is `hold`, at most `holdMs`). Resolves to a function that sends a signal to those
 * still running, for the caller's next step. Who each one is, where that costs nothing (Linux, /proc): a pid that ends
 * meanwhile and is handed out again gets no signal, nor one that /proc had nothing on (gone already). Elsewhere only
 * whether its pid is alive.
 */
export async function endAll(pids, { ident = system, platform = process.platform, waitMs = STOP_WAIT_MS, hold = null, holdMs = HOLD_WAIT_MS } = {}) {
  const ids = platform === 'linux' && pids.length && ident.self() ? ident.of(pids) : null;
  const still = (pid) => alive(pid) && !(ids && (!ids.get(pid) || sameProcess(ids.get(pid), ident.of([pid]).get(pid)) === false));
  const send = (sig) => {
    for (const pid of pids) {
      if (!still(pid)) continue;
      try {
        process.kill(pid, sig);
      } catch {
        /* gone, or not ours */
      }
    }
  };
  send('SIGHUP');
  send('SIGCONT');
  const start = Date.now();
  // Only a pid of the terminal's own is waited for longer: a stale record's pid may be anyone's by now.
  const held = pids.includes(hold) ? hold : null;
  const waiting = () => {
    const ms = Date.now() - start;
    return (ms < waitMs && pids.some(still)) || (held !== null && ms < holdMs && still(held));
  };
  while (waiting()) await wait(50);
  return send;
}
