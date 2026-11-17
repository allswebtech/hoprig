// The processes a terminal runs, for the backends that end them (pty.mjs, tmux.mjs). POSIX only.
import { execFile } from 'node:child_process';
import { alive, sameProcess, system } from '../../procid.mjs';
import { parseParents } from '../platform/common.mjs';

/** How long a program gets to end by itself after SIGHUP (Claude Code saves on the way out) before SIGKILL. */
export const STOP_WAIT_MS = 2000;
// Not unref'd: nothing else may hold the process while a caller waits for these to end (it lasts STOP_WAIT_MS at most).
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
 * SIGHUP to each of `pids`, as when a terminal window closes, and wait until all have ended (at most `waitMs`).
 * Resolves to a function that sends a signal to those still running, for the caller's next step. Who each one is,
 * where that costs nothing (Linux, /proc): a pid that ends meanwhile and is handed out again gets no signal, nor one
 * that /proc had nothing on (gone already). Elsewhere only whether its pid is alive.
 */
export async function endAll(pids, { ident = system, platform = process.platform, waitMs = STOP_WAIT_MS } = {}) {
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
  const end = Date.now() + waitMs;
  while (pids.some(still) && Date.now() < end) await wait(50);
  return send;
}
