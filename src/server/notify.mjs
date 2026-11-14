// Push notifications from the server, so they arrive with the page closed: a POST to a URL the user chooses when a
// session needs them.
//
// config.json → server.notify:
//   url      http(s) URL to POST to. An ntfy topic URL (https://ntfy.sh/<your-topic>) gives phone push with no account.
//   format   "ntfy" | "json"   default: "ntfy" when the URL's host name contains "ntfy", else "json"
//   headers  extra request headers, e.g. { "Authorization": "Bearer …" }      optional
//   events   which events to send                     default: all of EVENTS
//
// Events: "waiting" (Claude finished and waits for you), "attention" (Claude asks for your OK), "limit" (a usage
// limit was reached), "ended" (Claude exited), "switched" (the server moved a session to another profile),
// "automation" (an automation needs you: a retry gave up, a schedule failed, an update; see src/automation).
//
// The request, format "json":
//   POST <url>   Content-Type: application/json
//   { "title": "...", "message": "...", "session": "<name>", "status": "<event>", "url": "<page link or empty>" }
//   Title / Click headers are sent too, so a receiver that only reads headers still has them.
//
// The request, format "ntfy" (what ntfy.sh documents for publishing):
//   POST <url>   Content-Type: text/plain; charset=utf-8
//   Title: <title>   Click: <page link, when server.publicUrl is set>   Tags: <one emoji short code>
//   body: <message>
//
// The message is at most one short line Claude wrote last (300 characters); terminal text is never sent. A send
// times out after 5 s and never blocks or fails the server; errors are logged as one line.

export const EVENTS = ['waiting', 'attention', 'limit', 'ended', 'switched', 'automation'];
const TAGS = { waiting: 'hourglass', attention: 'raising_hand', limit: 'warning', ended: 'checkered_flag', switched: 'twisted_rightwards_arrows', automation: 'gear' };
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding']);

/** Validate a notify setting from the browser. Returns the clean object, or throws an Error with a plain message. */
export function cleanNotify(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('notify must be an object');
  const out = {};
  if (v.url !== undefined && v.url !== '') {
    let u;
    try {
      u = new URL(String(v.url));
    } catch {
      throw new Error('the notification URL is not a valid URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the notification URL must start with https:// or http://');
    if (String(v.url).length > 500) throw new Error('the notification URL is too long');
    out.url = u.toString();
  }
  if (v.format !== undefined && v.format !== '' && v.format !== 'auto') {
    if (v.format !== 'ntfy' && v.format !== 'json') throw new Error('format must be "ntfy" or "json"');
    out.format = v.format;
  }
  if (v.headers !== undefined && v.headers !== null) {
    if (typeof v.headers !== 'object' || Array.isArray(v.headers)) throw new Error('headers must be an object');
    const entries = Object.entries(v.headers);
    if (entries.length > 10) throw new Error('at most 10 headers');
    out.headers = {};
    for (const [k, val] of entries) {
      if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new Error(`"${k}" cannot be used as a header`);
      if (typeof val !== 'string' || val.length > 500 || /[\r\n\0]/.test(val)) throw new Error(`the value of header ${k} is not usable`);
      out.headers[k] = val;
    }
  }
  if (v.events !== undefined) {
    if (!Array.isArray(v.events) || v.events.some((e) => !EVENTS.includes(e))) throw new Error(`events must be some of: ${EVENTS.join(', ')}`);
    out.events = [...new Set(v.events)];
  }
  return out;
}

// HTTP header values must be Latin-1; keep them plain ASCII so every receiver reads them the same way.
const ascii = (s, max = 200) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/** The JSON payload and the headers for one event. Pure, so it can be tested. */
export function buildRequest(cfg, ev) {
  const host = (() => {
    try {
      return new URL(cfg.url).hostname;
    } catch {
      return '';
    }
  })();
  const format = cfg.format || (host.includes('ntfy') ? 'ntfy' : 'json');
  const payload = {
    title: String(ev.title || '').slice(0, 120),
    message: String(ev.message || '').slice(0, 300),
    session: String(ev.session || ''),
    status: String(ev.status || ''),
    url: String(ev.url || ''),
  };
  const headers = { ...(cfg.headers || {}), Title: ascii(payload.title) };
  if (payload.url) headers.Click = ascii(payload.url, 500);
  if (format === 'ntfy') {
    if (TAGS[payload.status]) headers.Tags = TAGS[payload.status];
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    return { format, headers, body: payload.message || payload.title, payload };
  }
  headers['Content-Type'] = 'application/json';
  return { format, headers, body: JSON.stringify(payload), payload };
}

/**
 * Send one event when server.notify asks for it. Never throws; resolves { sent, status?, error? }.
 * `fetchImpl` is for tests.
 */
export async function sendNotification(cfg, ev, { fetchImpl = fetch, timeoutMs = 5000, log = console.error } = {}) {
  if (!cfg || !cfg.url) return { sent: false, error: 'no URL set' };
  const events = Array.isArray(cfg.events) && cfg.events.length ? cfg.events : EVENTS;
  if (!ev.force && !events.includes(ev.status)) return { sent: false, error: 'event not selected' };
  const { headers, body } = buildRequest(cfg, ev);
  try {
    const r = await fetchImpl(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) {
      log(`notify: ${ev.status} for ${ev.session}: the receiver answered ${r.status}`);
      return { sent: false, status: r.status, error: `the receiver answered ${r.status}` };
    }
    return { sent: true, status: r.status };
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : e.message;
    log(`notify: ${ev.status} for ${ev.session}: ${why}`);
    return { sent: false, error: why };
  }
}

const WORDS = {
  waiting: 'is waiting for you',
  attention: 'needs your OK',
  limit: 'reached a usage limit',
  ended: 'has finished (Claude exited)',
  switched: 'moved to another profile',
};

/** A human title and message for an event about session `name`. */
export function describe(status, name, extra = '') {
  return { title: `${name} ${WORDS[status] || status}`, message: extra };
}
