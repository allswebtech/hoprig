// One card per conversation (Home, the App session list). A newer computer sends one card per `key` already
// (<tool>:<conversation>, or term:<name> for a shell); an older one sends the chat and its terminal apart, without a
// key, and those stay apart. A list that still holds two cards of one key shows the newer.

/** The card's key: the server's, else the one an older computer's record gives. */
export const cardKey = (s) => s.key || (s.kind === 'chat' ? `chat:${s.chatId}` : `term:${s.name}`);

const when = (s) => s.statusAt || s.activity || s.created || 0;

/** `list` with one card per key of each computer, the newer one, in the place the first one had. */
export function oneCardPerKey(list) {
  const at = new Map();
  const out = [];
  for (const s of list || []) {
    const k = `${s.machine ?? '~'}|${cardKey(s)}`;
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push(s);
    } else if (when(s) >= when(out[i])) out[i] = s;
  }
  return out;
}
