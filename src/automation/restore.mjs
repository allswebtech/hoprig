// Restore after a restart: remember the Claude sessions the dashboard knows (name, folder, account, Claude session
// id) and, when the service starts and they are gone (a reboot; or the built-in terminals, which always end with
// the service), reopen them the way they ran: the launcher's move arguments (`moveArgs` in src/launch.mjs), which
// keep --model, --permission-mode and the like and add `--resume <id>`. Nothing is typed into them.
//
// A session nobody typed into yet comes back too: the owner had it open, and after a restart the dashboard should
// look as it did. It has no conversation on disk (Claude Code writes that with the first message), so there is
// nothing to resume: it starts fresh under the same id, in the same folder, with the same arguments
// (`--session-id <id>`, as a move of such a session does). The same holds for one whose conversation file was
// removed while it was open: it was open, so it comes back.
//
// "Closed on purpose" needs no hook into the Close button: a session that disappears while the service runs was
// closed (by the owner, or by Claude exiting) and is forgotten. Only a session that was still there at the last
// tick, or vanished within GONE_WINDOW_MS before it (the shutdown that took tmux down with it), is reopened.
//
// Stored: { lastTickAt, sessions: { [name]: { name, cwd, profile, sessionId, carryArgs, goneAt, shellSince } } }
//
// Claude Code's sessions only: a Codex or OpenCode session is not reopened after a restart (yet).
import { isClaudeCard, toolOf } from './cards.mjs';

export const GONE_WINDOW_MS = 2 * 60_000;
/** A session that has been a plain shell this long had Claude exit in it: not a Claude session any more. */
export const SHELL_FORGET_MS = 2 * 60_000;

const emptyData = () => ({ lastTickAt: 0, sessions: {} });

/**
 * state: { cards, data, now, boot (first tick since the service started), enabled }. Returns { actions, data }.
 * Actions: { type: 'reopen', session: { name, cwd, profile, sessionId, carryArgs } }.
 */
export function decide({ cards, data, now, boot, enabled }) {
  if (!enabled) return { actions: [], data: emptyData() };
  const prev = { ...emptyData(), ...(data || {}) };
  const sessions = {};
  const actions = [];
  const present = new Map(cards.map((c) => [c.name, c]));
  // "Continue here" in a chat leaves its terminal a plain shell and the conversation in the chat: a terminal that
  // became a shell while an open chat has its conversation lost it to that chat, and is not reopened on it.
  const toChat = (s) => cards.some((c) => c.kind === 'chat' && toolOf(c) === 'claude' && c.sessionId === s.sessionId);

  for (const [name, s] of Object.entries(prev.sessions || {})) {
    const c = present.get(name);
    if (boot && !c) {
      // Gone at start: reopen what the service lost; forget what had been closed before it stopped.
      const lostAtStop = !s.goneAt || prev.lastTickAt - s.goneAt <= GONE_WINDOW_MS;
      if (lostAtStop && s.sessionId && !(s.shellSince && toChat(s))) {
        actions.push({ type: 'reopen', session: { name, cwd: s.cwd, profile: s.profile, sessionId: s.sessionId, carryArgs: s.carryArgs || [] } });
        sessions[name] = { ...s, goneAt: null, shellSince: null };
      }
      continue;
    }
    if (!c) {
      const goneAt = s.goneAt || now;
      if (now - goneAt <= GONE_WINDOW_MS) sessions[name] = { ...s, goneAt };
      continue;
    }
    if (!isClaudeCard(c)) {
      if (toChat(s)) continue; // its conversation went on in a chat
      // A shell: Claude is still starting (just reopened), or it exited. Wait a little before deciding.
      const shellSince = s.shellSince || now;
      if (now - shellSince <= SHELL_FORGET_MS) sessions[name] = { ...s, goneAt: null, shellSince };
      continue;
    }
    sessions[name] = { ...s, goneAt: null, shellSince: null };
  }

  // Learn the sessions there are now (and their current session id: /clear starts a new one). A conversation is
  // remembered under one name only: after a rename the old name must not reopen it a second time.
  for (const c of cards) {
    if (!isClaudeCard(c) || !c.sessionId || !c.profile || !c.profile.name) continue; // Claude Code's sessions only
    for (const [n, s] of Object.entries(sessions)) if (n !== c.name && s.sessionId === c.sessionId) delete sessions[n];
    const carryArgs = Array.isArray(c.carryArgs) ? c.carryArgs.filter((a) => typeof a === 'string') : [];
    sessions[c.name] = { name: c.name, cwd: c.cwd, profile: c.profile.name, sessionId: c.sessionId, carryArgs, goneAt: null, shellSince: null };
  }
  return { actions, data: { lastTickAt: now, sessions } };
}

/**
 * Carry out the actions. ctx: { deck.start({ dir, profile, mode: 'move', sessionId, carryArgs, name, fresh? }),
 * conversationExists(cwd, id) → bool, record(entry), label(profile)? → its shown name }. A start that finds the
 * conversation running already (a chat, a terminal) throws with `existing`: nothing is reopened.
 */
export async function apply(actions, ctx) {
  for (const a of actions) {
    const s = a.session;
    const fresh = !ctx.conversationExists(s.cwd, s.sessionId);
    try {
      const name = await ctx.deck.start({ dir: s.cwd, profile: s.profile, mode: 'move', sessionId: s.sessionId, carryArgs: s.carryArgs || [], name: s.name, ...(fresh ? { fresh } : {}) });
      // The provider as the owner named it: this line is read on Automations → Activity.
      const shown = (ctx.label && ctx.label(s.profile)) || s.profile;
      const how = fresh ? 'started fresh: it had no conversation to resume' : `resumed ${s.sessionId.slice(0, 8)}`;
      ctx.record({ automation: 'restore', session: name, did: `reopened on ${shown} (${how})`, outcome: 'ok' });
    } catch (e) {
      if (e.existing) ctx.record({ automation: 'restore', session: s.name, did: 'did not reopen', outcome: `skipped: ${e.message}` });
      else ctx.record({ automation: 'restore', session: s.name, did: 'could not reopen', outcome: `failed: ${e.message}` });
    }
  }
}
