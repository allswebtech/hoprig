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
import { capture, forThisUser, osName, showCommand, stream } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { detectKits, preselect, sysFacts } from './detect.mjs';
import { KITS, KIT_IDS, buildPlan, kitById } from './kits.mjs';
import { cloneRepo, expandDir, parseRepo, prepareEnv, projectNeeds, projectsDir, rememberDir } from './projects.mjs';
import { loadRecipe } from './recipe.mjs';
import { addRules, removeRules, rulesState } from './rules.mjs';
import { forInstalls, withoutSecrets } from '../secretenv.mjs';


/** PATH with the folders a fresh install puts programs in (nvm's node, Homebrew), so later steps find them. */
export function freshPath(env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') return env.PATH;
  const add = [];
  const nvm = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
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

/** The kits, compact: one line per kit; the items only where something is missing or old. */
export function formatKits(found, chosen) {
  const lines = [];
  for (const kit of KITS) {
    const items = (found[kit.id] || []).filter((i) => i.state !== 'na');
    const miss = items.filter((i) => i.state === 'missing');
    const old = items.filter((i) => i.state === 'old');
    const mark = miss.length ? (kit.defaultOn ? '✗' : '·') : old.length ? '!' : '✓';
    const have = items.filter((i) => i.state === 'ok').map((i) => `${i.name}${i.version ? ` ${i.version}` : ''}`).join(', ');
    const pick = chosen.includes(kit.id) && miss.length ? bold(' ← will set up') : '';
    lines.push(`  ${mark} ${bold(kit.title)}${miss.length ? `: missing ${miss.map((i) => i.name).join(', ')}` : ''}${old.length ? `${miss.length ? ';' : ':'} old ${old.map((i) => `${i.name} ${i.version}`).join(', ')}` : ''}${have ? dim(`  (${have})`) : ''}${pick}`);
  }
  return lines.join('\n');
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
export async function runSteps(steps, { ui, interactive, runner = stream, env = forInstalls(process.env), onStep = () => {} }) {
  const results = [];
  const failedKits = new Set();
  steps.forEach((s, i) => onStep(i, s, 'waiting'));
  for (const [i, step] of steps.entries()) {
    if (step.kit && failedKits.has(step.kit)) {
      results.push({ step, ok: false, skipped: true });
      onStep(i, step, 'skipped');
      continue;
    }
    onStep(i, step, 'running');
    ui.out(`\n  ${bold('→')} ${step.why ? `${step.why}: ` : ''}${showCommand(step.argv)}`);
    const live = interactive || step.interactive;
    // Without a terminal the package manager's long output is kept back and shown only when the step fails: the
    // run stays readable (with a terminal the command has it, so sudo can ask for its password). The dashboard's
    // job (ui.page) shows every line as it comes: the page folds the output itself.
    const kept = [];
    const onLine = ui.page ? (l) => ui.out(`    ${l}`) : (l) => kept.push(l);
    const r = await runner(step.argv, { env: { ...env, PATH: freshPath(env) }, interactive: live, onLine });
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
    else ui.line('warn', 'commit name and e-mail not set: git config --global user.name "Your Name" && git config --global user.email you@example.com');
  }
  if (items.signin && items.signin.state !== 'ok') {
    if (!sys.has('gh')) ui.line('warn', 'GitHub sign-in: gh is not installed (choose the GitHub kit)');
    else if (live && await ui.confirm('Sign in to GitHub now? (gh opens a browser or shows a code; choose HTTPS and let it set up git)', true)) {
      const r = await runner(['gh', 'auth', 'login', '--hostname', 'github.com'], { interactive: true });
      ui.line(r.ok ? 'ok' : 'warn', r.ok ? 'signed in to GitHub' : 'GitHub sign-in did not finish: run gh auth login');
      if (r.ok) res.push('signin');
    } else if (ui.page) ui.line('warn', 'not signed in to GitHub yet: use Sign in under Git and GitHub on this page');
    else ui.line('warn', `GitHub sign-in: run ${bold('gh auth login')}${ui.interactive ? '' : ' in a terminal'}`);
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
      out.failed.push({ repo: repo.url, command: `git clone ${repo.url} ${r.dest}` });
      continue;
    }
    if (!r.skipped) out.cloned.push(r.dest);
    prepareEnv(r.dest, (l) => ui.line('info', l));
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
    if (await ui.confirm(`${name}: run ${i.label}? (installs its dependencies)`, true)) {
      const r = await runner(i.argv, { cwd: dest, env: { ...withoutSecrets(process.env), PATH: freshPath() }, onLine: (l) => ui.out(`    ${dim(l)}`) });
      ui.line(r.ok ? 'ok' : 'fail', `${name}: ${i.label} ${r.ok ? 'done' : `failed — retry: cd "${dest}" && ${showCommand(i.argv)}`}`);
    }
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
export async function runPcSetup({ ui, yes = false, dryRun = false, kits = null, recipe = null, projects = false, rules = null, hold = false, sys: sysOver, runner = stream, ghList, onStep, codingTools: tools = null } = {}) {
  ui.yes = ui.yes || yes;
  ui.dryRun = ui.dryRun || dryRun;
  const sys = sysOver || (await sysFacts());
  let found = await detectKits(sys);
  const chosen = kits || (recipe && recipe.kits) || preselect(found);
  ui.out(`\n${bold('This computer')}  ${dim(`${osName(sys.platform)}${sys.pm ? ` · ${sys.pm}` : ''}${sys.root ? ' · root' : ''}`)}`);
  ui.out(formatKits(found, chosen));
  const plan = buildPlan(chosen, found, sys);
  for (const c of plan.cannot) ui.line('warn', `${c.name} (${kitById(c.kit).title}): no way to install it here automatically`);
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
      for (const s of plan.steps) ui.out(`    ${forThisUser(showCommand(s.argv), sys)}`);
      ui.line('fail', 'run the "as root" commands as root (or install sudo first), then run this again');
      return { ok: false, changed: false, missing: [], code: 1 };
    }
    ui.out(`\n${bold('Will run')}${plan.admin && !ui.page ? dim('  (sudo asks for your password itself; Hoprig never sees it)') : ''}`);
    for (const s of plan.steps) ui.out(`    ${showCommand(s.argv)}`);
    const go = await ui.confirm(`Install ${plan.steps.length === 1 ? 'this' : `these ${plan.steps.length} steps`} now?`, true);
    if (go) results = await runSteps(plan.steps, { ui, interactive: ui.interactive, runner, onStep });
    else if (!ui.dryRun) ui.note('Nothing installed.');
  }
  let changed = results.some((x) => x.ok);
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
      for (const w of recipe.workspaces) if ((await cloneProject(w, { ui, dir: proj.dir, runner })) !== 0) proj.failed.push({ repo: w, command: `hoprig project clone ${w}` });
    }
    if (proj.cloned.length) changed = true;
  }
  // Summary: what is ready, what failed (with the exact command to retry), what needs a new shell or login.
  const after = await detectKits(sys, chosen);
  ui.out(`\n${bold(ui.dryRun ? 'Dry run: nothing was changed' : 'Done')}`);
  const failed = results.filter((x) => !x.ok);
  const missing = [];
  for (const k of chosen) {
    const kit = kitById(k);
    const miss = (after[k] || []).filter((i) => i.state === 'missing');
    missing.push(...miss.map((i) => `${k}.${i.id}`));
    ui.line(miss.length ? 'warn' : 'ok', `${kit.title}: ${miss.length ? `still missing ${miss.map((i) => i.name).join(', ')}` : 'ready'}`);
    if (kit.after && results.some((x) => x.ok && x.step.kit === k)) ui.note(`   ${kit.after}`);
  }
  for (const f of failed) ui.out(`  ${dim('retry:')} ${showCommand(f.step.argv)}${f.skipped ? dim('  (skipped: an earlier step failed)') : ''}`);
  for (const f of (proj && proj.failed) || []) ui.out(`  ${dim('retry:')} ${f.command}`);
  for (const id of toolsFailed) ui.out(`  ${dim('retry:')} hoprig tools install ${id}`);
  if (results.some((x) => x.ok) && sys.platform !== 'win32') ui.note('Open a new terminal (or log in again) so every new program is found.');
  if (hold && ui.interactive) await ui.ask('\nPress Enter to close. ');
  const code = failed.length || (proj && proj.failed.length) || toolsFailed.length ? 1 : 0;
  return { ok: code === 0, changed, missing: [...missing, ...toolsFailed.map((id) => `codingTools.${id}`)], code };
}

/** `hoprig pc setup …`. Returns the exit code. */
export async function pcSetup(args, { ui, sys, runner = stream, ghList } = {}) {
  const o = parseArgs(args);
  if (o.errors.length) {
    ui.out(`${o.errors.join('\n')}\nusage: hoprig pc setup [--yes] [--dry-run] [--kits ${KIT_IDS.join(',')}] [--recipe <file or https address>] [--no-projects] [--rules | --remove-rules]`);
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
  const r = await runPcSetup({ ui, yes: o.yes, dryRun: o.dryRun, kits: o.kits, recipe, projects: o.projects && !o.kits && ui.interactive && !o.yes, rules: o.rules, hold: o.hold, sys, runner, ghList });
  // Then git and GitHub (gh is there now), which may restore a workspace from GitHub, then the workspace itself.
  if (!o.kits && !recipe) {
    await (await import('../workspace/gitstep.mjs')).runGitStep({ ui });
    await (await import('../workspace/step.mjs')).runWorkspaceStep({ ui });
  }
  return r.code;
}
