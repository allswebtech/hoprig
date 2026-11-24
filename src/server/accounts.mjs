// Providers in the dashboard (Providers → Add provider), as a server feature: { name, routes, close }.
// Three ways to add an account, none of which needs a terminal:
//
//   Claude subscription   the server runs `claude setup-token` in a terminal it holds, shows the sign-in link to the
//                         page, types the one-time code the owner pastes back, reads the long-lived token from the
//                         output and saves it as CLAUDE_CODE_OAUTH_TOKEN. The token never reaches the browser or a log.
//   Anthropic-compatible  base URL + key: the server lists the endpoint's models (x-api-key or Bearer, whichever it
//                         accepts), tests one tiny request, and saves the profile.
//   Other providers       through a gateway add-on on this computer (src/addons/gateways.mjs: it translates OpenAI,
//                         Gemini, … to Claude's API): the same as above with its address prefilled and PRERUN set so
//                         the gateway starts on demand. With more than one gateway, the page asks which.
//   OpenAI-compatible     base URL + key for OpenAI's API (or a service that speaks it), for OpenCode (and Codex): the
//                         same steps, tested with the Responses API and chat completions; saved as OPENAI_API_KEY.
//   Codex sign-in         the ChatGPT account Codex keeps itself (`codex login`): a provider file that says so
//                         (SIGNIN=codex), no key. For Codex only. Offered only while Codex is (src/codetools/offered.mjs);
//                         until then such a file is listed with `unusable: true` and is not used.
// A provider that serves none of the offered coding tools (that sign-in, or a key that answers only Codex's API) is
// listed with `unusable: true` (as profiles.mjs publicProfile says it in /api/state).
//
// Which coding tools a provider serves is profiles.mjs servesTools; "Test" on a provider asks the endpoint which API
// shapes it answers (probeShapes) and saves them as its API= line.
//
// Routes (behind the login; cookie only — another dashboard's bearer token may not reach them):
//   GET  /api/accounts                         accounts with kind, state, usage, model, Auto membership (viaGateway:
//                                              { id, title } of the gateway its PRERUN starts, or null; gatewayGone:
//                                              { id, notLoaded? } when that gateway is not there any more, with why
//                                              config.json's definition of it was not loaded, if it has one); defaults; the
//                                              gateways on this computer: [{ id, title, words, page, installable,
//                                              installed, version, running, url, defaults: { name, label, baseUrl } }]
//   POST /api/accounts/probe                   { baseUrl, key } or { account }: models + which header works → { probe,
//                                              auth, models|null, note }. The key stays on the server under `probe`.
//   POST /api/accounts/test                    { probe, model } → { ok, error? }   one request, max_tokens 1
//   POST /api/accounts/probe                   … with via: "openai" for an OpenAI-compatible key (Bearer first)
//   POST /api/accounts/save                    { probe, name, label, model?, smallModel?, via: "api"|"openai"|<gateway id> }
//   POST /api/accounts/<name>/test             {} the API shapes the provider answers, saved as API= → { ok, shapes, tools, error? }
//   POST /api/accounts/codex-signin            { name?, label? } a provider for the sign-in Codex keeps itself (404
//                                              while Codex is not offered)
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
import { gatewayAddons, gatewayOfPrerun, goneGatewayOf, notLoadedReason } from '../addons/gateways.mjs';
import { codexSignedIn } from '../codetools/codexsignin.mjs';
import { findTool } from '../codetools/index.mjs';
import { MODEL_RE, listModels, probeShapes, scrub, shapesAfterTest, testModel } from './endpoint.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { billedLogin } from '../routerstate.mjs';
import { lastBackup, ownEndpoint, ownEndpointWords, ownGatewaySecret, removeOwnEndpoint, restoreBackup } from '../codetools/ownsettings.mjs';
import { firstCheck } from '../providers/check.mjs';
import { deleteProfile, knownShapes, listProfiles, metaOf, ownFolder, readProfile, servesTools, validName, writeProfile } from '../profiles.mjs';

export const ANTHROPIC_URL = 'https://api.anthropic.com';
export const OPENAI_URL = 'https://api.openai.com';
// Older importers (claudelogin.mjs, tests) find these here too.
export { explain, listModels, passing, probeShapes, scrub, shapesAfterTest, testModel } from './endpoint.mjs';

const KEYED = ['api', 'openai']; // the kinds with an endpoint and a key
const PROBE_TTL_MS = 15 * 60_000;
const FLOW_TTL_MS = 10 * 60_000;
const LINK_WAIT_MS = 45_000;
const TOKEN_WAIT_MS = 60_000;
const KEY_RE = /^[\x21-\x7e]{8,500}$/; // printable ASCII, no spaces
const TOKEN_RE = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
const SIGNIN_HOSTS = /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

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

/** The environment for `claude setup-token`: no secret (../secretenv.mjs), no provider, no browser to open on the PC. */
export function signinEnv(base = process.env) {
  const env = { ...withoutSecrets(base), TERM: 'xterm-256color' };
  delete env.HOPRIG_PROFILE;
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

/** A provider's `via<Gateway>: true|false` under the old names an older page reads (gateways.mjs SHIPPED oldNames). */
const oldVia = (gws, used) => Object.fromEntries(gws.filter((g) => g.oldNames).map((g) => [g.oldNames.via, used === g]));

/** opts: { fetch, spawn, autoswitch, gateways (the gateway add-ons), now, times: { link, token, ttl } } — stand-ins for tests. */
export function accountsFeature(ctx, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const auto = opts.autoswitch || autoswitchModule;
  const gateways = () => opts.gateways || gatewayAddons();
  const gatewayOf = (id) => (typeof id === 'string' && gateways().find((g) => g.id === id)) || null;
  const now = opts.now || Date.now;
  // Codex's own sign-in is a provider kind only while Codex is offered (src/codetools/offered.mjs). `opts.findTool`:
  // tests of the kept Codex parts pass one that knows every built tool.
  const tool = opts.findTool || findTool;
  const codexOffered = () => !!tool('codex');
  const offered = (ids) => ids.filter((id) => tool(id));
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
    if (profile.kind === 'openai') {
      return { baseUrl: env.OPENAI_BASE_URL ? cleanBaseUrl(env.OPENAI_BASE_URL) : OPENAI_URL, key: env.OPENAI_API_KEY || '', auth: 'bearer', model: (/^\*=(.+)$/.exec(profile.models || '') || [])[1] || '', smallModel: '' };
    }
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

  function ownInfo() {
    const o = ownEndpoint();
    return o ? { words: ownEndpointWords(o), where: o.where, local: o.local, file: o.file, lines: o.lines, stamp: o.stamp, hasKey: o.hasKey } : null;
  }

  /** Only the owner, on this dashboard's own page, may change a file of the coding tool's. */
  function ownerPress(req) {
    if (ctx.caller && ctx.caller(req) !== 'page') throw fail(403, "Only you, on this computer's own dashboard page, may change the coding tool's settings file");
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
    if (KEYED.includes(prof.kind)) throw fail(409, `"${name}" uses an API key, not a sign-in: there is nothing to sign in to`);
    if (prof.kind === 'chatgpt') {
      throw fail(409, codexOffered() ? `"${name}" is Codex's own sign-in: Sign in on its page, or hoprig codex login in a terminal` : `"${name}" is a sign-in this version of Hoprig cannot use`);
    }
    return prof;
  }

  function signinState() {
    if (flow && flow.state !== 'closed') return { state: flow.state, url: flow.url, name: flow.name, label: flow.label, mode: flow.mode };
    const error = (flow && flow.error) || lastFlowError;
    return error ? { state: 'error', error } : { state: 'none' };
  }

  async function list() {
    // Providers that use another computer's gateway: whether that computer answers (src/gateway).
    const remote = opts.remote ? await opts.remote().catch(() => new Map()) : new Map();
    const st = await ctx.state();
    const order = auto.getAutoSwitch().order || [];
    const gws = gateways();
    // A Codex sign-in: whether Codex is signed in on this computer (null: Codex is not installed or does not say).
    const all = listProfiles();
    const codexIn = codexOffered() && all.some((p) => p.kind === 'chatgpt') ? await (opts.codexSignedIn || codexSignedIn)().catch(() => null) : null;
    return all.map((p) => {
      const s = st.profiles.find((x) => x.name === p.name) || {};
      const k = stored(p);
      const tools = offered(servesTools(p));
      let host = '';
      try {
        host = KEYED.includes(p.kind) ? new URL(k.baseUrl).host : '';
      } catch {
        /* bad address in the file */
      }
      return {
        name: p.name, label: p.label, kind: p.kind, paid: p.paid === true || billedLogin(p), host, model: KEYED.includes(p.kind) ? k.model : '', smallModel: p.kind === 'api' ? k.smallModel : '',
        tools, api: p.api || [], ...(tools.length ? {} : { unusable: true }), ...(ownFolder(p) ? { ownFolder: true } : {}),
        viaGateway: ((g) => (g ? { id: g.id, title: g.title } : null))(gatewayOfPrerun(p.prerun, gws)),
        ...oldVia(gws, gatewayOfPrerun(p.prerun, gws)),
        // Its PRERUN starts a gateway that is not there any more: every session on it would end at the start.
        // notLoaded: config.json still holds it, but it was not loaded, and why (Settings → Add-ons says the same).
        ...((id) => (id ? { gatewayGone: { id, ...((why) => (why ? { notLoaded: why } : {}))(notLoadedReason(id)) } } : {}))(goneGatewayOf(p.prerun, gws)),
        remote: remote.has(p.name) ? (({ computer, title, state, text }) => ({ computer, title: title || null, state, text }))(remote.get(p.name)) : null,
        limited: s.limited || null, usage: s.usage || null, inUse: s.inUse || 0, inAuto: order.includes(p.name),
        // providers that sign in: is the sign-in there, its plan, and whether that plan reports usage at all
        ...('signedIn' in s ? { signedIn: s.signedIn, plan: s.plan ?? null, usageReported: s.usageReported ?? null } : {}),
        // Codex's own sign-in, while Codex is offered (else the file is from a version that offered it: `unusable`).
        ...(p.kind === 'chatgpt' && tools.length ? { signedIn: codexIn } : {}),
      };
    });
  }

  const routes = [
    ['GET', /^\/api\/accounts$/, async () => {
      // The gateways on this computer, for "Other providers": what each says on the page, its state and its defaults.
      const gws = (await Promise.all(gateways().map(async (g) => {
        try {
          const p = g.profile();
          return {
            id: g.id, title: g.title, words: g.words, page: g.page ? g.page() : null, installable: g.installable !== false,
            ...(await g.status()), defaults: { name: freeName(p.name), label: p.label, baseUrl: p.env.ANTHROPIC_BASE_URL },
          };
        } catch {
          return null;
        }
      }))).filter(Boolean);
      // The same, under the old names an open page of an older version reads (gateways.mjs SHIPPED oldNames).
      const old = {};
      const oldDefaults = {};
      for (const g of gateways().filter((x) => x.oldNames)) {
        const e = gws.find((x) => x.id === g.id);
        old[g.oldNames.state] = e ? (({ id, title, words, page, installable, defaults, ...st }) => ({ ...st, baseUrl: defaults.baseUrl }))(e) : null;
        if (e) oldDefaults[g.oldNames.state] = { ...e.defaults };
      }
      return {
        accounts: await list(),
        // Auto mode's "Also use pay-per-use providers": a provider's page says before a press what "Use in Auto mode"
        // turns on with it.
        payPerUse: auto.getAutoSwitch().payPerUse === true,
        defaults: {
          subscription: { name: freeName('sub', { bare: false }), label: '' },
          api: { name: freeName('claude-api'), label: 'Claude API', baseUrl: ANTHROPIC_URL },
          ...oldDefaults,
          openai: { name: freeName('openai'), label: 'OpenAI API', baseUrl: OPENAI_URL },
          ...(codexOffered() ? { codex: { name: freeName('chatgpt'), label: 'Codex sign-in' } } : {}),
        },
        ...old,
        gateways: gws,
        signin: signinState(),
        // An address in Claude Code's own settings file, which wins over every profile: what it is and the lines a
        // press would take out (a key's value never: ownsettings.mjs).
        ownEndpoint: ownInfo(),
        // After a press: where the copy of the file as it was is kept, so the page can show it and put it back.
        ownBackup: lastBackup(),
      };
    }],
    // The owner's press, on this dashboard's own page only (not another computer's token, not Tia): take the shown
    // lines out of Claude Code's settings file, a backup beside it first.
    ['POST', /^\/api\/accounts\/own-endpoint\/remove$/, async (req) => {
      ownerPress(req);
      const b = await ctx.readJson(req);
      const r = removeOwnEndpoint({ stamp: typeof b.stamp === 'string' ? b.stamp : '' });
      if (!r.ok) throw fail(409, r.why);
      return { ok: true, backup: r.backup, removed: r.removed };
    }],
    // The way back after a press: the backup becomes the settings file again (the file as it is now kept beside it).
    ['POST', /^\/api\/accounts\/own-endpoint\/restore$/, async (req) => {
      ownerPress(req);
      const b = await ctx.readJson(req);
      const r = restoreBackup({ name: typeof b.name === 'string' ? b.name : '', stamp: typeof b.stamp === 'string' ? b.stamp : '' });
      if (!r.ok) throw fail(409, r.why);
      return { ok: true };
    }],
    // "Take it over": that gateway becomes a provider of its own (its key read here, from that file, into a profile
    // file as every key is kept), then the lines go out of the file as above. The key is never in the answer.
    ['POST', /^\/api\/accounts\/own-endpoint\/takeover$/, async (req) => {
      ownerPress(req);
      const b = await ctx.readJson(req);
      const o = ownEndpoint();
      if (!o || o.stamp !== b.stamp) throw fail(409, 'The settings file changed since it was shown. Look at it again, then press once more.');
      const sec = ownGatewaySecret();
      if (!sec) throw fail(400, 'The settings file has an address but no key for it: add that gateway with "Add provider" instead.');
      let baseUrl;
      try {
        baseUrl = cleanBaseUrl(sec.baseUrl);
      } catch {
        throw fail(400, 'The address in the settings file is not one a provider can use.');
      }
      const name = cleanNewName(b.name, freeName('gateway'));
      const label = cleanLabel(b.label, 'Gateway on this computer');
      const model = (v) => (MODEL_RE.test(v) ? v : '');
      writeProfile(name, { label, env: envFor({ baseUrl, key: sec.key, auth: sec.auth, model: model(sec.model), smallModel: model(sec.smallModel) }) });
      const r = removeOwnEndpoint({ stamp: o.stamp });
      if (!r.ok) {
        deleteProfile(name); // all or nothing: the file still decides, so the new provider would only mislead
        throw fail(409, r.why);
      }
      return { ok: true, name, backup: r.backup, removed: r.removed };
    }],
    ['POST', /^\/api\/accounts\/probe$/, async (req) => {
      const b = await ctx.readJson(req);
      limit(req);
      let baseUrl;
      let key;
      let account = null;
      if (b.account !== undefined) {
        const p = validName(b.account) ? readProfile(b.account) : null;
        if (!p || !KEYED.includes(p.kind)) throw fail(404, 'There is no such API provider');
        ({ baseUrl, key } = stored(p));
        if (!key) throw fail(400, 'This provider has no key stored');
        account = p.name;
      } else {
        baseUrl = cleanBaseUrl(b.baseUrl);
        key = cleanKey(b.key);
      }
      const openai = account ? readProfile(account).kind === 'openai' : b.via === 'openai';
      let prefer = openai ? 'bearer' : 'x';
      if (account) prefer = stored(readProfile(account)).auth || prefer; // the header the account already uses first
      const r = await listModels(fetchImpl, baseUrl, key, prefer);
      const id = crypto.randomBytes(12).toString('base64url');
      for (const [k, v] of probes) if (now() - v.at > PROBE_TTL_MS) probes.delete(k);
      probes.set(id, { baseUrl, key, auth: r.auth, at: now(), account, openai });
      return { probe: id, auth: r.auth === 'bearer' ? 'Authorization: Bearer' : r.auth === 'x' ? 'x-api-key' : null, models: r.models, note: r.note, baseUrl };
    }],
    ['POST', /^\/api\/accounts\/test$/, async (req) => {
      const b = await ctx.readJson(req);
      limit(req);
      const p = probeOf(b.probe);
      const model = cleanModel(b.model);
      if (p.openai) {
        // An OpenAI-compatible key: the APIs Codex and OpenCode use (Claude's is not asked for).
        const r = await probeShapes(fetchImpl, p.baseUrl, p.key, 'bearer', model, { only: ['responses', 'chat'] });
        if (r.ok) p.shapes = r.shapes;
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      }
      const r = await testModel(fetchImpl, p.baseUrl, p.key, p.auth, model);
      if (r.ok) p.auth = r.auth;
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }],
    ['POST', /^\/api\/accounts\/save$/, async (req) => {
      const b = await ctx.readJson(req);
      const p = probeOf(b.probe);
      if (p.account) throw fail(400, 'Use "Change model" for a provider that exists');
      const model = cleanModel(b.model, { optional: true });
      if (p.openai) {
        const name = cleanNewName(b.name, freeName('openai'));
        const label = cleanLabel(b.label, 'OpenAI API');
        const env = { OPENAI_API_KEY: p.key, ...(p.baseUrl !== OPENAI_URL ? { OPENAI_BASE_URL: p.baseUrl } : {}) };
        writeProfile(name, { label, models: model ? `*=${model}` : '', api: p.shapes || [], env });
        probes.delete(b.probe);
        return { ok: true, name };
      }
      // `via`: a gateway's id (0.2.6 sent the shipped one's the same way), else Claude's API itself.
      const gw = gatewayOf(b.via);
      const prof = gw ? gw.profile() : null;
      const name = cleanNewName(b.name, prof ? freeName(prof.name) : freeName('claude-api'));
      const label = cleanLabel(b.label, prof ? prof.label : 'Claude API');
      const smallModel = cleanModel(b.smallModel, { optional: true });
      const prerun = prof ? prof.prerun : '';
      const made = writeProfile(name, { label, prerun, models: model ? `*=${model}` : '', env: envFor({ ...p, auth: p.auth || 'x', model, smallModel }) });
      probes.delete(b.probe);
      // A gateway profile made here gets one round of the provider check by itself, in the background; never again
      // without the owner's press (providers/check.mjs).
      firstCheck(made, { fetchImpl, now });
      return { ok: true, name };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/model$/, async (req, m) => {
      const prof = accountOr404(m);
      const b = await ctx.readJson(req);
      const p = probeOf(b.probe);
      if (p.account !== prof.name) throw fail(400, 'That check belongs to another provider');
      const model = cleanModel(b.model);
      const smallModel = cleanModel(b.smallModel, { optional: true });
      if (prof.kind === 'openai') writeProfile(prof.name, { ...metaOf(prof), models: `*=${model}`, env: prof.env });
      else writeProfile(prof.name, { ...metaOf(prof), models: `*=${model}`, env: envFor({ ...p, auth: p.auth || stored(prof).auth || 'x', model, smallModel }, prof.env) });
      return { ok: true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/label$/, async (req, m) => {
      const prof = accountOr404(m);
      const b = await ctx.readJson(req);
      writeProfile(prof.name, { ...metaOf(prof), label: cleanLabel(b.label, prof.label), env: prof.env });
      return { ok: true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/test$/, async (req, m) => {
      // "Test": which API shapes the provider answers, saved as its API= line (servesTools reads it).
      const prof = accountOr404(m);
      await ctx.readJson(req);
      if (!KEYED.includes(prof.kind)) throw fail(409, `"${prof.label}" signs in: there is no API address to test`);
      limit(req);
      const k = stored(prof);
      if (!k.key) throw fail(400, 'This provider has no key stored');
      let model = k.model;
      if (!model) {
        const l = await listModels(fetchImpl, k.baseUrl, k.key, k.auth || 'bearer');
        model = (l.models || [])[0]?.id || '';
      }
      if (!model) throw fail(400, 'Pick the model this provider uses first (Change model)');
      const r = await probeShapes(fetchImpl, k.baseUrl, k.key, k.auth || 'x', model);
      if (!r.ok) return { ok: false, shapes: r.shapes, unsure: r.unsure, tools: offered(servesTools(prof)), error: r.error };
      const now = readProfile(prof.name);
      const api = shapesAfterTest(knownShapes(now), r);
      writeProfile(prof.name, { ...metaOf(now), api, env: now.env });
      const kept = api.filter((x) => !r.shapes.includes(x));
      return { ok: true, shapes: api, kept, tools: offered(servesTools(readProfile(prof.name))) };
    }],
    ['POST', /^\/api\/accounts\/codex-signin$/, async (req) => {
      // The ChatGPT account Codex keeps itself: no key here; Codex signs in with `codex login` in a terminal.
      if (!codexOffered()) throw fail(404, 'Codex is not part of this version of Hoprig.');
      const b = await ctx.readJson(req);
      const name = cleanNewName(b.name, freeName('chatgpt'));
      const label = cleanLabel(b.label, 'Codex sign-in');
      writeProfile(name, { label, signin: 'codex' });
      return { ok: true, name };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/auto$/, async (req, m) => {
      const prof = accountOr404(m);
      const b = await ctx.readJson(req);
      const before = auto.getAutoSwitch();
      const order = (before.order || []).filter((n) => n !== prof.name);
      if (b.on === true) order.push(prof.name);
      const after = auto.setAutoSwitch({ order });
      // A provider billed by use new to the order turns "Also use pay-per-use providers" on (autoswitch.mjs): the page
      // says so in its toast, as its switch's help said before the press.
      return { ok: true, order, payPerUse: after.payPerUse === true, payPerUseTurnedOn: before.payPerUse !== true && after.payPerUse === true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/delete$/, async (req, m) => {
      const prof = accountOr404(m);
      await ctx.readJson(req);
      if (opts.removing) await opts.removing(prof); // another computer's gateway: its key there is given up
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
          writeProfile(prof.name, { ...metaOf(prof), env: { ...prof.env, CLAUDE_CODE_OAUTH_TOKEN: token } });
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
