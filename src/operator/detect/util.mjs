// Small helpers the detectors share: how long ago, in plain words, and safe number reading.

const MIN = 60_000;

/** "under a minute", "12 min", "3 h 5 min", "2 days". */
export function span(ms) {
  if (!Number.isFinite(ms) || ms < MIN) return 'under a minute';
  const m = Math.floor(ms / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** A time (ISO text or epoch ms) as epoch ms, or null. */
export function ms(t) {
  if (t == null || t === '') return null;
  const n = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

/** A clock time for a fact line, in UTC so a test reads the same everywhere ("14:05 UTC", or a date when older). */
export function clock(t, now) {
  const n = ms(t);
  if (n == null) return 'unknown';
  const d = new Date(n);
  const hm = d.toISOString().slice(11, 16);
  return Math.abs((now ?? n) - n) < 20 * 3600_000 ? `${hm} UTC` : `${d.toISOString().slice(0, 10)} ${hm} UTC`;
}

/** A text cut to n characters with "…" (never in the middle of a surrogate pair). */
export const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : t);

/**
 * A provider as the Providers page names it: its label ("Claude Max"), its short name only where it has no label (the
 * page never shows "max" or "api"), cut to 40 characters; the provider auto is "Auto mode", as the page calls it (its
 * virtual profile's label is only "Auto"). Every item that names a provider says it this way.
 */
export const providerName = (name, label) => (name === 'auto' ? 'Auto mode' : cut(String(label || name || 'unknown'), 40));

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The page address of a session (its name is encoded, so any name gives a safe address). */
export const sessionHref = (name) => `#/s/${encodeURIComponent(name)}`;

/** Where a board's session is opened: a chat by its own address, a terminal session by its name. */
// A session Hoprig did not start has no page of its own here: its provider's page is where its step is.
export const openHref = (s) => (s.chatId ? `#/chat/${encodeURIComponent(s.chatId)}` : s.outside ? '#/providers' : sessionHref(s.name));
/** The open act's words for a board's session. */
export const openLabel = (s) => (s.chatId ? 'Open the chat' : s.outside ? 'Open Providers' : 'Open the session');

/** What an item about a board's session is called: a chat by its title and the start of its id (two may share one). */
export const subjectOf = (s) => (s.chatId ? `chat "${s.display || 'New session'}" (${s.chatId.slice(0, 8)})` : s.outside ? `session ${s.name}${s.folder ? ` in ${s.folder}` : ''}, not started by Hoprig` : `session ${s.name}`);
