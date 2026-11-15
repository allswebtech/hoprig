// What the automations need to know about a session, read from the dashboard's session cards. One place, so every
// automation agrees on what "busy", "idle" and "in trouble" mean.
//
// A card (see the ctx interface in ./index.mjs):
//   name, kind ('claude' | 'shell' | 'chat'), cwd, command, attached, activity (ms)
//   chat (src/chat: a conversation in the page, no terminal): profile { name }, status, running (its process runs)
//   claude only: profile { name }, status, statusAt, sessionId, runId, stopAt, limit (seen on screen),
//                runLimit (reported by Claude Code), failure { at, error, text } (the last reply ended in an
//                API error), attentionKind (the Notification's type, e.g. 'permission_prompt', 'idle_prompt')

export const isClaude = (c) => Boolean(c) && c.kind === 'claude';

/** At a usage limit, by the screen or by Claude Code's own report. */
export const atLimit = (c) => Boolean(c.limit || c.runLimit);

/** The last reply ended in an API error (StopFailure) and nobody sent anything since. */
export const failed = (c) => Boolean(c.failure && typeof c.failure === 'object');

/** Claude is thinking or still starting, in a terminal or in a chat: never type into it, never update under it. */
export const busy = (c) => (isClaude(c) || (Boolean(c) && c.kind === 'chat')) && (c.status === 'working' || c.status === 'starting');

/**
 * Claude finished and waits for the next message, with nothing in the way: no permission question, no limit, no
 * error. Claude Code's "waiting for your input" reminder (Notification of type idle_prompt) is still waiting.
 */
export const idle = (c) =>
  isClaude(c) &&
  (c.status === 'waiting' || (c.status === 'attention' && c.attentionKind === 'idle_prompt')) &&
  !atLimit(c) &&
  !failed(c);

/** Shell programs: a terminal whose foreground program is one of these runs nothing else. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell', 'cmd', 'login']);

export function plainShell(c) {
  if (!c || c.kind !== 'shell') return false;
  const base = String(c.command || '').split(/[\\/]/).pop().replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
  return SHELLS.has(base);
}

export const byName = (cards) => new Map(cards.map((c) => [c.name, c]));
