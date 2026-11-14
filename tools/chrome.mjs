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

/** Start headless Chrome on a free debugging port; returns { page(), close() }. */
export async function launchChrome({ port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome found; set CHROME=/path/to/chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-chrome-'));
  // The real home folder: the demo points HOME at its temp folder, and Chrome started with that home folder cannot
  // reach the network.
  const env = { ...process.env, HOME: os.userInfo().homedir };
  const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore', env });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(150);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 << 20 });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  const errors = []; // the page's uncaught errors and console.error lines, for a run to report
  ws.on('message', (m) => {
    const j = JSON.parse(m);
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
      reject(new Error(`${method}: no answer from Chrome within ${timeoutMs / 1000} s`));
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
    send,
    errors,
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
    async viewport(width, height, { mobile = false, scale = mobile ? 2 : 1, theme = 'light' } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
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
