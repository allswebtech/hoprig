// The browser terminal: one WebSocket = one attach stream from the session backend.
// Browser → server messages are JSON: {t:"in", d:"keys"}, {t:"bin", d:"bytes as latin1"} (mouse reports in the oldest
// encoding, where a byte above 127 is not a character) and {t:"resize", cols, rows}.
// Server → browser messages are the terminal output as text.

const MAX_IN = 64 * 1024;
const HIGH_WATER = 1 << 20; // pause the stream while more than 1 MiB waits for a slow phone connection

export const clamp = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);

/** Connect `ws` to session `name`. The caller has checked the login, the Origin and that the session exists. */
export function attachTerminal(ws, { backend, name, cols, rows }) {
  let stream;
  try {
    stream = backend.attach(name, { cols: clamp(cols, 2, 500, 80), rows: clamp(rows, 2, 300, 24) });
  } catch {
    ws.close(1011, 'could not start the terminal');
    return;
  }

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
  stream.onExit(() => {
    clearInterval(timer);
    if (ws.readyState === ws.OPEN) ws.close(4000, 'session ended');
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_IN) return;
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (m && m.t === 'in' && typeof m.d === 'string') stream.write(m.d);
    else if (m && m.t === 'bin' && typeof m.d === 'string' && !/[^\x00-\xff]/.test(m.d)) stream.write(Buffer.from(m.d, 'latin1'));
    else if (m && m.t === 'resize') {
      const c = clamp(m.cols, 2, 500, 0);
      const r = clamp(m.rows, 2, 300, 0);
      if (c && r) stream.resize(c, r);
    }
  });
  ws.on('close', () => {
    clearInterval(timer);
    stream.close();
  });
}
