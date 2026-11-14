// Providers in the dashboard (Providers → Add provider), as a server feature: { name, routes, close }.
// Three ways to add an account, none of which needs a terminal:
//
//   Claude subscription   the server runs `claude setup-token` in a terminal it holds, shows the sign-in link to the
//                         page, types the one-time code the owner pastes back, reads the long-lived token from the
//                         output and saves it as CLAUDE_CODE_OAUTH_TOKEN. The token never reaches the browser or a log.
//   Anthropic-compatible  base URL + key: the server lists the endpoint's models (x-api-key or Bearer, whichever it
//                         accepts), tests one tiny request, and saves the profile.
//   Other providers       through the TRouteAI add-on (it translates OpenAI, Gemini, … to Claude's API): the same as
//                         above with its address prefilled and PRERUN set so the gateway starts on demand.
//
// Routes (behind the login; cookie only — another dashboard's bearer token may not reach them):
//   GET  /api/accounts                         accounts with kind, state, usage, model, Auto membership; defaults
//   POST /api/accounts/probe                   { baseUrl, key } or { account }: models + which header works → { probe,
//                                              auth, models|null, note }. The key stays on the server under `probe`.
//   POST /api/accounts/test                    { probe, model } → { ok, error? }   one request, max_tokens 1
//   POST /api/accounts/save                    { probe, name, label, model?, smallModel?, via: "api"|"trouteai" }
//   POST /api/accounts/<name>/model            { probe, model, smallModel? }  pin another model
//   POST /api/accounts/<name>/label            { label }
//   POST /api/accounts/<name>/auto             { on }  add to / remove from Auto mode's order
//   POST /api/accounts/<name>/delete
//   GET  /api/accounts/subscription            the sign-in in progress: { state, url?, error?, name?, mode? }
//   POST /api/accounts/subscription/start      { mode?: "add", name?, label? } a new provider, or
//                                              { mode: "signin", name } sign in again for an existing provider that
//                                              signs in (not an API key): → { state: "link", url, name, label, mode }
//   POST /api/accounts/subscription/code       { code } → { state: "done", name, label, mode } or an error
//   POST /api/accounts/subscription/cancel
// "signin" keeps the provider's name, label, place in Auto mode's order and settings, and replaces its sign-in only
// when the new one succeeded: until then, and after a cancelled or failed attempt, its file is untouched.
// Probe and test calls are rate limited (they reach out to the internet with a key).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as autoswitchModule from '../autoswitch.mjs';
import { ptySpawn } from './backends/nodepty.mjs';
import { findAddon } from '../addons/index.mjs';
import { AUTH_VARS, deleteProfile, listProfiles, readProfile, validName, writeProfile } from '../profiles.mjs';

export const ANTHROPIC_URL = 'https://api.anthropic.com';
const FETCH_TIMEOUT_MS = 15_000;
const BODY_CAP = 2 * 1024 * 1024;
const PROBE_TTL_MS = 15 * 60_000;
const FLOW_TTL_MS = 10 * 60_000;
const LINK_WAIT_MS = 45_000;
const TOKEN_WAIT_MS = 60_000;
const MODEL_RE = /^[A-Za-z0-9._:/@+\-[\]]{1,120}$/;
const KEY_RE = /^[\x21-\x7e]{8,500}$/; // printable ASCII, no spaces
const TOKEN_RE = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
const SIGNIN_HOSTS = /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
/** Anything that could be a secret is cut out of text that leaves the server. */
export const scrub = (s, ...secrets) => {
  let out = String(s || '');
  for (const x of secrets) if (x && x.length >= 6) out = out.split(x).join('***');
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '***').replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
};

// ---------- validation ----------

/** A base URL for an endpoint: http(s), no credentials, no query or fragment; a trailing /v1 is dropped (Claude
 * Code adds /v1/messages itself). */
export function cleanBaseUrl(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 300) throw fail(400, 'Enter the address of the API, like https://api.anthropic.com');
  let u;
  try {
    u = new URL(v.trim());
  } catch {
    throw fail(400, 'That is not a web address. It should look like https://api.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail(400, 'The address must start with https:// or http://');
  if (u.username || u.password) throw fail(400, 'Put the key in the key field, not inside the address');
  if (u.search || u.hash) throw fail(400, 'The address must not contain ? or #');
  const p = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${u.origin}${p}`;
}

export function cleanKey(v) {
  if (typeof v !== 'string' || !KEY_RE.test(v.trim())) throw fail(400, 'Paste the whole key: one line, no spaces');
  return v.trim();
}

export function cleanModel(v, { optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return '';
  if (typeof v !== 'string' || !MODEL_RE.test(v.trim())) throw fail(400, 'Pick a model from the list or type its exact name');
  return v.trim();
}

export function cleanLabel(v, dflt) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return dflt;
  if (s.length > 60 || /[\r\n\0]/.test(s)) throw fail(400, 'The name to show must be one line of up to 60 characters');
  return s;
}

export function cleanNewName(v, dflt) {
  const n = typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : dflt;
  if (!validName(n)) throw fail(400, `"${n}" cannot be used as a short name: use a–z, 0–9, - and _, starting with a letter or digit`);
  if (readProfile(n)) throw fail(409, `There is already a provider called "${n}"`);
  return n;
}

/** The first free name of base, base2, base3 … (base itself only when `bare`). */
export function freeName(base, { bare = true, from = 2 } = {}) {
  if (bare && !readProfile(base)) return base;
  for (let i = from; i < 100; i++) if (!readProfile(`${base}${i}`)) return `${base}${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// ---------- talking to an endpoint ----------

/** Read at most BODY_CAP bytes of a response as text. */
async function readCapped(r) {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > BODY_CAP) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const HEADERS = { x: (key) => ({ 'x-api-key': key }), bearer: (key) => ({ Authorization: `Bearer ${key}` }) };

/**
 * One request to the endpoint. Redirects are never followed (a redirect could carry the key to another host).
 * Resolves { status, json, text } or { error } for network failures.
 */
async function call(fetchImpl, url, { method = 'GET', key, auth, body }) {
  try {
    const r = await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'anthropic-version': '2023-06-01', ...(body ? { 'content-type': 'application/json' } : {}), ...HEADERS[auth](key) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await readCapped(r);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  } catch (e) {
    const cause = e.cause && (e.cause.code || e.cause.message);
    return { error: e.name === 'TimeoutError' ? 'it did not answer within 15 seconds' : cause || e.message };
  }
}

/** What went wrong, in plain words, from an HTTP answer. */
export function explain(r, host, key) {
  if (r.error) return `Cannot reach ${host}: ${scrub(r.error, key)}`;
  const said = r.json && r.json.error ? (typeof r.json.error === 'string' ? r.json.error : r.json.error.message || r.json.error.type || '') : '';
  const extra = said ? ` The service said: "${scrub(said, key)}"` : '';
  if (r.status >= 300 && r.status < 400) return `${host} answered with a redirect (${r.status}). Use the final address instead; the key is not sent on to another address.`;
  if (r.status === 401) return `The key was refused (401).${extra}`;
  if (r.status === 403) return `The key may not do this (403).${extra}`;
  if (r.status === 404) return `Not found at this address (404): check the address and the model name.${extra}`;
  if (r.status === 429) return `Too many requests or no credit left (429).${extra}`;
  if (r.status === 529 || r.status === 503) return `The service is overloaded right now (${r.status}). Try again in a moment.${extra}`;
  if (r.status >= 500) return `The service had an error (${r.status}).${extra}`;
  return `The request was not accepted (${r.status}).${extra}`;
}

function modelsOf(json) {
  const list = json && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : null;
  if (!list) return null;
  const out = [];
  for (const m of list) {
    const id = m && typeof m.id === 'string' ? m.id : typeof m === 'string' ? m : null;
    if (!id || !MODEL_RE.test(id)) continue;
    out.push({ id, name: m && typeof m.display_name === 'string' ? m.display_name.slice(0, 80) : id });
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * List the models with either header. Returns { auth: 'x'|'bearer'|null, models: [...]|null, note }.
 * `auth` is null when no list exists (the test request decides then); a refused key is an error.
 */
export async function listModels(fetchImpl, baseUrl, key, prefer = 'x') {
  const host = new URL(baseUrl).host;
  const url = `${baseUrl}/v1/models?limit=1000`;
  let last = null;
  for (const auth of prefer === 'bearer' ? ['bearer', 'x'] : ['x', 'bearer']) {
    const r = await call(fetchImpl, url, { key, auth });
    if (r.error) throw fail(502, explain(r, host, key));
    if (r.status === 200) {
      const models = modelsOf(r.json);
      if (models) return { auth, models, note: models.length ? '' : 'The service lists no models; type the model name.' };
      return { auth, models: null, note: 'The service gave no model list; type the model name.' };
    }
    last = r;
    if (r.status !== 401 && r.status !== 403) break; // only a refused key is worth the other header
  }
  if (last && (last.status === 401 || last.status === 403)) throw fail(400, explain(last, host, key));
  return { auth: null, models: null, note: 'This service has no model list; type the model name.' };
}

/**
 * One tiny real request. Returns { ok, auth, error? }. `auth` is tried first; a refused key is tried once with the
 * other header (a model list may be open to anyone, so the header it accepted proves nothing).
 */
export async function testModel(fetchImpl, baseUrl, key, auth, model) {
  const host = new URL(baseUrl).host;
  const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] };
  let last = null;
  for (const a of auth === 'bearer' ? ['bearer', 'x'] : ['x', 'bearer']) {
    const r = await call(fetchImpl, `${baseUrl}/v1/messages`, { method: 'POST', key, auth: a, body });
    if (!r.error && r.status === 200) return { ok: true, auth: a };
    last = r;
    if (r.error || (r.status !== 401 && r.status !== 403)) break;
  }
  return { ok: false, auth, error: explain(last, host, key) };
}

// ---------- the subscription sign-in (`claude setup-token` in a terminal we hold) ----------

/** Plain text of terminal output: cursor jumps become spaces, other escape codes go. */
export function plainText(s) {
  return String(s)
    .replace(/\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(\x07|\x1b\\)/g, '') // hyperlink markers (the text stays)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78NOc]/g, '')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, '')
    .replace(/\r/g, '');
}

/** The sign-in address in the output: from a terminal hyperlink when there is one, else from the text. */
export function findSigninUrl(raw) {
  const candidates = [];
  for (const m of String(raw).matchAll(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b\s]+)(\x07|\x1b\\)/g)) candidates.push(m[1]);
  // Text fallback: lines may be wrapped; join the lines that continue a URL.
  const text = plainText(raw);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    // A long line that ends in a URL, followed by a line that is only URL characters: one wrapped URL.
    while (i < lines.length - 1 && /https:\/\/\S{20,}$/.test(lines[i]) && lines[i].length >= 40 && /^[A-Za-z0-9%&=._~:/?#[\]@!$'()*+,;-]+$/.test(lines[i + 1])) {
      lines[i] += lines[i + 1];
      lines.splice(i + 1, 1);
    }
  }
  const joined = lines.join('\n');
  for (const m of joined.matchAll(/https:\/\/[^\s"'<>]+/g)) candidates.push(m[0]);
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.protocol === 'https:' && SIGNIN_HOSTS.test(u.hostname) && /oauth\/authorize/.test(u.pathname)) return u.toString();
    } catch {
      /* not a URL */
    }
  }
  return null;
}

export const findToken = (raw) => {
  const m = TOKEN_RE.exec(plainText(raw).replace(/\s+/g, (w) => (w.includes('\n') ? '\n' : ' ')));
  return m ? m[0] : null;
};

/** An error line Claude Code shows after a bad code. */
export function findSigninError(raw) {
  const t = plainText(raw);
  const m = /(Invalid code[^\n]*|OAuth error[^\n]*|[^\n]*(?:failed|error)[^\n]*)/i.exec(t);
  return m ? scrub(m[1].trim()) : null;
}

/** The environment for `claude setup-token`: no account's credentials, no browser to open on the PC. */
export function signinEnv(base = process.env) {
  const env = { ...base, TERM: 'xterm-256color' };
  for (const k of [...AUTH_VARS, 'CLAUDE_CODE_OAUTH_TOKEN', 'HOPRIG_PROFILE']) delete env[k];
  for (const k of Object.keys(env)) if (/^ANTHROPIC_/.test(k)) delete env[k];
  env.BROWSER = process.platform === 'win32' ? 'cmd /c rem' : fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : 'true';
  return env;
}

class SigninFlow {
  constructor({ bin, name, label, mode = 'add', spawn = ptySpawn, times = {} }) {
    Object.assign(this, { name, label, mode });
    this.times = { link: LINK_WAIT_MS, token: TOKEN_WAIT_MS, ttl: FLOW_TTL_MS, ...times };
    this.state = 'starting';
    this.out = '';
    this.url = null;
    this.error = null;
    this.waiters = [];
    // Its own Claude folder, so nothing of the PC's Claude Code setup is read or changed; removed afterwards.
    this.cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
    const env = { ...signinEnv(), CLAUDE_CONFIG_DIR: this.cfgDir };
    // Wide, so the link is not wrapped; Ink draws every line in full.
    this.term = spawn(bin, ['setup-token'], { name: 'xterm-256color', cols: 1000, rows: 50, cwd: os.homedir(), env });
    this.term.onData((d) => {
      if (this.out.length < 1 << 20) this.out += d;
      this.#wake();
    });
    this.term.onExit(() => {
      this.exited = true;
      this.#wake();
    });
    this.timer = setTimeout(() => this.close('The sign-in took longer than 10 minutes and was stopped. Start again.'), this.times.ttl);
    this.timer.unref?.();
  }

  #wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves when `test()` returns something truthy, the process ends, or `ms` pass. */
  waitFor(test, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const check = () => {
        const v = test();
        if (v || this.exited || this.state === 'closed' || Date.now() >= end) return resolve(v || null);
        this.waiters.push(check);
        setTimeout(check, Math.max(0, Math.min(1000, end - Date.now()))).unref?.();
      };
      check();
    });
  }

  async link() {
    const url = await this.waitFor(() => findSigninUrl(this.out), this.times.link);
    if (!url) {
      const why = this.exited ? findSigninError(this.out) || 'Claude Code stopped before showing a sign-in link' : 'Claude Code showed no sign-in link';
      this.close(why);
      throw fail(502, `${why}. Use the terminal instead.`);
    }
    this.url = url;
    this.state = 'link';
    return url;
  }

  async code(code) {
    if (this.state !== 'link') throw fail(409, 'There is no sign-in waiting for a code. Start again.');
    this.state = 'checking';
    const mark = this.out.length;
    this.term.write(code);
    await new Promise((r) => setTimeout(r, 300));
    this.term.write('\r');
    const after = () => this.out.slice(mark);
    const token = await this.waitFor(() => findToken(after()) || (/Invalid code/i.test(plainText(after())) ? 'bad' : null), this.times.token);
    if (token && token !== 'bad') return token;
    const why = (token === 'bad' && 'The code was not accepted. Copy the whole code (it contains a #) and try again with a new link.') || findSigninError(after()) || 'No token came back within a minute.';
    this.close(why);
    throw fail(400, why);
  }

  close(error = null) {
    if (this.state === 'closed') return;
    if (error) this.error = error;
    this.state = 'closed';
    clearTimeout(this.timer);
    try {
      this.term.kill();
    } catch {
      /* already gone */
    }
    fs.rmSync(this.cfgDir, { recursive: true, force: true });
    this.out = ''; // nothing of the session stays in memory
    this.#wake();
  }
}

// ---------- the feature ----------

/** opts: { fetch, spawn, autoswitch, trouteai, now, times: { link, token, ttl } } — stand-ins for tests. */
export function accountsFeature(ctx, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const auto = opts.autoswitch || autoswitchModule;
  const addon = () => opts.trouteai || findAddon('trouteai');
  const now = opts.now || Date.now;
  const probes = new Map(); // id → { baseUrl, key, auth, models, at, account }
  let flow = null;
  let lastFlowError = null;

  // Probes and tests reach out with a key: at most 30 per 10 minutes per address.
  const hits = new Map();
  function limit(req) {
    const ip = ctx.clientIp(req);
    const t = now();
    const list = (hits.get(ip) || []).filter((x) => t - x < 10 * 60_000);
    if (list.length >= 30) throw fail(429, 'Too many checks in a short time. Wait a few minutes.');
    list.push(t);
    hits.set(ip, list);
  }

  const probeOf = (id) => {
    const p = typeof id === 'string' ? probes.get(id) : null;
    if (!p || now() - p.at > PROBE_TTL_MS) throw fail(400, 'This check has expired; enter the key again.');
    return p;
  };

  /** Where an account's key is and what it is pinned to — server side only. */
  function stored(profile) {
    const env = profile.env || {};
    const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    return {
      baseUrl: env.ANTHROPIC_BASE_URL ? cleanBaseUrl(env.ANTHROPIC_BASE_URL) : ANTHROPIC_URL,
      key,
      auth: env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : env.ANTHROPIC_API_KEY ? 'x' : null,
      model: env.ANTHROPIC_MODEL || (/^\*=(.+)$/.exec(profile.models || '') || [])[1] || '',
      smallModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
    };
  }

  function envFor({ baseUrl, key, auth, model, smallModel }, keep = {}) {
    const env = { ...keep };
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
    if (baseUrl !== ANTHROPIC_URL) env.ANTHROPIC_BASE_URL = baseUrl;
    env[auth === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
    if (model) env.ANTHROPIC_MODEL = model;
    if (smallModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
    return env;
  }

  const accountOr404 = (m) => {
    const name = decodeURIComponent(m[1]);
    const p = validName(name) ? readProfile(name) : null;
    if (!p) throw fail(404, 'There is no such provider');
    return p;
  };

  /**
   * The existing provider a "sign in again" is for: it must exist and be one that signs in. An API key is not a
   * sign-in (it is changed where the key was entered). The full profile, for the server only.
   */
  function signinProvider(rawName) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw fail(400, 'Say which provider to sign in again: { mode: "signin", name }');
    if (!validName(name)) throw fail(400, `"${name.slice(0, 40)}" is not a provider's short name`);
    const prof = readProfile(name);
    if (!prof) throw fail(404, `There is no provider called "${name}"`);
    if (prof.kind === 'api') throw fail(409, `"${name}" uses an API key, not a sign-in: there is nothing to sign in to`);
    return prof;
  }

  function signinState() {
    if (flow && flow.state !== 'closed') return { state: flow.state, url: flow.url, name: flow.name, label: flow.label, mode: flow.mode };
    const error = (flow && flow.error) || lastFlowError;
    return error ? { state: 'error', error } : { state: 'none' };
  }

  async function list() {
    const st = await ctx.state();
    const order = auto.getAutoSwitch().order || [];
    return listProfiles().map((p) => {
      const s = st.profiles.find((x) => x.name === p.name) || {};
      const k = stored(p);
      let host = '';
      try {
        host = p.kind === 'api' ? new URL(k.baseUrl).host : '';
      } catch {
        /* bad address in the file */
      }
      return {
        name: p.name, label: p.label, kind: p.kind, host, model: p.kind === 'api' ? k.model : '', smallModel: p.kind === 'api' ? k.smallModel : '',
        viaTrouteai: Boolean(p.prerun && /addons start trouteai/.test(p.prerun)),
        limited: s.limited || null, usage: s.usage || null, inUse: s.inUse || 0, inAuto: order.includes(p.name),
        // providers that sign in: is the sign-in there, its plan, and whether that plan reports usage at all
        ...('signedIn' in s ? { signedIn: s.signedIn, plan: s.plan ?? null, usageReported: s.usageReported ?? null } : {}),
      };
    });
  }

  const routes = [
    ['GET', /^\/api\/accounts$/, async () => {
      let tr = null;
      try {
        const a = addon();
        if (a) tr = { ...(await a.status()), baseUrl: a.profile().env.ANTHROPIC_BASE_URL };
      } catch {
        tr = null;
      }
      return {
        accounts: await list(),
        defaults: {
          subscription: { name: freeName('sub', { bare: false }), label: '' },
          api: { name: freeName('claude-api'), label: 'Claude API', baseUrl: ANTHROPIC_URL },
          trouteai: { name: freeName('api'), label: 'API via TRouteAI', baseUrl: tr ? tr.baseUrl : 'http://localhost:20017' },
        },
        trouteai: tr,
        signin: signinState(),
      };
    }],
    ['POST', /^\/api\/accounts\/probe$/, async (req) => {
      const b = await ctx.readJson(req);
      limit(req);
      let baseUrl;
      let key;
      let account = null;
      if (b.account !== undefined) {
        const p = validName(b.account) ? readProfile(b.account) : null;
        if (!p || p.kind !== 'api') throw fail(404, 'There is no such API provider');
        ({ baseUrl, key } = stored(p));
        if (!key) throw fail(400, 'This provider has no key stored');
        account = p.name;
      } else {
        baseUrl = cleanBaseUrl(b.baseUrl);
        key = cleanKey(b.key);
      }
      let prefer = 'x';
      if (account) prefer = stored(readProfile(account)).auth || 'x'; // the header the account already uses first
      const r = await listModels(fetchImpl, baseUrl, key, prefer);
      const id = crypto.randomBytes(12).toString('base64url');
      for (const [k, v] of probes) if (now() - v.at > PROBE_TTL_MS) probes.delete(k);
      probes.set(id, { baseUrl, key, auth: r.auth, at: now(), account });
      return { probe: id, auth: r.auth === 'bearer' ? 'Authorization: Bearer' : r.auth === 'x' ? 'x-api-key' : null, models: r.models, note: r.note, baseUrl };
    }],
    ['POST', /^\/api\/accounts\/test$/, async (req) => {
      const b = await ctx.readJson(req);
      limit(req);
      const p = probeOf(b.probe);
      const model = cleanModel(b.model);
      const r = await testModel(fetchImpl, p.baseUrl, p.key, p.auth, model);
      if (r.ok) p.auth = r.auth;
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }],
    ['POST', /^\/api\/accounts\/save$/, async (req) => {
      const b = await ctx.readJson(req);
      const p = probeOf(b.probe);
      if (p.account) throw fail(400, 'Use "Change model" for a provider that exists');
      const via = b.via === 'trouteai' ? 'trouteai' : 'api';
      const name = cleanNewName(b.name, via === 'trouteai' ? freeName('api') : freeName('claude-api'));
      const label = cleanLabel(b.label, via === 'trouteai' ? 'API via TRouteAI' : 'Claude API');
      const model = cleanModel(b.model, { optional: true });
      const smallModel = cleanModel(b.smallModel, { optional: true });
      const prerun = via === 'trouteai' ? addon().profile().prerun : '';
      writeProfile(name, { label, prerun, models: model ? `*=${model}` : '', env: envFor({ ...p, auth: p.auth || 'x', model, smallModel }) });
      probes.delete(b.probe);
      return { ok: true, name };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/model$/, async (req, m) => {
      const prof = accountOr404(m);
      const b = await ctx.readJson(req);
      const p = probeOf(b.probe);
      if (p.account !== prof.name) throw fail(400, 'That check belongs to another provider');
      const model = cleanModel(b.model);
      const smallModel = cleanModel(b.smallModel, { optional: true });
      writeProfile(prof.name, { label: prof.label, prerun: prof.prerun, models: `*=${model}`, env: envFor({ ...p, auth: p.auth || stored(prof).auth || 'x', model, smallModel }, prof.env) });
      return { ok: true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/label$/, async (req, m) => {
      const prof = accountOr404(m);
      const b = await ctx.readJson(req);
      writeProfile(prof.name, { label: cleanLabel(b.label, prof.label), prerun: prof.prerun, models: prof.models, env: prof.env });
      return { ok: true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/auto$/, async (req, m) => {
      const prof = accountOr404(m);
      const b = await ctx.readJson(req);
      const order = (auto.getAutoSwitch().order || []).filter((n) => n !== prof.name);
      if (b.on === true) order.push(prof.name);
      auto.setAutoSwitch({ order });
      return { ok: true, order };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/delete$/, async (req, m) => {
      const prof = accountOr404(m);
      await ctx.readJson(req);
      deleteProfile(prof.name);
      try {
        const a = auto.getAutoSwitch();
        if ((a.order || []).includes(prof.name)) auto.setAutoSwitch({ order: a.order.filter((n) => n !== prof.name) });
        auto.clearLimited(prof.name);
      } catch {
        /* nothing recorded */
      }
      return { ok: true };
    }],
    // ---- Claude subscription ----
    ['GET', /^\/api\/accounts\/subscription$/, async () => signinState()],
    ['POST', /^\/api\/accounts\/subscription\/start$/, async (req) => {
      const b = await ctx.readJson(req);
      const mode = b.mode === undefined || b.mode === null || b.mode === '' ? 'add' : b.mode;
      if (mode !== 'add' && mode !== 'signin') throw fail(400, 'mode must be "add" (a new provider) or "signin" (sign in again for an existing one)');
      if (flow && flow.state !== 'closed') throw fail(409, 'A sign-in is already in progress. Finish or cancel it first.');
      let name;
      let label;
      if (mode === 'signin') {
        // Sign in again: for a provider that exists and signs in. Its file is read again when the new sign-in is
        // there (below), so nothing is decided here that could be stale by then.
        const prof = signinProvider(b.name);
        ({ name, label } = prof);
      } else {
        name = cleanNewName(b.name, freeName('sub', { bare: false }));
        const n = /(\d+)$/.exec(name);
        label = cleanLabel(b.label, `Claude subscription${n ? ` ${n[1]}` : ''}`);
      }
      lastFlowError = null;
      const bin = ctx.config().claudeBin || 'claude';
      try {
        flow = new SigninFlow({ bin, name, label, mode, spawn: opts.spawn, times: opts.times });
      } catch (e) {
        throw fail(500, `Claude Code could not be started (${scrub(e.message)}). Use the terminal instead.`);
      }
      const f = flow;
      try {
        const url = await f.link();
        return { state: 'link', url, name, label, mode };
      } catch (e) {
        lastFlowError = f.error;
        flow = null;
        throw e;
      }
    }],
    ['POST', /^\/api\/accounts\/subscription\/code$/, async (req) => {
      const b = await ctx.readJson(req);
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      if (!/^[A-Za-z0-9_\-#.~]{10,512}$/.test(code)) throw fail(400, 'Paste the whole code shown after you signed in (letters, digits and a #)');
      if (!flow || flow.state !== 'link') throw fail(409, 'There is no sign-in waiting for a code. Start again.');
      const f = flow;
      let token;
      try {
        token = await f.code(code);
      } catch (e) {
        lastFlowError = f.error;
        flow = null;
        throw e;
      }
      let label = f.label;
      try {
        if (f.mode === 'signin') {
          // The provider as it is now: everything of it stays (label, PRERUN, MODELS, its other variables), only
          // the sign-in is replaced, in one atomic write. Up to here its file was never touched.
          const prof = signinProvider(f.name);
          label = prof.label;
          writeProfile(prof.name, { label: prof.label, prerun: prof.prerun, models: prof.models, env: { ...prof.env, CLAUDE_CODE_OAUTH_TOKEN: token } });
        } else {
          if (readProfile(f.name)) throw fail(409, `There is already a provider called "${f.name}"`);
          writeProfile(f.name, { label: f.label, env: { CLAUDE_CODE_OAUTH_TOKEN: token } });
        }
      } finally {
        token = null;
        f.close();
        flow = null;
      }
      return { state: 'done', name: f.name, label, mode: f.mode };
    }],
    ['POST', /^\/api\/accounts\/subscription\/cancel$/, async (req) => {
      await ctx.readJson(req);
      if (flow) flow.close('Cancelled');
      flow = null;
      lastFlowError = null;
      return { ok: true };
    }],
  ];

  return {
    name: 'accounts',
    routes,
    close() {
      if (flow) flow.close();
      flow = null;
      probes.clear();
    },
    // for tests
    _flow: () => flow,
  };
}
