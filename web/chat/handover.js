// Moving a conversation between the App and a terminal asks first only where something can be lost: while the
// coding tool is writing a reply. When nothing runs, one press does it.

/** `running`: a reply is being written. The sheet (`sheet(o)`, lib.js confirmSheet) only then; true: go on. */
export const askFirst = async (running, o, sheet) => (running ? sheet(o) : true);

/**
 * The terminal `term` ({ name, chatId? }) is writing a reply: a card of it in `sessions` (by its name, or by the
 * chat its conversation is, as the one card per conversation of a newer computer) says Working. A terminal not in the
 * list (outside the dashboard, not read yet) is asked about, as before.
 */
export function terminalWrites(sessions, term) {
  if (!term) return true;
  const its = (sessions || []).filter((s) => (term.name && s.name === term.name) || (term.chatId && s.chatId === term.chatId));
  return !its.length || its.some((s) => s.status === 'working' || s.status === 'starting');
}
