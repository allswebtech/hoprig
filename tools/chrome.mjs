// Dev-only: drive the local Chrome (or Chromium) headless over the DevTools protocol, with nothing to install.
// Used by tools/screenshots.mjs and tools/brand.mjs. Not part of the published package.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export const findChrome = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a start may take while the browser lives. */
const START_MS = 30_000;

/**
 * Start headless Chrome on a debugging port the system picks; returns { port, send, evaluate(), goto(), close(), … },
 * with `port` the debugging port Chrome picked (a caller that asks Chrome's own HTTP list uses it). Its home folder is one of
 * its own, in its temporary profile folder (removed by close()), so a browser a test starts never writes into the
 * person's real home. `realHome` hands it the person's real home folder instead; a caller that asks for it says why on
 * that line.
 *
 * It drives only the browser it started: Chrome writes its port and its own browser id into the profile
 * (DevToolsActivePort), which must be the id that answers on 127.0.0.1. (A Chrome that finds 127.0.0.1:port taken
 * binds [::1] alone, and a run once drove another run's browser on that port for 45 s.) Chrome writes that file only
 * for a port it picks itself (--remote-debugging-port=0), so a port named by the caller is refused: with one, every
 * start waited 12 s for the file and failed.
 */
export async function launchChrome({ port, realHome = false } = {}) {
  if (port !== undefined) throw new Error('launchChrome picks its own debugging port; leave out the port option');
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome found; set CHROME=/path/to/chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-chrome-'));
  const home = path.join(profile, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: realHome ? os.userInfo().homedir : home };
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', ...(process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env });
  // Its last error lines and how it ended, for the error when it does not start (a busy runner, or a browser that exits).
  let tail = '';
  proc.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
  proc.stderr.on('error', () => {});
  // `gone`: it failed (a code other than 0, a signal, no start at all), so waiting longer cannot help. A launcher that
  // hands the browser on and exits with 0 is waited for as before.
  let ended = null;
  let gone = false;
  proc.once('exit', (code, signal) => { ended = signal ? `it ended by signal ${signal}` : `it exited with code ${code}`; gone = code !== 0; });
  proc.once('error', (e) => { ended = `it could not be started (${e.code || e.message})`; gone = true; });
  const why = (waited) => {
    const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-5).join(' | ');
    return [ended || waited, lines && `its last error lines: ${lines}`].filter(Boolean).join('; ');
  };
  const fail = async (message, waited = null) => {
    proc.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing */ }
    const detail = waited === null ? '' : why(waited);
    return new Error(detail ? `${message}: ${detail}` : message);
  };
  // Chrome writes its port into DevToolsActivePort once it is up: waited for while it lives, up to START_MS (a busy
  // runner took more than 12 s).
  let active = null;
  for (const until = Date.now() + START_MS; !active && !gone && Date.now() < until;) {
    await sleep(150);
    try {
      const [p, id] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (Number(p) && id?.startsWith('/devtools/browser/')) active = { port: Number(p), id: id.trim() };
    } catch {
      /* not written yet */
    }
  }
  if (!active) throw await fail('Chrome did not start', `no DevToolsActivePort within ${START_MS / 1000} s`);
  let target = null;
  for (const until = Date.now() + START_MS; !target && !gone && Date.now() < until;) {
    let version = null;
    try {
      version = await (await fetch(`http://127.0.0.1:${active.port}/json/version`)).json();
    } catch {
      await sleep(150); // not up yet
      continue;
    }
    if (!String(version.webSocketDebuggerUrl || '').endsWith(active.id)) throw await fail(`port ${active.port}: another browser answers there, not the one this run started`);
    try {
      target = (await (await fetch(`http://127.0.0.1:${active.port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(150);
  }
  if (!target) throw await fail('Chrome did not start', `no page on its port ${active.port} within ${START_MS / 1000} s`);
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 << 20 });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  const errors = []; // the page's uncaught errors and console.error lines, for a run to report
  const listeners = []; // on(fn): every event Chrome sends (a check that answers a dialog, watches the network)
  ws.on('message', (m) => {
    const j = JSON.parse(m);
    if (j.method) for (const f of listeners) f(j);
    if (j.method === 'Runtime.exceptionThrown') errors.push(j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text);
    if (j.method === 'Runtime.consoleAPICalled' && j.params.type === 'error') errors.push(j.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (j.id && pending.has(j.id)) {
      pending.get(j.id)(j);
      pending.delete(j.id);
    }
  });
  // Every call has a deadline, so a stuck page fails the run instead of hanging it.
  const send = (method, params = {}, timeoutMs = 90_000) => new Promise((resolve, reject) => {
    const i = ++id;
    const t = setTimeout(() => {
      pending.delete(i);
      reject(new Error(`${method}${params.url ? ` ${params.url}` : ''}: no answer from Chrome within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    pending.set(i, (j) => {
      clearTimeout(t);
      if (j.error) reject(new Error(`${method}: ${j.error.message}`));
      else resolve(j.result);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  const api = {
    port: active.port,
    send,
    errors,
    on: (fn) => listeners.push(fn),
    async evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    async goto(url, wait = 1200) {
      // A navigation that gets no answer (seen now and then under heavy load) is tried again once.
      try {
        await send('Page.navigate', { url }, 30_000);
      } catch {
        await send('Page.navigate', { url }, 60_000);
      }
      await sleep(wait);
    },
    async viewport(width, height, { mobile = false, scale = mobile ? 2 : 1, theme = 'light', touch = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: !!touch, maxTouchPoints: 5 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    },
    /** PNG or JPEG bytes of the viewport (or a clip { x, y, width, height }). */
    async shot({ format = 'png', quality = 85, clip = null } = {}) {
      const r = await send('Page.captureScreenshot', { format, ...(format === 'png' ? {} : { quality }), ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: !!clip });
      return Buffer.from(r.data, 'base64');
    },
    sleep,
    async close() {
      try { ws.close(); } catch { /* gone */ }
      proc.kill();
      await sleep(600);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing */ }
    },
  };
  return api;
}
