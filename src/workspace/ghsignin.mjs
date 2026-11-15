// The GitHub sign-in without a terminal: gh's device flow, run in the background by the dashboard.
//
// `gh auth login --hostname github.com --git-protocol https --web` without a terminal prints (on its error output)
//   ! First copy your one-time code: ABCD-1234
//   Open this URL to continue in your web browser: https://github.com/login/device
// and then waits, asking GitHub every few seconds, until the code is confirmed there (or it runs out after 15
// minutes). The page shows the code and opens GitHub in the owner's own browser; gh finishes by itself. Then
// `gh auth setup-git`, so plain git uses that sign-in. gh's own attempt to open a browser is turned into nothing
// (GH_BROWSER): it would open on the computer that runs the dashboard, where the owner may not be.
// Nothing gh prints is kept but the code and the last plain line of a failure; the token stays in gh's own store.
import { spawn } from 'node:child_process';
import { parseGhAuth } from '../pcsetup/detect.mjs';
import { capture } from '../setup/system.mjs';

export const DEVICE_URL = 'https://github.com/login/device';
export const SIGNIN_ARGV = ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'];
const WAIT_MS = 15 * 60_000; // how long GitHub's device codes last
const CODE_WAIT_MS = 20_000;
const TOKEN_RE = /\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g;

/** The one-time code in gh's output, or null. */
export function parseDeviceCode(text) {
  const m = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** gh's environment for the sign-in: no browser opened by gh, no token variable (gh refuses to sign in with one). */
export function signinEnv(env = process.env, platform = process.platform) {
  const e = { ...env, GH_BROWSER: platform === 'win32' ? 'cmd /c rem' : 'true', NO_COLOR: '1' };
  delete e.GH_TOKEN;
  delete e.GITHUB_TOKEN;
  return e;
}

/** A failure's last line worth showing: not the clipboard notes, never a token. */
function lastWords(lines) {
  const plain = lines.map((l) => l.replace(TOKEN_RE, '••••').trim()).filter((l) => l && !/clipboard|one-time code|Open this URL/i.test(l));
  return plain.pop() || null;
}

/**
 * One sign-in at a time. `start()` resolves as soon as the code is there (or gh ended); `state()` says how far it
 * is: { state: idle | starting | code | done | failed | expired | cancelled, code, url, account, error }.
 */
export function githubSignin({ env = process.env, platform = process.platform, spawnImpl = spawn, run = capture, waitMs = WAIT_MS, codeWaitMs = CODE_WAIT_MS } = {}) {
  let cur = null;
  const state = () => (cur
    ? { state: cur.state, code: cur.state === 'code' ? cur.code : null, url: cur.state === 'code' ? DEVICE_URL : null, account: cur.account, error: cur.error }
    : { state: 'idle', code: null, url: null, account: null, error: null });
  const live = () => cur && (cur.state === 'starting' || cur.state === 'code');

  function start() {
    if (live()) return cur.ready.then(state);
    const s = { state: 'starting', code: null, account: null, error: null, lines: [], child: null, cancelled: false };
    cur = s;
    let ready;
    s.ready = new Promise((r) => (ready = r));
    const env2 = signinEnv(env, platform);
    try {
      s.child = spawnImpl(SIGNIN_ARGV[0], SIGNIN_ARGV.slice(1), { env: env2, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      Object.assign(s, { state: 'failed', error: e.message });
      ready();
      return Promise.resolve(state());
    }
    let text = '';
    const feed = (chunk) => {
      text = (text + chunk).slice(-8000);
      s.lines = text.split(/\r?\n/).slice(-20);
      const code = s.code || parseDeviceCode(text);
      if (code && s.state === 'starting') {
        Object.assign(s, { code, state: 'code' });
        ready();
      }
    };
    for (const st of [s.child.stdout, s.child.stderr]) {
      st.setEncoding('utf8');
      st.on('data', feed);
    }
    const timer = setTimeout(() => {
      s.expired = true;
      s.child.kill();
    }, waitMs);
    const noCode = setTimeout(ready, codeWaitMs);
    s.child.on('error', (e) => {
      s.lines.push(e.code === 'ENOENT' ? 'gh is not installed' : e.message);
    });
    s.child.on('close', async (code) => {
      clearTimeout(timer);
      clearTimeout(noCode);
      if (s.cancelled) s.state = 'cancelled';
      else if (s.expired) Object.assign(s, { state: 'expired', error: 'the code ran out before it was confirmed on GitHub' });
      else if (code !== 0) Object.assign(s, { state: 'failed', error: lastWords(s.lines) || `gh stopped (exit ${code})` });
      else {
        // Signed in: plain git uses that sign-in too, then the account name (the only thing kept or shown).
        const g = await run(['gh', 'auth', 'setup-git', '--hostname', 'github.com'], { env: env2, timeout: 30_000 });
        const a = parseGhAuth(await run(['gh', 'auth', 'status', '--hostname', 'github.com'], { env: env2, timeout: 20_000 }));
        Object.assign(s, { state: a.signedIn ? 'done' : 'failed', account: a.signedIn ? a.account : null, error: a.signedIn ? (g.ok ? null : 'signed in, but git could not be told to use it: gh auth setup-git') : 'gh ended, but no sign-in is there' });
      }
      s.code = null;
      ready();
    });
    return s.ready.then(state);
  }

  function cancel() {
    if (!live()) return state();
    cur.cancelled = true;
    if (cur.child) cur.child.kill();
    return { ...state(), state: 'cancelled' };
  }

  return { start, state, cancel };
}
