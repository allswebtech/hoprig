// What a window's button in the bar says about its session, with no DOM (bar.js draws it): the session a window's
// address is about, and the button's name for a screen reader (in front, minimised, needs you, ended).

const SESSION = /^#\/(?:m\/[^/?#]+\/)?(s|chat)\/([^/?#]+)/;

/**
 * The session of computer list `sessions` that window address `hash` shows: a session's page (#/s/<name>) or a chat
 * (#/chat/<id>), also of another computer (#/m/<computer>/…). undefined: the window shows no session (the Sessions
 * list, the Editor); null: it shows one that is not in the list (any more).
 */
export function sessionOf(hash, sessions) {
  const m = SESSION.exec(String(hash || ''));
  if (!m) return undefined;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return undefined;
  }
  const list = Array.isArray(sessions) ? sessions : [];
  return list.find((s) => s && (m[1] === 'chat' ? s.chatId === id : s.name === id)) || null;
}

/**
 * Whether the session window `key` shows has ended, by what this bar saw of it (`seen`, a Map kept between paints):
 * `s` is sessionOf's answer. Ended: it was seen and is gone from the list, or it was seen as a coding session and is a
 * shell now (the terminal stays as a shell when the coding tool exits; src/server/watcher.mjs counts that as ended
 * too). The second is a notice, as the watcher's is: shown while the window is not in front (`front`), gone once it is,
 * since its shell is still there to use. A window never seen with its session says nothing: a new session is in the
 * list a poll later.
 */
export function endedOf(key, s, seen, front = false) {
  if (s === undefined) return false;
  const was = seen.get(key);
  if (s === null) return was !== undefined;
  if (s.kind !== 'shell') {
    seen.set(key, 'coding');
    return false;
  }
  if ((was === 'coding' || was === 'ended') && !front) {
    seen.set(key, 'ended');
    return true;
  }
  seen.set(key, 'shell');
  return false;
}

/** The name of a window's button: its label, then what a look at the bar shows ("needs you", "minimised"…). */
export function barName(label, { front = false, min = false, needs = false, ended = false } = {}) {
  const parts = [needs && 'needs you', ended && 'session ended', min && 'minimised', front && !min && 'in front'].filter(Boolean);
  return parts.length ? `${label}, ${parts.join(', ')}` : label;
}
