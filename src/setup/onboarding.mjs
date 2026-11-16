// "Get started" as data for the dashboard: the steps a new user goes through, each done or not, and what to open.
//
//   GET  /api/onboarding                       (owner only: the login cookie, never another dashboard's token)
//   → {
//       steps: [{
//         id:       "claude" | "tools" | "rules" | "project" | "skills" | "phone" | "account2" | "computer",
//         title:    string,            one line, plain words
//         done:     boolean,
//         optional: boolean,           true for "account2" and "computer": shown, never counted as missing
//         detail:   string,            what is there now (never a key, a token, a password or an e-mail)
//         action:   null | { kind: "page", target: string }          the part of the page to open:
//                                       "pc/setup" | "pc/projects" | "settings/skills" | "settings/signin-device"
//                                       | "settings/accounts" | "settings/computers"
//                        | { kind: "terminal", run: string, label: string }   POST /api/onboarding/run { run } opens a
//                                       terminal session with that command ("claude-login": Claude Code's own sign-in)
//                        | { kind: "install-claude", label: string }   POST /api/onboarding/install-claude installs
//                                       Claude Code as a background job in the page (GET /api/onboarding/job)
//                        | { kind: "request", method: "POST", path: string, body: object }   a route the page calls
//                        | { kind: "claude-login", label: string }   the page signs Claude Code in itself
//                                       (src/server/claudelogin.mjs; "claude-login" above stays its terminal way)
//       }],
//       done: number, total: number,   required steps done / required steps
//       checkedAt: number              when the slow parts (Claude Code, the coding tools) were last looked at
//     }
//   POST /api/onboarding/run { run }           → { session }: the command in a new terminal session (owner only)
//   POST /api/onboarding/install-claude        → { started: true }: Claude Code with its official installer, and the
//                                              first provider ("sub"), as a background job (owner only)
//   GET  /api/onboarding/job?from=N            that job: { running, lines, next, result: { ok, version } }
//
// The slow parts (running `claude`, looking for every coding tool) are cached for a minute; the rest are file reads.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { loginSeen } from '../routerstate.mjs';
import { stateDir } from '../paths.mjs';
import { uniqueName } from '../server/validate.mjs';

const CACHE_MS = 60_000;

// The terminal commands the page may ask for: argv built here, never from the request. Only Claude Code's own
// sign-in is left here; installing it and the coding tools run in the page.
export function runCommands(launcher, claudeBin) {
  return {
    'claude-login': { label: 'Sign in to Claude', argv: [claudeBin, 'auth', 'login'] },
  };
}

/** Install Claude Code (the official installer) and make the first provider, like `hoprig setup` does. */
async function installClaude({ onLine }) {
  const cc = await import('../claudecode.mjs');
  const r = await cc.claudeInstall({ onLine });
  if (r.ok) (await import('../menu.mjs')).ensureFirstProfile();
  return r;
}

/** Live browser sessions of the dashboard (a count; the file holds only hashes and expiry times). */
export function browserSessions(file = path.join(stateDir(), 'web-sessions.json'), now = Date.now()) {
  try {
    return Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).filter((s) => s && s.expires > now).length;
  } catch {
    return 0;
  }
}

const real = {
  claude: async () => {
    const cc = await import('../claudecode.mjs');
    const [info, login] = await Promise.all([cc.claudeInfo({ fetchImpl: async () => ({ ok: false }) }), cc.claudeLoginStatus()]);
    return { installed: info.installed, loggedIn: login.loggedIn };
  },
  tools: async () => {
    const { sysFacts, detectKits } = await import('../pcsetup/detect.mjs');
    const { KITS } = await import('../pcsetup/kits.mjs');
    const found = await detectKits(await sysFacts(), KITS.filter((k) => k.defaultOn).map((k) => k.id));
    const missing = Object.values(found).flat().filter((i) => i.state === 'missing' && i.id !== 'identity' && i.id !== 'signin').map((i) => i.name);
    return { missing };
  },
  rules: async () => (await import('../pcsetup/rules.mjs')).rulesState(),
  projects: async () => {
    const { projectsDir, listRepos } = await import('../pcsetup/projects.mjs');
    return listRepos(projectsDir()).map((d) => path.basename(d));
  },
  skills: async () => (await import('../skillhub/hub.mjs')).installed({}).skills.map((s) => s.name),
  profiles: async () => (await import('../profiles.mjs')).listProfiles(),
  machines: async () => (await import('../machines/store.mjs')).loadMachines(),
  sessions: async () => browserSessions(),
};

/** The steps, from facts. Pure, so each step's done/not-done can be tested. */
export function onboardingSteps(f) {
  const page = (target) => ({ kind: 'page', target });
  const claudeDone = !!(f.claude.installed && (f.claude.loggedIn || f.profiles.some((p) => p.kind !== 'login')));
  const auto = (() => {
    try {
      return !!(loadConfig().autoSwitch || {}).enabled;
    } catch {
      return false;
    }
  })();
  return [
    {
      id: 'claude', title: 'Claude Code installed and signed in', optional: false, done: claudeDone,
      detail: !f.claude.installed ? 'Claude Code is not installed' : claudeDone ? `Claude Code ${f.claude.installed}` : 'not signed in yet',
      action: claudeDone ? null : !f.claude.installed ? { kind: 'install-claude', label: 'Install Claude Code' } : { kind: 'claude-login', label: 'Sign in to Claude' },
    },
    {
      id: 'tools', title: 'Tools for coding', optional: false, done: !f.tools.missing.length,
      detail: f.tools.missing.length ? `missing: ${f.tools.missing.slice(0, 4).join(', ')}${f.tools.missing.length > 4 ? ', …' : ''}` : 'git, Node.js, Python and the rest are here',
      action: f.tools.missing.length ? page('pc/setup') : null,
    },
    {
      id: 'rules', title: 'Working rules for Claude', optional: false, done: !!f.rules.installed,
      detail: f.rules.installed ? `${f.rules.edited ? 'your edited copy' : 'added'}` : 'a good set of rules, yours to edit',
      action: f.rules.installed ? null : { kind: 'request', method: 'POST', path: '/api/pcsetup/rules', body: { action: 'add' } },
    },
    {
      id: 'project', title: 'A first project', optional: false, done: f.projects.length > 0,
      detail: f.projects.length ? f.projects.slice(0, 4).join(', ') : 'none yet: start one or get one from GitHub',
      action: f.projects.length ? null : page('pc/projects'),
    },
    {
      id: 'skills', title: 'Skills for Claude', optional: false, done: f.skills.length > 0,
      detail: f.skills.length ? `${f.skills.length} that Claude Code uses` : 'none yet: the one that comes with Hoprig is a good start',
      action: f.skills.length ? null : page('settings/skills'),
    },
    {
      id: 'phone', title: 'Your phone signed in', optional: false, done: f.sessions >= 2,
      detail: f.sessions >= 2 ? `${f.sessions} browsers signed in` : 'scan a code with the phone: no password to type',
      action: f.sessions >= 2 ? null : page('settings/signin-device'),
    },
    {
      id: 'account2', title: 'A second provider, for Auto mode', optional: true, done: f.profiles.length >= 2,
      detail: f.profiles.length >= 2 ? `${f.profiles.length} providers${auto ? ', Auto mode on' : ''}` : 'when one provider reaches its limit, the session goes on with the next',
      action: f.profiles.length >= 2 ? null : page('settings/accounts'),
    },
    {
      id: 'computer', title: 'Another computer', optional: true, done: f.machines.length > 0,
      detail: f.machines.length ? `${f.machines.length} connected` : 'see and drive your other computers from here',
      action: f.machines.length ? null : page('settings/computers'),
    },
  ];
}

/** The server feature. `opts.facts` replaces the fact sources (tests), `opts.loginSeen` the last sign-in check; `opts.now` the clock. */
export function onboardingFeature(sctx, opts = {}) {
  const src = { ...real, ...(opts.facts || {}) };
  const now = opts.now || Date.now;
  let slow = null; // { at, claude, tools }
  const job = { running: false, lines: [], result: null };

  const owner = (req) => {
    if (!sctx.authed(req)) throw Object.assign(new Error('only the owner of this dashboard can see this'), { status: 403 });
  };

  async function facts() {
    if (!slow || now() - slow.at > CACHE_MS) {
      const [claude, tools] = await Promise.all([src.claude().catch(() => ({ installed: null, loggedIn: null })), src.tools().catch(() => ({ missing: [] }))]);
      slow = { at: now(), claude, tools };
    }
    // A sign-in checked since (the page's own sign-in, a session start, doctor) is newer than the cached answer.
    const seen = (opts.loginSeen || loginSeen)();
    if (seen && seen.at > slow.at && typeof seen.loggedIn === 'boolean') slow = { ...slow, claude: { ...slow.claude, loggedIn: seen.loggedIn } };
    const safe = (fn, d) => fn().catch(() => d);
    const [rules, projects, skills, profiles, machines, sessions] = await Promise.all([
      safe(src.rules, {}), safe(src.projects, []), safe(src.skills, []), safe(src.profiles, []), safe(src.machines, []), safe(src.sessions, 0),
    ]);
    return { claude: slow.claude, tools: slow.tools, rules, projects, skills, profiles, machines, sessions, checkedAt: slow.at };
  }

  const routes = [
    ['GET', /^\/api\/onboarding$/, async (req) => {
      owner(req);
      const f = await facts();
      const steps = onboardingSteps(f);
      const req_ = steps.filter((s) => !s.optional);
      return { steps, done: req_.filter((s) => s.done).length, total: req_.length, checkedAt: f.checkedAt };
    }],
    ['POST', /^\/api\/onboarding\/run$/, async (req) => {
      owner(req);
      const b = await sctx.readJson(req);
      let claudeBin = 'claude';
      try {
        claudeBin = loadConfig().claudeBin || 'claude';
      } catch {
        /* the default */
      }
      const all = runCommands(sctx.deck.launcher(), claudeBin);
      // Own keys only: "__proto__" or "constructor" must not find anything.
      const cmd = typeof b.run === 'string' && Object.hasOwn(all, b.run) ? all[b.run] : null;
      if (!cmd) throw Object.assign(new Error('unknown command'), { status: 400 });
      const taken = (await sctx.backend.list()).map((t) => t.session);
      const name = uniqueName(`get-started-${b.run}`.slice(0, 30), taken);
      await sctx.backend.create({ name, dir: (await import('node:os')).homedir(), argv: cmd.argv });
      slow = null; // look again next time: the user is about to change something
      return { session: name };
    }],
    ['POST', /^\/api\/onboarding\/install-claude$/, async (req) => {
      owner(req);
      await sctx.readJson(req);
      if (job.running) throw Object.assign(new Error('Claude Code is being installed already'), { status: 409 });
      Object.assign(job, { running: true, lines: [], result: null });
      const onLine = (l) => job.lines.length < 3000 && job.lines.push(String(l).slice(0, 500));
      Promise.resolve()
        .then(() => (opts.installClaude || installClaude)({ onLine }))
        .then((r) => (job.result = { ok: Boolean(r && r.ok), version: (r && r.version) || null }))
        .catch((e) => {
          onLine(e.message);
          job.result = { ok: false, version: null };
        })
        .finally(() => {
          job.running = false;
          slow = null;
        });
      return { started: true };
    }],
    ['GET', /^\/api\/onboarding\/job$/, async (req, m, q) => {
      owner(req);
      const from = Math.max(0, Math.min(job.lines.length, Number(q && q.get('from')) || 0));
      return { running: job.running, lines: job.lines.slice(from), next: job.lines.length, result: job.result };
    }],
  ];
  return { name: 'onboarding', routes };
}
