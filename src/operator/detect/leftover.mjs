// A left-over process: a tmux server on a private socket that has no client and whose shells run nothing, or a
// dashboard process listening on a port other than the configured one. Each only once it is older than 10
// minutes, so a test or a start that is still on its way is never named. A tmux server is at work, whoever started
// it, when any pane runs a program or any pane's shell has a child process of any name (a job in the background, a
// subshell, a stopped job, a pipeline): it is never offered for ending, and neither is one whose panes could not be
// read. The rule is onlyIdleShells below; the list, these words and the end act all ask it.
//
// Reads board.leftovers[]: { what: 'tmux' | 'dashboard', pid, startedAt, socket, port, clients, parentAlive,
// panes: [{ command, children }] | null } (children: how many processes the pane's shell started; null when the
// pane's program is not a shell).
// The pid and its start time go into the item's target: the server reads the identity again before it ends it.

import { makeItem } from '../item.mjs';
import { ms, span } from './util.mjs';

export const LEFTOVER_MS = 10 * 60_000;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'ash', 'tcsh', 'csh', 'nu', 'pwsh']);

/** Whether a program's name is a shell's (a login shell's name starts with "-"). */
export const isShell = (command) => SHELLS.has(String(command).replace(/^-/, ''));

/**
 * The one rule for a tmux server that only holds memory: every pane's program is a shell, and that shell has no child
 * process, whatever its name. Panes that could not be read are not idle.
 */
export const onlyIdleShells = (panes) => Array.isArray(panes) && panes.every((p) => p != null && isShell(p.command) && p.children === 0);

export function detectLeftover(board, { now = Date.now(), minAgeMs = LEFTOVER_MS } = {}) {
  const out = [];
  for (const p of board.leftovers ?? []) {
    const born = ms(p.startedAt);
    if (born == null || now - born < minAgeMs || !Number.isInteger(p.pid)) continue;
    let subject;
    const facts = [`process ${p.pid}, running for ${span(now - born)}`];
    if (p.what === 'tmux') {
      if (p.parentAlive !== false || (p.clients ?? 0) > 0 || !onlyIdleShells(p.panes)) continue;
      subject = `tmux server ${p.socket}`;
      facts.push('no terminal is attached to it', p.panes.length ? `its shells run nothing (${p.panes.length} pane${p.panes.length > 1 ? 's' : ''}, no child process)` : 'nothing runs in it');
    } else if (p.what === 'dashboard') {
      if (!Number.isInteger(p.port) || p.port === board.port) continue;
      subject = `dashboard on port ${p.port}`;
      facts.push(`this dashboard is on port ${board.port ?? 'unknown'}`, 'nothing of yours uses the other one');
    } else continue;
    out.push(makeItem({
      kind: 'leftover',
      cls: 'machine',
      subject,
      since: born,
      facts,
      acts: ['end'],
      why: p.what === 'tmux' ? 'Its shells run nothing and no session uses it; its panes are read again before it is ended.' : 'A test\'s or a try\'s dashboard; it is read again by its id before it is ended.',
      // `proc`: who the process is beyond its pid (procid.mjs); the end act ends it only when it is still that one.
      // `temp`: a test's or a try's (the Hoprig that started it keeps its state in the temporary folder): the only
      // kind a rule of Tia's ends.
      target: { pid: p.pid, startedAt: p.startedAt, what: p.what, socket: p.socket ?? null, proc: p.proc ?? null, temp: p.temp === true },
    }));
  }
  return out;
}
