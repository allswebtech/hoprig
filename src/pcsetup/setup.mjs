// `hoprig pc setup`: from a fresh computer to one that is ready for coding, in one guided, repeatable run.
//   1. what is there and what is missing, per kit
//   2. ONE confirmation with the exact commands
//   3. the installs, with their output as it comes; in a terminal sudo / Windows ask for the password themselves
//      (hoprig never sees it); the dashboard's setup job asks in the page instead and hands it to sudo (admin.mjs)
//   4. git name and e-mail, GitHub sign-in (only when there is a terminal to ask in)
//   5. the projects folder and the repositories to clone, each with its dependency install offered
//   6. what was installed, what failed with the exact command to retry, and what needs a new login or shell
// Safe to run again: what is there is left alone (never reinstalled, never downgraded).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, forThisUser, osName, showCommand, stream, wingetWords } from '../setup/system.mjs';
import { bold, dim, yours } from '../setup/ui.mjs';
import { detectKits, preselect, sysFacts } from './detect.mjs';
import { KITS, KIT_IDS, PY_INSTALL, afterText, buildPlan, kitById, kitCovered, noDesktop, sshSession, stepLine } from './kits.mjs';
import { progressWords, runInside } from './devinstall.mjs';
import { brokenText, javaHomeText } from './java.mjs';
import { extraSteps, optionalExtras } from './optional.mjs';
import { leftOutText } from './suggest.mjs';
import { cloneRepo, expandDir, parseRepo, prepareEnv, projectNeeds, projectsDir, rememberDir } from './projects.mjs';
import { loadRecipe } from './recipe.mjs';
import { addRules, removeRules, rulesState } from './rules.mjs';
import { forInstalls, withoutSecrets } from '../secretenv.mjs';
import { blockLine } from '../setup/localbin.mjs';
import { yourSteps } from './kitinfo.mjs';


/** PATH with the folders a fresh install puts programs in (nvm's node, Homebrew), so later steps find them. */
export function freshPath(env = process.env, home = os.homedir(), platform = process.platform, wsNvm = null) {
  if (platform === 'win32') return env.PATH;
  const add = [];
  // nvm where NVM_DIR says, else ~/.nvm, else the workspace's development/nodejs/nvm (a new nvm goes there).
  const nvms = [env.NVM_DIR, path.join(home, '.nvm'), ...(wsNvm ? [wsNvm] : [])].filter(Boolean);
  const nvm = path.join(nvms.find((d) => fs.existsSync(path.join(d, 'versions', 'node'))) || nvms[0], 'versions', 'node');
  try {
    const vs = fs.readdirSync(nvm).filter((v) => /^v\d+/.test(v)).sort((a, b) => Number(b.slice(1).split('.')[0]) - Number(a.slice(1).split('.')[0]));
    if (vs[0]) add.push(path.join(nvm, vs[0], 'bin'));
  } catch {
    /* no nvm */
  }
  if (platform === 'darwin') add.push('/opt/homebrew/bin', '/usr/local/bin');
  const parts = String(env.PATH || '').split(':');
  return [...parts, ...add.filter((p) => !parts.includes(p))].join(':');
}

// The items that only the person can do (their name and e-mail, their sign-in): inside set-up's run, without a terminal to
// ask in, they go to its closing list (setup/ui.mjs), and this step does not say them again.
const PERSONAL = { identity: 'identity', signin: 'github' };

/**
 * The kits, compact: one line per kit; the items only where something is missing or old. An optional kit says so;
 * under it, why a project here suggests it (`extras`, optional.mjs) and, under PHP, the version note; then the Java line.
 * `personal`: inside set-up without questions, where a kit missing only those items is "yours to do", not set up.
 */
export function formatKits(found, chosen, extras = null, { personal = false } = {}) {
  const lines = [];
  for (const kit of KITS) {
    const all = found[kit.id] || [];
    const items = all.filter((i) => i.state !== 'na');
    const opt = kit.defaultOn ? '' : dim(' (optional)');
    if (!items.length && all.some((i) => i.detail === 'not covered on Windows')) {
      lines.push(`  · ${bold(kit.title)}${opt}: not covered on Windows (Hoprig does not set it up there)`);
      continue;
    }
    const miss = items.filter((i) => i.state === 'missing');
    const old = items.filter((i) => i.state === 'old');
    const mark = miss.length ? (kit.defaultOn ? '✗' : '·') : old.length ? '!' : '✓';
    const have = items.filter((i) => i.state === 'ok' || i.state === 'offpath').map((i) => `${i.name}${i.version ? ` ${i.version}` : ''}`).join(', ');
    const own = personal && miss.length && miss.every((i) => PERSONAL[i.id]);
    // An item that is only found, never installed (Android Studio), is not "will set up".
    const due = miss.filter((i) => !(kit.items.find((x) => x.id === i.id) || {}).foundOnly);
    const pick = chosen.includes(kit.id) && due.length ? bold(own ? ' ← yours to do (listed at the end)' : ' ← will set up') : '';
    lines.push(`  ${mark} ${bold(kit.title)}${opt}${miss.length ? `: missing ${miss.map((i) => i.name).join(', ')}` : ''}${old.length ? `${miss.length ? ';' : ':'} old ${old.map((i) => `${i.name} ${i.version}`).join(', ')}` : ''}${have ? dim(`  (${have})`) : ''}${pick}`);
    for (const i of items) if (i.detail && i.state === 'ok' && !kit.defaultOn) lines.push(`      ${dim(`${i.name}: ${i.detail}`)}`);
    if (!extras) continue;
    const why = (extras.suggested || []).filter((x) => x.kit === kit.id).map((x) => x.reason);
    if (why.length) lines.push(`      suggested: ${why.join('; ')}${chosen.includes(kit.id) ? '' : dim(` (not chosen: add --kits ${kit.id})`)}`);
    if (kit.id === 'php') for (const n of extras.php || []) lines.push(`      ${n.verdict === 'fits' ? '✓' : n.verdict === 'unknown' || n.verdict === 'unreadable' ? '·' : '!'} ${n.text}`);
  }
  if (extras && extras.leftOut) lines.push(`  · ${dim(leftOutText(extras.leftOut))}`);
  const j = extras && extras.java;
  if (j) {
    lines.push(`  ${j.state === 'ok' ? '✓' : '·'} ${bold('Java')}${dim(' (no kit: Hoprig only looks for it)')}: ${j.text}`);
    if (j.broken.length) lines.push(`      ${brokenText(j)}`);
    if (javaHomeText(j)) lines.push(`      ${dim(javaHomeText(j))}`);
  }
  return lines.join('\n');
}

/** The extras, never in the way of setup: what cannot be read is left out. */
export async function readExtras(sys, found, dir = projectsDir()) {
  try {
    return await optionalExtras(sys, dir, found);
  } catch {
    return { suggested: [], php: [], java: null };
  }
}

/** Parse the flags. Unknown flags are an error (exit 2). */
export function parseArgs(args) {
  const o = { yes: false, dryRun: false, kits: null, recipe: null, hold: false, projects: true, rules: null, removeRules: false, errors: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]);
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--hold') o.hold = true;
    else if (a === '--no-projects') o.projects = false;
    else if (a === '--rules') o.rules = true;
    else if (a === '--no-rules') o.rules = false;
    else if (a === '--remove-rules') o.removeRules = true;
    else if (a === '--kits' || a.startsWith('--kits=')) o.kits = String(val() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--recipe' || a.startsWith('--recipe=')) o.recipe = val() || '';
    else o.errors.push(`unknown option ${a}`);
  }
  for (const k of o.kits || []) if (!KIT_IDS.includes(k)) o.errors.push(`unknown kit "${k}" (kits: ${KIT_IDS.join(', ')})`);
  return o;
}

/**
 * Run the plan's steps in order. A failed step skips the rest of its kit (they build on it). Returns
 * [{ step, ok, skipped }]. `onStep(index, step, state)` hears each step's state (waiting, running, ok, fail,
 * skipped): the dashboard marks its steps with it. The steps run installers from the internet (nvm's, Docker's,
 * Homebrew's) and package managers: no secret and no GitHub token reaches them (../secretenv.mjs).
 */
// A step with `do` instead of `argv` is not a command: Hoprig runs it itself (devinstall.mjs: a checked download, an
// adoption link, the kits block of the shell start files), never through `runner`, so never under sudo. `get` is the
// vendor's getter (tests hand their own); `signal` stops a download. `stopOn`: the process signals (Ctrl-C's SIGINT, a
// kill's SIGTERM) that stop such a step, heard only while it runs, so that it removes what it made before the run
// ends; a command step keeps the signal's usual way. After a stop no further step runs.
export async function runSteps(steps, { ui, interactive, runner = stream, env = forInstalls(process.env), onStep = () => {}, get, signal, stopOn = [] }) {
  const results = [];
  const failedKits = new Set();
  let stopped = false;
  steps.forEach((s, i) => onStep(i, s, 'waiting'));
  for (const [i, step] of steps.entries()) {
    if (stopped || (signal && signal.aborted) || (step.kit && failedKits.has(step.kit))) {
      results.push({ step, ok: false, skipped: true });
      onStep(i, step, 'skipped');
      continue;
    }
    onStep(i, step, 'running');
    ui.out(`\n  ${bold('→')} ${step.why ? `${step.why}: ` : ''}${stepLine(step, showCommand)}`);
    if (!step.argv) {
      const words = progressWords(step.why || 'download');
      const ac = new AbortController();
      const stop = () => ac.abort();
      for (const s of stopOn) process.on(s, stop);
      let r;
      try {
        r = await runInside(step, { ...(get ? { get } : {}), signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal, onProgress: (b, t) => {
          const w = words(b, t);
          if (w) ui.out(`    ${dim(w)}`);
        } });
      } finally {
        for (const s of stopOn) process.off(s, stop);
      }
      if (ac.signal.aborted) stopped = true;
      if (stopped) ui.line('warn', 'stopped: what this step had made is removed, and no further step runs');
      if (r.ok) ui.line('ok', r.said);
      else {
        ui.line('fail', `that failed: ${r.why}`);
        if (r.todo) ui.out(`    ${r.todo}`);
        if (step.kit) failedKits.add(step.kit);
      }
      onStep(i, step, r.ok ? 'ok' : 'fail', r);
      results.push({ step, ok: r.ok, skipped: false, ...(stopped ? { stopped: true } : {}), ...(r.ok ? {} : { why: r.why, todo: r.todo }) });
      continue;
    }
    const live = interactive || step.interactive;
    // Without a terminal the package manager's long output is kept back and shown only when the step fails: the
    // run stays readable (with a terminal the command has it, so sudo can ask for its password). The dashboard's
    // job (ui.page) shows every line as it comes: the page folds the output itself.
    const kept = [];
    const onLine = ui.page ? (l) => ui.out(`    ${l}`) : (l) => kept.push(l);
    // A step's own `env` (JAVA_HOME for one tool) is for that step only.
    const r = await runner(step.argv, { env: { ...env, ...(step.env || {}), PATH: freshPath(env, os.homedir(), process.platform, step.nvmDir || null) }, interactive: live, onLine });
    if (!r.ok) {
      for (const l of kept.slice(-15)) ui.out(`    ${dim(l)}`);
      ui.line('fail', `that failed (exit ${r.code ?? '?'})`);
      if (step.kit) failedKits.add(step.kit);
    }
    onStep(i, step, r.ok ? 'ok' : 'fail');
    results.push({ step, ok: r.ok, skipped: false });
  }
  return results;
}

/** Ask the git name/e-mail (or take the recipe's) and offer the GitHub sign-in. Interactive parts need a terminal. */
async function github(ui, sys, found, recipe, runner) {
  const res = [];
  const items = Object.fromEntries((found.github || []).map((i) => [i.id, i]));
  const live = ui.interactive && !ui.dryRun;
  // Inside set-up with no one to ask: the kit line said it; the closing list gives the next step.
  const personal = !!ui.todo && !live;
  if (items.identity && items.identity.state !== 'ok' && sys.has('git')) {
    let name = recipe && recipe.git ? recipe.git.name : '';
    let email = recipe && recipe.git ? recipe.git.email || '' : '';
    if (live && !name) name = ((await ui.ask('  Your name for commits (empty: skip): ')) || '').trim();
    if (live && name && !email) email = ((await ui.ask('  Your e-mail for commits (GitHub shows it on commits): ')) || '').trim();
    if (ui.dryRun) ui.note('(dry run) would ask your name and e-mail for commits');
    else if (name && /^[^\0-\x1f\x7f"\\<>]{1,100}$/.test(name)) {
      await runner(['git', 'config', '--global', 'user.name', name], {});
      if (email && /^[^\s@<>"\\]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(email)) await runner(['git', 'config', '--global', 'user.email', email], {});
      ui.line('ok', 'commit name set' + (email ? ' and e-mail set' : ''));
      res.push('identity');
    } else if (ui.page) ui.line('warn', 'commit name and e-mail not set yet: set them under Git and GitHub on this page');
    else if (personal) ui.todo('identity');
    else yours(ui, 'warn', 'commit name and e-mail not set', 'identity');
  }
  if (items.signin && items.signin.state !== 'ok') {
    if (!sys.has('gh')) ui.line('warn', 'GitHub sign-in: gh is not installed (choose the GitHub kit)');
    else if (live && await ui.confirm('Sign in to GitHub now? (gh opens a browser or shows a code; choose HTTPS and let it set up git)', true)) {
      const r = await runner(['gh', 'auth', 'login', '--hostname', 'github.com'], { interactive: true });
      if (r.ok) ui.line('ok', 'signed in to GitHub');
      else yours(ui, 'warn', 'GitHub sign-in did not finish', 'github');
      if (r.ok) res.push('signin');
    } else if (ui.page) ui.line('warn', 'not signed in to GitHub yet: use Sign in under Git and GitHub on this page');
    else if (personal) ui.todo('github');
    else yours(ui, 'warn', 'not signed in to GitHub', 'github', { alone: `GitHub sign-in: run ${bold('gh auth login')}${ui.interactive ? '' : ' in a terminal'}` });
  }
  return res;
}

/** The projects folder and the repositories to clone. Returns { dir, cloned: [dest], failed: [{ repo, command }] }. */
export async function projectsStep(ui, sys, { recipe = null, runner = stream, remember = rememberDir, gh = null } = {}) {
  ui.out(`\n${bold('Projects')}`);
  let dir = recipe && recipe.projectsDir ? expandDir(recipe.projectsDir, sys.home) : null;
  const known = projectsDir();
  if (!dir) {
    dir = known;
    if (ui.interactive && !ui.yes && !ui.dryRun) {
      const a = ((await ui.ask(`  Where do your projects live? (${dir.replace(sys.home, '~')}) `)) || '').trim();
      if (a) dir = expandDir(a, sys.home) || dir;
    }
  }
  if (ui.dryRun) ui.note(`(dry run) projects folder would be ${dir}`);
  else {
    fs.mkdirSync(dir, { recursive: true });
    remember(dir);
    ui.line('ok', `projects folder: ${dir} (the dashboard's folder picker shows it first)`);
  }
  const wanted = [...((recipe && recipe.repos) || [])];
  if (ui.interactive && !ui.yes && !ui.dryRun && !recipe) {
    if (gh && gh.signedIn) {
      const list = await gh.list();
      if (list.length) {
        list.slice(0, 50).forEach((r, i) => ui.out(`    ${String(i + 1).padStart(2)}  ${r.nameWithOwner}${r.isPrivate ? dim('  private') : ''}`));
        const a = ((await ui.ask('  Numbers to clone (e.g. 1 3 5), empty for none: ')) || '').trim();
        for (const n of a.split(/[\s,]+/).map(Number).filter((n) => n >= 1 && n <= list.length)) wanted.push(list[n - 1].url);
      }
    }
    const typed = ((await ui.ask('  Paste Git addresses or owner/repo names to clone (space-separated, empty for none): ')) || '').trim();
    wanted.push(...typed.split(/\s+/).filter(Boolean));
  }
  const out = { dir, cloned: [], failed: [] };
  for (const w of wanted) {
    const repo = parseRepo(w);
    if (!repo) {
      ui.line('fail', `"${w}" is not a Git address (https or SSH, no password in it)`);
      continue;
    }
    if (ui.dryRun) {
      ui.note(`(dry run) would clone ${repo.url} into ${path.join(dir, repo.name.replace(/\.git$/, ''))}`);
      continue;
    }
    ui.out(`\n  ${bold('→')} git clone ${repo.url}`);
    const r = await cloneRepo({ ...repo, name: repo.name.replace(/\.git$/, '') }, dir, { onLine: (l) => ui.out(`    ${dim(l)}`), run: runner });
    if (!r.ok) {
      out.failed.push({ repo: repo.url, command: showCommand(['git', 'clone', repo.url, r.dest]) });
      continue;
    }
    // A repository that was here already is left as it is: no .env made in it, no install run in it.
    if (r.skipped) continue;
    out.cloned.push(r.dest);
    await prepareEnv(r.dest, (l) => ui.line('info', l));
    await offerInstall(ui, r.dest, runner, sys);
  }
  return out;
}

/** Show what a project needs and offer its dependency install (nothing else of the project ever runs). */
export async function offerInstall(ui, dest, runner, sys) {
  const n = projectNeeds(dest, { has: sys.has });
  const name = path.basename(dest);
  if (n.node && !n.node.ok) ui.line('warn', `${name} wants Node ${n.node.wants}, this computer has ${n.node.have}: run nvm install in ${dest}`);
  for (const i of n.installs) {
    if (!i.ready) {
      ui.line('warn', `${name}: ${i.label} — ${i.why}`);
      continue;
    }
    if (await ui.confirm(`${name}: run ${i.label}? (installs its dependencies)`, true)) await runInstall(ui, dest, i, runner);
  }
}

/** One dependency install of projectNeeds, run in `dest` with its output shown. */
export async function runInstall(ui, dest, i, runner, { root = dest, at = {} } = {}) {
  const name = path.basename(dest);
  // Started only in a folder really inside its project (inside.mjs startIn): never in one a link leads to.
  const { startIn } = await import('../workspace/inside.mjs');
  const r = await startIn({ ...at, root }, dest, i.argv, runner, { env: { ...withoutSecrets(process.env), PATH: freshPath() }, onLine: (l) => ui.out(`    ${dim(l)}`) });
  if (r.leaves) {
    ui.line('fail', `${name}: ${i.label} not run: ${r.stderr}`);
    return false;
  }
  ui.line(r.ok ? 'ok' : 'fail', `${name}: ${i.label} ${r.ok ? 'done' : `failed — retry: ${showCommand(['cd', dest])} && ${showCommand(i.argv)}`}`);
  return r.ok;
}

/**
 * The short text about this workspace (wsrules.mjs), offered once at a terminal when there is a workspace and the
 * file is not written yet: shown first, written only on a yes. Never with --yes or without a terminal.
 */
async function workspaceRulesStep(ui) {
  if (!ui.interactive || ui.yes || ui.dryRun) return false;
  const { isDir, brainDir } = await import('../workspace/layout.mjs');
  if (!isDir(brainDir())) return false;
  const w = await import('./wsrules.mjs');
  const { text } = await w.currentWorkspaceRules();
  const st = w.workspaceRulesState({ text });
  if (st.exists) return false;
  ui.out(`\n${dim(text)}`);
  if (!(await ui.confirm(`Write this short text about your workspace into ${st.file}, so coding sessions know it? (hoprig workspace rules)`, false))) return false;
  try {
    ui.line('ok', `wrote ${w.writeWorkspaceRules({ text }).file}`);
    return true;
  } catch (e) {
    ui.line('warn', e.message);
    return false;
  }
}

/** The opt-in working rules for Claude Code (rules.mjs). */
async function rulesStep(ui, want) {
  const st = rulesState();
  if (st.installed && !st.oldBlock) return false;
  if (want === false) return false;
  const yes = want === true || (ui.interactive && !ui.yes && await ui.confirm('Give Claude a good set of working rules? (model and effort per task, order of work, done means proven; yours to edit)', false));
  if (ui.dryRun) {
    if (want) ui.note(`(dry run) would add the working rules to ${st.rules}`);
    return false;
  }
  if (!yes) return false;
  for (const l of addRules().said) ui.line('ok', `working rules: ${l}`);
  return true;
}

/**
 * The computer step of a first-run flow, callable from other commands:
 *   runPcSetup({ ui, yes, dryRun, kits, recipe, projects, rules }) → { ok, changed, missing, code }
 * `ui` is setup/ui.mjs makeUi(); `kits` a list of kit ids (default: the kits that miss something);
 * `missing` lists "kit.item" still missing afterwards; `changed` is true when anything was installed or set.
 */
// `extraSteps`: steps of `hoprig setup` itself (lingering), named `ownSteps` here: optional.mjs's extraSteps() is another thing.
export async function runPcSetup({ ui, yes = false, dryRun = false, kits = null, recipe = null, projects = false, rules = null, hold = false, sys: sysOver, runner = stream, ghList, onStep, codingTools: tools = null, extras: extrasOver, extraSteps: ownSteps = [], get, signal, stopOn = [] } = {}) {
  ui.yes = ui.yes || yes;
  ui.dryRun = ui.dryRun || dryRun;
  const sys = sysOver || (await sysFacts());
  let found = await detectKits(sys);
  // An optional kit is taken only when it is named (--kits, a recipe, a tick on the page): never by a suggestion.
  const chosen = kits || (recipe && recipe.kits) || preselect(found);
  const extras = extrasOver || (await readExtras(sys, found));
  ui.out(`\n${bold('This computer')}  ${dim(`${osName(sys.platform, sys.release)}${sys.pm ? ` · ${sys.pm}` : ''}${sys.root ? ' · root' : ''}`)}`);
  const personal = !!ui.todo && !(ui.interactive && !ui.dryRun);
  ui.out(formatKits(found, chosen, extras, { personal }));
  for (const k of chosen.filter((id) => kitById(id) && !kitCovered(kitById(id), sys.platform))) ui.line('warn', `${kitById(k).title}: not covered on Windows, so nothing of it is installed here`);
  const plan = buildPlan(chosen, found, sys, { extra: extraSteps(extras), named: kits || (recipe && recipe.kits) || [] });
  // Steps of `hoprig setup` that need sudo too (lingering, setup/linger.mjs): in the same list, under the same yes.
  if (ownSteps.length) {
    plan.steps.push(...ownSteps);
    plan.admin = plan.admin || ownSteps.some((x) => x.admin);
  }
  // Windows: winget registered but not starting (or not here) is said once, with why and what to do, before each item
  // it would have installed names its own installer.
  if (sys.platform === 'win32' && sys.winget && !sys.winget.starts && plan.cannot.length) ui.line('warn', wingetWords(sys.winget));
  for (const c of plan.cannot) ui.line('warn', `${c.name} (${kitById(c.kit).title}): ${c.why || 'no way to install it here automatically'}`);
  // The owner's own steps of a chosen kit (packages that need administrator rights): shown with the command, never run.
  for (const y of yourSteps(chosen, found, sys)) {
    ui.line('warn', `${y.kit}: yours to do: ${y.text}`);
    if (y.command) ui.out(`    ${y.command}`);
  }
  const asks = chosen.includes('github') && (found.github || []).some((i) => ['identity', 'signin'].includes(i.id) && i.state === 'missing');
  const rulesDue = rules === true || (rules === null && ui.interactive && !ui.yes && !(rulesState().installed && !rulesState().oldBlock));
  const repos = recipe && ((recipe.repos && recipe.repos.length) || (recipe.workspaces && recipe.workspaces.length));
  const ct = tools || (await import('../codetools/index.mjs'));
  const toolsDue = ((recipe && recipe.codingTools) || []).map(ct.findTool).filter((t) => t && !t.installedVersion());
  if (!plan.steps.length && !asks && !rulesDue && !repos && !projects && !toolsDue.length) {
    ui.out(`\n  ${bold('Everything is here.')} Nothing to do.`);
    return { ok: true, changed: false, missing: [], code: 0 };
  }
  let results = [];
  if (plan.steps.length) {
    // No sudo on this computer: the commands are shown as root has to run them (setup/system.mjs: forThisUser, the
    // same phrasing doctor's fix lines get), not with a sudo that is not there.
    if (sys.platform === 'linux' && !sys.root && plan.admin && !sys.has('sudo')) {
      ui.out(`\n${bold('These need administrator rights, and sudo is not installed here')}`);
      for (const s of plan.steps) ui.out(`    ${s.argv ? forThisUser(showCommand(s.argv), sys) : stepLine(s, showCommand)}`);
      ui.line('fail', 'run the "as root" commands as root (or install sudo first), then run this again');
      return { ok: false, changed: false, missing: [], code: 1 };
    }
    ui.out(`\n${bold('Will run')}${plan.admin && !ui.page ? dim('  (sudo asks for your password itself; Hoprig never sees it)') : ''}`);
    for (const s of plan.steps) {
      ui.out(`    ${stepLine(s, showCommand)}`);
      // The kits block's lines are shown exactly as they are written.
      if (s.do === 'shell') for (const l of s.lines) ui.out(`        ${blockLine(l)}`);
    }
    // A kit that sets up a service (MariaDB) says so before the yes, with the start commands it leaves to you.
    for (const k of new Set(plan.steps.map((s) => s.kit))) {
      const kit = kitById(k);
      if (!kit || !kit.start || !plan.steps.some((s) => s.kit === k && s.items.includes('mariadb'))) continue;
      ui.out(`  ${dim(`${kit.title}: ${afterText(kit, sys)}`)}`);
      for (const l of kit.start(sys)) ui.out(`    ${showCommand(l)}`);
    }
    // A kit's own folder of the workspace (database/mysql with MariaDB) is said before the yes (workspace/kitfolder.mjs).
    for (const k of new Set(plan.steps.filter((s) => s.items.includes('mariadb')).map((s) => s.kit))) for (const l of (await import('../workspace/kitfolder.mjs')).kitFolderPlan(kitById(k))) ui.out(`  ${dim(l)}`);
    const go = await ui.confirm(`${ownSteps.length === plan.steps.length ? 'Run' : 'Install'} ${plan.steps.length === 1 ? 'this' : `these ${plan.steps.length} steps`} now?`, true);
    if (go) results = await runSteps(plan.steps, { ui, interactive: ui.interactive, runner, onStep, get, signal, stopOn });
    else if (!ui.dryRun) ui.note('Nothing installed.');
  }
  // On Windows the Path is read again from the system right after the installs: what was just installed (gh for the
  // GitHub sign-in below, npm for the coding tools, every kit in the summary) is found in this same run, and by a
  // dashboard that runs this, in its own process from now on.
  if (results.some((x) => x.ok) && sys.refreshPath) await sys.refreshPath();
  // A stop (Ctrl-C, a kill) ends the run here: nothing more is installed, asked or cloned.
  if (results.some((x) => x.stopped)) {
    ui.out(`\n${bold('Stopped')}  ${dim('run it again when you want it: hoprig pc setup')}`);
    return { ok: false, changed: results.some((x) => x.ok), missing: [], code: 1, stopped: true };
  }
  let changed = results.some((x) => x.ok);
  // ...and made once MariaDB is installed: only that folder, only when it is missing.
  for (const k of new Set(results.filter((x) => x.ok && x.step.items.includes('mariadb')).map((x) => x.step.kit))) for (const m of await (await import('../workspace/kitfolder.mjs')).makeKitFolders(kitById(k))) ui.line(m.ok ? 'ok' : 'warn', m.text);
  // The recipe's coding tools (the offered ones Hoprig installs): into Hoprig's own tools folder, after the kits (they need npm).
  const toolsFailed = [];
  for (const t of toolsDue) {
    ui.out(`\n${bold(t.name)}  ${dim("into Hoprig's tools folder")}`);
    if (ui.dryRun) {
      ui.note(`would install ${t.name} ${t.pin}`);
      continue;
    }
    const r = await t.install({ onLine: (l) => ui.out(`    ${l}`) });
    if (r.ok) {
      changed = true;
      ui.line('ok', `${t.name} ${r.version}`);
      ct.turnOn(t.id);
    } else {
      toolsFailed.push(t.id);
      ui.line('fail', `${t.name} was not installed: hoprig tools install ${t.id}`);
    }
  }
  if (chosen.includes('github')) {
    found = await detectKits(sys);
    if ((await github(ui, sys, found, recipe, runner)).length) changed = true;
  }
  if (await rulesStep(ui, rules)) changed = true;
  if (await workspaceRulesStep(ui)) changed = true;
  let proj = null;
  if (projects || repos) {
    const gh = ghList || {
      signedIn: (found.github || []).some((i) => i.id === 'signin' && i.state === 'ok'),
      list: async () => {
        const r = await capture(['gh', 'repo', 'list', '--json', 'nameWithOwner,url,isPrivate', '--limit', '100'], { timeout: 30_000 });
        try {
          return JSON.parse(r.stdout).filter((x) => parseRepo(x.url));
        } catch {
          return [];
        }
      },
    };
    proj = await projectsStep(ui, sys, { recipe, runner, gh });
    if (recipe && recipe.workspaces && recipe.workspaces.length && !ui.dryRun) {
      const { cloneProject } = await import('./project.mjs');
      for (const w of recipe.workspaces) {
        // The retry is the result's own fix where it has one (here under another name, its folder taken): getting it
        // again cannot help there.
        let got = null;
        if ((await cloneProject(w, { ui, dir: proj.dir, runner, onDone: (r) => (got = r) })) !== 0) proj.failed.push({ repo: w, command: (got && got.fix) || showCommand(['hoprig', 'project', 'clone', w]) });
      }
    }
    if (proj.cloned.length) changed = true;
  }
  // Summary: what is ready, what failed (with the exact command to retry), what needs a new shell or login.
  const after = await detectKits(sys, chosen);
  ui.out(`\n${bold(ui.dryRun ? 'Dry run: nothing was changed' : 'Done')}`);
  // Set-up's own extra steps (lingering) say what came of them themselves (setup/linger.mjs lingerOutcome): no retry
  // line, no "new terminal" note and no failed part for them here.
  const own = results.filter((x) => !ownSteps.includes(x.step));
  const failed = own.filter((x) => !x.ok);
  const missing = [];
  // Windows: installed now, and still not found with the system's own Path: Windows shows it to programs only after a
  // new sign-in.
  // Only a kit whose every step went through: one with a failed step shows that failure and its retry line, and a new
  // sign-in would not help it.
  const allOk = (k) => results.some((x) => x.step.kit === k) && results.filter((x) => x.step.kit === k).every((x) => x.ok);
  // Python in a session without a desktop (SSH, a service, a scheduled task): the install manager is there, Python is
  // not, and the last step is the person's, in a window of their own.
  const pyLeft = sys.platform === 'win32' && chosen.includes('python') && noDesktop(sys.env) && allOk('python') && (after.python || []).some((i) => i.state === 'missing');
  for (const k of chosen) {
    const kit = kitById(k);
    if (!kitCovered(kit, sys.platform)) continue;
    // An item that is only found (Android Studio) is not "still missing": where to get it was said before the yes.
    const only = (i) => (kit.items.find((x) => x.id === i.id) || {}).foundOnly;
    const miss = (after[k] || []).filter((i) => i.state === 'missing' && !only(i));
    missing.push(...miss.map((i) => `${k}.${i.id}`));
    // What is in the closing list already is not said here again.
    const said = miss.filter((i) => !(personal && PERSONAL[i.id] && ui.todos.has(PERSONAL[i.id])));
    if (said.length < miss.length && !said.length) continue;
    const what = k === 'python' && pyLeft ? 'the Python install manager is installed; Python itself, pip and venv are not there yet (the step left is below)' : `still missing ${said.map((i) => i.name).join(', ')}`;
    ui.line(said.length ? 'warn' : 'ok', `${kit.title}: ${said.length ? what : 'ready'}`);
    // A kit with a service (MariaDB) says its sentence and start commands only when the service was installed now.
    const service = results.some((x) => x.ok && x.step.kit === k && x.step.items.includes('mariadb'));
    if (kit.after && results.some((x) => x.ok && x.step.kit === k) && (!kit.start || service)) {
      ui.note(`   ${afterText(kit, sys)}`);
      if (kit.start) for (const l of kit.start(sys)) ui.out(`    ${showCommand(l)}`);
    }
  }
  // A step Hoprig runs itself is retried by its kit: that line is said once, whatever else of the kit was skipped.
  const retried = new Set();
  for (const f of failed) {
    const kitLine = !f.step.argv || (retried.has(f.step.kit) && f.skipped);
    if (kitLine && retried.has(f.step.kit)) continue;
    if (kitLine) retried.add(f.step.kit);
    ui.out(`  ${dim('retry:')} ${kitLine ? `hoprig pc setup --kits ${f.step.kit}` : showCommand(f.step.argv)}${f.skipped && !kitLine ? dim('  (skipped: an earlier step failed)') : ''}`);
  }
  for (const f of (proj && proj.failed) || []) ui.out(`  ${dim('retry:')} ${f.command}`);
  for (const id of toolsFailed) ui.out(`  ${dim('retry:')} hoprig tools install ${id}`);
  if (own.some((x) => x.ok) && sys.platform !== 'win32') {
    if (ui.todo) ui.todo('terminal');
    else ui.note('Open a new terminal (or log in again) so every new program is found.');
  }
  const unseen = sys.platform === 'win32' ? chosen.filter((k) => !(k === 'python' && pyLeft) && allOk(k) && (after[k] || []).some((i) => i.state === 'missing')) : [];
  // Without a desktop the install manager only updates itself: the last step is the person's, in a window of their own.
  const where = sshSession(sys.env) ? 'over SSH' : 'in a session without a desktop (a service, a scheduled task or a remote shell)';
  if (pyLeft) ui.note(`Python: the Python install manager is installed; Python itself, pip and venv are not there yet. The one step left cannot be done ${where}. On that computer, in a window of your own (PowerShell from the Start menu), run:\n    ${showCommand(PY_INSTALL)}\n  Then run hoprig pc setup again: it looks once more.`);
  if (unseen.length) ui.note(`${unseen.map((k) => kitById(k).title).join(', ')}: installed, but Windows shows ${unseen.length > 1 ? 'them' : 'it'} to programs only after you sign out of Windows and sign in again (or restart the computer). Then run hoprig pc setup again: it checks once more.`);
  if (hold && ui.interactive) await ui.ask('\nPress Enter to close. ');
  const code = failed.length || (proj && proj.failed.length) || toolsFailed.length ? 1 : 0;
  return { ok: code === 0, changed, missing: [...missing, ...toolsFailed.map((id) => `codingTools.${id}`)], code };
}

/** The usage of `hoprig pc setup` (printed for a wrong option, and as its help). */
export const SETUP_USAGE = `usage: hoprig pc setup [--yes] [--dry-run] [--kits ${KIT_IDS.join(',')}] [--recipe <file or https address>] [--no-projects] [--rules | --remove-rules]`;

// Ctrl-C or a kill while Hoprig downloads or unpacks a toolchain: that step removes its half download, then the run ends.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

/** `hoprig pc setup …`. Returns the exit code. */
export async function pcSetup(args, { ui, sys, runner = stream, ghList, get } = {}) {
  const o = parseArgs(args);
  if (o.errors.length) {
    ui.out(`${o.errors.join('\n')}\n${SETUP_USAGE}`);
    return 2;
  }
  if (o.removeRules) {
    for (const l of removeRules().said) ui.line('ok', l);
    return 0;
  }
  let recipe = null;
  if (o.recipe) {
    const r = await loadRecipe(o.recipe);
    if (!r.ok) {
      ui.out(`The recipe was refused:\n${r.errors.map((e) => `  ✗ ${e}`).join('\n')}`);
      return 2;
    }
    recipe = r.recipe;
  }
  ui.out(`\n${bold('hoprig pc setup')}`);
  const startedAt = Date.now();
  // How each step ended, for the field report (src/field): heard through onStep, as the dashboard hears it.
  const ended = [];
  const onStep = (i, step, state) => {
    if (state === 'ok' || state === 'fail' || state === 'skipped') ended[i] = { step, ok: state === 'ok', skipped: state === 'skipped' };
  };
  const r = await runPcSetup({ ui, yes: o.yes, dryRun: o.dryRun, kits: o.kits, recipe, projects: o.projects && !o.kits && ui.interactive && !o.yes, rules: o.rules, hold: o.hold, sys, runner, ghList, onStep, get, stopOn: STOP_SIGNALS });
  // Then git and GitHub (gh is there now), which may restore a workspace from GitHub, then the workspace itself.
  // A run that was stopped (Ctrl-C) ends here.
  if (!o.kits && !recipe && !r.stopped) {
    await (await import('../workspace/gitstep.mjs')).runGitStep({ ui });
    await (await import('../workspace/step.mjs')).runWorkspaceStep({ ui });
  }
  // A field report (src/field): "kit" when only kits were asked for; a dry run changes nothing and makes none.
  if (!o.dryRun) (await import('../field/wire.mjs')).reportPcSetup(o.kits ? 'kit' : 'pc-setup', ended.filter(Boolean), r.code, startedAt);
  return r.code;
}
