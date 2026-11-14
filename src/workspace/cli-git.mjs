// The git side of `hoprig workspace` (docs/WORKSPACE.md): the map, restore, sync, where things are, forget, and the
// Git and GitHub step. Every command takes --json (the same data the dashboard's routes give) and the ones that
// change something take --dry-run.
import { flags } from '../pcsetup/project.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { runGitStep } from './gitstep.mjs';
import { forget, updateMap } from './map.mjs';
import { syncWith } from './peer.mjs';
import { setPlaces } from './places.mjs';
import { restoreWorkspace } from './restore.mjs';
import { syncAll } from './sync.mjs';

export const GIT_COMMANDS = ['map', 'restore', 'sync', 'set', 'forget', 'git'];
export const GIT_USAGE = `  hoprig workspace map [--dry-run] [--json]   write the map of every git repository of the workspace
                                               (ai_brain/workspace.json; shows what changed; never commits)
  hoprig workspace restore <brain address> [--dry-run] [--yes] [--json]
                                               a fresh computer: clone the brain, then everything its map names
  hoprig workspace sync [--memory] [--push] [--with <computer>] [--dry-run] [--json]
                                               every repository: fetch and fast-forward; push only with --push;
                                               --with: straight from another computer over SSH (pull only)
  hoprig workspace set [--dir <folder>] [--projects <folder>] [--json]
                                               where the workspace and the projects folder are (nothing is moved)
  hoprig workspace forget <project or folder> [--json]   take it out of the map (no file is deleted)
  hoprig workspace git                         git's name and e-mail, the GitHub sign-in, your workspace on GitHub`;

const MARK = { here: 'ok', missing: 'warn', different: 'warn', unmapped: 'info' };
const SAY = { here: '', missing: 'not on this computer: get it with  hoprig workspace restore', different: 'another folder is where the map puts it', unmapped: 'not in the map: add it with  hoprig workspace map' };

/** The map against this computer (status). */
export function printMapStatus(ui, ms) {
  if (ms.errors) return ui.line('fail', `the workspace map was refused: ${ms.errors.join('; ')}`);
  ui.out(`\n${bold('Map')}  ${ms.exists ? dim('ai_brain/workspace.json') : dim('none yet: hoprig workspace map')}`);
  for (const e of ms.entries) ui.line(MARK[e.state], `${e.label}${e.url ? dim(`  ${e.url}`) : dim('  not on a git server yet')}${SAY[e.state] ? `  ${SAY[e.state]}` : ''}`);
}

function printMap(ui, r) {
  const d = r.diff;
  if (d.created) ui.line('ok', `${r.dryRun ? 'would write' : 'wrote'} the map: ${r.map.projects.length} project${r.map.projects.length === 1 ? '' : 's'}, ${r.map.others.length} other repositor${r.map.others.length === 1 ? 'y' : 'ies'}`);
  for (const a of d.added) ui.line('ok', `added: ${a}`);
  for (const a of d.removed) ui.line('warn', `removed: ${a} (no longer on this computer; use forget to keep it out, or restore to get it back)`);
  for (const c of d.changed) ui.line('info', `changed address: ${c.label}: ${c.from || 'none'} → ${c.to || 'none'}`);
  if (d.same && !d.created) ui.line('ok', 'the map is up to date');
  for (const n of r.notes) ui.note(n);
  for (const m of r.manifests) ui.note(`${m.project}/project.json ${r.dryRun ? 'would get' : 'got'} ${m.added.join(', ')} (commit it in that project)`);
  if (!r.dryRun && !(d.same && !d.created)) ui.note(`commit it:  ${r.commit}`);
}

export async function gitMain(sub, args, { ui, write, usage }) {
  const json = (v) => (write(JSON.stringify(v, null, 2) + '\n'), 0);
  const failed = (e) => {
    ui.line('fail', e.message);
    return 1;
  };
  if (sub === 'map') {
    const o = flags(args, { 'dry-run': 'bool', json: 'bool' });
    if (o.errors.length || o._.length) return usage();
    const r = await updateMap({ dryRun: o['dry-run'] }).catch((e) => e);
    if (r instanceof Error) return failed(r);
    if (o.json) return json(r);
    printMap(ui, r);
    return 0;
  }
  if (sub === 'restore') {
    const o = flags(args, { 'dry-run': 'bool', yes: 'bool', json: 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    ui.yes = ui.yes || o.yes;
    const plan = await restoreWorkspace(o._[0], { ui, dryRun: true }).catch((e) => e);
    if (plan instanceof Error) return failed(plan);
    if (o['dry-run']) {
      if (o.json) return json(plan);
      printPlan(ui, plan);
      return 0;
    }
    if (!o.json) printPlan(ui, plan);
    const todo = plan.plan.filter((e) => e.action === 'clone').length + plan.folders.length;
    if (todo && !o.json && !(await ui.confirm(`Get ${todo === 1 ? 'this' : `these ${todo}`} now?`, true))) return 1;
    const r = await restoreWorkspace(o._[0], { ui }).catch((e) => e);
    if (r instanceof Error) return failed(r);
    if (o.json) return json(r);
    ui.out(`\n${bold('Restored')}`);
    for (const e of r.plan) ui.line(String(e.result).startsWith('failed') ? 'fail' : /^(skipped|left alone)/.test(e.result) ? 'warn' : 'ok', `${e.label}: ${e.result}`);
    ui.note('Claude Code\'s global rules, skills and home memory: hoprig workspace link');
    return r.ok ? 0 : 1;
  }
  if (sub === 'sync') {
    const o = flags(args, { memory: 'bool', push: 'bool', with: 'v', 'dry-run': 'bool', json: 'bool' });
    if (o.errors.length || o._.length) return usage();
    const onLine = o.json ? () => {} : (l) => ui.out(`  ${l}`);
    if (o.with !== undefined) {
      if (o.push || o.memory) return failed(new Error('--with only gets commits from the other computer (pull only); --push and --memory are for the git server'));
      const r = await syncWith(o.with, { dryRun: o['dry-run'], onLine }).catch((e) => e);
      if (r instanceof Error) return failed(r);
      return o.json ? json(r) : r.repos.some((x) => x.todo.length) ? 1 : 0;
    }
    const r = await syncAll({ memory: o.memory, push: o.push, dryRun: o['dry-run'], onLine }).catch((e) => e);
    if (r instanceof Error) return failed(r);
    if (o.json) return json(r);
    for (const m of r.memory) ui.note(`memory of ${m.label}: ${m.committed ? 'committed' : m.why}`);
    if (!r.fromMap) ui.note('no workspace map yet: synced what is on this computer (hoprig workspace map writes one)');
    ui.out(`\n  ${r.done} in step, ${r.todo} thing${r.todo === 1 ? '' : 's'} to decide${o.push ? '' : ' (pushing only with --push)'}`);
    return r.todo ? 1 : 0;
  }
  if (sub === 'set') {
    const o = flags(args, { dir: 'v', projects: 'v', json: 'bool' });
    if (o.errors.length || o._.length) return usage();
    let r;
    try {
      r = setPlaces({ dir: o.dir, projects: o.projects });
    } catch (e) {
      return failed(e);
    }
    if (o.json) return json(r);
    for (const c of r.changed) ui.line('ok', `${c.what}: ${c.from} → ${c.to}`);
    for (const n of r.notes) ui.note(n);
    for (const m of r.moves) ui.note(`to move the files too:  ${m}`);
    return 0;
  }
  if (sub === 'forget') {
    const o = flags(args, { json: 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    let r;
    try {
      r = forget(o._[0]);
    } catch (e) {
      return failed(e);
    }
    if (o.json) return json(r);
    ui.line('ok', `${r.forgotten} ${r.wasInMap ? 'is out of the map' : 'was not in the map; it stays out'} (no file was touched; the map keeps it out from now on). Commit the brain to share that.`);
    return 0;
  }
  if (sub === 'git') {
    if (args.length) return usage();
    const r = await runGitStep({ ui });
    return r.ok ? 0 : 1;
  }
  return usage();
}

/** Restore's plan: every repository and where it goes. */
function printPlan(ui, p) {
  ui.out(`\n${bold('Restore')}  ${dim(`from ${p.brain}`)}`);
  const ACT = { clone: 'clone', here: 'here already', different: 'left alone', 'no-address': 'skipped' };
  for (const e of p.plan) ui.line(e.action === 'clone' ? 'info' : e.action === 'here' ? 'ok' : 'warn', `${e.label}  ${dim(e.url || 'no address')}  →  ${e.dest}  ${bold(ACT[e.action])}${e.why ? dim(`  (${e.why})`) : ''}`);
  for (const f of p.folders) ui.line('info', `create ${f.path}`);
  for (const n of p.notes) ui.note(n);
}

