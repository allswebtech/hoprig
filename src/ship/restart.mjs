// What a restart of the dashboard would cut (rule 6b of docs/GO-LIVE.md). For Hoprig itself (the project whose folder
// holds the running dashboard's own code) and for a project that says `"live": { "restarts": "hoprig" }`, the update
// restarts the dashboard, and a restart ends: a running turn of the assistant, a running App session's turn, and every
// built-in (non-tmux) terminal session. A running turn is WAITED for, up to the project's "turnSeconds"; what would
// still be cut after that, and every built-in terminal session, is NAMED before the tap, and the tap then says
// "restart anyway". A go-live by itself never cuts anything: it waits, and after the limit it does not go live and
// says why.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder of the running dashboard's own code (this file is src/ship/restart.mjs in it). */
export const OWN_CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Whether the go-live of the project at real path `real` (with its cleaned live block) restarts the dashboard. */
export const restartsDashboard = (real, live, own = OWN_CODE) => !!(live && live.restarts) || within(own, real);

/**
 * What runs now that a restart would end. `src`: { chats() → the App sessions' cards, assistant() → Tia's
 * conversations [{ id, title, busy }], terminals() → the terminal sessions [{ session }] with `kind` the backend's kind }.
 * → { turns: [{ kind: 'app' | 'assistant', id, name }], terminals: [names] }.
 */
export async function whatRestartCuts(src) {
  const turns = [];
  for (const c of (await src.chats?.()) || []) if (c && (c.status === 'working' || c.status === 'attention')) turns.push({ kind: 'app', id: String(c.chatId || c.name), name: String(c.display || c.title || 'an App session').slice(0, 80) });
  for (const c of (await src.assistant?.()) || []) if (c && c.busy) turns.push({ kind: 'assistant', id: String(c.id), name: String(c.title || 'a question to the assistant').slice(0, 80) });
  const terminals = src.kind === 'pty' ? ((await src.terminals?.()) || []).filter((s) => s && !s.dead).map((s) => String(s.session).slice(0, 80)) : [];
  return { turns, terminals };
}

/** The words the page and the command line show for what a restart would cut (null when it cuts nothing). */
export function cutWords(cut) {
  const parts = [];
  if (cut.turns.length) parts.push(`${cut.turns.length === 1 ? 'a turn that is still running' : `${cut.turns.length} turns that are still running`}: ${cut.turns.map((t) => `${t.kind === 'assistant' ? 'the assistant' : 'App session'} "${t.name}"`).join(', ')}`);
  if (cut.terminals.length) parts.push(`${cut.terminals.length === 1 ? 'the terminal' : 'the terminals'} ${cut.terminals.join(', ')} (terminals of this dashboard always close on a restart)`);
  return parts.length ? `A restart would end ${parts.join('; and ')}.` : null;
}

/**
 * Before the update of a step that restarts the dashboard: wait for running turns up to `seconds`. `named`: the turns
 * and terminals the owner was shown when he tapped "restart anyway" (null: he was shown nothing, or it goes by itself).
 * Throws (the step then did not start, and says why) when after the wait something would be cut that he did not accept:
 * by itself, anything at all; on his tap, a turn or terminal he was not shown.
 */
export async function waitForTurns(src, { seconds, named = null, byItself = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const until = now() + seconds * 1000;
  let cut = await whatRestartCuts(src);
  while (cut.turns.length && now() < until) {
    await sleep(Math.min(1000, Math.max(10, until - now())));
    cut = await whatRestartCuts(src);
  }
  if (!cut.turns.length && !cut.terminals.length) return cut;
  // The words of cutWords end a sentence: inside another one they go without their period.
  const had = cutWords(cut).replace(/^A restart would end/, 'a restart would have ended').replace(/\.$/, '');
  if (byItself) throw Object.assign(new Error(`it did not go live by itself: ${had} (waited ${seconds} s)`), { status: 409, details: { code: 'restart-cuts' } });
  const ok = named && cut.turns.every((t) => named.turns.includes(t.id)) && cut.terminals.every((n) => named.terminals.includes(n));
  if (!ok) throw Object.assign(new Error(`it did not go live: ${had}, which was not named when you tapped`), { status: 409, details: { code: 'restart-cuts' } });
  return cut;
}
