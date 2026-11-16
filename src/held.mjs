// The launcher's side of "one conversation, one process" (runs.mjs heldBefore): before it starts a coding tool on a
// conversation it names, a launcher looks for another live process on it, and says in one sentence where that runs
// and what to do.
import { spawnSync } from 'node:child_process';
import { heldBefore } from './runs.mjs';

/** The dashboard's name of the terminal that `r` runs in: tmux knows it now (also after a rename), else the record. */
function sessionName(r) {
  if (r.tmuxPane && r.tmuxSocket) {
    const out = spawnSync('tmux', ['-S', r.tmuxSocket, 'display-message', '-p', '-t', r.tmuxPane, '#{session_name}'], { encoding: 'utf8', timeout: 3000 });
    const name = out.status === 0 ? String(out.stdout || '').trim() : '';
    if (name) return name;
  }
  return typeof r.termName === 'string' && r.termName ? r.termName : null;
}

/** Where record `r` runs its conversation, and what to do, as the launcher says it. `tool`: the coding tool's name. */
export function heldWords(r, tool = 'Claude Code') {
  if (r.kind === 'chat') return `hoprig: this conversation is open in a chat in the dashboard. Close that chat, or choose "Open in terminal" in its menu.`;
  const name = sessionName(r);
  if (name) return `hoprig: this conversation runs in the terminal session "${name}". Stop ${tool} there first, or open that session as a chat and choose "Continue here".`;
  return `hoprig: this conversation runs in another terminal (process ${r.pid}). Stop ${tool} there first.`;
}

/**
 * The record of the process that runs conversation `id` before this launcher's record `run`, said on stderr; null when
 * there is none (the launcher goes on). A launcher that names no conversation (a new one, "continue the last one") has
 * nothing to ask.
 */
export function refuseIfHeld(run, id, tool = 'claude', label = 'Claude Code') {
  if (!id) return null;
  const other = heldBefore(run, id, tool);
  if (other) console.error(heldWords(other, label));
  return other;
}
