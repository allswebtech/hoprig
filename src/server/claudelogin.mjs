// Claude Code's own sign-in from the page (Setup → Claude login, Home → Get started, Providers → a provider that uses
// Claude Code's stored login), as a server feature: { name, routes, close }. Sign in, sign out, and sign in with
// another account (at a usage limit: the work goes on under the same provider).
//
// The server holds `claude auth login` in a terminal of its own and the page opens the sign-in link in the same
// browser. Claude Code does the OAuth and keeps its credentials where it always does (its own config folder);
// Hoprig never reads or handles them (README: "Is this allowed?"). Afterwards `claude auth status` confirms it.
//
// Two ways back, both open at the same time (Claude Code 2.1.325, probed):
//   on this computer  Claude Code hands its BROWSER a link whose redirect is http://localhost:<port>/callback, where
//                     it listens. BROWSER is a small helper that only writes that link to a file. A browser on the
//                     same computer reaches the port, so approving finishes the sign-in by itself.
//   from anywhere     Claude Code prints a link that ends on Anthropic's page with a code; the owner pastes the code
//                     into the page and the server types it in.
// The server picks the way from the request (sameComputer): a browser on another computer cannot reach this
// computer's localhost, and a wrong guess only costs the owner one click on "Use a code instead".
//
// Another account (2.1.325, probed with a Claude folder of its own and a stand-in sign-in):
//   - `claude auth login` starts a new sign-in while one is stored, and the stored one stays untouched until the new
//     one succeeds. So "Sign in with another account" is ONE step, with no sign-out first: a sign-in that is
//     cancelled or fails leaves everything as it was. `--email <address>` only pre-fills the sign-in page.
//   - Sessions and chats that run on the stored sign-in need no restart: Claude Code reads the stored sign-in again
//     before its next request (a terminal session and a headless chat process, both seen to send the next request
//     as the new account, also from a session standing at its 5-hour limit). After a sign-out their next request
//     ends in "Not logged in · Please run /login", and goes through again once someone has signed in.
//     Seen on Linux, where the sign-in is the file .credentials.json in Claude Code's folder (Windows: the same
//     file; macOS: the Keychain, with that file as the fallback). Not run on macOS or Windows.
//   - `claude auth logout` prints one line and exits 0, signed in or not. It also removes what else Claude Code
//     saved with the sign-in (its sign-ins to MCP servers).
// A new account has its own limits: the sign-in check that sees another account (claudecode.mjs) clears the limit
// marks and usage figures of the providers that use the stored sign-in — also when the account was changed with
// /login in a terminal.
//
// Who is signed in (e-mail, organisation) is shown to the owner on this dashboard's own page and nowhere else: it
// is asked from Claude Code when the page asks, never stored, never logged, and not in any other route's answer.
//
// Routes (behind the login, cookie only: /api/accounts/ is closed to another dashboard's token and to Tia):
//   GET  /api/accounts/claude-login          { state: none|starting|link|checking|verifying|done|error,
//                                              way?, url?, codeUrl?, error?, plan?, changed? }
//   POST /api/accounts/claude-login/start    { email? } → { state: "link", way: "local"|"code", url, codeUrl }
//   POST /api/accounts/claude-login/code     { code } → { state: "done", plan, changed } or an error
//   POST /api/accounts/claude-login/cancel
//   GET  /api/accounts/claude-login/account  { loggedIn, plan, email, org }   (?fresh=1: ask Claude Code now)
//   POST /api/accounts/claude-login/logout   → { ok: true }
// `changed`: another account than the one seen before (its limit marks and figures were cleared).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccount, claudeLogout, resolveClaude } from '../claudecode.mjs';
import { LINK_HEADER } from '../machines/link.mjs';
import { findSigninError, findSigninUrl, plainText, scrub, signinEnv } from './accounts.mjs';
import { ptySpawn } from './backends/nodepty.mjs';

const TIMES = { link: 45_000, browser: 3000, done: 60_000, verify: 10_000, ttl: 10 * 60_000 };
const CODE_RE = /^[A-Za-z0-9_\-.~]{4,400}#[A-Za-z0-9_\-.~]{4,400}$/;
// An address to pre-fill the sign-in page with. It becomes one argument of `claude auth login` (never a shell
// string), and may not look like an option.
const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,180}[A-Za-z0-9])?\.[A-Za-z]{2,24}$/;
const ACCOUNT_TTL_MS = 15_000; // `claude auth status` is a program start: not one per look at the page
// Headers a proxy or tunnel adds (cloudflared, Caddy, nginx, Tailscale Serve, …), and the marks of a request that
// came from another computer (a bearer token, the hub's link). Any of them: not the browser of this computer.
const NOT_LOCAL = new Set(['forwarded', 'via', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'fly-client-ip', 'tailscale-user-login', 'authorization', LINK_HEADER]);

const fail = (status, message) => Object.assign(new Error(message), { status });
const bare = (ip) => String(ip || '').replace(/^::ffff:/i, '').replace(/%.*$/, '').toLowerCase();

/** Every address of this computer's network interfaces. */
export function ownAddresses(ifaces = os.networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(ifaces || {})) for (const a of list || []) if (a && a.address) out.add(bare(a.address));
  return out;
}

/**
 * Is the browser behind this request on this computer? Only when it connected from a loopback address or one of
 * this computer's own, and nothing forwarded it: a tunnel such as cloudflared also arrives from loopback, but it
 * adds its headers.
 */
export function sameComputer(req, { addresses = ownAddresses() } = {}) {
  for (const k of Object.keys(req.headers || {})) if (k.startsWith('x-forwarded-') || NOT_LOCAL.has(k)) return false;
  const ip = bare(req.socket && req.socket.remoteAddress);
  return Boolean(ip) && (ip === '::1' || /^127\./.test(ip) || addresses.has(ip));
}

/** The redirect of a sign-in link goes to Claude Code on this computer (http://localhost:<port>/callback). */
function toLocalhost(u) {
  try {
    const r = new URL(new URL(u).searchParams.get('redirect_uri') || '');
    return r.protocol === 'http:' && (r.hostname === 'localhost' || r.hostname === '127.0.0.1') && r.pathname === '/callback';
  } catch {
    return false;
  }
}

/** The sign-in link Claude Code gave its BROWSER: Anthropic's sign-in page, with the redirect to localhost. */
export function localLink(text) {
  const u = findSigninUrl(String(text || '').trim());
  return u && toLocalhost(u) ? u : null;
}

/** The link Claude Code printed: Anthropic's sign-in page that ends with a code to paste. */
export function codeLink(raw) {
  const u = findSigninUrl(raw);
  return u && !toLocalhost(u) ? u : null;
}

/**
 * The environment for `claude auth login`: no provider's address or key and none of Claude Code's own switches (a
 * session's variables must not steer the sign-in), CLAUDE_CONFIG_DIR as it is (the sign-in goes where Claude Code
 * keeps it), and BROWSER set to the helper, or to a program that opens nothing.
 */
export function loginEnv(base = process.env, browser = null) {
  const env = signinEnv(base);
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE' || k === 'HOPRIG_RUN_FILE') delete env[k];
  if (browser) env.BROWSER = browser;
  return env;
}

/**
 * A BROWSER for Claude Code that writes the link it was given into `<dir>/link` and opens nothing. A shell script,
 * so POSIX only; elsewhere, and in a folder whose name the script could not hold safely, there is none and the page
 * uses the code (that way works on every system).
 */
export function browserHelper(dir, platform = process.platform) {
  const file = path.join(dir, 'browser');
  const out = path.join(dir, 'link');
  if (platform === 'win32' || /[\s'"\\$`]/.test(file)) return null;
  fs.writeFileSync(file, `#!/bin/sh\n# Hoprig: Claude Code's sign-in link is written down here; no browser is opened.\nprintf '%s\\n' "$1" > '${out}'\n`, { mode: 0o700 });
  return file;
}

class LoginFlow {
  constructor({ bin, spawn = ptySpawn, times, status, email = null, onDone = () => {} }) {
    Object.assign(this, { times, status, onDone, state: 'starting', out: '', codeUrl: null, localUrl: null, error: null, plan: null, changed: false, ended: false, exited: false });
    this.waiters = [];
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-login-'));
    try {
      const env = loginEnv(process.env, browserHelper(this.dir));
      // Wide, so the link is not wrapped.
      this.term = spawn(bin, ['auth', 'login', ...(email ? ['--email', email] : [])], { name: 'xterm-256color', cols: 1000, rows: 50, cwd: os.homedir(), env });
    } catch (e) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      throw e;
    }
    this.term.onData((d) => {
      if (this.out.length < 1 << 20) this.out += d;
      if (/Login successful/i.test(plainText(this.out))) this.#verify();
      this.#wake();
    });
    this.term.onExit(({ exitCode } = {}) => {
      this.exited = true;
      if (exitCode === 0 || /Login successful/i.test(plainText(this.out))) this.#verify();
      else if (!this.ended && this.state !== 'verifying') {
        const said = findSigninError(this.out);
        this.end(this.state === 'checking'
          ? `The code was not accepted${said ? ` (${said})` : ''}. Start again and copy the whole code.`
          : said || 'Claude Code stopped before the sign-in finished');
      }
      this.#wake();
    });
    this.timer = setTimeout(() => this.end('The sign-in took longer than 10 minutes and was stopped. Start again.'), this.times.ttl);
    this.timer.unref?.();
  }

  get way() {
    return this.localUrl ? 'local' : 'code';
  }

  #wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves with what `test()` returns once it is truthy, or null after `ms`. */
  waitFor(test, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const check = () => {
        const v = test();
        if (v || Date.now() >= end) return resolve(v || null);
        this.waiters.push(check);
        setTimeout(check, Math.max(0, Math.min(250, end - Date.now()))).unref?.();
      };
      check();
    });
  }

  #helperLink() {
    try {
      return localLink(fs.readFileSync(path.join(this.dir, 'link'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Wait for the printed link; for a browser on this computer, also for the one the helper was given. */
  async link(local) {
    const url = await this.waitFor(() => codeLink(this.out) || (this.ended && 'ended'), this.times.link);
    if (!url || url === 'ended') {
      const why = this.ended ? this.error : 'Claude Code showed no sign-in link';
      this.end(why);
      throw fail(502, `${why}. Use the terminal instead.`);
    }
    this.codeUrl = url;
    if (local) this.localUrl = await this.waitFor(() => this.#helperLink(), this.times.browser);
    if (this.ended) throw fail(502, `${this.error}. Use the terminal instead.`);
    this.state = 'link';
  }

  async code(code) {
    if (this.state !== 'link') throw fail(409, 'There is no sign-in waiting for a code. Start again.');
    this.state = 'checking';
    this.term.write(code);
    await new Promise((r) => setTimeout(r, 300));
    this.term.write('\r');
    // A refused code ends Claude Code ("Login failed", exit 1: the error comes from onExit). Its "Invalid code" (no #)
    // cannot happen: the route takes only codes with a # in the middle.
    const r = await this.waitFor(() => (this.state === 'done' || this.state === 'error' ? this.state : null), this.times.done);
    if (r === 'done') return;
    if (r === 'error') throw fail(400, this.error);
    this.end('Claude Code gave no answer within a minute. Start again.');
    throw fail(504, this.error);
  }

  /** Claude Code said the sign-in worked: let it finish, then ask it whether it is signed in now. */
  async #verify() {
    if (this.ended || this.state === 'verifying') return;
    this.state = 'verifying';
    this.#wake();
    await this.waitFor(() => this.exited || this.ended, this.times.verify);
    if (this.ended) return;
    let s;
    try {
      s = await this.status();
    } catch {
      s = { loggedIn: null };
    }
    if (this.ended) return;
    if (s.loggedIn === true) {
      this.plan = s.plan || null;
      this.changed = s.changed === true;
      this.state = 'done';
      this.end();
      this.onDone();
    } else this.end(s.loggedIn === false ? 'Claude Code finished, but it does not report a sign-in. Start again.' : `The sign-in could not be checked: ${s.reason || 'Claude Code gave no answer'}.`);
  }

  /** Stop Claude Code and remove the helper; with `error`, the sign-in failed. */
  end(error = null) {
    if (this.ended) return;
    this.ended = true;
    if (error) Object.assign(this, { state: 'error', error });
    clearTimeout(this.timer);
    try {
      this.term.kill();
    } catch {
      /* already gone */
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.out = ''; // nothing of the sign-in stays in memory
    this.#wake();
  }

  view() {
    if (this.state === 'done') return { state: 'done', plan: this.plan, changed: this.changed };
    if (this.state === 'error') return { state: 'error', error: this.error };
    return { state: this.state, way: this.way, url: this.localUrl || this.codeUrl, codeUrl: this.codeUrl };
  }
}

/** opts: { spawn, status, logout, addresses, times } — stand-ins for tests. */
export function claudeLoginFeature(ctx, opts = {}) {
  const times = { ...TIMES, ...(opts.times || {}) };
  // { loggedIn, plan, email, org, changed }: who is signed in, asked from Claude Code (and kept for Providers).
  const status = opts.status || (() => claudeAccount({ env: process.env }));
  const logout = opts.logout || (() => claudeLogout({ env: process.env }));
  let flow = null; // the last one, kept after it ended so the page can read how it ended
  let seen = null; // { at, account }: the last answer, for a page that looks again within a few seconds

  const owner = (req) => {
    if (!ctx.authed(req)) throw fail(403, 'Only the owner of this dashboard can sign in Claude Code');
  };
  const changed = () => {
    seen = null;
    ctx.poke?.(); // Providers, Home and the session pages read the new state at once
  };
  async function account(fresh) {
    if (!fresh && seen && Date.now() - seen.at < ACCOUNT_TTL_MS) return seen.account;
    let s;
    try {
      s = await status();
    } catch {
      s = { loggedIn: null };
    }
    const one = (v) => (typeof v === 'string' && v ? v : null);
    const a = { loggedIn: typeof s.loggedIn === 'boolean' ? s.loggedIn : null, plan: s.loggedIn ? one(s.plan) : null, email: s.loggedIn ? one(s.email) : null, org: s.loggedIn ? one(s.org) : null };
    seen = { at: Date.now(), account: a };
    if (s.changed) ctx.poke?.();
    return a;
  }

  const routes = [
    ['GET', /^\/api\/accounts\/claude-login$/, async (req) => {
      owner(req);
      return flow ? flow.view() : { state: 'none' };
    }],
    ['GET', /^\/api\/accounts\/claude-login\/account$/, async (req, m, q) => {
      owner(req);
      return account(q.get('fresh') === '1');
    }],
    ['POST', /^\/api\/accounts\/claude-login\/start$/, async (req) => {
      owner(req);
      const b = await ctx.readJson(req);
      let email = null;
      if (b.email !== undefined && b.email !== null && b.email !== '') {
        email = typeof b.email === 'string' ? b.email.trim() : '';
        if (!EMAIL_RE.test(email) || email.length > 254) throw fail(400, 'That does not look like an e-mail address. Leave it empty to choose the account on the sign-in page.');
      }
      if (flow && !flow.ended) throw fail(409, 'A sign-in is already in progress. Finish or cancel it first.');
      const found = resolveClaude({ bin: ctx.config().claudeBin || 'claude' });
      if (!found) throw fail(409, 'Claude Code is not installed on this computer yet. Set it up first.');
      const local = sameComputer(req, opts.addresses ? { addresses: opts.addresses } : undefined);
      // Who is signed in now, before anything changes: the check afterwards then knows whether it is another account.
      await account(true);
      if (flow && !flow.ended) throw fail(409, 'A sign-in is already in progress. Finish or cancel it first.');
      let f;
      try {
        f = new LoginFlow({ bin: found.path, spawn: opts.spawn, times, status, email, onDone: changed });
      } catch (e) {
        throw fail(500, `Claude Code could not be started (${scrub(e.message)}). Use the terminal instead.`);
      }
      flow = f;
      await f.link(local);
      return f.view();
    }],
    ['POST', /^\/api\/accounts\/claude-login\/logout$/, async (req) => {
      owner(req);
      await ctx.readJson(req);
      if (flow && !flow.ended) throw fail(409, 'A sign-in is in progress. Finish or cancel it first.');
      let r;
      try {
        r = await logout();
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (!r || !r.ok) throw fail(502, `Claude Code did not sign out${r && r.error ? ` (${scrub(r.error)})` : ''}. Try again, or run "claude auth logout" in a terminal.`);
      const now = await account(true); // also kept for Providers: "Not signed in"
      changed();
      if (now.loggedIn === true) throw fail(502, 'Claude Code still reports a sign-in. Try again, or run "claude auth logout" in a terminal.');
      return { ok: true };
    }],
    ['POST', /^\/api\/accounts\/claude-login\/code$/, async (req) => {
      owner(req);
      const b = await ctx.readJson(req);
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      if (!CODE_RE.test(code)) throw fail(400, 'Paste the whole code from the sign-in page: it has a # in the middle');
      if (!flow || flow.ended) throw fail(409, 'There is no sign-in waiting for a code. Start again.');
      await flow.code(code);
      return flow.view();
    }],
    ['POST', /^\/api\/accounts\/claude-login\/cancel$/, async (req) => {
      owner(req);
      await ctx.readJson(req);
      if (flow) flow.end('Cancelled');
      flow = null;
      return { ok: true };
    }],
  ];

  return {
    name: 'claude-login',
    routes,
    close() {
      if (flow) flow.end();
      flow = null;
    },
  };
}
