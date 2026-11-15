// VS Code for the project folders, as a server feature: { name, routes, handle, upgrade, start, close }.
//
// Three ways to open a folder. The dashboard offers only folders inside its roots (server.roots), but that is a choice
// of what to offer, not a limit: VS Code runs as this user, and inside it Open Folder, its file links and its
// terminal reach every file this user can. Turning it on gives the dashboard's login that reach (as a session does).
//   in the browser       VS Code's own browser version (`code serve-web`, process.mjs), behind the dashboard's login at
//                        /vscode/ (proxy.mjs), so it works wherever the dashboard works: the network or a public link.
//                        Not on Windows yet (process.mjs says why).
//   on this computer     `code <folder>` opens the desktop VS Code on this computer's own screen
//   on another device    a vscode://vscode-remote/ssh-remote+<target><folder> link (the page builds it) for a device
//                        whose VS Code has Remote-SSH and reaches this computer by SSH
// Only for this computer: the relay to another computer (/m/<name>/…) carries the API and the terminals, not VS Code,
// and these routes refuse another computer's token.
//
// config.json key "vscode" (all optional):
//   enabled            true: VS Code in the browser may start           default false (it runs programs)
//   licenseAcceptedAt  when the owner accepted the VS Code Server license (it is never started before)
//   idleMinutes        stopped when no VS Code page has been open this long   default 15
//   sshTarget          for "on another device": user@host or a name from the device's SSH config
//
//   GET  /api/vscode            the state: { installed, enabled, license, idleMinutes, running, starting, error,
//                               desktop: { available }, sshTarget, install }
//   POST /api/vscode/settings   { enabled?, acceptLicense?, idleMinutes?, sshTarget? }
//   POST /api/vscode/desktop    { dir }: open the folder in VS Code on this computer's screen
//   GET  /vscode/?folder=<dir>  VS Code in the browser (started on demand)
import { spawn } from 'node:child_process';
import os from 'node:os';
import { insideRoots, resolveRoots } from '../server/folders.mjs';
import { requestHost } from '../server/security.mjs';
import { BASE, VscodeServer, browserSupported, childEnv, findCode, spawnPlan } from './process.mjs';
import { proxyHttp, proxyUpgrade, refuseUpgrade } from './proxy.mjs';

export const LICENSE_URL = 'https://aka.ms/vscode-server-license';
export const PRIVACY_URL = 'https://privacy.microsoft.com/en-US/privacystatement';
export const DEFAULT_IDLE_MINUTES = 15;
const SSH_TARGET_RE = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const OURS = /^\/vscode(\/|$)/;

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/** Where to get VS Code, for this system. Nothing is installed by itself. */
export function installHelp(platform = process.platform) {
  const url = 'https://code.visualstudio.com/download';
  if (platform === 'darwin') return { url, text: 'Download VS Code for macOS, move it to Applications, then run "Shell Command: Install \'code\' command in PATH" from its command palette.' };
  if (platform === 'win32') return { url, text: 'Download and run the VS Code installer for Windows (it puts the code command on the PATH).' };
  return { url, text: 'Install the .deb or .rpm package from the download page (or: snap install code --classic), so that the code command exists.' };
}

/**
 * Whether `code <folder>` would open a window someone sees: macOS and Windows run it in the signed-in user's desktop;
 * on Linux the dashboard must know the desktop session (DISPLAY or WAYLAND_DISPLAY in its environment).
 */
export function desktopAvailable(env = process.env, platform = process.platform) {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** The "vscode" settings as stored, with defaults. */
export function vscodeSettings(cfg) {
  const s = cfg && cfg.vscode && typeof cfg.vscode === 'object' ? cfg.vscode : {};
  const idle = Number(s.idleMinutes);
  return {
    enabled: s.enabled === true,
    licenseAcceptedAt: typeof s.licenseAcceptedAt === 'string' ? s.licenseAcceptedAt : null,
    idleMinutes: Number.isInteger(idle) && idle >= 5 && idle <= 1440 ? idle : DEFAULT_IDLE_MINUTES,
    sshTarget: typeof s.sshTarget === 'string' && SSH_TARGET_RE.test(s.sshTarget) ? s.sshTarget : '',
  };
}

/** A settings patch from the browser, checked; the full new "vscode" object. */
export function cleanVscodePatch(b, cur, { installed, supported = true }) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'send an object');
  const next = { ...cur };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'acceptLicense') {
      if (v !== true) throw fail(400, 'acceptLicense can only be true');
      next.licenseAcceptedAt = cur.licenseAcceptedAt || new Date().toISOString();
    } else if (k === 'enabled') {
      if (typeof v !== 'boolean') throw fail(400, 'enabled must be true or false');
      next.enabled = v;
    } else if (k === 'idleMinutes') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 5 || n > 1440) throw fail(400, 'the idle time must be a whole number of minutes from 5 to 1440');
      next.idleMinutes = n;
    } else if (k === 'sshTarget') {
      const t = typeof v === 'string' ? v.trim() : null;
      if (t === null || (t && !SSH_TARGET_RE.test(t))) throw fail(400, 'the SSH address must look like you@computer or a name from your SSH config');
      next.sshTarget = t;
    } else throw fail(400, `"${k}" cannot be changed here`);
  }
  if (next.enabled && !next.licenseAcceptedAt) throw fail(409, 'accept the VS Code Server license first', 'license');
  if (next.enabled && !cur.enabled && !installed) throw fail(409, 'VS Code is not installed on this computer', 'not-installed');
  if (next.enabled && !cur.enabled && !supported) throw fail(409, 'VS Code in the browser is not offered on Windows yet', 'not-supported');
  return next;
}

/**
 * `opts`: command (argv of a stand-in for `code`, tests), desktopCommand (argv for "on this computer"), env,
 * platform, dataDir, readyMs, tickMs (how often the idle stop looks).
 */
export function vscodeFeature(sctx, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const vs = new VscodeServer({ command: opts.command || null, env, platform, dataDir: opts.dataDir || null, ...(opts.readyMs ? { readyMs: opts.readyMs } : {}) });
  const settings = () => vscodeSettings(sctx.config());
  const roots = () => resolveRoots(sctx.config().server.roots);
  const installed = () => Boolean(opts.command || findCode(env, platform));
  const proxyOpts = () => ({ trustProxy: sctx.config().server.trustProxy === true });

  // The idle stop: how many VS Code WebSockets are open (an open VS Code tab keeps one), and when it was last used.
  let open = 0;
  let lastUse = Date.now();
  let stopping = null;
  let timer = null;

  const stop = () => {
    if (!stopping) stopping = vs.stop().finally(() => (stopping = null));
    return stopping;
  };
  const ensure = async () => {
    if (stopping) await stopping;
    lastUse = Date.now();
    await vs.start();
  };
  function idleCheck(now = Date.now()) {
    if (!vs.child || vs.starting || open > 0) return false;
    if (now - lastUse < settings().idleMinutes * 60_000) return false;
    stop();
    return true;
  }

  /** The folder to open: one the dashboard offers (inside the roots), else a 400 the page shows. Not a limit (header). */
  const folderOf = (dir) => {
    const real = insideRoots(dir, roots());
    if (!real) throw fail(400, 'choose a folder inside the folders this dashboard may show');
    return real;
  };

  function view() {
    const s = settings();
    return {
      installed: installed(),
      browser: browserSupported(platform), // false: the page offers only the other ways
      enabled: s.enabled,
      license: { accepted: Boolean(s.licenseAcceptedAt), at: s.licenseAcceptedAt, url: LICENSE_URL, privacy: PRIVACY_URL },
      idleMinutes: s.idleMinutes,
      running: vs.running,
      starting: vs.starting,
      error: vs.error,
      desktop: { available: desktopAvailable(env, platform) },
      sshTarget: s.sshTarget,
      install: installHelp(platform),
    };
  }

  async function openOnDesktop(dir) {
    if (!desktopAvailable(env, platform)) throw fail(409, 'This computer has no desktop session the dashboard can open a window in.', 'no-desktop');
    const prog = opts.desktopCommand || (findCode(env, platform) ? [findCode(env, platform)] : null);
    if (!prog) throw fail(409, 'VS Code is not installed on this computer.', 'not-installed');
    const plan = spawnPlan([...prog, dir], platform, env);
    // DISPLAY and the like stay: they are how it finds the screen. A provider's sign-in does not go along.
    const child = spawn(plan.command, plan.args, { ...plan.options, env: childEnv(env), cwd: os.homedir(), stdio: 'ignore', detached: true, windowsHide: false });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(fail(500, `VS Code could not be started: ${e.message}`)));
    });
    child.unref();
    return { opened: true };
  }

  // Only this dashboard's own login (or the owner's in-process call): another computer that controls this one with
  // its token may not accept a license here or open windows on this screen. The relay names the refusal as such.
  const own = (req) => {
    if (!sctx.authed(req)) throw fail(403, 'VS Code is opened from this computer\'s own dashboard', 'token-forbidden');
  };
  const routes = [
    ['GET', /^\/api\/vscode$/, async (req) => {
      own(req);
      return view();
    }],
    ['POST', /^\/api\/vscode\/settings$/, async (req) => {
      own(req);
      const b = await sctx.readJson(req);
      const next = cleanVscodePatch(b, settings(), { installed: installed(), supported: browserSupported(platform) });
      sctx.saveConfig({ vscode: next });
      if (!next.enabled) await stop();
      return view();
    }],
    ['POST', /^\/api\/vscode\/desktop$/, async (req) => {
      own(req);
      const b = await sctx.readJson(req);
      return openOnDesktop(folderOf(b.dir));
    }],
  ];

  const text = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  /** The request line VS Code gets: the browser's own path and query. */
  const upstreamPath = (url) => `${url.pathname}${url.search}`;

  /**
   * The landing page opens only a folder the dashboard offers (inside the roots) and no ?workspace= file, so a link
   * cannot start VS Code somewhere unexpected. Not a limit: inside VS Code every file of this user is reachable.
   */
  function pageRefusal(url) {
    if (url.pathname !== BASE && url.pathname !== `${BASE}/`) return null;
    if (url.searchParams.has('workspace')) return 'Open a folder from the dashboard instead of a workspace file.';
    const f = url.searchParams.get('folder');
    if (f !== null && !insideRoots(f, roots())) return 'This folder is not one the dashboard may show. Open a project from the Workspace page.';
    return null;
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return false;
    }
    if (!OURS.test(url.pathname)) return false;
    if (!sctx.authed(req)) {
      if (req.method === 'GET' && /text\/html/.test(String(req.headers.accept || ''))) {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        res.end();
      } else text(res, 401, 'Log in to the dashboard first.');
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sctx.originOk(req)) {
      text(res, 403, 'cross-site request refused');
      return true;
    }
    const s = settings();
    if (!s.enabled || !s.licenseAcceptedAt) {
      text(res, 403, 'VS Code in the dashboard is off. Turn it on in the dashboard: Settings → VS Code.');
      return true;
    }
    const refused = pageRefusal(url);
    if (refused) {
      text(res, 403, refused);
      return true;
    }
    const p = upstreamPath(url);
    if (!vs.running) {
      // Only VS Code's own page starts it (a reload after the idle stop); its other files wait for that page.
      if (url.pathname !== BASE && url.pathname !== `${BASE}/`) {
        text(res, 503, 'VS Code is not running. Open it again from the dashboard.');
        return true;
      }
      try {
        await ensure();
      } catch (e) {
        text(res, 502, `VS Code could not be started: ${e.message}`);
        return true;
      }
    }
    lastUse = Date.now();
    await proxyHttp(req, res, vs.target, { host: requestHost(req, proxyOpts()), path: p });
    lastUse = Date.now();
    return true;
  }

  async function upgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return false;
    }
    if (!OURS.test(url.pathname)) return false;
    if (!sctx.originOk(req)) refuseUpgrade(socket, 403, 'Forbidden');
    else if (!sctx.authed(req)) refuseUpgrade(socket, 401, 'Unauthorized');
    else if (!settings().enabled || !vs.running) refuseUpgrade(socket, 503, 'Service Unavailable');
    else {
      await proxyUpgrade(req, socket, head, vs.target, {
        host: requestHost(req, proxyOpts()), path: upstreamPath(url),
        onOpen: () => {
          open++;
          lastUse = Date.now();
        },
        onClose: () => {
          open = Math.max(0, open - 1);
          lastUse = Date.now();
        },
      });
    }
    return true;
  }

  return {
    name: 'vscode',
    routes,
    handle,
    upgrade,
    start() {
      try {
        vs.cleanLeftover();
      } catch {
        /* nothing to clean */
      }
      timer = setInterval(() => idleCheck(), opts.tickMs || 30_000);
      timer.unref();
    },
    async close() {
      clearInterval(timer);
      await stop();
    },
    // For tests: the server object and the idle check.
    vscode: { server: vs, idleCheck, openCount: () => open },
  };
}
