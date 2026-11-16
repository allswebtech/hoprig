// The dashboard's HTTP + WebSocket server.
//
// config.json keys under "server" (all optional except passwordHash, which the passwd command writes):
//   host            address to listen on                    default "127.0.0.1" (only this machine)
//   port            port                                    default 7433
//   passwordHash    scrypt hash of the dashboard password    set by the passwd command
//   roots           folders the folder picker may show       default [your home directory]
//   reach           "home": those folders; "everything": the whole disk, for sessions, the editor and Files
//                   (Hoprig's own folders and sign-in files stay locked)   default "home"
//   backend         "auto" | "tmux" | "pty"                  default "auto"
//   tmuxSocket      tmux -L socket name                      default "" = your normal tmux server (tmux attach works)
//   trustProxy      true behind a reverse proxy: believe X-Forwarded-Proto/-Host/-For   default false
//                   (-For only from a proxy on this computer: see clientIp in security.mjs)
//   allowedOrigins  extra origins allowed to send requests   default []  (e.g. ["https://deck.example.net"])
//   uploadsDir      folder, inside the session's folder, that uploaded files go to   default ".uploads"
//   uploadMaxMB     largest upload                           default 25
//   quickActions    chips in the session view that type a message: [{ label, text }]   default: see settings.mjs
//   notify          push notifications from the server (see notify.mjs)                default: none
//   publicUrl       the page's address from outside, for links in notifications        default: none
//   machineLabel    this computer's name next to the other computers (src/machines)  default: its host name
//
// Auto-switch settings live under the top-level key "autoSwitch" (src/autoswitch.mjs).
//
// Everything except the login page and its assets needs a valid session, the WebSocket included. Requests that
// change something must come from this site (Origin check) and carry JSON (uploads: raw bytes). The one exception:
// another dashboard that controls this one sends a bearer token instead (src/machines; see handle()).
//
// Features (plug-ins) are registered in ONE list, `features`, at the top of createServer(). Each is built from `ctx`
// (deck, backend, config, saveConfig, state, poke, authed, originOk, clientIp, onTick, notify, readJson, HttpError,
// dispatch: the owner's own request run in-process through the same handling, for Tia's tools) and
// returns { name, routes?, handle?, upgrade?, trusted?, start?, close? }:
//   handle(req, res) / upgrade(req, socket, head)  called first, in order; true = answered, false = go on
//   trusted(req)        true when the feature authenticated the request itself (no cookie, no Origin check)
//   routes              [method, regex, handler(req, match, query, res)], behind the login, merged with the core ones
//   start(ctx)          after the server listens;  close()  when it stops
// A new feature is one file plus one line in that list.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { WebSocketServer } from 'ws';
import * as autoswitchModule from '../autoswitch.mjs';
import { EFFORTS, MODELS, PERMISSION_MODES, cleanSessionDefaults, loadConfig, saveConfig } from '../config.mjs';
import { stateDir, tilde } from '../paths.mjs';
import { deleteProfile, listProfiles, publicProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { sessionTitle, sessionsIn } from '../sessions.mjs';
import {
  COOKIE, RateLimiter, SessionStore, clearCookie, hashPassword, parseCookies, sessionCookie, sha256, verifyPassword,
} from './auth.mjs';
import { createBackend } from './backends/index.mjs';
import { Deck } from './deck.mjs';
import { browse, insideRoots, reachRoots, recentFolders, resolveRoots } from './folders.mjs';
import { detectLimit } from './limits.mjs';
import { alwaysOption, menuOpen } from './prompts.mjs';
import { killProcess, power, snapshot } from './platform.mjs';
import { machinesFeature } from '../machines/index.mjs';
import { assistantFeature } from '../assistant/feature.mjs';
import { automationFeature } from '../automation/feature.mjs';
import { addonsFeature } from '../addons/feature.mjs';
import { reachableUrl } from '../addons/reach.mjs';
import { accountsFeature } from './accounts.mjs';
import { claudeLoginFeature, sameComputer } from './claudelogin.mjs';
import { gatewayFeature } from '../gateway/index.mjs';
import { pcsetupFeature } from '../pcsetup/feature.mjs';
import { skillhubFeature } from '../skillhub/feature.mjs';
import { workspaceFeature } from '../workspace/feature.mjs';
import { editorFeature } from '../editor/feature.mjs';
import { chatFeature } from '../chat/feature.mjs';
import { onboardingFeature } from '../setup/onboarding.mjs';
import { desktopFeature } from '../desktop/feature.mjs';
import { removeDashboardFile, writeDashboardFile } from './dashboardfile.mjs';
import { createLoginLink, loginLinkStatus, qrRows, useLoginLink } from './loginlink.mjs';
import { clientIp, isHttps, originOk, requestHost, securityHeaders } from './security.mjs';
import { notePassword, passwordProblem } from './strength.mjs';
import { monacoManifest, resolveStatic, sendFile } from './static.mjs';
import { attachTerminal } from './terminal.mjs';
import { EVENTS, sendNotification } from './notify.mjs';
import { AUTO, DEFAULT_QUICK_ACTIONS, cleanServerPatch } from './settings.mjs';
import { DEFAULT_UPLOADS_DIR, DEFAULT_UPLOAD_MAX_MB, saveUpload, uploadsDirName } from './uploads.mjs';
import * as v from './validate.mjs';
import { Watcher, enrich } from './watcher.mjs';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7433;
const BODY_MAX = 64 * 1024;
const HISTORY_MAX = 5000;
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
})();

// Files a logged-out browser may load: the login page and what it needs.
const PUBLIC = new Set([
  '/login', '/login.html', '/login.js', '/brand.js', '/style.css', '/icons.js', '/manifest.webmanifest',
  '/icon.svg', '/icon-maskable.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
  '/favicon.ico', '/favicon-32.png',
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg = 'bad request') => new HttpError(400, msg);

/** An error as the page gets it: its message, plus the facts a deliberate refusal carries (e.g. a newer version). */
const errorBody = (e) => ({ ...(Number.isInteger(e.status) && e.details && typeof e.details === 'object' ? e.details : {}), error: e.message || 'server error' });

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) return reject(new HttpError(415, 'send JSON'));
    if (Number(req.headers['content-length'] || 0) > BODY_MAX) return reject(new HttpError(413, 'too large'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        reject(bad('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Build the server. `opts` override config.json (tests use them): host, port, tmuxSocket, tmuxConfigFile, backend,
 * autoswitch and claudecode (stand-ins for src/autoswitch.mjs and src/claudecode.mjs), watch (false: no watcher),
 * fetch (for notifications), autoSwitchGraceMs and watchTickMs (faster watcher for tests), machines (options for
 * src/machines: fake ssh, timeouts), dashboardFile (false: do not write <stateDir>/dashboard.json).
 * Returns { server, deck, backend, watcher, listen(), close() }.
 */
export function createServer(opts = {}) {
  const cfg = () => loadConfig();
  const first = cfg().server;
  const backend = opts.backend || createBackend({ kind: first.backend || 'auto', socket: opts.tmuxSocket ?? first.tmuxSocket ?? '', configFile: opts.tmuxConfigFile || '' });
  const deck = new Deck({ backend, config: cfg, profiles: listProfiles });
  const sessions = new SessionStore(path.join(stateDir(), 'web-sessions.json'));
  const limiter = new RateLimiter();
  const autoswitch = opts.autoswitch || autoswitchModule;
  // Loaded on first use, so the dashboard still starts if that module fails to load.
  const claudecode = async () => opts.claudecode || import('../claudecode.mjs');
  // The Computer tab's view of the system and its actions on it; the demo passes stand-ins, so it never shows or
  // touches the real computer.
  let loginTimer = null; // the half-hourly sign-in check started in listen()
  let firstLoginCheck = null; // its first run, a few seconds after start
  let closed = false;
  let signInTimer = null; // the look every 10 s at whether the stored sign-in changed (claudecode.mjs signInWatch)
  const system = { snapshot, killProcess, power, ...opts.system };
  const notifyFetch = opts.fetch || fetch;
  const watcher = new Watcher({
    cards: () => cards(),
    deck,
    auto: autoswitch,
    // Click links in a push lead to where this dashboard is reached from anywhere: the set address, else the public link's.
    settings: () => ({ notify: cfg().server.notify || null, publicUrl: reachableUrl(cfg()) || '' }),
    send: (n, ev) => sendNotification(n, ev, { fetchImpl: notifyFetch }),
    ...(opts.autoSwitchGraceMs !== undefined ? { graceMs: opts.autoSwitchGraceMs } : {}),
    ...(opts.watchTickMs !== undefined ? { tickMs: opts.watchTickMs } : {}),
  });

  const proxyOpts = () => {
    const s = cfg().server;
    return { trustProxy: s.trustProxy === true, allowed: Array.isArray(s.allowedOrigins) ? s.allowedOrigins : [] };
  };
  const roots = () => reachRoots(cfg().server);
  // The models one session may start with: the fixed aliases, plus the model saved as the default for new sessions
  // (already checked when it was saved), so the page offers exactly what Settings → New-session defaults offers.
  const sessionModels = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved && !MODELS.includes(saved) ? [...MODELS, saved] : [...MODELS];
  };
  // Sessions are tied to the current password: a new password logs every browser out at once.
  const passwordTag = () => sha256(String(cfg().server.passwordHash || '')).slice(0, 16);
  // A request the server makes to itself for the owner (ctx.dispatch, Tia's tools) carries this mark; no request
  // from the network can, so it counts as the owner's own login and its own site.
  const INTERNAL = Symbol('hoprig.internal');
  const authed = (req) => req[INTERNAL] === true || sessions.valid(parseCookies(req.headers.cookie)[COOKIE], passwordTag());
  // What a feature gets (see the header). state() and readJson are declared further down; they are called later.
  const ctx = {
    deck, backend, config: cfg, saveConfig, authed,
    state: () => state(),
    originOk: (req) => req[INTERNAL] === true || originOk(req, proxyOpts()),
    // Run `method path` with a JSON `body` through the very same handling a page request gets (features, routes,
    // validators, the relay to another computer at /m/<name>/…) on the owner's behalf. Resolves { status, json }.
    // ONLY Tia's door (src/assistant/door.mjs: an allowlist of routes) may call it — no other feature: it acts as the
    // owner on any route. A test (test/assistant/door.test.mjs) checks the source for other callers.
    dispatch: (method, url, body) => dispatch(method, url, body),
    clientIp: (req) => clientIp(req, proxyOpts()),
    onTick: (fn) => watcher.onTick(fn),
    poke: () => watcher.poke(), // look at the sessions soon (a feature just started or typed into one)
    notify: (ev) => {
      const n = cfg().server.notify;
      return n && n.url ? sendNotification(n, ev, { fetchImpl: notifyFetch }) : Promise.resolve({ sent: false });
    },
    readJson: (req) => readJson(req),
    HttpError,
  };
  // ---- the features: one line each ----
  const machines = machinesFeature(ctx, opts.machines);
  const gateway = gatewayFeature(ctx, { hub: machines.machines.hub, ...opts.gateway });
  const chat = chatFeature(ctx, opts.chat);
  const features = [
    assistantFeature(ctx, { hub: machines.machines.hub, ...opts.assistant }), // Tia; first, so her own token is checked before the machines gate
    gateway, // /gateway/…: a gateway shared with a gateway key (before the machines gate, which takes any bearer as its own)
    machines, // other computers: relay, pairing, bearer tokens
    editorFeature(ctx, opts.editor), // the code editor's files and git under /api/code/ (another computer's token too); removes VS Code Server's leftovers once
    automationFeature(ctx, { tick: opts.watch !== false, ...opts.automation }), // queue, schedules, restore, retry, updates, idle care
    addonsFeature(ctx, opts.addons), // Settings → Add-ons: install, start, stop, update, set up as an account
    accountsFeature(ctx, { remote: gateway.states, removing: gateway.forget, ...opts.accounts }), // Providers: add a subscription, an API key or a TRouteAI gateway in the page
    claudeLoginFeature(ctx, opts.claudeLogin), // Claude Code's own sign-in from the page (Setup, Get started, Providers)
    pcsetupFeature(ctx, opts.pcsetup), // PC → Setup: system status, set up this computer, projects, recipes
    skillhubFeature(ctx, opts.skillhub), // Settings → Skills: installed, suggested for a project, find, review → approve, updates
    onboardingFeature(ctx, opts.onboarding), // Home → Get started: the steps a new user goes through, done or not
    workspaceFeature(ctx, opts.workspace), // Workspace: the tree, its map, restore and sync, Git and GitHub, the AI brain (read-only)
    chat, // coding without the terminal: a Claude Code conversation as a chat (its cards are among the sessions)
    desktopFeature(ctx, opts.desktop), // the desktop's Task manager, Services and Logs: processes, usage, services, the journal and log files
  ];
  const trusted = (req) => features.some((f) => f.trusted && f.trusted(req));

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function sessionOr404(name) {
    if (!v.sessionName(name)) throw bad('bad session name');
    const found = await deck.find(name);
    if (!found) throw new HttpError(404, 'no such session');
    return found;
  }

  // src/routerstate.mjs (Auto mode's router: which account serves which session, and each account's usage).
  // Loaded on first use; without it Auto sessions simply show no "now on …".
  let routerStateP = null;
  let rsCache = null;
  const routerState = () =>
    (routerStateP ||= opts.routerstate
      ? Promise.resolve(opts.routerstate)
      : import('../routerstate.mjs').catch(() => ({ routerSessions: () => ({}), profileUsage: () => ({}) })));
  const safe = (fn) => {
    try {
      return fn() || {};
    } catch {
      return {};
    }
  };

  /** Auto mode is on: sessions may run on the virtual profile "auto" (the router picks the account). */
  const autoOn = () => autoswitch.getAutoSwitch().enabled === true;
  /** A profile name from the browser: a real profile, or "auto" while Auto mode is on. Full object or null. */
  const pickProfile = (name) => (name === AUTO.name ? (autoOn() ? { name: AUTO.name, env: {} } : null) : v.profile(name));

  const cards = async () => {
    const list = enrich(await deck.list(), listRuns());
    const rs = await routerState();
    rsCache = rs;
    const serving = safe(() => rs.routerSessions());
    const names = new Map(listProfiles().map((p) => [p.name, p.label]));
    for (const c of list) {
      if (c.kind !== 'claude' || !c.profile || c.profile.name !== AUTO.name) continue;
      c.profile = { name: AUTO.name, label: AUTO.label, kind: 'auto' };
      const now = c.sessionId && serving[c.sessionId];
      c.autoOn = now && now.profile ? { name: now.profile, label: names.get(now.profile) || now.profile, at: now.at || null } : null;
    }
    // Open chats are sessions too (kind "chat"): Home lists them, the watcher notifies about them.
    return [...list, ...chat.cards()];
  };

  /** Move a session to another profile; "auto" is not a profile file, so it is built here. */
  async function moveTo(term, run, name) {
    if (name !== AUTO.name) return deck.move(term, run, name);
    await backend.respawn(term.id, run.cwd, deck.moveArgv({ name: AUTO.name, env: {} }, run));
  }

  /**
   * Profiles as the page shows them: public fields, limit state, how many sessions use each (Auto sessions count
   * for the account serving them), usage (the router's figures first, else the newest run's). While Auto mode is
   * on, a virtual "Auto" profile comes first.
   */
  function profileStates(list) {
    const limited = autoswitch.limitedProfiles();
    const routerUsage = safe(() => (rsCache || {}).profileUsage?.());
    // Where each provider is in the order Auto mode really uses (no pay-per-use key unless allowed): the limit card
    // offers the first free one, and says where Auto would go.
    const order = autoswitch.usableOrder ? autoswitch.usableOrder() : [];
    const out = listProfiles().map((p) => {
      const mine = list.filter((c) => c.profile && (c.profile.name === p.name || (c.autoOn && c.autoOn.name === p.name)));
      const fromRun = mine.find((c) => c.usage);
      const ru = routerUsage[p.name];
      const l = limited[p.name];
      return {
        ...publicProfile(p),
        // signedIn, plan, usageReported for providers that sign in (routerstate.mjs: providerFacts; read from files).
        ...safe(() => (rsCache || {}).providerFacts?.(p)),
        limited: l
          ? { until: l.until || null, exact: l.exact !== false, reason: l.reason || '', text: String(l.text || '').slice(0, 200) }
          : ru && ru.status === 'rejected' ? { until: null, exact: false, reason: 'router', text: '' } : null,
        inUse: mine.length,
        autoPlace: order.includes(p.name) ? order.indexOf(p.name) : null,
        // `at`: when the figures were seen (they are kept after the session that showed them ended).
        usage: ru && (ru.fiveHour || ru.week) ? { fiveHour: ru.fiveHour, week: ru.week, status: ru.status, at: ru.at || null } : fromRun ? fromRun.usage : null,
      };
    });
    if (autoOn()) {
      out.unshift({ ...AUTO, kind: 'auto', virtual: true, limited: null, inUse: list.filter((c) => c.profile && c.profile.name === AUTO.name).length, usage: null });
    }
    return out;
  }

  async function state() {
    const list = await cards();
    const auto = autoswitch.getAutoSwitch();
    const profiles = profileStates(list);
    const names = new Set(profiles.map((p) => p.name));
    for (const c of list) {
      if (c.kind !== 'claude' || !c.profile) continue;
      // "Move back" is offered on a session that runs on this profile only because a preferred one hit its limit.
      const pref = c.fallback ? autoswitch.preferredAvailable(c.profile.name) : null;
      c.preferred = pref && pref !== c.profile.name && names.has(pref) ? pref : null;
      c.autoMove = watcher.pending.has(c.name) ? watcher.pending.get(c.name).to : null;
      // Since when it stands at its limit, as far as known: the page compares it with when another Claude account
      // signed in (the provider's accountAt), to offer "Continue with the new account".
      if (c.limit || c.runLimit) c.limitAt = (c.runLimit && c.runLimit.at) || watcher.seen.get(c.runId) || null;
    }
    const rec = autoswitch.recommendedProfile ? autoswitch.recommendedProfile() : null;
    // Auto mode on: "Auto" is the first choice for a new session.
    const recommended = autoOn() ? AUTO.name : (rec && names.has(rec) ? rec : null) || (profiles.find((p) => !p.limited && !p.virtual) || profiles[0] || {}).name || null;
    const qa = cfg().server.quickActions;
    return {
      sessions: list, profiles, autoSwitch: auto, recommended,
      quickActions: Array.isArray(qa) ? qa : DEFAULT_QUICK_ACTIONS,
      backend: { kind: backend.kind, capabilities: backend.capabilities || {} },
      ...(opts.demo ? { demo: true } : {}), // `hoprig demo` (src/demo): the page shows a "Demo" marker
      getStartedDismissed: cfg().server.getStartedDismissed === true, // Home → Get started was closed (settings.mjs)
      // `hoprig setup --hub` (config hubOnly): this computer only links the others; the page gives it the hub's own
      // checklist and opens the coding pages on a computer that codes.
      ...(cfg().hubOnly === true ? { hub: true } : {}),
      home: os.homedir(), // the page writes paths under it as ~/… (lib.js tildePath)
    };
  }

  // The Claude Code update runs at most once at a time; the page polls its output.
  const update = { running: false, lines: [], result: null };
  let claudeInfoCache = null;

  function settingsView() {
    const s = cfg().server;
    return {
      server: {
        quickActions: Array.isArray(s.quickActions) ? s.quickActions : DEFAULT_QUICK_ACTIONS,
        roots: resolveRoots(s.roots), // the allowed folders as set; roots() is the reach (all of the disk with reach 'everything')
        reach: s.reach === 'everything' ? 'everything' : 'home',
        notify: s.notify || null,
        publicUrl: s.publicUrl || '',
      },
      autoSwitch: autoswitch.getAutoSwitch(),
      backend: { kind: backend.kind, capabilities: backend.capabilities || {} },
      network: (() => {
        const a = server.address();
        return {
          host: a && typeof a === 'object' ? a.address : s.host || DEFAULT_HOST,
          port: a && typeof a === 'object' ? a.port : s.port || DEFAULT_PORT,
          trustProxy: s.trustProxy === true,
          allowedOrigins: Array.isArray(s.allowedOrigins) ? s.allowedOrigins : [],
        };
      })(),
      uploads: { dir: s.uploadsDir || DEFAULT_UPLOADS_DIR, maxMB: Number(s.uploadMaxMB) || DEFAULT_UPLOAD_MAX_MB },
      notifyEvents: EVENTS,
      sessionDefaults: cfg().sessionDefaults || {},
      sessionChoices: { permissionModes: PERMISSION_MODES, efforts: EFFORTS, models: sessionModels() },
      version: VERSION,
      platform: process.platform,
    };
  }

  // ---- API routes: [method, regex, handler(req, match, query, res)] ----
  const routes = [
    ['GET', /^\/api\/state$/, async () => {
      watcher.poke();
      return state();
    }],
    ['GET', /^\/api\/profiles$/, async () => ({ profiles: profileStates(await cards()), autoSwitch: autoswitch.getAutoSwitch() })],
    ['GET', /^\/api\/folders\/recent$/, async () => {
      const live = (await backend.list()).map((t) => ({ cwd: t.cwd, session: t.session }));
      const r = roots();
      return { folders: recentFolders(live, r), roots: r.map((p) => ({ path: p, short: tilde(p) })) };
    }],
    ['GET', /^\/api\/folders\/browse$/, async (req, m, q) => {
      const r = roots();
      if (!r.length) throw new HttpError(404, 'no usable folder in server.roots');
      const p = q.get('path') ? v.absPath(q.get('path')) : r[0];
      if (!p) throw bad('bad path');
      const out = browse(p, r, { hidden: q.get('hidden') === '1' });
      if (!out) throw new HttpError(404, 'folder not found or not allowed');
      return { ...out, roots: r.map((x) => ({ path: x, short: tilde(x) })) };
    }],
    ['GET', /^\/api\/folders\/sessions$/, async (req, m, q) => {
      const dir = insideRoots(v.absPath(q.get('path')), roots());
      if (!dir) throw new HttpError(404, 'folder not found or not allowed');
      return { sessions: sessionsIn(dir).slice(0, 30).map((s) => ({ id: s.id, at: s.mtimeMs, title: sessionTitle(s.file) || '(untitled)' })) };
    }],
    ['POST', /^\/api\/sessions$/, async (req) => {
      const b = await readJson(req);
      const dir = insideRoots(v.absPath(b.dir), roots());
      if (!dir) throw bad('choose a folder inside the allowed roots');
      const profile = pickProfile(b.profile);
      if (!profile) throw bad('there is no such provider');
      const mode = ['new', 'continue', 'resume'].includes(b.mode) ? b.mode : null;
      if (!mode) throw bad('bad mode');
      let sid = null;
      if (mode === 'resume') {
        sid = v.sessionId(b.sessionId);
        if (!sid || !sessionsIn(dir).some((s) => s.id === sid)) throw bad('that conversation is not in this folder');
      }
      // One conversation runs in one place only. "continue" (-c) is the folder's newest conversation.
      const runs = mode === 'resume' ? sid : mode === 'continue' ? (sessionsIn(dir)[0] || {}).id : null;
      if (runs && chat.running(runs)) throw new HttpError(409, 'this conversation is open as a chat right now; open it in a terminal from the chat');
      // An optional first message (Tia's start_session; one line, see deck.mjs promptArgs).
      let prompt = null;
      if (b.prompt !== undefined && b.prompt !== null) {
        prompt = v.message(b.prompt);
        if (!prompt) throw bad(`the first message must be 1 to ${v.MESSAGE_MAX} bytes`);
      }
      // Options for this one session (New session → Options); the fixed lists in config.mjs, never free text.
      const flags = [];
      if (b.permissionMode !== undefined && b.permissionMode !== null) {
        if (!PERMISSION_MODES.includes(b.permissionMode)) throw bad(`the permission mode must be one of: ${PERMISSION_MODES.join(', ')}`);
        flags.push('--permission-mode', b.permissionMode);
      }
      if (b.effort !== undefined && b.effort !== null) {
        if (!EFFORTS.includes(b.effort)) throw bad(`the effort must be one of: ${EFFORTS.join(', ')}`);
        flags.push('--effort', b.effort);
      }
      if (b.model !== undefined && b.model !== null) {
        const models = sessionModels();
        if (!models.includes(b.model)) throw bad(`the model must be one of: ${models.join(', ')}`);
        flags.push('--model', b.model);
      }
      const name = await deck.start({ dir, profile, mode, sessionId: sid, prompt, flags });
      watcher.poke();
      return { name };
    }],
    ['POST', /^\/api\/shells$/, async (req) => {
      const b = await readJson(req);
      const r = roots();
      const dir = b.dir ? insideRoots(v.absPath(b.dir), r) : r[0];
      if (!dir) throw bad('choose a folder inside the allowed roots');
      return { name: await deck.shell(dir) };
    }],
    ['GET', /^\/api\/sessions\/([^/]+)$/, async (req, m) => {
      const name = decodeURIComponent(m[1]);
      const st = await state();
      const card = st.sessions.find((s) => s.name === name);
      if (!card) throw new HttpError(404, 'no such session');
      return { ...st, session: card };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/key$/, async (req, m) => {
      const b = await readJson(req);
      // Escape / C-c interrupt; Enter, arrows, Tab and a digit answer a menu or a permission question.
      if (!['Escape', 'C-c', 'Enter', 'Up', 'Down', 'Tab', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(b.key)) throw bad('bad key');
      const { term } = await sessionOr404(decodeURIComponent(m[1]));
      // "Always allow" from the page: the number is typed only while the question on screen still has that answer
      // with the same words, so a question that changed since the page looked is never answered blind.
      if (b.expect !== undefined) {
        const now = alwaysOption(await backend.capture(term.id, 40));
        if (typeof b.expect !== 'string' || !now || now.key !== b.key || now.text !== b.expect) throw new HttpError(409, 'the question on the screen changed; look at the session and answer there');
      }
      if (/^[1-9]$/.test(b.key)) await backend.sendText(term.id, b.key);
      else await backend.sendKey(term.id, b.key);
      return { ok: true };
    }],
    ['GET', /^\/api\/sessions\/([^/]+)\/history$/, async (req, m, q) => {
      const { term } = await sessionOr404(decodeURIComponent(m[1]));
      const lines = Math.max(10, Math.min(HISTORY_MAX, Number(q.get('lines')) || 2000));
      return { text: await backend.capture(term.id, lines) };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/send$/, async (req, m) => {
      const b = await readJson(req);
      const text = v.message(b.text);
      if (!text) throw bad(`the message must be 1 to ${v.MESSAGE_MAX} bytes`);
      const { term } = await sessionOr404(decodeURIComponent(m[1]));
      await deck.send(term.id, text, { enter: b.enter !== false });
      return { ok: true };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/scroll$/, async (req, m) => {
      const b = await readJson(req);
      if (!['up', 'down', 'exit'].includes(b.action)) throw bad('bad scroll action');
      const { term } = await sessionOr404(decodeURIComponent(m[1]));
      await backend.scroll(term.id, b.action, Number.isInteger(b.lines) ? b.lines : 3);
      return { ok: true };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/switch$/, async (req, m) => {
      const b = await readJson(req);
      const profile = pickProfile(b.profile);
      if (!profile) throw bad('there is no such provider');
      const { term, run } = await sessionOr404(decodeURIComponent(m[1]));
      if (!run) throw new HttpError(409, 'this is a plain shell, not a Claude session started by the launcher');
      await moveTo(term, run, profile.name);
      return { ok: true };
    }],
    // A session that stopped at a usage limit goes on, on the provider it is on: after another Claude account signed
    // in (claudelogin.mjs) or the limit reset. Claude Code needs no restart for another account (2.1.325 reads the
    // stored sign-in again before its next request), so the continue prompt is simply typed — unless a menu stands
    // on the screen, where typing would answer the menu: then nothing is typed and the page offers the restart
    // ({ restart: true }: the same conversation starts again in place with --resume, then the prompt).
    ['POST', /^\/api\/sessions\/([^/]+)\/continue$/, async (req, m) => {
      const b = await readJson(req);
      const name = decodeURIComponent(m[1]);
      const { term, run } = await sessionOr404(name);
      if (!run) throw new HttpError(409, 'this is a plain shell, not a Claude session started by the launcher');
      if (run.profile === AUTO.name) throw new HttpError(409, 'a session on Auto goes on by itself');
      const prompt = autoswitch.getAutoSwitch().prompt;
      if (b.restart === true) {
        if (!v.profile(run.profile)) throw new HttpError(409, 'the provider of this session is gone; move it to another one');
        await deck.move(term, run, run.profile);
        watcher.pending.set(name, { to: run.profile, prompt, since: Date.now(), notRun: run.runId || null });
        watcher.poke();
        return { ok: true, restarted: true };
      }
      const screen = await backend.capture(term.id, 40);
      if (!detectLimit(screen) && !run.limit) throw new HttpError(409, 'this session is not waiting at a usage limit');
      if (menuOpen(screen)) return { ok: false, menu: true };
      await deck.send(term.id, prompt);
      watcher.poke();
      return { ok: true };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/rename$/, async (req, m) => {
      const b = await readJson(req);
      if (!backend.validName(b.name)) throw bad('use letters, digits, - and _ (up to 40)');
      const name = decodeURIComponent(m[1]);
      const { taken } = await sessionOr404(name);
      if (taken.includes(b.name)) throw new HttpError(409, 'that name is taken');
      await backend.rename(name, b.name);
      return { name: b.name };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/kill$/, async (req, m) => {
      await readJson(req);
      const name = decodeURIComponent(m[1]);
      await sessionOr404(name);
      await backend.kill(name);
      return { ok: true };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/upload$/, async (req, m) => {
      const s = cfg().server;
      const dirName = uploadsDirName(s.uploadsDir);
      if (!dirName) throw new HttpError(500, 'server.uploadsDir must be a relative folder name');
      const maxBytes = Math.max(1, Number(s.uploadMaxMB) || DEFAULT_UPLOAD_MAX_MB) * 1024 * 1024;
      const { term, run } = await sessionOr404(decodeURIComponent(m[1]));
      const cwd = insideRoots(run ? run.cwd : term.cwd, roots());
      if (!cwd) throw bad('this session runs outside the allowed folders');
      let fileName = 'upload';
      try {
        fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload'));
      } catch {
        /* keep the default */
      }
      return saveUpload(req, { cwd, dirName, fileName, maxBytes });
    }],
    ['GET', /^\/api\/pc$/, async () => {
      const snap = await system.snapshot();
      const ts = new Map();
      for (const t of await backend.list()) {
        const prev = ts.get(t.session);
        ts.set(t.session, { name: t.session, attached: t.attached, created: t.created, panes: (prev ? prev.panes : 0) + 1 });
      }
      return { ...snap, sessions: [...ts.values()] };
    }],
    ['POST', /^\/api\/pc\/kill$/, async (req) => {
      const b = await readJson(req);
      const pid = v.pid(b.pid);
      if (!pid) throw bad('bad pid');
      const r = await system.killProcess(pid, b.signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
      if (!r.ok) throw new HttpError(409, r.error);
      return r;
    }],
    ['POST', /^\/api\/pc\/power$/, async (req) => {
      const b = await readJson(req);
      if (!['reboot', 'poweroff'].includes(b.action) || b.confirm !== b.action) throw bad('type the action to confirm it');
      const r = await system.power(b.action);
      if (!r.ok) throw new HttpError(409, r.error);
      return r;
    }],
    // ---- settings ----
    ['GET', /^\/api\/settings$/, async () => settingsView()],
    ['POST', /^\/api\/settings$/, async (req) => {
      const b = await readJson(req);
      let serverPatch = null;
      let sessionDefaults = null;
      try {
        // Check everything first; save only when all of it is valid.
        if (b.server !== undefined) serverPatch = cleanServerPatch(b.server);
        if (b.sessionDefaults !== undefined) sessionDefaults = cleanSessionDefaults(b.sessionDefaults);
        if (b.autoSwitch !== undefined) {
          if (!b.autoSwitch || typeof b.autoSwitch !== 'object' || Array.isArray(b.autoSwitch)) throw new Error('autoSwitch must be an object');
          autoswitch.setAutoSwitch(b.autoSwitch);
        }
      } catch (e) {
        throw bad(e.message);
      }
      if (serverPatch && Object.keys(serverPatch).length) saveConfig({ server: serverPatch });
      if (sessionDefaults) saveConfig({ sessionDefaults });
      watcher.poke();
      return settingsView();
    }],
    ['POST', /^\/api\/settings\/password$/, async (req, m, q, res) => {
      // Only a signed-in browser gets here, so the overall cap (which an attacker could fill) does not apply.
      const ip = clientIp(req, proxyOpts());
      const wait = limiter.retryAfter(ip, { overall: false });
      if (wait > 0) throw new HttpError(429, `Too many tries. Wait ${Math.ceil(wait / 60000)} min.`);
      const b = await readJson(req);
      if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 1024) throw bad('the new password needs at least 8 characters');
      // While the page can be reached from anywhere, a weak password would open the computer to anyone; `strong: true`
      // asks the same before the link is turned on (Settings → Public link's "Make a strong password").
      const weak = cfg().publicLink?.on === true || b.strong === true ? passwordProblem(b.next) : null;
      if (weak) throw bad(`${b.strong === true && cfg().publicLink?.on !== true ? 'for the public link' : 'the public link is on, so'} the new password must be strong: ${weak}`);
      limiter.fail(ip, { overall: false }); // counted before the slow check, as for the login
      const ok = typeof b.current === 'string' && b.current.length <= 1024 && (await verifyPassword(b.current, cfg().server.passwordHash));
      if (!ok) throw new HttpError(403, 'the current password is wrong');
      limiter.succeed(ip, { overall: false });
      const hash = await hashPassword(b.next);
      saveConfig({ server: { passwordHash: hash } });
      notePassword(b.next, hash);
      // The tag changed with the hash, so every other browser is logged out now; this one gets a new session.
      res.setHeader('Set-Cookie', sessionCookie(sessions.create(passwordTag()), { secure: isHttps(req, proxyOpts()) }));
      return { ok: true };
    }],
    ['POST', /^\/api\/notify\/test$/, async (req) => {
      await readJson(req);
      const n = cfg().server.notify;
      if (!n || !n.url) throw bad('set a notification URL first');
      const r = await sendNotification(n, { force: true, status: 'waiting', session: 'test', title: 'Test notification', message: 'Notifications from your sessions will look like this.' }, { fetchImpl: notifyFetch });
      if (!r.sent) throw new HttpError(502, `not delivered: ${r.error}`);
      return r;
    }],
    ['POST', /^\/api\/profiles\/add$/, async (req) => {
      await readJson(req);
      const r = roots();
      const taken = (await backend.list()).map((t) => t.session);
      const name = v.uniqueName('add-account', taken);
      await backend.create({ name, dir: r[0] || os.homedir(), argv: [...deck.launcher(), 'add'] });
      return { name };
    }],
    ['POST', /^\/api\/profiles\/([^/]+)\/delete$/, async (req, m) => {
      await readJson(req);
      const p = v.profile(decodeURIComponent(m[1]));
      if (!p) throw new HttpError(404, 'there is no such provider');
      deleteProfile(p.name);
      try {
        autoswitch.clearLimited(p.name);
      } catch {
        /* nothing recorded */
      }
      return { ok: true };
    }],
    ['POST', /^\/api\/profiles\/([^/]+)\/available$/, async (req, m) => {
      await readJson(req);
      const p = v.profile(decodeURIComponent(m[1]));
      if (!p) throw new HttpError(404, 'there is no such provider');
      autoswitch.clearLimited(p.name);
      return { ok: true };
    }],
    // ---- Claude Code version and update ----
    ['GET', /^\/api\/claude$/, async (req, m, q) => {
      if (!claudeInfoCache || q.get('fresh') === '1' || Date.now() - claudeInfoCache.at > 10 * 60_000) {
        claudeInfoCache = { at: Date.now(), info: await (await claudecode()).claudeInfo() };
      }
      return { ...claudeInfoCache.info, updating: update.running };
    }],
    ['POST', /^\/api\/claude\/update$/, async (req) => {
      await readJson(req);
      if (update.running) throw new HttpError(409, 'an update is already running');
      const cc = await claudecode();
      Object.assign(update, { running: true, lines: [], result: null });
      cc
        .claudeUpdate({ onLine: (t) => update.lines.length < 2000 && update.lines.push(String(t).slice(0, 500)) })
        .then((r) => (update.result = { ok: !!r.ok, version: r.version || null }))
        .catch((e) => (update.result = { ok: false, version: null, error: e.message }))
        .finally(() => {
          update.running = false;
          claudeInfoCache = null;
        });
      return { started: true };
    }],
    ['GET', /^\/api\/claude\/update$/, async (req, m, q) => {
      const from = Math.max(0, Number(q.get('from')) || 0);
      return { running: update.running, lines: update.lines.slice(from), next: update.lines.length, result: update.result };
    }],
    // ---- one-time sign-in links (a phone scans the QR instead of typing the password) ----
    ['POST', /^\/api\/login\/links$/, async (req) => {
      const b = await readJson(req);
      // The address from anywhere (the set one, else the public link's) first: a phone scans the QR from elsewhere.
      const pub = reachableUrl(cfg());
      const host = requestHost(req, proxyOpts());
      const own = host ? `${isHttps(req, proxyOpts()) ? 'https' : 'http'}://${host}` : null;
      let base = pub || own;
      // { base }: a link for another address this dashboard is reached at (the public link's, the hub's), and only
      // one it knows: this page's own, the configured public address, or an allowed origin (a running public link
      // adds its own there).
      if (b.base !== undefined) {
        const originOf = (u) => {
          try {
            const x = new URL(String(u));
            return /^https?:$/.test(x.protocol) ? x.origin : null;
          } catch {
            return null;
          }
        };
        const want = originOf(b.base);
        const known = new Set([own, pub, cfg().server.publicUrl, process.env.HOPRIG_PUBLIC_URL, ...(cfg().server.allowedOrigins || [])].map(originOf).filter(Boolean));
        if (!want || !known.has(want)) throw bad('that address is not one this dashboard is reached at');
        base = want;
      }
      if (!base) throw bad('cannot tell this page\'s address; set it in Settings → Notifications → This page\'s address');
      const link = createLoginLink({ baseUrl: base, minutes: 15 });
      const hostname = new URL(link.url).hostname;
      return { ...link, qr: qrRows(link.url), local: /^(127\.|localhost$|\[?::1\]?$)/.test(hostname) };
    }],
    ['GET', /^\/api\/login\/links\/([0-9a-f]{12})$/, async (req, m) => ({ status: loginLinkStatus(m[1]) })],
    ['POST', /^\/api\/logout$/, async (req, m, q, res) => {
      sessions.destroy(parseCookies(req.headers.cookie)[COOKIE]);
      res.setHeader('Set-Cookie', clearCookie(isHttps(req, proxyOpts())));
      return { ok: true };
    }],
    ...features.flatMap((f) => f.routes || []),
  ];

  // The overall cap of the sign-in limit (auth.mjs RateLimiter) counts every password try from elsewhere, whatever
  // the password is like: it bounds a guess spread over many addresses and the hashes strangers can make us run.
  // Left out for this computer itself; a sign-in link (loginByLink) never counts. Those are the owner's ways in.
  const overallFor = (req) => ({ overall: !sameComputer(req) });

  async function login(req, res) {
    const ip = clientIp(req, proxyOpts());
    const lim = overallFor(req);
    const wait = limiter.retryAfter(ip, lim);
    if (wait > 0) {
      return send(res, 429, { error: `Too many tries. Wait ${Math.ceil(wait / 60000)} min.` }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    }
    const b = await readJson(req);
    // Count the try BEFORE the slow password check. Counting afterwards would let a burst of parallel guesses all
    // pass the limit above (each waits for scrypt before any is counted) and run that many 32 MiB hashes at once.
    limiter.fail(ip, lim);
    const hash = cfg().server.passwordHash;
    const ok = typeof b.password === 'string' && b.password.length <= 1024 && (await verifyPassword(b.password, hash));
    if (!ok) return send(res, 401, { error: 'Wrong password.' });
    limiter.succeed(ip, lim);
    notePassword(b.password, hash); // what it is like, for the public link's check (only the result is kept)
    const token = sessions.create(passwordTag());
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isHttps(req, proxyOpts()) }) });
  }

  /**
   * A sign-in link: the token from the link's #fragment, sent once by the login page. Limited per address like the
   * login, but never by the overall cap: it is the owner's way in from outside while someone guesses the password.
   */
  async function loginByLink(req, res) {
    const ip = clientIp(req, proxyOpts());
    const lim = { overall: false };
    const wait = limiter.retryAfter(ip, lim);
    if (wait > 0) {
      return send(res, 429, { error: `Too many tries. Wait ${Math.ceil(wait / 60000)} min.` }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    }
    const b = await readJson(req);
    limiter.fail(ip, lim);
    if (!useLoginLink(b.token)) return send(res, 401, { error: 'This sign-in link was used already or has expired. Make a new one on a device that is signed in.' });
    limiter.succeed(ip, lim);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sessions.create(passwordTag()), { secure: isHttps(req, proxyOpts()) }) });
  }

  async function handle(req, res) {
    for (const [k, val] of Object.entries(securityHeaders(requestHost(req, proxyOpts())))) res.setHeader(k, val);
    // For process managers and hosting panels: no login, and it says nothing but that the server answers.
    if (/^\/healthz(\?|$)/.test(req.url) && (req.method === 'GET' || req.method === 'HEAD')) return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(req.method === 'HEAD' ? undefined : 'ok');
    for (const f of features) if (f.handle && (await f.handle(req, res))) return;
    // A bearer token from another dashboard is not an ambient browser credential: no cookie, no Origin check.
    const viaToken = trusted(req) || req[INTERNAL] === true;
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return send(res, 400, { error: 'bad url' });
    }
    const p = url.pathname;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && !viaToken && !originOk(req, proxyOpts())) return send(res, 403, { error: 'cross-site request refused' });

    if (p === '/api/login' && method === 'POST') return login(req, res);
    if (p === '/api/login/link' && method === 'POST') return loginByLink(req, res);
    if (p === '/api/me' && method === 'GET') return send(res, 200, { authed: authed(req) });

    if (p.startsWith('/api/')) {
      if (!viaToken && !authed(req)) return send(res, 401, { error: 'log in first' });
      for (const [m, re, fn] of routes) {
        const match = re.exec(p);
        if (match && m === method) {
          const out = await fn(req, match, url.searchParams, res);
          // A route that answered itself (a file sent as a download) has nothing more to send.
          return res.headersSent ? undefined : send(res, 200, out);
        }
      }
      return send(res, 404, { error: 'not found' });
    }

    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    if (!PUBLIC.has(p) && !authed(req)) {
      if (p === '/' || p === '/index.html') {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return send(res, 401, { error: 'log in first' });
    }
    // Where the code editor's files are and its workers' names (they carry a hash), for the editor page.
    if (p === '/vendor/monaco.json') return send(res, ...(monacoManifest() ? [200, monacoManifest()] : [404, { error: 'the code editor is not installed' }]));
    const file = resolveStatic(p === '/login' ? '/login.html' : p);
    if (!file) return send(res, 404, { error: 'not found' });
    return sendFile(res, file, method === 'HEAD');
  }

  /** ctx.dispatch: one in-process request through handle(), answered into memory. */
  function dispatch(method, url, body) {
    return new Promise((resolve) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = Readable.from(data ? [data] : []);
      Object.assign(req, {
        method, url,
        headers: { host: '127.0.0.1', ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) },
        socket: { remoteAddress: '127.0.0.1' },
      });
      req[INTERNAL] = true;
      const chunks = [];
      let status = 200;
      const finish = () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status, json });
      };
      const res = new Writable({
        write(c, enc, cb) {
          chunks.push(Buffer.from(c));
          cb();
        },
        final(cb) {
          finish();
          cb();
        },
      });
      res.headersSent = false;
      res.setHeader = () => {};
      res.getHeader = () => undefined;
      res.writeHead = (s) => {
        status = s;
        res.headersSent = true;
        return res;
      };
      handle(req, res).catch((e) => {
        status = Number.isInteger(e.status) ? e.status : 500;
        chunks.length = 0;
        chunks.push(Buffer.from(JSON.stringify(errorBody(e))));
        finish();
      });
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = Number.isInteger(e.status) ? e.status : e instanceof URIError ? 400 : 500;
      // Log the failure, never the request body or headers.
      if (status === 500) console.error(`${req.method} ${req.url.split('?')[0]}: ${e.message}`);
      if (!res.headersSent) send(res, status, errorBody(e));
      else res.end();
    });
  });
  server.requestTimeout = 10 * 60_000; // long enough for an upload over a slow phone connection
  server.headersTimeout = 15_000;

  // ---- WebSocket: /ws/term?name=<session>&cols=&rows= ----
  // autoPong off: browsers never ping, and answering pings is how ws < 8.23 could be made to buffer without bound.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, autoPong: false });
  server.on('upgrade', async (req, socket, head) => {
    const reject = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    try {
      for (const f of features) if (f.upgrade && (await f.upgrade(req, socket, head))) return;
      const viaToken = trusted(req);
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws/term') return reject(404, 'Not Found');
      if (!viaToken && !originOk(req, proxyOpts())) return reject(403, 'Forbidden');
      if (!viaToken && !authed(req)) return reject(401, 'Unauthorized');
      const name = v.sessionName(url.searchParams.get('name'));
      if (!name || !(await deck.find(name))) return reject(404, 'Not Found');
      const cols = Number(url.searchParams.get('cols'));
      const rows = Number(url.searchParams.get('rows'));
      wss.handleUpgrade(req, socket, head, (ws) => {
        // A phone that drops off the network leaves a half-open socket; ping and drop it when it stops answering.
        let alive = true;
        ws.on('pong', () => (alive = true));
        const beat = setInterval(() => {
          if (!alive) return ws.terminate();
          alive = false;
          ws.ping();
        }, 30_000);
        ws.on('close', () => clearInterval(beat));
        attachTerminal(ws, { backend, name, cols, rows });
      });
    } catch {
      reject(500, 'Internal Server Error');
    }
  });

  return {
    server,
    deck,
    backend,
    sessions,
    watcher,
    features,
    listen(port = opts.port ?? first.port ?? DEFAULT_PORT, host = opts.host ?? first.host ?? DEFAULT_HOST) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          if (opts.watch !== false) watcher.start();
          // Whether a Claude account is signed in here, and on which plan: asked once now and then every half hour,
          // so the Providers page is right from the first minute. Before, only doctor, setup or a session start
          // asked, and after a restart the page knew nothing. Only the real `serve` command turns it on (the demo and
          // tests bring their own facts), and it is never in the way of a request: it is a program start.
          if (opts.loginCheck === true) {
            const ask = () => import('../claudecode.mjs').then((m) => m.claudeLoginStatus()).catch(() => {});
            // A few seconds after start, not at once: starting the dashboard stays quick, and a server that lives
            // only a moment (a test of `serve`, a quick `--help`) never starts another program.
            firstLoginCheck = setTimeout(ask, 5000);
            firstLoginCheck.unref();
            loginTimer = setInterval(ask, 30 * 60_000);
            loginTimer.unref();
            // An account changed with /login in a session or a terminal: noticed within seconds, not at the next
            // half-hourly check, so the earlier account's limit mark does not keep the provider out of use.
            import('../claudecode.mjs')
              .then((m) => {
                const w = m.signInWatch();
                if (closed) return;
                signInTimer = setInterval(() => w.check().catch(() => {}), 10_000);
                signInTimer.unref();
              })
              .catch(() => {});
          }
          // Where this dashboard really listens, for `hoprig pair --json`, `link` and setup (dashboardfile.mjs).
          const a = server.address();
          if (opts.dashboardFile !== false && a && typeof a === 'object') writeDashboardFile({ host: a.address, port: a.port });
          for (const f of features) {
            try {
              f.start?.(ctx);
            } catch (e) {
              console.error(`feature ${f.name}: ${e.message}`);
            }
          }
          resolve(server.address());
        });
      });
    },
    async close() {
      closed = true;
      for (const f of features) {
        try {
          await f.close?.();
        } catch {
          /* stop the rest anyway */
        }
      }
      removeDashboardFile();
      clearTimeout(firstLoginCheck);
      clearInterval(loginTimer);
      clearInterval(signInTimer);
      watcher.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      const done = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await done;
      if (typeof backend.close === 'function') await backend.close();
    },
  };
}

/** True when a password is set. `serve` refuses to start without one. */
export const hasPassword = () => {
  const h = loadConfig().server.passwordHash;
  return typeof h === 'string' && h.startsWith('scrypt$');
};
