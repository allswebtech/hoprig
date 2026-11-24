// The browser's terminal shows a tmux session without tmux: its status line is off and nobody there knows its keys.
// tmux's prefix key (Ctrl+B by default) is still read by the attach client, so a Ctrl+B meant for the program was
// eaten and the key after it became a tmux command (Ctrl+B then x asks to kill the pane). Pressing the prefix twice
// sends it on once (send-prefix), so the attach doubles every prefix byte that the browser sends outside a bracketed
// paste (tmux passes a paste on as it is), and the program gets the key a plain terminal would give it.

/** The byte of a tmux key name, for the control keys a prefix can be ("C-b" -> "\x02"); null for any other. */
export function controlByte(name) {
  const n = String(name || '').trim();
  if (/^C-Space$/i.test(n)) return '\x00';
  const m = /^C-([a-zA-Z@[\\\]^_])$/.exec(n);
  return m ? String.fromCharCode(m[1].toUpperCase().charCodeAt(0) ^ 0x40) : null; // Ctrl clears bit 6: B (0x42) -> 0x02
}

/**
 * The prefix bytes that are safe to double: tmux's `prefix` and `prefix2` (from `show-options -gv`) whose binding in
 * the prefix table (from `list-keys -T prefix`) is send-prefix (-2 for prefix2). Escape is never one: it starts a key.
 */
export function prefixBytes({ prefix, prefix2, keys }) {
  const out = [];
  for (const [name, two] of [[prefix, false], [prefix2, true]]) {
    const byte = controlByte(name);
    if (byte === null || byte === '\x1b') continue;
    const k = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bound = new RegExp(`^bind-key\\s+(?:-r\\s+)?-T prefix\\s+${k}\\s+send-prefix${two ? '\\s+-2' : ''}\\s*$`, 'm');
    if (bound.test(String(keys || ''))) out.push(byte);
  }
  return out;
}

const PASTE_END = '\x1b[201~';

/**
 * A writer's filter that doubles the given bytes outside a bracketed paste; a paste's marks may span two writes.
 * A prefix byte right after an Escape is not doubled: tmux reads Escape and the byte as one key with Alt (Ctrl+Alt+B is
 * ESC ^B, M-C-b), which is no prefix, and a doubled byte would leave a lone prefix that makes the next key a tmux
 * command. Escapes pair up (ESC ESC is M-Escape), so only an odd run joins. An Escape at the end of one write joins
 * the next write's first byte only when that comes within tmux's escape-time (`joinMs`); later tmux took it alone.
 * One write may be a whole paste of megabytes, and the dashboard waits while it is filtered: the text between two
 * prefix bytes is searched as a whole for paste marks and Escapes, never one character at a time (that took about
 * 170 ms per MiB).
 */
export function prefixDoubler(bytes, { joinMs = 0, now = Date.now } = {}) {
  const find = new RegExp(`[${bytes.map((b) => `\\u${b.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}]`, 'g');
  let inPaste = false;
  let carry = ''; // the last characters seen, for a paste mark split across two parts
  let escapes = 0; // Escapes right before the next character
  let last = -Infinity;
  /** What `part` (no prefix byte in it, or one alone) changes: inside a paste or not, the Escapes at its end. */
  const see = (part) => {
    if (!part) return;
    const text = carry + part;
    const start = text.lastIndexOf('\x1b[200~');
    const end = text.lastIndexOf(PASTE_END);
    if (start !== end) inPaste = start > end; // the last mark counts; both -1: no mark, no change
    let run = 0;
    while (run < part.length && part[part.length - 1 - run] === '\x1b') run++;
    escapes = run === part.length ? escapes + run : run;
    carry = text.slice(-5);
  };
  /** Where the paste that `s` is in from `from` on ends (just after its end mark, which may begin in carry), or -1. */
  const pasteEnd = (s, from) => {
    const j = (carry + s.slice(from, from + PASTE_END.length - 1)).indexOf(PASTE_END);
    if (j >= 0) return from + j + PASTE_END.length - carry.length;
    const k = s.indexOf(PASTE_END, from);
    return k < 0 ? -1 : k + PASTE_END.length;
  };
  return (s) => {
    if (!bytes.length || typeof s !== 'string') return s;
    const t = now();
    if (t - last > joinMs) escapes = 0;
    last = t;
    let out = '';
    let doubled = false;
    for (let from = 0; from < s.length;) {
      if (inPaste) {
        // Inside a paste nothing is doubled: straight to its end mark, never from one prefix byte to the next (a paste
        // dense with Ctrl+B took twice as long as the old filter that went one character at a time).
        const after = pasteEnd(s, from);
        const stop = after < 0 ? s.length : after;
        carry = stop - from >= 5 ? s.slice(stop - 5, stop) : (carry + s.slice(from, stop)).slice(-5);
        escapes = 0; // the end mark ends with "~"; inside the paste no Escape counts
        inPaste = after < 0;
        out += s.slice(from, stop);
        from = stop;
        continue;
      }
      find.lastIndex = from;
      const m = find.exec(s);
      if (!m) {
        see(s.slice(from));
        out += s.slice(from);
        break;
      }
      const i = m.index;
      see(s.slice(from, i));
      const twice = !inPaste && escapes % 2 === 0;
      see(s[i]);
      out += s.slice(from, i + 1) + (twice ? s[i] : '');
      doubled ||= twice;
      from = i + 1;
    }
    return doubled ? out : s;
  };
}
