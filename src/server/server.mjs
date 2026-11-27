// The dashboard's HTTP + WebSocket server.
//
// config.json keys under "server" (all optional except passwordHash, which the passwd command writes):
//   host            address to listen on                    default "127.0.0.1" (only this machine)
//   port            port                                    default 7433
//   passwordHash    scrypt hash of the dashboard password    set by the passwd command
//   roots           folders the folder picker may show       default [your home directory]
//   reach           how far Files and the editor reach: "home" = those folders; "everything" = the whole disk
//                   (Hoprig's own folders and sign-in files stay locked; sessions, Tia and automations keep to roots)
//                                                            default "home"
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
// defaultProvider: the provider a new session in a folder starts on when nobody chose one,
// dispatch: the owner's own request run in-process through the same handling, for Tia's tools) and
// returns { name, routes?, handle?, upgrade?, trusted?, start?, close? }:
//   handle(req, res) / upgrade(req, socket, head)  called first, in order; true = answered, false = go on
//   trusted(req)        true when the feature authenticated the request itself (no cookie, no Origin check)
//   routes              [method, regex, handler(req, match, query, res)], behind the login, merged with the core ones
//   start(ctx)          after the server listens;  close()  when it stops
// A new feature is one file plus one line in that list.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { WebSocketServer } from 'ws';
import * as autoswitchModule from '../autoswitch.mjs';
import { chooseDefault, folderProviders, lastProviderIn } from '../defaultprovider.mjs';
import { EFFORTS, MODELS, PERMISSION_MODES, cleanSessionDefaults, loadConfig, saveConfig } from '../config.mjs';
import { ALL, BYPASS, allAllowed, bypassAllowed, gateModes, ownerModes, ROOT_BYPASS_LINE, runsAsRoot } from '../bypassgate.mjs';
import { allError, allRefusal } from '../allguard.mjs';
import { bypassFeature } from './bypass.mjs';
import { moveFeature } from '../setup/moveroutes.mjs';
import { handsOffFeature } from './handsoff.mjs';
import { herRightsFeature } from './herrights.mjs';
import { herSigninFeature } from './hersignin.mjs';
import { handsOffOffered } from '../handsoff.mjs';
import { stateDir, tilde } from '../paths.mjs';
import { fromHerDoor } from './herdoor.mjs';
import { assertServes, deleteProfile, listProfiles, publicProfile } from '../profiles.mjs';
import { listRuns, runsConversation } from '../runs.mjs';
import { system as processes } from '../procid.mjs';
import { sessionsIn } from '../sessions.mjs';
import { readTitles, sessionName, setOwnName } from '../titles.mjs';
import {
  COOKIE, RateLimiter, SessionStore, THIS_COMPUTER, clearCookie, hashPassword, parseCookies, sessionCookie, sha256, verifyPassword,
} from './auth.mjs';
import { createBackend } from './backends/index.mjs';
import { Deck } from './deck.mjs';
import { browse, insideRoots, recentFolders, refuseSecretStart, resolveRoots } from './folders.mjs';
import { detectLimit } from './limits.mjs';
import { alwaysOption, dialogShows, menuOpen, permissionDialog, permissionQuestion } from './prompts.mjs';

// How much of a terminal's screen is read for a permission dialog: its long answers wrap over many lines when narrow.
const SCREEN_LINES = 80;
import { killProcess, power, snapshot } from './platform.mjs';
import { machinesFeature } from '../machines/index.mjs';
import { healthFeature } from '../machines/health.mjs';
import { ownLinePage } from '../machines/healthline.mjs';
import { gatewayHostFeature } from '../addons/gatewayhost.mjs';
import { gatewayManageFeature } from '../addons/gatewaymanage.mjs';
import { confirmedCard } from '../assistant/confirmed.mjs';
import { assistantFeature } from '../assistant/feature.mjs';
import { automationFeature } from '../automation/feature.mjs';
import { addonsFeature } from '../addons/feature.mjs';
import { reachableUrl } from '../addons/reach.mjs';
import { accountsFeature } from './accounts.mjs';
import { claudeLoginFeature, sameComputer } from './claudelogin.mjs';
import { gatewayFeature } from '../gateway/index.mjs';
import { pcsetupFeature } from '../pcsetup/feature.mjs';
import { newProjectFeature } from '../pcsetup/newprojectstart.mjs';
import { skillhubFeature } from '../skillhub/feature.mjs';
import { learnFeature } from '../skillhub/learnfeature.mjs';
import { fieldFeature } from '../field/feature.mjs';
import { proposalsFeature } from '../skillhub/proposals.mjs';
import { improveFeature } from '../assistant/improvefeature.mjs';
import { workspaceFeature } from '../workspace/feature.mjs';
import { leaveFeature } from '../workspace/leavefeature.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { adoptFeature } from '../adopt/feature.mjs';
import { workFeature } from '../work/feature.mjs';
import { modelsFeature } from '../models/feature.mjs';
import { partDoor } from '../models/partdoor.mjs';
import { modelProblem } from '../models/catalog.mjs';
import { editorFeature } from '../editor/feature.mjs';
import { chatFeature } from '../chat/feature.mjs';
import { onboardingFeature } from '../setup/onboarding.mjs';
import { forwardLine, reasonWords, serverReason, serverWays } from '../setup/server.mjs';
import { findWorkUser, rootFacts, rootView, STAY_ROOT_KEY, stayRootChoice } from '../setup/rootfacts.mjs';
import { desktopFeature } from '../desktop/feature.mjs';
import { localKey, removeDashboardFile, stateKey, writeDashboardFile } from './dashboardfile.mjs';
import { createLoginLink, loginLinkStatus, qrRows, useLoginLink } from './loginlink.mjs';
import { clientIp, forwardedVisitor, isHttps, originOk, requestHost, securityHeaders } from './security.mjs';
import { notePassword, passwordProblem } from './strength.mjs';
import { monacoManifest, resolveStatic, sendFile } from './static.mjs';
import { attachTerminal } from './terminal.mjs';
import { EVENTS, keepHeaders, sendNotification } from './notify.mjs';
import { AUTO, DEFAULT_QUICK_ACTIONS, cleanServerPatch } from './settings.mjs';
import { DEFAULT_UPLOADS_DIR, DEFAULT_UPLOAD_MAX_MB, dropsFolder, pruneDrops, saveUpload, uploadsDirName } from './uploads.mjs';
import * as v from './validate.mjs';
import { Watcher, enrich } from './watcher.mjs';
import { isClaudeCard } from '../automation/cards.mjs';
import { oneCard } from './onecard.mjs';
import { codetoolsFeature } from '../codetools/feature.mjs';
import { operatorFeature } from '../operator/feature.mjs';
import { roomsFeature } from '../operator/rooms.mjs';
import { providersFeature } from '../providers/feature.mjs';
import { heldError, heldUntil } from '../operator/decide-store.mjs';
import { asksAdapter } from '../operator/decide-asks.mjs';
import { shipFeature } from '../ship/feature.mjs';
import { enabledToolIds } from '../codetools/index.mjs';
import { assertHerToolBound, assertToolReady, toolFlags, toolFromRequest } from '../codetools/start.mjs';
import { isToolSessionId, toolSessions } from '../codetools/stores.mjs';

/**
 * { server: { why, ways } } when this computer is a server, else {}. Asked at each answer: the service has no ssh session,
 * so the reason is mostly the one set-up saved (server.mjs), and a set-up run while the dashboard runs may change it.
 */
function onServer(port, over = {}) {
  const sys = { env: process.env, platform: process.platform, ...over };
  const r = serverReason(sys);
  return r ? { server: { why: reasonWords(r), ways: serverWays(port), forward: forwardLine(port, { ...sys, sshPort: r.sshPort }) } } : {};
}

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
 * src/machines: fake ssh, timeouts), dashboardFile (false: do not write <stateDir>/dashboard.json), toolSessions
 * (a stand-in for the conversation lists of another coding tool's store).
 * Returns { server, deck, backend, watcher, listen(), close() }.
 */
export function createServer(opts = {}) {
  const cfg = () => loadConfig();
  // Hoprig runs as root here (a test hands it in): Claude Code refuses bypass permissions mode for root.
  const asRoot = opts.root !== undefined ? opts.root === true : runsAsRoot();
  // As root, the work user Hoprig made, looked up once: the page's ssh line names it, never root@ (rootfacts.mjs).
  let workUser = opts.workUser || null;
  if (asRoot && opts.workUser === undefined) findWorkUser().then((u) => (workUser = u), () => {});
  const first = cfg().server;
  const backend = opts.backend || createBackend({ kind: first.backend || 'auto', socket: opts.tmuxSocket ?? first.tmuxSocket ?? '', configFile: opts.tmuxConfigFile || '' });
  const deck = new Deck({ backend, config: cfg, profiles: listProfiles, saveConfig, root: asRoot });
  const sessions = new SessionStore(path.join(stateDir(), 'web-sessions.json'));
  const limiter = new RateLimiter();
  const linkLimiter = new RateLimiter(); // sign-in links: their own count, which wrong passwords never fill
  const autoswitch = opts.autoswitch || autoswitchModule;
  // Loaded on first use, so the dashboard still starts if that module fails to load.
  const claudecode = async () => opts.claudecode || import('../claudecode.mjs');
  // A coding tool's conversations of a folder, from its own store (opts.toolSessions: a stand-in, in tests).
  const listToolSessions = opts.toolSessions || toolSessions;
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
  const roots = () => resolveRoots(cfg().server.roots);
  // The models one session may start with: the fixed aliases, plus the model saved as the default for new sessions
  // (already checked when it was saved), so the page offers exactly what Settings → New sessions offers.
  // An older page's list (sessionChoices.models): the family names, plus the saved default. A picker of this version
  // asks GET /api/models for the provider's own list (src/models/catalog.mjs).
  const sessionModels = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved && !MODELS.includes(saved) ? [...MODELS, saved] : [...MODELS];
  };
  // Sessions are tied to the current password: a new password logs every browser out at once.
  const passwordTag = () => sha256(String(cfg().server.passwordHash || '')).slice(0, 16);
  // A request the server makes to itself for the owner (ctx.dispatch, Tia's tools) carries this mark; no request
  // from the network can, so it counts as the owner's own login and its own site.
  const INTERNAL = Symbol('hoprig.internal');
  const CARD = Symbol('hoprig.confirmed-card'); // the card of Tia's the owner confirmed, on a request its act makes
  const authed = (req) => req[INTERNAL] === true || sessions.valid(parseCookies(req.headers.cookie)[COOKIE], passwordTag(), req.headers && req.headers.host);
  // What a feature gets (see the header). state() and readJson are declared further down; they are called later.
  const ctx = {
    deck, backend, config: cfg, saveConfig, authed,
    root: asRoot, // Hoprig runs as root here: no bypass permissions mode (bypassgate.mjs)
    // The loopback names the owner is signed in under here: a plain link to a gateway on this computer avoids them, as
    // a cookie goes to every port of its name (src/addons/gatewayhost.mjs, web/health.js plainHost).
    signedInHosts: () => sessions.hosts(passwordTag()).filter((x) => ['127.0.0.1', 'localhost', '[::1]'].includes(x)),
    state: () => state(),
    originOk: (req) => req[INTERNAL] === true || originOk(req, proxyOpts()),
    // Who sent a request: 'self' (ctx.dispatch, Tia's door), 'computer' (another dashboard's bearer token) or 'page'.
    caller: (req) => (req[INTERNAL] === true ? 'self' : trusted(req) ? 'computer' : 'page'),
    // Run `method path` with a JSON `body` through the very same handling a page request gets (features, routes,
    // validators, the relay to another computer at /m/<name>/…) on the owner's behalf. Resolves { status, json }.
    // ONLY Tia's door (src/assistant/door.mjs: an allowlist of routes) may call it — no other feature: it acts as the
    // owner on any route. A test (test/assistant/door.test.mjs) checks the source for other callers.
    dispatch: (method, url, body) => dispatch(method, url, body),
    // Where THIS server listens ({ address, port } once listening, else null): a feature that tells a program of its own
    // where the dashboard is (Tia's MCP server) takes it from here, never from a default port another dashboard may hold.
    listening: () => {
      const a = server.listening ? server.address() : null;
      return a && typeof a === 'object' ? a : null;
    },
    // The confirmed card of Tia's whose act made this in-process request (src/assistant/confirmed.mjs), or null.
    ownerCard: (req) => (req[INTERNAL] === true && req[CARD]) || null,
    clientIp: (req) => clientIp(req, proxyOpts()),
    onTick: (fn) => watcher.onTick(fn),
    poke: () => watcher.poke(), // look at the sessions soon (a feature just started or typed into one)
    notify: (ev) => {
      const n = cfg().server.notify;
      return n && n.url ? sendNotification(n, ev, { fetchImpl: notifyFetch }) : Promise.resolve({ sent: false });
    },
    readJson: (req) => readJson(req),
    // The provider a new session or chat of coding tool `tool` in `dir` starts on when nobody chose one
    // (src/defaultprovider.mjs). `last`: the provider the caller's own record says ran there last (a chat's); else
    // the folder's record of that tool.
    defaultProvider: (dir, last = null, tool = 'claude') => defaultProviderIn(dir, last, tool),
    // "Also open" from a browser: map names of extra folders for one session in `dir`, each decided by the one function
    // (workspace/needs.mjs extraFolder). → [name]; throws 400 with why.
    checkWith: async (list, dir) => {
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || list.length > 10 || list.some((x) => typeof x !== 'string')) throw new HttpError(400, '"with" is a list of at most 10 names of the workspace map');
      if (!list.length) return [];
      const N = await import('../workspace/needs.mjs');
      const m = N.mapFor();
      if (m.why) throw new HttpError(400, m.why);
      const at = { dir: workspaceDir(), projects: projectsIn() };
      let self = null;
      try {
        self = fs.realpathSync(dir);
      } catch {
        /* the folder is checked by the caller */
      }
      const out = [];
      for (const name of list) {
        // No walk of links here: the start walks once and refuses or names what it finds (needs.mjs sessionExtras).
        const r = await N.extraFolder(name, { map: m.map, ctx: at, self, walk: false });
        if (r.own) continue; // ticked in the list, then that very project was started: it is the session's folder already
        if (!r.ok) throw new HttpError(400, r.fix ? `${r.why}: get it first with  ${r.fix}` : r.why);
        if (!out.includes(r.ref)) out.push(r.ref);
      }
      return out;
    },
    HttpError,
  };
  // ---- the features: one line each ----
  const machines = machinesFeature(ctx, opts.machines);
  const gateway = gatewayFeature(ctx, { hub: machines.machines.hub, ...opts.gateway });
  const chat = chatFeature(ctx, opts.chat);
  // "Use other providers": a Lead chat's one tool. Work's runs and these parts share the computer's slots.
  let work = null;
  const parts = partDoor({ chat, config: cfg, readJson: (req) => readJson(req), aloneRunning: () => (work && work.sched && work.sched.running ? work.sched.running() : 0), ...opts.parts });
  chat.setPartsConfig((c) => parts.configFor(c), (id) => parts.handedOf(id));
  const learn = learnFeature(ctx, opts.learn);
  // A mission's choices go through the Operator's one decision door (src/mission/seam.mjs); the Operator is built below.
  const door = (item) => features.find((f) => f.name === 'operator')?.decide?.mission(item) ?? null;
  work = workFeature(ctx, { chat, learn, hub: machines.machines.hub, door, othersRunning: () => parts.running(), ...opts.work });
  // Each computer's room for new work (src/operator/rooms.mjs): read on his look; by itself only with his switch.
  const rooms = roomsFeature(ctx, { hub: machines.machines.hub, running: () => (work.sched && work.sched.running ? work.sched.running() : 0), machine: () => features.find((f) => f.name === 'operator')?.machine(), changed: () => features.find((f) => f.name === 'operator')?.forget(), undone: () => features.find((f) => f.name === 'operator')?.elsewhereUndone(), ...opts.rooms });
  const features = [
    work.boxTool, // a mission session's tool token (src/mission/boxtool.mjs): its one route, and refused everywhere else; first, before any feature that takes a bearer as its own
    work.tokens, // a Work token (another program, src/work/tokenfeature.mjs): answered here and nowhere else; first, before any other door
    bypassFeature(ctx, { chat, ...opts.bypass }), // Settings → Allow bypass permissions mode; first: its one-time step at the start comes before any session starts
    moveFeature(ctx, opts.move), // Settings → Runs as root: move Hoprig to an ordinary user, as a job, from this server's own page only
    handsOffFeature(ctx, opts.handsOff), // Hands-off: the project's and the session's switch, the project's note
    herRightsFeature(ctx, opts.herrights), // Settings → Tia: the owner's choice of Tia's administrator-rights level (off, ask, full), per computer
    herSigninFeature(ctx, opts.hersignin), // Settings → Tia: the owner's choice of which credentials file signs her sessions in to the git server
    assistantFeature(ctx, { hub: machines.machines.hub, chat, ...opts.assistant }), // Tia; first, so her own token is checked before the machines gate
    parts, // a Lead chat's part token (src/models/partdoor.mjs): answered here only, before the machines gate
    gateway, // /gateway/…: a gateway shared with a gateway key (before the machines gate, which takes any bearer as its own)
    machines, // other computers: relay, pairing, bearer tokens
    healthFeature(ctx, { own: () => rooms.own(), ...opts.health }), // GET /api/health: this computer's checks, versions, service, load, memory and disks (a hub reads it with its token)
    editorFeature(ctx, opts.editor), // the code editor's files and git under /api/code/ (another computer's token too); removes VS Code Server's leftovers once
    automationFeature(ctx, { tick: opts.watch !== false, chat, work: () => work.sched, ...opts.automation }), // queue, schedules (also of chats and runs that end by themselves), restore, retry, updates, idle care
    addonsFeature(ctx, opts.addons), // Settings → Add-ons: install, start, stop, update, set up as an account
    gatewayHostFeature(ctx, opts.gatewayhost), // Health → Gateways: start, stop and run a gateway as a service on this computer, behind a confirmation that names it
    gatewayManageFeature(ctx, opts.gatewaymanage), // Providers → the shipped gateway: its accounts, limits, Add, combos and keys, through its own management interface (never Tia's)
    modelsFeature(ctx, { autoOn: () => autoOn(), ...opts.models }), // the models a picker offers: the provider's own list (src/models)
    accountsFeature(ctx, { remote: gateway.states, removing: gateway.forget, ...opts.accounts }), // Providers: add a subscription, an API key or a gateway in the page
    providersFeature(ctx, opts.providers), // Providers → a provider: its check (sent only on the owner's press), its map, what is left
    claudeLoginFeature(ctx, opts.claudeLogin), // Claude Code's own sign-in from the page (Setup, Get started, Providers)
    pcsetupFeature(ctx, opts.pcsetup), // PC → Setup: system status, set up this computer, projects, recipes
    newProjectFeature(ctx, { chat, ...opts.newproject }), // New project's "Start with AI": a session with the new-project skill and the brief
    skillhubFeature(ctx, opts.skillhub), // Skills: installed, suggested for a project, find, review → approve, updates
    onboardingFeature(ctx, opts.onboarding), // Home → Get started: the steps a new user goes through, done or not
    workspaceFeature(ctx, opts.workspace), // Workspace: the tree, its map, restore and sync, Git and GitHub, the AI brain (read-only)
    leaveFeature(ctx, opts.leave), // Computers → Before you format this computer: the whole check (read only), the daily line on Home, the one press that pushes the other branches
    adoptFeature(ctx, opts.adopt), // Workspace → Projects found on this computer: look, suggest, arrange (the owner's own page only)
    learn, // Skills → Learned: drafts of skills from the owner's own work (off by default), Install, Discard, Undo
    fieldFeature(ctx, opts.field), // Settings → Version and updates → Field reports and their Home lines: nothing is sent, shown or learned without the owner's choice
    proposalsFeature(ctx, { reload: () => features.find((f) => f.name === 'assistant')?.core?.skills?.reload(), ...opts.proposals }), // Skills: proposal files of an outside improvement loop, Accept with Undo, Not now
    improveFeature(ctx, opts.improve), // Settings → Tia → Improve Tia: a round that measures rewordings of her texts and proposes the better ones
    work, // Work: tasks and Today, kept in a file of the workspace and saved to git by name; "Do it" opens a chat
    chat, // coding without the terminal: a Claude Code conversation as a chat (its cards are among the sessions)
    codetoolsFeature(ctx, opts.codetools), // Codex's and OpenCode's servers: stopped when no session uses them
    desktopFeature(ctx, opts.desktop), // the desktop's Task manager, Services and Logs: processes, usage, services, the journal and log files
    operatorFeature(ctx, { session: { // Operator: the board, the attention list and the owner's taps (the same move and stop as the session routes)
      move: async (name, to) => { const { term, run } = await sessionOr404(name); if (!run) throw new HttpError(409, 'this is a plain shell'); const p = pickProfile(to, run.tool || 'claude'); if (!p) throw bad('there is no such provider'); await moveTo(term, run, p.name); },
      stop: async (name) => { await sessionOr404(name); await backend.kill(name); },
      nudge: async (name, text) => { await sessionOr404(name); await deck.sendToTool(name, text, { enter: true }); }, // only while the coding tool is in front (typing.mjs)
      start: (o) => { const a = features.find((f) => f.name === 'automation')?.automation; if (!a) throw new HttpError(503, 'automations are not running'); return a.deck.start(o); }, // a rule reopens a session whose coding tool died: the very start a restart makes
    }, asks: asksAdapter({ chat }), rooms: () => rooms.keeper.view(), work: () => work.looks, ...opts.operator }),
    rooms, // GET /api/operator/rooms: each computer's room for new work; the switch "Look at my other computers too"
    shipFeature(ctx, { chat, assistant: () => features.find((f) => f.name === 'assistant'), ...opts.ship }), // Work → Go live: put finished task branches together, check them, go live on the owner's tap
  ];
  const trusted = (req) => features.some((f) => f.trusted && f.trusted(req));

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // A session of Health's line-ready kind (deck.mjs lineReady) holds a line for the owner to run himself: `owner: true`
  // there is taken only from this dashboard's own page, never from Tia (her door) or another computer's token.
  async function ownKeysOnly(req, name) {
    if (ctx.caller(req) !== 'page' && (await deck.isLineReady(name))) throw Object.assign(new HttpError(409, `Nothing was typed: session "${name}" holds a line for you to run yourself. Type there on this computer's own page`), { code: 'line_ready' });
  }
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
  const defaultFor = (profiles, last = null, tool = 'claude') => chooseDefault({ profiles, auto: { ...autoswitch.getAutoSwitch(), enabled: autoOn() }, autoName: AUTO.name, last, tool });
  const defaultProviderIn = async (dir, last = null, tool = 'claude') => defaultFor(profileStates(await cards()), last || (dir ? lastProviderIn(dir, undefined, tool) : null), tool);
  /** A profile name from the browser: a real profile, or "auto" while Auto mode is on. Full object or null. */
  // A provider that does not serve the session's coding tool is refused (400). Auto mode is Claude Code's.
  const pickProfile = (name, tool = 'claude') => {
    const p = name === AUTO.name ? (autoOn() && tool === 'claude' ? { name: AUTO.name, env: {} } : null) : v.profile(name);
    if (p) assertServes(p, tool);
    return p;
  };

  const cards = async () => {
    const list = enrich(await deck.list(), listRuns());
    const rs = await routerState();
    rsCache = rs;
    const serving = safe(() => rs.routerSessions());
    const names = new Map(listProfiles().map((p) => [p.name, p.label]));
    for (const c of list) {
      if (!isClaudeCard(c) || !c.profile || c.profile.name !== AUTO.name) continue;
      c.profile = { name: AUTO.name, label: AUTO.label, kind: 'auto' };
      const now = c.sessionId && serving[c.sessionId];
      c.autoOn = now && now.profile ? { name: now.profile, label: names.get(now.profile) || now.profile, at: now.at || null } : null;
    }
    // Open chats are sessions too (kind "chat"): Home lists them, the watcher notifies about them.
    await chat.readNames?.(); // the App sessions' names read in pieces first (titles.mjs readTitles)
    return [...list, ...chat.cards()];
  };

  /** Move a session to another profile; "auto" is not a profile file, so it is built here. */
  async function moveTo(term, run, name) {
    return deck.move(term, run, name, name === AUTO.name ? { profile: { name: AUTO.name, env: {} } } : {});
  }

  /**
   * Profiles as the page shows them: public fields, limit state, how many sessions use each (Auto sessions count
   * for the account serving them), usage (the router's figures first, else the newest run's). While Auto mode is
   * on, a virtual "Auto" profile comes first.
   */
  function profileStates(list) {
    const limited = autoswitch.limitedProfiles();
    const routerUsage = safe(() => (rsCache || {}).profileUsage?.());
    const speed = safe(() => (rsCache || {}).speedVerdicts?.()); // how soon each starts its answers (router.mjs)
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
        ...(speed[p.name] ? { speed: speed[p.name] } : {}),
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

  // One conversation, one card on the page (./onecard.mjs): the terminal's card while a terminal runs or starts it,
  // else the chat's, each with its `key` and `where`. Only what the page gets: cards() keeps every chat, for the
  // assistant's jobs and marks, which follow a chat by its own card.
  async function state() {
    const list = oneCard(await cards());
    const auto = autoswitch.getAutoSwitch();
    const profiles = profileStates(list);
    const names = new Set(profiles.map((p) => p.name));
    for (const c of list) {
      if (!isClaudeCard(c) || !c.profile) continue;
      // "Move back" is offered on a session that runs on this profile only because a preferred one hit its limit.
      const pref = c.fallback ? autoswitch.preferredAvailable(c.profile.name) : null;
      c.preferred = pref && pref !== c.profile.name && names.has(pref) ? pref : null;
      c.autoMove = watcher.pending.has(c.name) ? watcher.pending.get(c.name).to : null;
      // Since when it stands at its limit, as far as known: the page compares it with when another Claude account
      // signed in (the provider's accountAt), to offer "Continue with the new account".
      if (c.limit || c.runLimit) c.limitAt = (c.runLimit && c.runLimit.at) || watcher.seen.get(c.runId) || null;
    }
    // The provider a new session starts on (src/defaultprovider.mjs): "auto" while Auto mode is on. `recommendedIn`:
    // the folders whose own default (the provider used last there) differs from it.
    const recommended = defaultFor(profiles);
    // Auto mode is on, yet a new session starts elsewhere: Auto's provider is slow or refusing now (fasterThanAuto).
    const autoSlow = autoOn() && recommended !== AUTO.name;
    const recommendedIn = {};
    const folders = Object.entries(folderProviders());
    if (!autoOn()) for (const [d, e] of folders) {
      const r = defaultFor(profiles, e && e.profile);
      if (r && r !== recommended) recommendedIn[d] = r;
    }
    // The same for each other coding tool that is on (New session shows the default of the tool chosen there):
    // { [tool]: { recommended, recommendedIn } }. Left out while Claude Code is the only one.
    const others = enabledToolIds(cfg()).filter((t) => t !== 'claude');
    const toolDefaults = others.length ? Object.fromEntries(others.map((t) => {
      const rec = defaultFor(profiles, null, t);
      const inDir = {};
      for (const [d, e] of folders) {
        const r = e && e.tools && typeof e.tools[t] === 'string' ? defaultFor(profiles, e.tools[t], t) : null;
        if (r && r !== rec) inDir[d] = r;
      }
      return [t, { recommended: rec, recommendedIn: inDir }];
    })) : null;
    const qa = cfg().server.quickActions;
    return {
      sessions: list, profiles, autoSwitch: auto, recommended, recommendedIn, ...(autoSlow ? { autoSlow: true } : {}), ...(toolDefaults ? { toolDefaults } : {}),
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
        roots: roots(),
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
          // On a server (setup/server.mjs) the page names the ways to reach it instead of "serve --host 0.0.0.0".
          ...onServer(a && typeof a === 'object' ? a.port : s.port || DEFAULT_PORT, { ...(workUser ? { workUser } : {}), ...opts.serverFacts }),
        };
      })(),
      uploads: { dir: s.uploadsDir || DEFAULT_UPLOADS_DIR, maxMB: Number(s.uploadMaxMB) || DEFAULT_UPLOAD_MAX_MB },
      notifyEvents: EVENTS,
      sessionDefaults: cfg().sessionDefaults || {},
      sessionTitles: cfg().sessionTitles !== false, // the App asks Claude Code for a session's title (chat.mjs askTitle)
      sessionChoices: { permissionModes: ownerModes(PERMISSION_MODES, cfg(), asRoot), efforts: EFFORTS, models: sessionModels() },
      // As root: the line the sheet and Settings say where bypass would be chosen (null otherwise).
      rootBypass: asRoot ? ROOT_BYPASS_LINE : null,
      // As root: the facts that make it on purpose (a container, his kept choice) and the sentence that keeps it (null otherwise).
      // `opts.rootExists` answers the container files in tests.
      root: rootView({ ...rootFacts({ cfg: cfg(), ...(opts.rootExists ? { exists: opts.rootExists } : {}) }), root: asRoot }),
      // Whether Hands-off is offered on this computer (handsOff.offered): the page shows its switch and Settings entry
      // only when this is true. Offered is the shipped default; only handsOff.offered:false hides it (handsOffOffered).
      handsOff: { offered: handsOffOffered(cfg()) },
      version: VERSION,
      platform: process.platform,
    };
  }

  /**
   * A session start on a conversation that runs already (chat.startTerminal): nothing new starts, the answer is where it
   * runs ({ name } of the terminal, or { chat } with the chat's id), and a first message is not sent there.
   */
  function runsAlready(where, prompt) {
    const unsent = prompt ? { sent: false } : {};
    if (where.chat) return { chat: where.chat, existing: true, ...unsent };
    if (where.terminal && where.terminal.name) return { name: where.terminal.name, existing: true, ...unsent };
    throw new HttpError(409, 'This conversation runs in a terminal outside the dashboard: it cannot run in a second one.');
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
      // A chat at work counts as running there too: the picker opens it rather than a second one.
      for (const c of chat.cards()) if (c.status !== 'waiting') live.push({ cwd: c.cwd, chat: c.chatId });
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
      // ?tool=codex|opencode: that coding tool's own store (a conversation stays with the tool it was started in).
      const tool = toolFromRequest(q.get('tool'));
      if (tool !== 'claude') {
        assertToolReady(tool, cfg());
        return { tool, sessions: (await listToolSessions(tool, dir)).slice(0, 30).map((s) => ({ ...s, title: s.title || '(untitled)' })) };
      }
      const list = sessionsIn(dir).slice(0, 30);
      await readTitles(list.map((s) => s.file)); // only the ones shown, in pieces (titles.mjs)
      // chat: the App session that has it open (as the App's own list says); terminal: a terminal session runs it now
      // (its run record names it, read once for the whole list). A page offers no Delete for either.
      const runs = listRuns().filter((r) => r.status !== 'ended');
      return { sessions: list.map((s) => ({ id: s.id, at: s.mtimeMs, title: sessionName(s.file, s.id).slice(0, 120) || '(untitled)', chat: chat.openOf(s.id), terminal: runs.some((r) => runsConversation(r, s.id)) })) };
    }],
    // "Also open" in the new-session sheet: what may be opened beside a session in this folder, and its project's needs.
    ['GET', /^\/api\/folders\/extras$/, async (req, m, q) => {
      // No path: the choices before a project is chosen.
      const dir = q.get('path') ? insideRoots(v.absPath(q.get('path')), roots()) : null;
      if (q.get('path') && !dir) throw new HttpError(404, 'folder not found or not allowed');
      return (await import('../workspace/needs.mjs')).extraChoices(dir, { dir: workspaceDir(), projects: projectsIn() });
    }],
    // The owner's yes for a need of a project on this computer, or its taking back (workspace/needsyes.mjs): from his
    // own page only (the project's page, the new-session sheet), never from Tia's door or another computer.
    ['POST', /^\/api\/folders\/extras\/accept$/, async (req) => {
      if (ctx.caller(req) !== 'page') throw new HttpError(403, 'a need is allowed only on this dashboard\'s own page, by you');
      const b = await readJson(req);
      if (typeof b.need !== 'string' || typeof b.path !== 'string' || typeof b.allow !== 'boolean') throw bad('send { path, need, allow }');
      const dir = insideRoots(v.absPath(b.path), roots());
      if (!dir) throw new HttpError(404, 'folder not found or not allowed');
      try {
        return await (await import('../workspace/needs.mjs')).acceptNeed(null, b.need, { yes: b.allow, dir: workspaceDir(), projects: projectsIn(), folder: dir });
      } catch (e) {
        throw new HttpError(e.status || 400, e.message);
      }
    }],
    ['POST', /^\/api\/sessions$/, async (req) => {
      const b = await readJson(req);
      // Started through Tia's door (her in-process call, or another computer's dashboard relaying hers): the session
      // is hers, marked and signed in as hers by its launcher (launch.mjs). Never from the body: a page, a token or a
      // session cannot say it. Every other start is the owner's own and stays unmarked.
      const hers = fromHerDoor(ctx, req);
      const held = heldUntil(); // "start nothing new": a decision of Tia's while the computer was overloaded
      if (held) throw heldError(held);
      if (b.permissionMode === BYPASS && asRoot) throw Object.assign(new HttpError(409, ROOT_BYPASS_LINE), { details: { code: 'root-bypass' } });
      if (b.permissionMode === BYPASS && !bypassAllowed(cfg(), asRoot)) throw Object.assign(bad('bypass permissions mode (the coding tool then acts without asking you first) is off: turn on "Allow bypass permissions mode" in Settings → New sessions first.'), { details: { code: 'bypass-off' } });
      const dir = insideRoots(v.absPath(b.dir), roots());
      if (!dir) throw bad('choose a folder inside the allowed roots');
      await refuseSecretStart(ctx, req, dir); // the credentials folder and the sign-in places: only his own page starts there
      await (await import('../workspace/instep.mjs')).lookBeforeStart(dir); // 3 seconds at most; never throws
      // `tool`: the coding tool (absent: Claude Code, as before). Codex and OpenCode take their own choices.
      const tool = toolFromRequest(b.tool);
      // "Also open" is Claude Code's only: another coding tool cannot keep an extra folder read-only (refused first).
      if (tool !== 'claude' && Array.isArray(b.with) && b.with.length) throw bad('"Also open" works with Claude Code only: this coding tool gets no extra folders, because Hoprig cannot keep them read-only there');
      if (tool !== 'claude') assertToolReady(tool, cfg());
      // A session she started on Codex or OpenCode gets no hook, so her administrator-rights level cannot hold an
      // administrator command in it: Hoprig lets her start one only at Full (where her commands run cardless anyway).
      assertHerToolBound(tool, { hers, cfg: cfg() });
      // No provider chosen: the folder's default for that coding tool (the one it used there last, …: defaultprovider.mjs).
      if (b.profile === undefined || b.profile === null || b.profile === '') {
        b.profile = await defaultProviderIn(dir, null, tool);
        if (!b.profile) throw Object.assign(bad(tool === 'claude' ? 'there is no provider on this computer yet: add one under Providers first' : 'there is no provider for this coding tool yet: add one under Providers first'), { details: { code: 'no-provider' } });
      }
      const profile = pickProfile(b.profile, tool);
      if (!profile) throw bad('there is no such provider');
      const mode = ['new', 'continue', 'resume'].includes(b.mode) ? b.mode : null;
      if (!mode) throw bad('bad mode');
      if (tool !== 'claude') {
        let sid = null;
        if (mode === 'resume') {
          sid = isToolSessionId(tool, b.sessionId) ? b.sessionId : null;
          if (!sid || !(await listToolSessions(tool, dir)).some((s) => s.id === sid)) throw bad('that conversation is not in this folder');
        }
        // One conversation runs in one place only, as for Claude Code ("continue": the folder's newest of the tool): a
        // chat or a terminal that runs it already is the answer (chat.startTerminal, by the tool's own records).
        const runs = mode === 'resume' ? sid : mode === 'continue' ? ((await listToolSessions(tool, dir))[0] || {}).id : null;
        let prompt = null;
        if (b.prompt !== undefined && b.prompt !== null) {
          prompt = v.message(b.prompt);
          if (!prompt) throw bad(`the first message must be 1 to ${v.MESSAGE_MAX} bytes`);
        }
        // The newest is started by its id, as for Claude Code: its launcher names it in its run record from the start.
        const go = async () => ({ name: await deck.start({ tool, dir, profile, mode: runs ? 'resume' : mode, sessionId: runs || sid, prompt, flags: toolFlags(tool, b), hers }) });
        const r = runs ? await chat.startTerminal(runs, go, tool) : await go();
        if (r.existing) return runsAlready(r.existing, prompt);
        watcher.poke();
        return { name: r.name, tool };
      }
      let sid = null;
      if (mode === 'resume') {
        sid = v.sessionId(b.sessionId);
        if (!sid || !sessionsIn(dir).some((s) => s.id === sid)) throw bad('that conversation is not in this folder');
      }
      // One conversation runs in one place only. "continue" (-c) is the folder's newest conversation.
      const runs = mode === 'resume' ? sid : mode === 'continue' ? (sessionsIn(dir)[0] || {}).id : null;
      // An optional first message (Tia's start_session), whole: several lines too (deck.mjs promptArgs).
      let prompt = null;
      if (b.prompt !== undefined && b.prompt !== null) {
        prompt = v.message(b.prompt);
        if (!prompt) throw bad(`the first message must be 1 to ${v.MESSAGE_MAX} bytes`);
      }
      // Options for this one session (New session → Options); the fixed lists in config.mjs, never free text.
      const flags = [];
      // "Allow everything" (bypassgate.mjs ALL): Claude Code runs in bypassPermissions and the session's hook and launcher
      // do the rest (hook.mjs). Only the owner's own page starts it, by the choice or by the default; any other start
      // (Tia's door, another computer, a schedule) that would take the default of it starts in Bypass (sessionArgs).
      let all = false;
      const ownPage = ctx.caller(req) === 'page' && !hers;
      if (b.permissionMode === ALL) {
        const why = allRefusal({ cfg: cfg(), root: asRoot, page: ownPage, hers });
        if (why) throw allError(HttpError, why);
        all = true;
        flags.push('--permission-mode', BYPASS);
      } else if (b.permissionMode !== undefined && b.permissionMode !== null) {
        if (!PERMISSION_MODES.includes(b.permissionMode)) throw bad(`the permission mode must be one of: ${PERMISSION_MODES.join(', ')}`);
        flags.push('--permission-mode', b.permissionMode);
      } else if ((cfg().sessionDefaults || {}).permissionMode === ALL && ownPage && allAllowed(cfg(), asRoot)) all = true;
      if (b.effort !== undefined && b.effort !== null) {
        if (!EFFORTS.includes(b.effort)) throw bad(`the effort must be one of: ${EFFORTS.join(', ')}`);
        flags.push('--effort', b.effort);
      }
      if (b.model !== undefined && b.model !== null) {
        // The provider's own list as known now, a family name, the saved default or a checked exact name (catalog.mjs).
        const why = modelProblem(profile.name === AUTO.name ? 'auto' : profile, b.model, { saved: sessionModels() });
        if (why) throw bad(why);
        flags.push('--model', b.model);
      }
      // The folder's newest conversation is started by its id, not by -c: the launcher then names it in its run record
      // from the first moment (launch.mjs conversationOf), and nothing else can start a process on it meanwhile.
      // "Also open": each name checked here, and again by the launcher at the start (launch.mjs startExtras).
      for (const name of await ctx.checkWith(b.with, dir)) flags.push('--with', name);
      const go = async () => ({ name: await deck.start({ dir, profile, mode: runs ? 'resume' : mode, sessionId: runs || sid, prompt, flags, hers, all }) });
      const r = runs ? await chat.startTerminal(runs, go) : await go();
      if (r.existing) return runsAlready(r.existing, prompt);
      watcher.poke();
      return { name: r.name };
    }],
    ['POST', /^\/api\/shells$/, async (req) => {
      const b = await readJson(req);
      const r = roots();
      const dir = b.dir ? insideRoots(v.absPath(b.dir), r) : r[0];
      if (!dir) throw bad('choose a folder inside the allowed roots');
      // The terminal pane under a chat sends its chat's id: the shell is made for that chat and ends when it is archived.
      if (b.chat !== undefined && (typeof b.chat !== 'string' || !b.chat || b.chat.length > 100)) throw bad('bad chat');
      const name = await deck.shell(dir);
      if (b.chat) chat.madeShell(b.chat, name);
      return { name };
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
      const name = decodeURIComponent(m[1]);
      const { term, run } = await sessionOr404(name);
      // The page's answer to a permission dialog (Allow: 1, Do not allow: Escape, "always": that answer's number,
      // `expect` its words; `about`: the command or file its card showed) is typed only while Claude Code's permission
      // dialog stands on the screen (prompts.mjs), shows that command or file, and for "always" still has that answer
      // in the same words; and only while one asker waits (with two, the card shows the newest ask while the dialog
      // shows Claude Code's own queue). The card can be a moment old: a key would then answer whatever came next (the
      // plan's approval, which turns bypass on; a question Claude put to the owner; another tool's call). A number
      // takes its answer at once wherever the arrow is (seen on 2.1.326); Enter takes the answer the arrow is on, so
      // it is typed only while the arrow is on "1. Yes" (a page of before sends it). The screen is looked at as the
      // last step before the key goes (backends/index.mjs `when`).
      let when = null;
      if (b.expect !== undefined) {
        if (typeof b.expect !== 'string' || !/^[1-9]$/.test(b.key)) throw bad('bad answer');
        when = { lines: SCREEN_LINES, message: 'The question on the screen changed. Look at the session and answer there', test: (screen) => {
          const now = alwaysOption(screen);
          return !!now && now.key === b.key && now.text === b.expect;
        } };
      } else if (b.question === true) {
        if (!['1', 'Enter', 'Escape'].includes(b.key)) throw bad('bad answer');
        when = { lines: SCREEN_LINES, test: permissionQuestion, message: 'No permission question is on the screen now. Look at the session and answer there' };
      }
      if (when) {
        if (Array.isArray(run?.asks) && run.asks.length > 1) throw new HttpError(409, 'More than one question waits. Answer them in the terminal');
        const dialog = when.test;
        const about = typeof b.about === 'string' ? b.about : '';
        when.test = (screen) => {
          if (!dialog(screen)) return false;
          if (!dialogShows(screen, about, run?.cwd)) return !(when.message = 'The question on the screen is not the one the card shows. Look at the session and answer there');
          if (b.key === 'Enter' && permissionDialog(screen).cursor !== 1) return !(when.message = 'The answer chosen on the screen is not "Yes". Look at the session and answer there');
          return true;
        };
      }
      // `owner: true`: the page's own answer and stop buttons, the owner's keys: to whatever runs there, as before. Anyone
      // else (the assistant, which may never send that key: assistant/door.mjs) presses a key only for the coding tool
      // while it is in front (deck.mjs keyToTool; 409 otherwise): an Enter never runs what stands on a shell's line.
      if (b.owner === true) await ownKeysOnly(req, name);
      if (b.owner !== true) {
        if (when && !when.test(await backend.capture(term.id, SCREEN_LINES))) throw new HttpError(409, when.message);
        await deck.keyToTool(name, b.key);
      } else if (/^[1-9]$/.test(b.key)) await backend.sendText(term.id, b.key, { when });
      else await backend.sendKey(term.id, b.key, { when });
      // "Do not allow" ends the turn without an event from Claude Code: the card follows the screen at once (deck.mjs).
      if (b.question === true && b.key === 'Escape') deck.noteRefused(name, run);
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
      // `expect: 'waiting'` (the reply box on a Home card): typed only while the session still waits for an answer, as
      // the card showed it. Its run record is read again under the typing lock right before the bytes (typing.mjs), and
      // a menu on its screen (a permission dialog, a question, the menu at a limit: prompts.mjs menuOpen, as the
      // continue route reads it) would take the words as its answer: 409 then, nothing typed. Its one value; without it
      // the send is as before.
      if (b.expect !== undefined && b.expect !== 'waiting') throw bad('expect knows one value: "waiting"');
      if (b.expect !== undefined && b.owner === true) throw bad('expect is for a message to the coding tool, not for the owner\'s own keys');
      const name = decodeURIComponent(m[1]);
      const { term } = await sessionOr404(name);
      const stillWaiting = (run) => {
        if (run.status !== 'waiting') throw new HttpError(409, `Nothing was sent: ${name} is no longer waiting for an answer.`);
      };
      const guard = b.expect === 'waiting' ? async (run, t) => {
        stillWaiting(run);
        if (menuOpen(await backend.capture(t.id, SCREEN_LINES, { now: true }))) throw new HttpError(409, `Nothing was sent: ${name} shows a question on its screen. Open the session to answer it there.`);
      } : null;
      // Its Enter, a moment after the text, goes only while the record still waits (a question since would take it as
      // its answer): the record alone then, as the typed text in the message box can read as a menu. A refused Enter
      // is "typed but not sent" (typing.mjs).
      // `owner: true`: the session page's message box, the owner's own keys: typed into whatever runs there, as he sees
      // it. Anyone else (the assistant, which may never send that key: assistant/door.mjs; a request without it) types
      // only for the coding tool while it is in front, never a control byte (src/server/typing.mjs; 409 otherwise).
      if (b.owner === true) await ownKeysOnly(req, name);
      if (b.owner === true) await deck.send(term.id, text, { enter: b.enter !== false });
      else await deck.sendToTool(name, text, { enter: b.enter !== false, ...(guard ? { guard, enterGuard: stillWaiting } : {}) });
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
      const { term, run } = await sessionOr404(decodeURIComponent(m[1]));
      if (!run) throw new HttpError(409, 'this is a plain shell, not a coding session started by the launcher');
      // The conversation stays in its coding tool: only a provider that serves that tool may take it.
      const profile = pickProfile(b.profile, run.tool || 'claude');
      if (!profile) throw bad('there is no such provider');
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
      // Usage limits are followed for Claude Code only: a Codex or OpenCode session is never at one here.
      if ((run.tool || 'claude') !== 'claude') throw new HttpError(409, 'only a Claude Code session waits at a usage limit here');
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
      // The prompt is for Claude Code's own prompt: typed only while it is in front (409 with the reason otherwise).
      await deck.sendToTool(name, prompt);
      watcher.poke();
      return { ok: true };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/rename$/, async (req, m) => {
      const b = await readJson(req);
      if (!backend.validName(b.name)) throw bad('use letters, digits, - and _ (up to 40)');
      const name = decodeURIComponent(m[1]);
      const { taken, run } = await sessionOr404(name);
      if (taken.includes(b.name)) throw new HttpError(409, 'that name is taken');
      await backend.rename(name, b.name);
      // A Claude Code session is shown by its conversation's name (deck.mjs): the rename names the conversation, as
      // a rename in the App does, so it is the name everywhere and wins over Claude Code's later titles.
      if (run && (run.tool || 'claude') === 'claude' && run.sessionId) {
        const s = sessionsIn(run.cwd).find((x) => x.id === run.sessionId);
        setOwnName(run.sessionId, b.name, s ? s.file : null);
      }
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
    // A file dropped or pasted on a session's terminal (web/session.js): the page types the path it gets back, as a
    // terminal does on a drop. Kept in Hoprig's state folder (<state>/drops/<session>), never in the session's
    // repository; the same size limit and clean name as an attachment; a week, then a later drop removes it.
    // The path ends in /upload: a relay to another computer passes the body on as raw bytes (machines/legs.mjs).
    ['POST', /^\/api\/sessions\/([^/]+)\/drop\/upload$/, async (req, m) => {
      const s = cfg().server;
      const maxBytes = Math.max(1, Number(s.uploadMaxMB) || DEFAULT_UPLOAD_MAX_MB) * 1024 * 1024;
      const name = decodeURIComponent(m[1]);
      await sessionOr404(name); // a name of letters, digits, ". _ -" that never starts with "." (validate.mjs)
      const dir = dropsFolder(stateDir());
      try {
        pruneDrops(dir);
      } catch {
        /* a file that cannot be removed now is tried again with the next drop */
      }
      let fileName = 'upload';
      try {
        fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload'));
      } catch {
        /* keep the default */
      }
      return saveUpload(req, { cwd: dir, dirName: name, fileName, maxBytes, ignoreFile: false });
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
      // Choosing Allow everything as the default of new sessions: only the owner's own page, after he accepted it; a
      // default that is carried unchanged passes (Tia's change_setting sends the whole block back).
      if (b.sessionDefaults && typeof b.sessionDefaults === 'object' && b.sessionDefaults.permissionMode === ALL && (cfg().sessionDefaults || {}).permissionMode !== ALL) {
        const why = allRefusal({ cfg: cfg(), root: asRoot, page: ctx.caller(req) === 'page' && !fromHerDoor(ctx, req) });
        if (why) throw allError(HttpError, why);
      }
      let serverPatch = null;
      let sessionDefaults = null;
      let stayRoot = null;
      try {
        // Check everything first; save only when all of it is valid.
        if (b.server !== undefined) serverPatch = cleanServerPatch(b.server);
        if (b.sessionDefaults !== undefined) sessionDefaults = cleanSessionDefaults(b.sessionDefaults);
        if (sessionDefaults && sessionDefaults.permissionMode === BYPASS && asRoot && (cfg().sessionDefaults || {}).permissionMode !== BYPASS) throw new Error(ROOT_BYPASS_LINE);
        if (sessionDefaults && sessionDefaults.permissionMode === BYPASS && !asRoot && !bypassAllowed(cfg())) throw Object.assign(new Error('bypass permissions mode (the coding tool then acts without asking you first) is off: turn on "Allow bypass permissions mode" in Settings → New sessions first.'), { details: { code: 'bypass-off' } });
        // Keeping Hoprig on root on purpose: only as root, and only with the sentence typed as it is written (its case
        // aside), so it is never chosen by one click or for a computer that is not on root.
        if (b.stayRoot !== undefined) stayRoot = stayRootChoice(b.stayRoot, asRoot);
        if (b.sessionTitles !== undefined && typeof b.sessionTitles !== 'boolean') throw new Error('sessionTitles must be true or false');
        if (b.autoSwitch !== undefined) {
          if (!b.autoSwitch || typeof b.autoSwitch !== 'object' || Array.isArray(b.autoSwitch)) throw new Error('autoSwitch must be an object');
          autoswitch.setAutoSwitch(b.autoSwitch);
        }
      } catch (e) {
        // A refusal that names its place keeps its code (web/errorways.js), so the page draws the button to it.
        throw Object.assign(bad(e.message), e.details ? { details: e.details } : {});
      }
      if (serverPatch && serverPatch.notify) serverPatch.notify = keepHeaders(serverPatch.notify, cfg().server.notify);
      if (serverPatch && Object.keys(serverPatch).length) saveConfig({ server: serverPatch });
      if (sessionDefaults) saveConfig({ sessionDefaults });
      if (typeof b.sessionTitles === 'boolean') saveConfig({ sessionTitles: b.sessionTitles });
      if (stayRoot !== null) saveConfig({ [STAY_ROOT_KEY]: stayRoot });
      watcher.poke();
      return settingsView();
    }],
    ['POST', /^\/api\/settings\/password$/, async (req, m, q, res) => {
      // Only a signed-in browser gets here, so the overall cap (which an attacker could fill) does not apply. Counted
      // as the login counts its visitor: this computer is one, whatever loopback address it uses.
      const { ip } = visitorFor(req);
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
      await deck.terminal({ name, dir: r[0] || os.homedir(), argv: [...deck.launcher(), 'add'] });
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
      if (!base) throw Object.assign(bad('this page\'s address is not known here: set it in Settings → Notifications → This page\'s address'), { details: { code: 'notify-address' } });
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

  // Who a sign-in try is counted as. The overall cap of the sign-in limit (auth.mjs RateLimiter) counts every password
  // try from elsewhere, whatever the password is like: it bounds a guess spread over many addresses and the hashes
  // strangers can make us run. This computer itself is left out of it, so guesses from the internet cannot lock the
  // owner out at his own machine; a sign-in link (loginByLink) never counts. In return this computer is ONE visitor
  // under one key: it owns every 127.x address and ::1, and counting each as its own visitor gave it no limit at all.
  // A visitor the public link's tunnel forwards is the one Cloudflare names (security.mjs forwardedVisitor).
  const visitorFor = (req) => (sameComputer(req)
    ? { ip: THIS_COMPUTER, lim: { overall: false } }
    : { ip: forwardedVisitor(req, proxyOpts()) || clientIp(req, proxyOpts()), lim: { overall: true } });

  async function login(req, res) {
    const { ip, lim } = visitorFor(req);
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
   * A sign-in link: the token from the link's #fragment, sent once by the login page. Limited per visitor like the
   * login, but in a count of its own and never by the overall cap: it is the owner's way in from outside while
   * someone guesses the password, so wrong passwords (also from his own address) never lock it.
   */
  async function loginByLink(req, res) {
    const { ip } = visitorFor(req);
    const lim = { overall: false };
    const wait = linkLimiter.retryAfter(ip, lim);
    if (wait > 0) {
      return send(res, 429, { error: `Too many tries. Wait ${Math.ceil(wait / 60000)} min.` }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    }
    const b = await readJson(req);
    linkLimiter.fail(ip, lim);
    if (!useLoginLink(b.token)) return send(res, 401, { error: 'This sign-in code was used already or is too old. On the computer, press Show a sign-in code again.' });
    linkLimiter.succeed(ip, lim);
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
    // What set-up and doctor ask the running dashboard: its version, where it really listens, and the sessions in its
    // built-in terminals (they end with it; tmux sessions do not). Only from this computer, with the key of the
    // dashboard file only this user can read; anything else is told nothing.
    if (p === '/api/local/facts' && method === 'GET') {
      const k = req.headers['x-hoprig-local-key'];
      // Bytes, not characters, are compared: a header of the right length in letters but not in bytes (é) is a wrong key.
      const got = typeof k === 'string' ? Buffer.from(k) : null;
      const ok = sameComputer(req) && got && got.length === Buffer.byteLength(localKey()) && crypto.timingSafeEqual(got, Buffer.from(localKey()));
      if (!ok) return send(res, 404, { error: 'not found' });
      const a = server.address();
      const terms = backend.kind === 'pty' ? (await backend.list()).map((t) => t.session).filter(Boolean) : [];
      return send(res, 200, { version: VERSION, pid: process.pid, state: stateKey(), host: a && typeof a === 'object' ? a.address : null, port: a && typeof a === 'object' ? a.port : null, backend: backend.kind, terminals: terms });
    }

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
      const card = confirmedCard();
      if (card) req[CARD] = card;
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
      // A session that holds a line for the owner to run (Health): a token types there only for a hub's own page.
      if (viaToken && (await deck.isLineReady(name)) && !(await ownLinePage(ctx, req))) return reject(409, 'Conflict');
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
    routes, // the route table (the page's and every feature's), read by the inventory test of what Tia can do (test/assistant/inventory.test.mjs)
    listen(port = opts.port ?? first.port ?? DEFAULT_PORT, host = opts.host ?? first.host ?? DEFAULT_HOST) {
      return new Promise((resolve, reject) => {
        // Each try takes its own two handlers off again, whichever comes: a start that tries again on a held port
        // (takeover.mjs) would otherwise add a 'listening' handler per try (MaxListenersExceededWarning).
        const failed = (e) => {
          server.off('listening', listening);
          reject(e);
        };
        const listening = () => {
          server.off('error', failed);
          started();
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(port, host);
        function started() {
          if (opts.watch !== false) watcher.start();
          // Its requests list the run records: on Windows asking the system who runs a pid takes most of a second.
          processes.askInBackground();
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
          for (const f of opts.startFeatures === false ? [] : features) {
            try {
              f.start?.(ctx);
            } catch (e) {
              console.error(`feature ${f.name}: ${e.message}`);
            }
          }
          resolve(server.address());
        }
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
