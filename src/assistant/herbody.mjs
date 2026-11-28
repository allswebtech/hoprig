// What a plan step of hers carries that her own tool would carry (design 2.3: a step is checked like an act done alone):
// the mark that a message or a chat start is HERS, and Settings' defaults for a chat she starts. Made here, once, for the step
// the card shows and for the request the runner makes, so the card binds exactly what is sent (door.mjs cardBinds).

/** The args of a step as they go to the route: her own tool's fields added where the route's body check asks for them. */
export function herArgs(row, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!row) return a;
  if (row.id === 'chats.send') return { byTia: true, ...a };
  if (row.id === 'chat.chats') {
    // Her mark stands after the step's own args: a new chat is hers whatever the step says.
    const m = { defaults: true, ...(a.sessionId ? {} : { byTia: true }), ...a };
    if (!a.sessionId) m.byTia = true;
    return m;
  }
  return a;
}

/** The acts of a plan that start or move work on a provider: the fields of the step's args that name providers (the first is required); each must be one she may use. */
export const STARTS = Object.freeze({
  'chat.chats': Object.freeze(['profile', 'others']),
  'session.sessions': Object.freeze(['profile']),
  'chats.provider': Object.freeze(['profile']),
  'work.items.do': Object.freeze(['provider']),
});
