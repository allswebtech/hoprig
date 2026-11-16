// The one line another computer pastes to link itself to the main Hoprig ("Link to my main Hoprig" in its page, or
// `hoprig join <line>`): the main one's address with the code after "#join=", and for a hub with its own certificate
// "&fingerprint=…". What follows "#" is never sent by a browser, so opening the address by mistake sends no code.
// The older form, the whole command `hoprig join <address> <code> [--fingerprint …]`, is read too.

const MAX = 2048;

/** The line for `base` (an http(s) address) and `code`; `pin`: the hub's own authority's fingerprint, or null. */
export function joinLine(base, code, pin = null) {
  return `${String(base).replace(/\/+$/, '')}#join=${code}${pin ? `&fingerprint=${pin}` : ''}`;
}

/**
 * What a pasted line says: { url, code, fingerprint } (fingerprint null when it has none), or null when it is
 * neither form. Nothing is checked here beyond the shape: claimLink checks the address, the code and the fingerprint.
 */
export function parseJoinLine(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > MAX) return null;
  const words = s.split(/\s+/);
  if (words.length > 1) {
    // The command form: "<app> join <address> <code> [--fingerprint <pin>] [--insecure]".
    if (words[1] !== 'join' || words.length < 4) return null;
    const at = words.indexOf('--fingerprint');
    return /^https?:\/\//i.test(words[2]) ? { url: words[2], code: words[3], fingerprint: at > 0 ? words[at + 1] || null : null } : null;
  }
  const hash = s.indexOf('#');
  if (hash < 0 || !/^https?:\/\//i.test(s)) return null;
  const params = new URLSearchParams(s.slice(hash + 1));
  const code = params.get('join');
  if (!code) return null;
  return { url: s.slice(0, hash), code, fingerprint: params.get('fingerprint') || null };
}
