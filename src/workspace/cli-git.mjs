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

export const GIT_COMMANDS = ['map', 'restore', 'sync', 'set', 'forget', 'git', 'auto'];
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
  hoprig workspace git                         git's name and e-mail, the GitHub sign-in, your workspace on GitHub
  hoprig workspace auto [--map on|off] [--commit on|off] [--sync on|off] [--push on|off] [--every <hours>] [--json]
                                               the upkeep the dashboard does by itself: show or set its switches`;

const MARK = { here: 'ok', missing: 'warn', different: 'warn', unmapped: 'info' };
const SAY = { here: '', missing: 'in the map, not on this computer: get it with  hoprig workspace restore', different: 'another folder is where the map puts it', unmapped: 'not in the map: add it with  hoprig workspace map' };

/** The map against this computer (status). */
export function printMapStatus(ui, ms) {
  if (ms.errors) return ui.line('fail', `the workspace map was refused: ${ms.errors.join('; ')}`);
  ui.out(`\n${bold('Map')}  ${ms.exists ? dim('ai_brain/workspace.json') : dim('none yet: hoprig workspace map')}`);
  const line = (e) => ui.line(MARK[e.state], `${e.label}${e.url ? dim(`  ${e.url}`) : dim('  not on a git server yet')}${SAY[e.state] ? `  ${SAY[e.state]}` : ''}`);
  ms.entries.filter((e) => !e.tool).forEach(line);
  const tools = ms.entries.filter((e) => e.tool);
  if (tools.length) {
    ui.out(`  ${bold('Tools')}  ${dim('restored on a fresh computer, never synced ("sync": false in the map)')}`);
    tools.forEach(line);
  }
  if (ms.saved && ms.saved.unsaved) ui.line('warn', `the map changed and is not saved in the brain's history yet:  ${ms.saved.command}`);
}

const ONOFF = { on: true, off: false };
/** `workspace auto`: the switches of the workspace automation (the setting the dashboard uses: automation.workspace). */
async function auto(args, { ui, json, failed, usage }) {
  const o = flags(args, { map: 'v', commit: 'v', sync: 'v', push: 'v', every: 'v', json: 'bool' });
  if (o.errors.length || o._.length) return usage();
  const { loadConfig, saveConfig } = await import('../config.mjs');
  const { cleanSettingsPatch, readSettings } = await import('../automation/settings.mjs');
  const cur = readSettings(loadConfig().automation);
  const patch = {};
  for (const [flag, key] of [['map', 'map'], ['commit', 'commitMap'], ['sync', 'sync'], ['push', 'push']]) {
    if (o[flag] === undefined) continue;
    if (!(o[flag] in ONOFF)) return failed(new Error(`--${flag} is on or off`));
    patch[key] = ONOFF[o[flag]];
  }
  if (o.every !== undefined) patch.everyHours = o.every;
  let next = cur;
  if (Object.keys(patch).length) {
    try {
      next = cleanSettingsPatch({ workspace: patch }, cur);
    } catch (e) {
      return failed(e);
    }
    saveConfig({ automation: next });
  }
  const w = next.workspace;
  if (o.json) return json(w);
  const say = (on, text) => ui.line(on ? 'ok' : 'info', `${on ? 'on ' : 'off'}  ${text}`);
  say(w.map, 'map: the map keeps building itself (only where a map exists; written only when something changed)');
  say(w.commitMap, 'commit: a change of the map is saved in the brain\'s history (that one file only)');
  say(w.sync, 'sync: every repository is fetched and fast-forwarded (tools are left alone)');
  say(w.push, 'push: what is purely ahead is uploaded (the map\'s commit, and sync)');
  ui.note(`every ${w.everyHours} hour${w.everyHours === 1 ? '' : 's'}, and right after the dashboard starts${next.paused ? ' (all automations are paused now)' : ''}. The dashboard runs it: hoprig serve / service.`);
  return 0;
}

function printMap(ui, r) {
  const d = r.diff;
  if (d.created) ui.line('ok', `${r.dryRun ? 'would write' : 'wrote'} the map: ${r.map.projects.length} project${r.map.projects.length === 1 ? '' : 's'}, ${r.map.others.length} other repositor${r.map.others.length === 1 ? 'y' : 'ies'}`);
  for (const a of d.added) ui.line('ok', `added: ${a}`);
  for (const t of r.takenOut) ui.line('warn', `taken out of ${t.project} by its project.json: ${t.dir} (the project's own project.json is the truth for a project on this computer)`);
  if (r.notHere.length) ui.note(`in the map, not on this computer (kept; only forget takes something out): ${r.notHere.join(', ')}`);
  for (const c of d.changed) ui.line('info', `changed address: ${c.label}: ${c.from || 'none'} → ${c.to || 'none'}`);
  if (d.same && !d.created && !r.otherChanges) ui.line('ok', 'the map is up to date');
  if (r.otherChanges) ui.line('info', `${r.dryRun ? 'would update' : 'updated'}: the projects folder, memory links or which entries are tools`);
  if (r.tools.length) ui.note(`tools: restored on a fresh computer, never synced: ${r.tools.join(', ')}`);
  for (const n of r.notes) ui.note(n);
  for (const m of r.manifests) ui.note(`${m.project}/project.json ${r.dryRun ? 'would get' : 'got'} ${m.added.join(', ')} (commit it in that project)`);
  if (!r.dryRun && !(d.same && !d.created && !r.otherChanges)) ui.note(`commit it:  ${r.commit}`);
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
  if (sub === 'auto') return auto(args, { ui, json, failed, usage });
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

