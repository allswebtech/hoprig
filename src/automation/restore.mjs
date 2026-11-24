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
// Stored: { lastTickAt, sessions: { [name]: { name, tool?, cwd, profile, sessionId, carryArgs, goneAt, shellSince } } }
//
// Claude Code's and OpenCode's terminal sessions. OpenCode's comes back on its own conversation id (`opencode
// --resume <id>` through the launcher); one whose run record holds no id OpenCode's store would know is not
// reopened on another conversation (the folder's newest one could be someone else's): it is left out and named in
// the activity log. Codex is not reopened.
import { isToolSessionId } from '../codetools/stores.mjs';
import { isClaudeCard, isCodingCard, toolOf } from './cards.mjs';

/** A terminal session the restore remembers: Claude Code's, or OpenCode's. */
const restorable = (c) => isClaudeCard(c) || (isCodingCard(c) && toolOf(c) === 'opencode');

export const GONE_WINDOW_MS = 2 * 60_000;
/** A session that has been a plain shell this long had Claude exit in it: not a Claude session any more. */
export const SHELL_FORGET_MS = 2 * 60_000;

const emptyData = () => ({ lastTickAt: 0, sessions: {} });

/**
 * state: { cards, data, now, boot (first tick since the service started), enabled, taken ([{ tool, conversation,
 * runId }]: the terminals "Continue here" took a conversation from, ./taken.mjs) }. Returns { actions, data, taken }.
 * Actions: { type: 'reopen', session: { name, cwd, profile, sessionId, carryArgs } } | { type: 'skip', session, why }.
 */
export function decide({ cards, data, now, boot, enabled, taken = [] }) {
  if (!enabled) return { actions: [], data: emptyData(), taken };
  // A take-over is matched by the run id the restore remembers for the session: that run lost its conversation to a
  // chat, so a start reopens it on nothing (the record is written before the terminal is ended, so no tick has to
  // see the shell first). A start uses the entry up; a tick that sees a terminal run that conversation again under
  // another run drops it.
  const used = new Set();
  const takenFrom = (s) => {
    const i = taken.findIndex((e) => s.runId && e.runId === s.runId && e.conversation === s.sessionId && e.tool === (s.tool || 'claude'));
    if (i >= 0) used.add(i);
    return i >= 0;
  };
  const prev = { ...emptyData(), ...(data || {}) };
  const sessions = {};
  const actions = [];
  const present = new Map(cards.map((c) => [c.name, c]));
  // "Continue here" in a chat leaves its terminal a plain shell and the conversation in the chat: a terminal that
  // became a shell while an open chat has its conversation lost it to that chat, and is not reopened on it.
  const toChat = (s) => Boolean(s.sessionId) && cards.some((c) => c.kind === 'chat' && toolOf(c) === (s.tool || 'claude') && c.sessionId === s.sessionId);

  for (const [name, s] of Object.entries(prev.sessions || {})) {
    const c = present.get(name);
    if (boot && !c) {
      // Gone at start: reopen what the service lost; forget what had been closed before it stopped.
      const lostAtStop = !s.goneAt || prev.lastTickAt - s.goneAt <= GONE_WINDOW_MS;
      if (lostAtStop && s.tool === 'opencode' && !isToolSessionId('opencode', s.sessionId)) {
        actions.push({ type: 'skip', session: { name, tool: s.tool }, why: 'it has no conversation id OpenCode knows, so it is not reopened on another conversation' });
        continue;
      }
      if (lostAtStop && s.sessionId && !(s.shellSince && toChat(s)) && !takenFrom(s)) {
        actions.push({ type: 'reopen', session: { name, ...(s.tool === 'opencode' ? { tool: s.tool } : {}), cwd: s.cwd, profile: s.profile, sessionId: s.sessionId, carryArgs: s.carryArgs || [], ...(s.hers === true ? { hers: true } : {}) } });
        sessions[name] = { ...s, goneAt: null, shellSince: null };
      }
      continue;
    }
    if (!c) {
      const goneAt = s.goneAt || now;
      if (now - goneAt <= GONE_WINDOW_MS) sessions[name] = { ...s, goneAt };
      continue;
    }
    if (!restorable(c) || toolOf(c) !== (s.tool || 'claude')) {
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
    if (!restorable(c) || !c.profile || !c.profile.name) continue; // Claude Code's and OpenCode's sessions only
    const tool = toolOf(c);
    // Claude Code's without an id is not remembered (as before). OpenCode's is, so that a restart can name it as left out.
    if (!c.sessionId && tool === 'claude') continue;
    if (c.sessionId) for (const [n, s] of Object.entries(sessions)) if (n !== c.name && s.sessionId === c.sessionId) delete sessions[n];
    const carryArgs = Array.isArray(c.carryArgs) ? c.carryArgs.filter((a) => typeof a === 'string') : [];
    // A session of Tia's comes back as hers (the mark of its old run went with that run): `hers` is what the adapter
    // read from the mark the dashboard wrote, never from the card's own record.
    sessions[c.name] = { name: c.name, ...(tool === 'opencode' ? { tool } : {}), cwd: c.cwd, profile: c.profile.name, sessionId: c.sessionId || null, ...(typeof c.runId === 'string' && c.runId ? { runId: c.runId } : {}), carryArgs, ...(c.hers === true ? { hers: true } : {}), goneAt: null, shellSince: null };
  }
  const again = (e) => cards.some((c) => restorable(c) && toolOf(c) === e.tool && c.sessionId === e.conversation && c.runId && c.runId !== e.runId);
  return { actions, data: { lastTickAt: now, sessions }, taken: taken.filter((e, i) => !used.has(i) && !again(e)) };
}

/**
 * A start skipped because the conversation still ran is tried once more after this long. tmux can end without a
 * reboot (an out-of-memory kill, `tmux kill-server`) and the dashboard start again at once: the programs whose terminal
 * closed are still ending then (on Node 20 a crash report holds each for a second or more), and their run records
 * still say they run. A conversation that really runs elsewhere is skipped the second time too.
 */
export const RETRY_MS = 5000;

/**
 * Carry out the actions. ctx: { deck.start({ dir, profile, mode: 'move', sessionId, carryArgs, name, fresh? }),
 * conversationExists(cwd, id) → bool, record(entry), label(profile)? → its shown name, later(fn, ms)?, closed()? }. A
 * start that finds the conversation running already (a chat, a terminal) throws with `existing`: nothing is reopened,
 * after one more try RETRY_MS later. That try runs by itself (`later`), outside the tick: the other automations do
 * not wait for it.
 */
export async function apply(actions, ctx) {
  const busy = [];
  for (const a of actions) {
    if (a.type === 'skip') ctx.record({ automation: 'restore', session: a.session.name, did: 'did not reopen', outcome: `skipped: ${a.why}` });
    else if (await reopen(a.session, ctx, false)) busy.push(a.session);
  }
  if (!busy.length) return;
  const again = async () => {
    for (const s of busy) if (!ctx.closed?.()) await reopen(s, ctx, true);
  };
  const later = ctx.later || ((fn, ms) => setTimeout(() => fn().catch(() => {}), ms).unref());
  later(again, RETRY_MS);
}

/** One start; true when the conversation ran already and this was the first try (the caller tries again). */
async function reopen(s, ctx, last) {
  // OpenCode's conversation is always resumed by its id (a malformed one never reaches here): `fresh` is Claude Code's.
  const oc = s.tool === 'opencode';
  const fresh = !oc && !ctx.conversationExists(s.cwd, s.sessionId);
  try {
    const name = await ctx.deck.start({ ...(oc ? { tool: s.tool } : {}), dir: s.cwd, profile: s.profile, mode: 'move', sessionId: s.sessionId, carryArgs: s.carryArgs || [], name: s.name, ...(fresh ? { fresh } : {}), ...(s.hers === true ? { hers: true } : {}) });
    // The provider as the owner named it: this line is read on Automations → Activity.
    const shown = (ctx.label && ctx.label(s.profile)) || s.profile;
    const how = fresh ? 'started fresh: it had no conversation to resume' : `resumed ${s.sessionId.slice(0, 8)}`;
    ctx.record({ automation: 'restore', session: name, did: `reopened on ${shown} (${how})`, outcome: 'ok' });
  } catch (e) {
    if (e.existing && !last) return true;
    if (e.existing) ctx.record({ automation: 'restore', session: s.name, did: 'did not reopen', outcome: `skipped: ${e.message}` });
    else ctx.record({ automation: 'restore', session: s.name, did: 'could not reopen', outcome: `failed: ${e.message}` });
  }
  return false;
}
