// The parts of `hoprig setup` after the dashboard's own steps, in the same run:
//   git       git's name and e-mail, the GitHub sign-in, and a workspace of yours from GitHub (src/workspace)
//   workspace the one folder tree (src/workspace): made on a new computer, only reported where it is there
//   pc        this computer for coding (src/pcsetup: kits, and the working rules as their opt-in)
//   project   a new or an existing project, skippable with Enter
//   skills    skills for that project (src/skillhub; the bundled hoprig skill first)
// Each part first shows what is there, proposes only what is missing, asks once, and says nothing more when nothing
// is missing. One part failing never stops the next: every result is collected and named at the end.
//
// `parts` lets tests (and nothing else) replace the real work: { git, workspace, pc, projectNew, cloneProject, projectSkills,
// userSkills } with the same signatures as the functions below.
import fs from 'node:fs';
import path from 'node:path';
import { bold, dim } from './ui.mjs';

export const PARTS = ['base', 'pc', 'git', 'workspace', 'project', 'skills'];

const real = {
  workspace: async (o) => (await import('../workspace/step.mjs')).runWorkspaceStep(o),
  git: async (o) => (await import('../workspace/gitstep.mjs')).runGitStep(o),
  pc: async ({ facts, ...o }) => {
    const { runPcSetup } = await import('../pcsetup/index.mjs');
    if (!facts || o.sys) return runPcSetup(o);
    return runPcSetup({ ...o, sys: await (await import('../pcsetup/detect.mjs')).sysFacts(facts) });
  },
  projectNew: async (args, o) => (await import('../pcsetup/project.mjs')).projectNew(args, o),
  cloneProject: async (spec, o) => (await import('../pcsetup/project.mjs')).cloneProject(spec, o),
  projectSkills: async (o) => (await import('../skillhub/hub.mjs')).runSkillsStep(o),
  userSkills: (o) => userSkills(o),
  projects: async () => {
    const { projectsDir, listRepos } = await import('../pcsetup/projects.mjs');
    const dir = projectsDir();
    return { dir, names: listRepos(dir).map((d) => path.basename(d)) };
  },
};

/** The skills meant for the user (the bundled `hoprig` skill): added when there is no project to suggest for. */
export async function userSkills({ ui, dryRun = false }) {
  const hub = await import('../skillhub/hub.mjs');
  const st = await hub.skillsStatus({ check: false });
  const todo = st.user.suggested;
  const added = [];
  const skipped = [];
  if (!todo.length) {
    ui.say('Skills: the ones that come with Hoprig are installed.');
    return { ok: true, added, skipped };
  }
  // Without a question only on a first run (none of Hoprig's skills is there yet). On a computer that has some, a missing
  // one may have been refused or removed on purpose: asked at a terminal, skipped without one.
  const { loadCatalog } = await import('../skillhub/catalog.mjs');
  const first = todo.length === loadCatalog().entries.filter((e) => e.scope === 'user').length;
  for (const x of todo) {
    ui.say(`  ${x.id} (for you): ${x.for}`);
    if (dryRun) {
      skipped.push({ id: x.id, why: 'dry run' });
      continue;
    }
    if (!first && !(await ui.confirm(`Add "${x.id}" for you?`))) {
      skipped.push({ id: x.id, why: 'not asked for' });
      continue;
    }
    try {
      const review = await hub.prepare(x.id, {});
      // Hoprig's own skills come pinned and reviewed: added without a question; one with a blocking finding never is.
      const go = !review.counts.block && review.pinned;
      if (!go) {
        hub.cancel(review.id);
        skipped.push({ id: x.id, why: review.counts.block ? 'the review found a blocking problem' : 'not pinned' });
        continue;
      }
      added.push(hub.approve(review.id).name);
    } catch (e) {
      skipped.push({ id: x.id, why: e.message });
      return { ok: false, added, skipped };
    }
  }
  return { ok: true, added, skipped };
}

const heading = (ui, title) => ui.out(`\n${bold(title)}`);

/** "Workspace": the folder tree, before the projects folder is chosen (a new install keeps projects in it). */
export async function partWorkspace(ui, opts, p = real) {
  try {
    const r = await p.workspace({ ui, yes: opts.yes, dryRun: opts.dryRun });
    return { part: 'workspace', ok: r.ok };
  } catch (e) {
    ui.line('fail', `Workspace: ${e.message}`);
    return { part: 'workspace', ok: false, note: e.message, retry: 'hoprig workspace setup' };
  }
}

/** "Git and GitHub": after the computer's tools (gh), before the workspace (it may restore one from GitHub). */
export async function partGit(ui, opts, p = real) {
  try {
    const r = await p.git({ ui });
    return { part: 'git', ok: r.ok, retry: r.ok ? undefined : 'hoprig workspace git' };
  } catch (e) {
    ui.line('fail', `Git and GitHub: ${e.message}`);
    return { part: 'git', ok: false, note: e.message, retry: 'hoprig workspace git' };
  }
}

/** "This computer for coding". */
export async function partPc(ui, opts, p = real) {
  // runPcSetup prints its own heading ("This computer" and the OS).
  try {
    // The working rules are not asked here: Get started offers them as one press. The commit name and the GitHub
    // sign-in are the Git part's, asked once there (not when that part does not run: --only pc).
    const r = await p.pc({ ui, yes: opts.yes, dryRun: opts.dryRun, rules: false, signInLater: !opts.only, projects: false, extraSteps: opts.extraSteps || [], facts: opts.pcFacts });
    opts.extraRan = true; // the computer step listed them (setup.mjs then only says what came of them)
    if (opts.afterPc) await opts.afterPc();
    return { part: 'pc', ok: r.ok, note: r.ok ? (r.missing && r.missing.length ? `still missing: ${r.missing.join(', ')}` : '') : 'an install failed: its retry command is above' };
  } catch (e) {
    ui.line('fail', `This computer for coding: ${e.message}`);
    return { part: 'pc', ok: false, note: e.message, retry: 'hoprig pc setup' };
  }
}

/** "A project": show what is in the projects folder; a new name, owner/repo or a Git address; Enter skips. */
export async function partProject(ui, opts, p = real) {
  heading(ui, 'A project');
  const { dir, names } = await p.projects();
  if (names.length && !opts.askProject) {
    // Projects are there: nothing is missing, nothing is asked.
    ui.line('ok', `${dir}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}`);
    ui.note('Another one: hoprig project new <name>   or   hoprig project clone <owner/repo>');
    return { part: 'project', ok: true, dir: null };
  }
  ui.line('info', `${dir}: no project yet`);
  if (opts.dryRun) {
    ui.note('(dry run) would ask for a project: a new name, owner/repo or a Git address (Enter skips)');
    return { part: 'project', ok: true, dir: null };
  }
  if (opts.yes || !ui.interactive) {
    ui.note('Later: hoprig project new <name>   or   hoprig project clone <owner/repo>');
    return { part: 'project', ok: true, dir: null };
  }
  const a = await ui.ask(`  A project to work on: ${names.length ? 'one of the above, ' : ''}a new name, owner/repo or a Git address (Enter to skip): `);
  const answer = (a || '').trim();
  if (!answer) return { part: 'project', ok: true, dir: null };
  if (names.includes(answer)) {
    ui.line('ok', `${answer}: already here`);
    return { part: 'project', ok: true, dir: path.join(dir, answer) };
  }
  const { parseProjectSpec } = await import('../pcsetup/workspace.mjs');
  const spec = parseProjectSpec(answer);
  if (!spec) {
    ui.line('fail', `"${answer}" is not a project name, owner/repo or a Git address. Later: hoprig project new <name>`);
    return { part: 'project', ok: false, dir: null, retry: 'hoprig project new <name>' };
  }
  try {
    let got = null;
    const code = spec.url ? await p.cloneProject(answer, { ui, dir, onDone: (r) => (got = r) }) : await p.projectNew([answer], { ui });
    const target = got && got.dir ? got.dir : path.join(dir, spec.name);
    // Not done, it needs you (here under another name, or its folder taken): the command to run, not a retry.
    if (got && got.fix) return { part: 'project', ok: false, dir: null, note: got.result === 'misnamed' ? 'it is here already under another name; Hoprig moves nothing by itself' : got.temp ? 'its folder is taken, so the clone was left under a temporary name' : 'its folder holds another repository, so nothing was cloned', retry: got.fix };
    const ok = code === 0;
    return { part: 'project', ok, dir: ok && fs.existsSync(target) ? target : null, retry: ok ? undefined : spec.url ? `hoprig project clone ${answer}` : `hoprig project new ${answer}` };
  } catch (e) {
    ui.line('fail', `A project: ${e.message}`);
    return { part: 'project', ok: false, dir: null, retry: `hoprig project new ${answer}` };
  }
}

/** "Skills": for the project chosen above, else the ones for the user. */
export async function partSkills(ui, opts, project, p = real) {
  heading(ui, 'Skills');
  const sui = { say: (l) => ui.out(`  ${l}`), confirm: (q) => ui.confirm(q, true) };
  try {
    const r = project
      ? await p.projectSkills({ ui: sui, project, yes: opts.yes, dryRun: opts.dryRun })
      : await p.userSkills({ ui: sui, yes: opts.yes, dryRun: opts.dryRun });
    if (r.added.length) ui.line('ok', `added: ${r.added.join(', ')}`);
    const real_ = r.skipped.filter((s) => s.why !== 'dry run');
    for (const s of real_) ui.note(`not added: ${s.id} (${s.why})`);
    return { part: 'skills', ok: r.ok, note: r.ok ? '' : 'a skill could not be added', retry: r.ok ? undefined : 'hoprig skills suggest' };
  } catch (e) {
    ui.line('fail', `Skills: ${e.message}`);
    return { part: 'skills', ok: false, note: e.message, retry: 'hoprig skills suggest' };
  }
}

/** Run the chosen parts in order; a failure is recorded and the next part still runs. */
export async function runParts(ui, opts, { only = null, parts = real } = {}) {
  const p = { ...real, ...parts };
  const want = (x) => !only || only === x;
  const results = [];
  let project = null;
  if (want('pc')) results.push(await partPc(ui, opts, p));
  if (want('git')) results.push(await partGit(ui, opts, p));
  if (want('workspace')) results.push(await partWorkspace(ui, opts, p));
  if (want('project')) {
    const r = await partProject(ui, { ...opts, askProject: only === 'project' }, p);
    project = r.dir;
    results.push(r);
  }
  if (want('skills')) results.push(await partSkills(ui, opts, project, p));
  return results;
}

/** One line per part that did not finish, with its retry command. */
export function reportParts(ui, results) {
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return;
  ui.out();
  for (const r of failed) ui.line('warn', `${{ git: 'Git and GitHub', workspace: 'Workspace', pc: 'This computer for coding', project: 'A project', skills: 'Skills' }[r.part]}: not finished${r.note ? ` (${r.note})` : ''}${r.retry ? dim(`  retry: ${r.retry}`) : ''}`);
}

// ---- the quiet first run -------------------------------------------------------------------------------------------
// A first run is `hoprig setup` on a computer with no settings file yet and nothing chosen by hand. It asks nothing,
// installs only what the first chat needs (Claude Code, the terminal module, a password nobody needs to see, the
// service), keeps the dashboard to this computer, and ends by opening the browser signed in. A later `hoprig setup`
// (the settings file is there) is the full run with its questions: the way for an expert and for a second computer.

/** True when this run is a first run. `file`: the settings file's path (tests give their own). */
export function isFirstRun(opts, file) {
  if (opts.hub || opts.only || opts.dryRun || opts.stayRoot || opts.noDashboard || opts.access) return false;
  try {
    return !fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * The first run's way of talking: a tick per part and nothing else that went well. A step that failed, a warning and
 * a plain fact the person must know (info) still print.
 */
export function quietUi(ui) {
  const line = ui.line;
  ui.quiet = true;
  ui.line = (status, text) => (status === 'ok' ? undefined : line(status, text));
  ui.note = () => {};
  ui.tick = (text) => line('ok', text);
  return ui;
}

/**
 * The end of a first run: on a desktop the default browser opens at a one-time link, so the person is signed in; the
 * link is printed too, for a browser that did not open. A server (ssh, no desktop) opens nothing: its own end text.
 * `h`: { open, link(baseUrl), forward(port), ways(port) } (the callers' own, and tests').
 */
export async function openFirstRun(ui, state, sys, h) {
  const { loadConfig } = await import('../config.mjs');
  const cfg = loadConfig();
  const port = cfg.server.port || 7433;
  const local = `http://127.0.0.1:${port}`;
  const made = await h.link(local);
  if (state.server) {
    // A server: nobody can open a browser here. The ssh forward from the person's own computer, then this link.
    ui.out('  How to open the dashboard:');
    for (const w of h.ways(port)) ui.out(`    · ${w}`);
    ui.out(`        ${h.forward(port)}`);
    if (made) ui.out(`  Then open this link in your browser (it works once, for 15 minutes):\n  ${made.url}`);
    return;
  }
  ui.out();
  const { browserAtHand } = await import('../chat/cli.mjs');
  const { openBrowser, openedLines } = await import('../openbrowser.mjs');
  if (!made) {
    ui.out(`  Open ${local} in your browser.`);
    return;
  }
  const opened = browserAtHand(sys.env, sys.platform, true) && (h.open || openBrowser)(made.url);
  if (opened) for (const l of openedLines(made.url)) ui.out(`  ${l}`);
  else ui.out(`  Open this link in your browser (it works once, for 15 minutes):\n  ${made.url}`);
  ui.out('  You can close this window.');
}
