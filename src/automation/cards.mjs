// What the automations need to know about a session, read from the dashboard's session cards. One place, so every
// automation agrees on what "busy", "idle" and "in trouble" mean.
//
// A card (see the ctx interface in ./index.mjs):
//   name, kind ('claude' | 'shell' | 'chat'), tool (coding sessions: 'claude' | 'codex' | 'opencode'), cwd, command,
//   attached, activity (ms)
//   chat (src/chat: a conversation in the page, no terminal): profile { name }, status, running (its process runs)
//   claude only: profile { name }, status, statusAt, sessionId, runId, stopAt, limit (seen on screen),
//                runLimit (reported by Claude Code), failure { at, error, text } (the last reply ended in an
//                API error), attentionKind (what the session waits for: 'permission_prompt', 'elicitation_dialog'…)

// A coding session in a terminal is a card of kind "claude" whatever its coding tool (older pages and computers know
// that kind); `tool` says which tool, and is absent on cards of older computers (then it is Claude Code). These
// helpers are the one place that says what a card is: elsewhere, ask them instead of comparing kinds.
const TOOL_KINDS = new Set(['codex', 'opencode']);

/** A coding session in a terminal (any coding tool), not a chat and not a plain shell. */
export const isCodingCard = (c) => Boolean(c) && (c.kind === 'claude' || TOOL_KINDS.has(c.kind));

/** The coding tool a card belongs to: `tool` when the card says it, else Claude Code (older cards, chats); null for a shell. */
export const toolOf = (c) => (c && typeof c.tool === 'string' ? c.tool : c && (c.kind === 'claude' || c.kind === 'chat') ? 'claude' : c && TOOL_KINDS.has(c.kind) ? c.kind : null);

/** A Claude Code session in a terminal: what Auto mode, limits, retries and restoring after a restart act on. */
export const isClaudeCard = (c) => isCodingCard(c) && toolOf(c) === 'claude';

/** @deprecated the older name of isCodingCard */
export const isClaude = isCodingCard;

/** At a usage limit, by the screen or by Claude Code's own report. */
export const atLimit = (c) => Boolean(c.limit || c.runLimit);

/** The last reply ended in an API error (StopFailure) and nobody sent anything since. */
export const failed = (c) => Boolean(c.failure && typeof c.failure === 'object');

/** Claude is thinking or still starting, in a terminal or in a chat: never type into it, never update under it. */
export const busy = (c) => (isCodingCard(c) || (Boolean(c) && c.kind === 'chat')) && (c.status === 'working' || c.status === 'starting');

/**
 * Claude finished and waits for the next message, with nothing in the way: no permission question, no limit, no
 * error. Claude Code's "waiting for your input" reminder (Notification of type idle_prompt) is still waiting: the
 * hook leaves the status alone for it now, and a record an older hook wrote may still carry it as "attention".
 */
export const idle = (c) =>
  isCodingCard(c) &&
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
