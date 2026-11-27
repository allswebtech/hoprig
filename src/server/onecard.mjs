// One conversation, one card on the page (/api/state). A conversation can have several records at once: the chat of
// the App that has it open, the terminal that runs it, and before the coding tool reports its id only the conversation
// its launcher named (runs.mjs: conversation) or the Deck's note of the start (deck.mjs: launching). Each card the page
// gets says which conversation it is (`key`) and where it is now (`where`), and a key is listed once: the terminal's
// card while a terminal runs or starts the conversation, else the chat's. Two conversations with the same title are
// two keys, never merged. Only what the page gets: cards() keeps every chat, for the assistant's jobs and marks.
import { isCodingCard, plainShell, toolOf } from '../automation/cards.mjs';

/** The conversation a card stands for: `<tool>:<conversation>`, or `term:<name>` for a terminal with none. */
export function keyOf(c) {
  if (c.kind === 'chat') return c.sessionId ? `${toolOf(c)}:${c.sessionId}` : `chat:${c.chatId || c.name}`;
  // The tool's own report decides once there is one (after /clear it runs another conversation).
  const id = isCodingCard(c) ? c.sessionId || c.conversation || null : null;
  if (id) return `${toolOf(c)}:${id}`;
  const l = c.launching;
  if (l && typeof l.conversation === 'string' && l.conversation) return `${typeof l.tool === 'string' ? l.tool : 'claude'}:${l.conversation}`;
  return `term:${c.name}`;
}

/**
 * `list`: the cards of this computer (cards() in server.mjs, most recently changed first). Returns the cards the page
 * shows, each with `key` and `where` ('terminal' | 'app'). A plain shell that "Continue here" left behind (deck.mjs
 * shellLeft) is not listed while it stays a plain shell: its conversation went on in the App. The terminal's card says
 * that the App has its conversation open to read along (`readAlong`), while that chat's own process does not run.
 */
export function oneCard(list) {
  const keyed = list.filter((c) => !(c.shellLeft && plainShell(c))).map((c) => ({ c, key: keyOf(c) }));
  const inTerminal = new Set(keyed.filter((x) => x.c.kind !== 'chat' && !x.key.startsWith('term:')).map((x) => x.key));
  const along = new Set(keyed.filter((x) => x.c.kind === 'chat' && !x.c.running && inTerminal.has(x.key)).map((x) => x.key));
  const seen = new Set();
  const out = [];
  for (const { c, key } of keyed) {
    if (seen.has(key)) continue;
    const terminal = c.kind !== 'chat';
    if (!terminal && inTerminal.has(key)) continue; // the terminal's card is the conversation's
    seen.add(key);
    out.push({ ...c, key, where: terminal ? 'terminal' : 'app', ...(terminal && along.has(key) ? { readAlong: true } : {}) });
  }
  return out;
}
