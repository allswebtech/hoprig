// The PC tab's Setup section and project workspaces, as a server feature: { name, routes }.
//
//   GET  /api/pcsetup/status              every status check: { ok, checks, projectsDir }
//   GET  /api/pcsetup/kits                kits with what is there and the commands setup would run
//   POST /api/pcsetup/setup { kits }      opens a terminal session that runs `pc setup --yes --kits …`: sudo (or
//                                         Windows) asks for the password there, typed by the owner, never through the page
//   POST /api/pcsetup/fix { id }          the same for one status check that has a fix (looked up here, never sent)
//   POST /api/pcsetup/recipe { recipe | url }   validated, then `pc setup --yes --recipe <file>` in a terminal session
//   GET  /api/pcsetup/recipe?email=1      this computer's recipe (no keys, no tokens; the e-mail only when asked)
//   GET  /api/pcsetup/github              { signedIn, repos: [{ name, url, private }] } from `gh repo list`
//   POST /api/pcsetup/clone { repos }     clone into the projects folder (background job, live output)
//   POST /api/pcsetup/install { dir }     a cloned project's dependency install (background job)
//   GET  /api/pcsetup/projects            the projects folder, its workspaces (parent + code repos) and other repos
//   GET  /api/pcsetup/project/preview?name=N             what "New project" would create, before anything is made
//   POST /api/pcsetup/project/new { name, github }       `project new` as a background job (never asks: GitHub only when chosen)
//   POST /api/pcsetup/project/clone { spec }             `project clone` as a background job (installs are left to the page)
//   POST /api/pcsetup/project/add { name, repo, github } `project add`: a new code repository in the project's code/
//   POST /api/pcsetup/project/sync { name, memory }      background job; its result says per repository what was
//                                                        done and what needs a decision ({ kind, why, command })
//   POST /api/pcsetup/projects-dir { dir }               change the projects folder (made when missing)
//   POST /api/pcsetup/rules { action }   add | remove the opt-in working rules for Claude Code (no admin rights needed)
//   GET  /api/pcsetup/job?from=N          the background job's output: { running, lines, next, result }
//
// A hub that controls this computer may reach all of these (it can already open terminals here); none of them
// ever returns a key, a token or a password, and every input is validated here again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { uniqueName } from '../server/validate.mjs';
import { capture, stream } from '../setup/system.mjs';
import { detectKits, ghAuth, sysFacts } from './detect.mjs';
import { KITS, KIT_IDS, buildPlan } from './kits.mjs';
import { cloneRepo, expandDir, listRepos, parseRepo, prepareEnv, projectNeeds, projectsDir, rememberDir, repoState } from './projects.mjs';
import { cloneProject, projectAdd, projectNew } from './project.mjs';
import { parseRecipeText, validateRecipe, loadRecipe } from './recipe.mjs';
import { pcStatus, exitCode } from './status.mjs';
import { BUILTIN_TEMPLATE, NAME_RE, listWorkspaces, parseProjectSpec, readTemplate, repoInfo, syncWorkspace, workspaceState } from './workspace.mjs';
import { showCommand } from '../setup/system.mjs';
import { loadConfig } from '../config.mjs';
import { makeUi } from '../setup/ui.mjs';
import { addRules, removeRules } from './rules.mjs';

const LINES_MAX = 3000;
const fail = (status, message) => Object.assign(new Error(message), { status });
// eslint-disable-next-line no-control-regex
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Text for the page: the home folder written as "~", so no user name shows in the output or a screenshot. A path in
 * quotes keeps working when it is copied into a shell: "~/x" would not expand there, ~/"x" does.
 */
export function tildeText(s, home = os.homedir()) {
  let t = String(s);
  if (!home || home === path.parse(home).root) return t;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  t = t.replace(new RegExp(`(["'])${esc}([\\\\/])`, 'g'), '~$2$1').replace(new RegExp(`(["'])${esc}\\1`, 'g'), '~');
  return t.split(home).reduce((out, part, i) => (i === 0 ? part : /^([\\/]|$|["'\s:),.])/.test(part) ? `${out}~${part}` : `${out}${home}${part}`));
}

/**
 * A command-line ui for a background job: it never asks (no terminal: every question takes its safe "no"), its lines
 * go to the job's output without colours, and the first failure is kept as the job's error in plain words.
 */
function jobUi(onLine) {
  const failures = [];
  const ui = makeUi({ interactive: false, write: (s) => String(s).replace(/\n$/, '').split('\n').forEach((l) => onLine(plain(l))) });
  const line = ui.line;
  ui.line = (status, text) => {
    if (status === 'fail') failures.push(plain(text));
    line(status, text);
  };
  return { ui, failures };
}

/** What a sync left to the owner, as one word the page explains: the server's sentence stays for the details. */
export function todoKind(why) {
  const w = String(why || '');
  if (/has no upstream/.test(w)) return 'not-online';
  if (/both moved/.test(w)) return 'diverged';
  if (/to pull, but there are/.test(w)) return 'pull-blocked';
  if (/uncommitted change/.test(w)) return 'uncommitted';
  if (/^fetch failed/.test(w)) return 'fetch-failed';
  if (/^push failed/.test(w)) return 'push-failed';
  if (/not cloned/.test(w)) return 'missing';
  return 'other';
}

/** `opts`: { sys, status, run, projectsDir } stand-ins for tests. */
export function pcsetupFeature(sctx, opts = {}) {
  const facts = () => (opts.sys ? Promise.resolve(opts.sys) : sysFacts());
  const pdir = () => (opts.projectsDir ? opts.projectsDir() : projectsDir());
  let job = null; // one background job at a time: { kind, running, lines, result }

  function startJob(kind, fn) {
    if (job && job.running) throw fail(409, 'another setup job is still running; wait until it finishes');
    const j = { kind, running: true, lines: [], result: null, data: null, error: null };
    job = j;
    const onLine = (l) => {
      j.lines.push(tildeText(l));
      if (j.lines.length > LINES_MAX) j.lines.splice(0, j.lines.length - LINES_MAX);
    };
    // fn may set j.data (what the page shows as the result) and j.error (why it did not work, in plain words).
    Promise.resolve()
      .then(() => fn(onLine, j))
      .then((r) => (j.result = { ok: r !== false, error: r === false && j.error ? tildeText(j.error) : null, data: j.data }))
      .catch((e) => {
        j.result = { ok: false, error: tildeText(e.message), data: j.data };
        onLine(e.message);
      })
      .finally(() => (j.running = false));
    return { started: true };
  }

  async function terminal(base, args) {
    const taken = (await sctx.backend.list()).map((t) => t.session);
    const name = uniqueName(base.slice(0, 30), taken);
    const dir = fs.existsSync(pdir()) ? pdir() : os.homedir();
    await sctx.backend.create({ name, dir, argv: [...sctx.deck.launcher(), ...args] });
    return { session: name };
  }

  const kitsOf = (list) => {
    if (!Array.isArray(list) || !list.length || list.some((k) => !KIT_IDS.includes(k))) throw fail(400, `kits must be some of: ${KIT_IDS.join(', ')}`);
    return [...new Set(list)];
  };

  const projectDirOf = (name) => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail(400, 'bad project name');
    const d = path.join(pdir(), name);
    if (!fs.existsSync(path.join(d, '.git'))) throw fail(404, 'no such project');
    return d;
  };

  const routes = [
    ['GET', /^\/api\/pcsetup\/status$/, async (req, m, q) => {
      const checks = await (opts.status ? opts.status() : pcStatus({ sys: await facts(), offline: q && q.get('offline') === '1', projects: pdir() }));
      return { ok: exitCode(checks) === 0, checks, projectsDir: pdir() };
    }],
    ['GET', /^\/api\/pcsetup\/kits$/, async () => {
      const sys = await facts();
      const found = await detectKits(sys);
      return {
        platform: sys.platform, pm: sys.pm,
        kits: KITS.map((k) => {
          const plan = buildPlan([k.id], found, sys);
          return {
            id: k.id, title: k.title, summary: k.summary, defaultOn: k.defaultOn, after: k.after || null,
            items: found[k.id].filter((i) => i.state !== 'na').map(({ id, name, state, version }) => ({ id, name, state, version })),
            commands: plan.steps.map((s) => showCommand(s.argv)), admin: plan.admin,
          };
        }),
      };
    }],
    ['POST', /^\/api\/pcsetup\/setup$/, async (req) => {
      const b = await sctx.readJson(req);
      const kits = kitsOf(b.kits);
      return terminal('setup', ['pc', 'setup', '--yes', '--hold', '--no-projects', '--kits', kits.join(',')]);
    }],
    ['POST', /^\/api\/pcsetup\/fix$/, async (req) => {
      const b = await sctx.readJson(req);
      const checks = await (opts.status ? opts.status() : pcStatus({ sys: await facts(), offline: true, projects: pdir() }));
      const c = checks.find((x) => x.id === b.id);
      if (!c || !c.fixKit) throw fail(400, 'that check has no fix Hoprig can run');
      return terminal(`fix-${c.fixKit}`, ['pc', 'setup', '--yes', '--hold', '--no-projects', '--kits', c.fixKit]);
    }],
    ['GET', /^\/api\/pcsetup\/recipe$/, async (req, m, q) => {
      const { currentRecipe } = await import('./cli.mjs');
      return opts.recipe ? opts.recipe(q.get('email') === '1') : currentRecipe({ withEmail: q && q.get('email') === '1', sys: await facts() });
    }],
    ['POST', /^\/api\/pcsetup\/recipe$/, async (req) => {
      const b = await sctx.readJson(req);
      let v;
      if (typeof b.url === 'string' && b.url) v = await loadRecipe(b.url);
      else if (typeof b.text === 'string') v = parseRecipeText(b.text);
      else v = validateRecipe(b.recipe);
      if (!v.ok) throw fail(400, `the recipe was refused: ${v.errors.slice(0, 5).join('; ')}`);
      fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      const file = path.join(stateDir(), 'pcsetup-recipe.json');
      fs.writeFileSync(file, JSON.stringify(v.recipe, null, 2) + '\n', { mode: 0o600 });
      return { ...(await terminal('recipe', ['pc', 'setup', '--yes', '--hold', '--recipe', file])), recipe: v.recipe };
    }],
    ['GET', /^\/api\/pcsetup\/github$/, async () => {
      const sys = await facts();
      const a = await ghAuth(sys);
      if (!a.signedIn) return { signedIn: false, repos: [] };
      const r = await (opts.run || capture)(['gh', 'repo', 'list', '--json', 'nameWithOwner,url,isPrivate', '--limit', '200'], { timeout: 30_000 });
      let list = [];
      try {
        list = JSON.parse(r.stdout);
      } catch {
        /* no list */
      }
      return { signedIn: true, account: a.account, repos: list.filter((x) => x && parseRepo(x.url)).map((x) => ({ name: String(x.nameWithOwner), url: x.url, private: Boolean(x.isPrivate) })) };
    }],
    ['POST', /^\/api\/pcsetup\/clone$/, async (req) => {
      const b = await sctx.readJson(req);
      if (!Array.isArray(b.repos) || !b.repos.length || b.repos.length > 50) throw fail(400, 'send 1 to 50 repositories');
      const repos = b.repos.map((u) => parseRepo(u));
      if (repos.some((r) => !r)) throw fail(400, 'every repository must be a Git address (https or SSH, no password in it) or owner/repo');
      const dir = pdir();
      return startJob('clone', async (onLine) => {
        fs.mkdirSync(dir, { recursive: true });
        rememberDir(dir);
        let ok = true;
        for (const r of repos) {
          onLine(`→ git clone ${r.url}`);
          const c = await cloneRepo({ ...r, name: r.name.replace(/\.git$/, '') }, dir, { onLine, quiet: true, run: opts.stream || stream });
          if (!c.ok) {
            ok = false;
            onLine(`✗ failed: ${r.url} (a private repository needs the GitHub sign-in first)`);
            continue;
          }
          prepareEnv(c.dest, onLine);
          const n = projectNeeds(c.dest);
          for (const i of n.installs) onLine(`  ${path.basename(c.dest)} needs: ${i.label}${i.ready ? ' (Install button below)' : ` — ${i.why}`}`);
          if (n.node && !n.node.ok) onLine(`  ${path.basename(c.dest)} wants Node ${n.node.wants}; this computer has ${n.node.have}`);
          onLine(`✓ ${path.basename(c.dest)}`);
        }
        return ok;
      });
    }],
    ['POST', /^\/api\/pcsetup\/install$/, async (req) => {
      const b = await sctx.readJson(req);
      if (typeof b.dir !== 'string' || !/^[A-Za-z0-9._-]{1,100}(\/code\/[A-Za-z0-9._-]{1,100})?$/.test(b.dir) || b.dir.split('/').some((s) => s === '..' || s === '.')) throw fail(400, 'bad project folder');
      const dest = path.join(pdir(), b.dir);
      if (!fs.existsSync(path.join(dest, '.git'))) throw fail(404, 'no such project');
      const installs = projectNeeds(dest).installs.filter((i) => i.ready);
      if (!installs.length) throw fail(400, 'nothing to install there (or its tool is missing)');
      return startJob('install', async (onLine) => {
        let ok = true;
        for (const i of installs) {
          onLine(`→ ${i.label} in ${b.dir}`);
          const r = await (opts.stream || stream)(i.argv, { cwd: dest, onLine });
          if (!r.ok) ok = false;
        }
        return ok;
      });
    }],
    ['GET', /^\/api\/pcsetup\/projects$/, async () => {
      const dir = pdir();
      const ws = listWorkspaces(dir);
      const workspaces = await Promise.all(ws.map(async (w) => {
        const st = await workspaceState(w, opts.run || capture);
        // A code repository without an online address is not in project.json (project add writes only those that
        // have one): it is still part of the project, so it is listed too.
        let kids = [];
        try {
          kids = fs.readdirSync(path.join(w, 'code'), { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name) && fs.existsSync(path.join(w, 'code', d.name, '.git'))).map((d) => `code/${d.name}`);
        } catch {
          /* no code folder */
        }
        const missing = kids.filter((rel) => !st.repos.some((r) => r.rel === rel)).sort();
        const extra = await Promise.all(missing.map(async (rel) => ({ rel, ...(await repoInfo(path.join(w, rel), opts.run || capture)), localOnly: true })));
        return { ...st, repos: [...st.repos, ...extra] };
      }));
      const others = await Promise.all(listRepos(dir).filter((d) => !ws.includes(d)).map((d) => repoState(d, opts.run || capture)));
      const strip = (s) => ({ rel: s.rel, ok: s.ok, error: s.error || null, branch: s.branch || null, changes: s.changes || 0, ahead: s.ahead || 0, behind: s.behind || 0, upstream: Boolean(s.upstream), installs: s.ok ? projectNeeds(s.dir).installs.filter((i) => i.ready).map((i) => i.label) : [] });
      return {
        projectsDir: dir,
        home: os.homedir(), // shown as ~/… on the page
        workspaces: workspaces.map((w) => ({ id: path.basename(w.root), name: w.name, dir: w.root, manifest: w.source === 'project.json', memories: w.memories, repos: w.repos.map((s) => ({ ...strip(s), dir: s.dir })) })),
        repos: others.map((s) => ({ ...strip(s), id: path.basename(s.dir), rel: path.basename(s.dir), dir: s.dir })),
      };
    }],
    ['GET', /^\/api\/pcsetup\/project\/preview$/, async (req, m, q) => {
      const name = String((q && q.get('name')) || '').trim();
      if (!NAME_RE.test(name)) throw fail(400, 'a project name is letters, digits, ".", "_" and "-"');
      const dir = path.join(pdir(), name);
      let template = null;
      try {
        template = loadConfig().projectTemplate || null;
      } catch {
        /* defaults */
      }
      // A template folder is listed as it is; one at a Git address is only fetched when the project is made.
      let files = null;
      if (!template) files = Object.keys(BUILTIN_TEMPLATE);
      else if (fs.existsSync(template)) files = (() => { try { return readTemplate(template).map((f) => f.rel); } catch { return null; } })();
      const gh = await ghAuth(await facts()).catch(() => ({ signedIn: false }));
      return { name, dir, home: os.homedir(), exists: fs.existsSync(dir), template: template ? 'yours' : 'built-in', files, github: { signedIn: Boolean(gh.signedIn), account: gh.signedIn ? gh.account || null : null } };
    }],
    ['POST', /^\/api\/pcsetup\/project\/new$/, async (req) => {
      const b = await sctx.readJson(req);
      if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw fail(400, 'a project name is letters, digits, ".", "_" and "-"');
      if (fs.existsSync(path.join(pdir(), b.name))) throw fail(409, 'a folder with that name is already there');
      const dir = path.join(pdir(), b.name);
      return { ...startJob('new', async (onLine, j) => {
        const { ui, failures } = jobUi(onLine);
        const code = await (opts.projectNew || projectNew)([b.name, b.github === true ? '--github' : '--no-github'], { ui, run: opts.stream || stream });
        j.data = { name: b.name, dir, made: fs.existsSync(path.join(dir, '.git')) };
        j.error = failures[0] || null;
        return code === 0;
      }), name: b.name, dir };
    }],
    ['POST', /^\/api\/pcsetup\/project\/clone$/, async (req) => {
      const b = await sctx.readJson(req);
      const p = parseProjectSpec(b.spec);
      if (!p) throw fail(400, 'give a project name, owner/name or a Git address');
      const dir = path.join(pdir(), p.name);
      // Never a password prompt on the server's own terminal: a private repository needs the GitHub sign-in first.
      const quiet = (argv, o = {}) => (opts.stream || stream)(argv, { ...o, env: { ...(o.env || process.env), GIT_TERMINAL_PROMPT: '0' } });
      return { ...startJob('clone-project', async (onLine, j) => {
        const { ui, failures } = jobUi(onLine);
        const code = await (opts.cloneProject || cloneProject)(p.url || p.name, { ui, dir: pdir(), runner: quiet });
        j.data = { name: p.name, dir, made: fs.existsSync(path.join(dir, '.git')) };
        j.error = failures[0] || null;
        return code === 0;
      }), name: p.name, dir };
    }],
    ['POST', /^\/api\/pcsetup\/project\/add$/, async (req) => {
      const b = await sctx.readJson(req);
      projectDirOf(b.name);
      if (typeof b.repo !== 'string' || !NAME_RE.test(b.repo)) throw fail(400, 'a repository name is letters, digits, ".", "_" and "-"');
      return startJob('add', async (onLine, j) => {
        const { ui, failures } = jobUi(onLine);
        const code = await (opts.projectAdd || projectAdd)([b.name, b.repo, ...(b.github === true ? ['--github'] : [])], { ui, run: opts.stream || stream });
        j.error = failures[0] || null;
        return code === 0;
      });
    }],
    ['POST', /^\/api\/pcsetup\/project\/sync$/, async (req) => {
      const b = await sctx.readJson(req);
      const root = projectDirOf(b.name);
      return startJob('sync', async (onLine, j) => {
        const r = await (opts.syncWorkspace || syncWorkspace)(root, { memory: b.memory === true });
        if (r.memory) onLine(r.memory.committed ? '✓ memory committed' : `· memory: ${r.memory.why}`);
        let ok = true;
        for (const x of r.repos) {
          onLine(`${x.todo.length ? '!' : '✓'} ${x.rel}: ${x.did.join(', ') || 'nothing to do'}`);
          for (const t of x.todo) {
            ok = false;
            onLine(`    ${t.why}${t.command ? ` → ${t.command}` : ''}`);
          }
        }
        // The page says it in plain words: what was done (pulled / pushed N) and what is left, with its kind.
        j.data = {
          memory: r.memory ? { committed: Boolean(r.memory.committed), why: r.memory.why || null } : null,
          repos: r.repos.map((x) => ({
            rel: x.rel,
            did: x.did.map((d) => { const m = /^(pulled|pushed) (\d+)$/.exec(d); return m ? { kind: m[1], count: Number(m[2]) } : { kind: 'other', text: d }; }),
            todo: x.todo.map((t) => ({ kind: todoKind(t.why), why: tildeText(t.why), command: tildeText(t.command || '') })),
          })),
        };
        return ok;
      });
    }],
    ['POST', /^\/api\/pcsetup\/projects-dir$/, async (req) => {
      const b = await sctx.readJson(req);
      const dir = expandDir(b.dir);
      if (!dir || dir === path.parse(dir).root) throw fail(400, 'give a full folder path, like ~/projects');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        throw fail(400, `that folder cannot be made: ${e.code || e.message}`);
      }
      if (!fs.statSync(dir).isDirectory()) throw fail(400, 'that is a file, not a folder');
      (opts.rememberDir || rememberDir)(dir);
      return { projectsDir: dir };
    }],
    ['POST', /^\/api\/pcsetup\/rules$/, async (req) => {
      const b = await sctx.readJson(req);
      if (b.action !== 'add' && b.action !== 'remove') throw fail(400, 'action is add or remove');
      return b.action === 'add' ? (opts.rules || addRules)() : (opts.unrules || removeRules)();
    }],
    ['GET', /^\/api\/pcsetup\/job$/, async (req, m, q) => {
      const j = job || { kind: null, running: false, lines: [], result: null };
      const from = Math.max(0, Math.min(j.lines.length, Number(q && q.get('from')) || 0));
      return { kind: j.kind, running: j.running, lines: j.lines.slice(from), next: j.lines.length, result: j.result };
    }],
  ];

  return { name: 'pcsetup', routes };
}
