// The browser terminal: one WebSocket = one attach stream from the session backend.
// Browser → server messages are JSON: {t:"in", d:"keys"} (with paste:true for a frame of a bracketed paste), {t:"bin", d:"bytes as latin1"} (mouse reports in the oldest
// encoding, where a byte above 127 is not a character) and {t:"resize", cols, rows}.
// Server → browser messages are the terminal output as text.

const MAX_IN = 64 * 1024;
const HIGH_WATER = 1 << 20; // pause the stream while more than 1 MiB waits for a slow phone connection

export const clamp = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const PASTE_CAP = 4 << 20; // characters held for one paste; a longer one goes on as it comes

/**
 * A bracketed paste arrives whole or not at all. The page sends a long paste in frames (web/termkeys.js inputMessages);
 * when the link dropped half-way the program was left inside the paste, and the keys typed after the reconnect, Enter
 * too, became paste text. From its start mark to its end mark a paste is held and written in one go; a socket that
 * closes before the end drops it. The start mark comes whole at the head of a frame; the end mark may span two.
 * A paste over the cap goes on as it comes, and if the socket closes in it the end mark is written, so the program
 * leaves paste mode. Only frames the page flags as a paste come here: a start mark inside typed or pasted text of
 * its own (a program that did not ask for bracketed paste gets the clipboard as it is) is no paste the page made,
 * and held, it took every key after it until the page reconnected.
 */
export function wholePaste(write, { cap = PASTE_CAP } = {}) {
  let held = null; // the frames of the paste so far, while it is held: joined once, at its end mark
  let size = 0; // their characters
  let seam = ''; // the last characters held, for an end mark split across two frames
  let through = false; // a paste over the cap, being passed on
  let tail = ''; // the last characters passed on in it, for an end mark split across two frames
  const take = (d) => {
    if (held !== null) {
      // Only the new frame and the seam before it are searched: searching (and joining) all that was held on every
      // frame took the square of the paste, 0.7 s at 4 Mi, and every other terminal and page waited meanwhile.
      const s = seam + d;
      const end = s.indexOf(PASTE_END);
      if (end >= 0) {
        const cut = end + PASTE_END.length - seam.length;
        held.push(d.slice(0, cut));
        write(held.join(''));
        held = null;
        seam = '';
        return cut < d.length && take(d.slice(cut));
      }
      held.push(d);
      size += d.length;
      seam = s.slice(-(PASTE_END.length - 1));
      if (size > cap) {
        write(held.join(''));
        tail = seam;
        held = null;
        seam = '';
        through = true;
      }
      return;
    }
    if (through) {
      const s = tail + d;
      const end = s.indexOf(PASTE_END);
      if (end < 0) {
        write(d);
        tail = s.slice(-(PASTE_END.length - 1));
        return;
      }
      const cut = end + PASTE_END.length - tail.length;
      write(d.slice(0, cut));
      through = false;
      tail = '';
      return cut < d.length && take(d.slice(cut));
    }
    const start = d.indexOf(PASTE_START);
    if (start < 0) return write(d);
    if (start > 0) write(d.slice(0, start));
    held = [];
    size = 0;
    take(d.slice(start));
  };
  return {
    write: take,
    /** The socket closed: a paste held so far is dropped, one passed on in part is ended. */
    close() {
      if (through) write(PASTE_END);
      held = null;
      seam = '';
      through = false;
    },
  };
}

/** Connect `ws` to session `name`. The caller has checked the login, the Origin and that the session exists. */
export function attachTerminal(ws, { backend, name, cols, rows }) {
  let stream;
  try {
    stream = backend.attach(name, { cols: clamp(cols, 2, 500, 80), rows: clamp(rows, 2, 300, 24) });
  } catch {
    ws.close(1011, 'could not start the terminal');
    return;
  }

  const paste = wholePaste((d) => stream.write(d));
  let paused = false;
  const timer = setInterval(() => {
    if (paused && ws.bufferedAmount < HIGH_WATER / 4) {
      paused = false;
      stream.resume();
    }
  }, 50);

  stream.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(data);
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      stream.pause();
    }
  });
  // The attach ends when the session does, and also when only the attach client went (a detach key of the user's tmux
  // config, as bind -n C-q detach-client): then the session runs on, and the page connects again instead of saying
  // it ended.
  stream.onExit(async () => {
    clearInterval(timer);
    const lives = await Promise.resolve().then(() => backend.list()).then((ts) => ts.some((t) => t.session === name), () => false);
    if (ws.readyState === ws.OPEN) ws.close(lives ? 4001 : 4000, lives ? 'detached' : 'session ended');
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_IN) return;
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (m && m.t === 'in' && typeof m.d === 'string') (m.paste === true ? paste.write(m.d) : stream.write(m.d));
    else if (m && m.t === 'bin' && typeof m.d === 'string' && !/[^\x00-\xff]/.test(m.d)) stream.write(Buffer.from(m.d, 'latin1'));
    else if (m && m.t === 'resize') {
      const c = clamp(m.cols, 2, 500, 0);
      const r = clamp(m.rows, 2, 300, 0);
      if (c && r) stream.resize(c, r);
    }
  });
  ws.on('close', () => {
    clearInterval(timer);
    paste.close();
    stream.close();
  });
  // A frame over the server's limit (a huge paste) or a broken frame is an 'error' on this socket; ws closes it
  // afterwards. Without a listener the error is uncaught and ends the whole dashboard.
  ws.on('error', () => {});
}
