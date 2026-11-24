// The git side of `hoprig workspace` (docs/WORKSPACE.md): the map, restore, sync, where things are, forget, and the
// Git and GitHub step. Every command takes --json (the same data the dashboard's routes give) and the ones that
// change something take --dry-run.
import { flags } from '../pcsetup/project.mjs';
import { needsYes } from '../yes.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { runGitStep } from './gitstep.mjs';
import { FIND_USAGE, findMain } from './findcmd.mjs';
import { TOOL_USAGE, toolMain } from './grouptool.mjs';
import { GROUP_USAGE, groupMain } from './groupcmd.mjs';
import { forget, updateMap } from './map.mjs';
import { syncWith } from './peer.mjs';
import { setPlaces } from './places.mjs';
import { restoreWorkspace } from './restore.mjs';
import { syncAll } from './sync.mjs';

export const GIT_COMMANDS = ['map', 'restore', 'sync', 'set', 'forget', 'git', 'auto', 'group', 'find', 'tool', 'label'];
export const GIT_USAGE = `  hoprig workspace map [--dry-run] [--json]   write the map of every git repository of the workspace
                                               (ai_brain/workspace.json; shows what changed; never commits)
  hoprig workspace map --upgrade [--dry-run] [--yes] [--json]
                                               the map to version 2 (needed for groups); says first which
                                               computers need a newer Hoprig
  hoprig workspace restore <brain address> [--with-projects] [--dry-run] [--yes] [--json]
                                               a fresh computer: clone the brain, the credentials and groups'
                                               repositories and the others its map names; no project unless
                                               --with-projects (hoprig get <name> fetches one)
  hoprig workspace sync [<project>] [--memory] [--push] [--with <computer>] [--dry-run] [--json]
                                               every repository here (or one project's): fetch and fast-forward;
                                               push only with --push;
                                               --with: straight from another computer over SSH (pull only)
  hoprig workspace set [--dir <folder>] [--projects <folder>] [--json]
                                               where the workspace and the projects folder are (nothing is moved)
  hoprig workspace forget <entry> [--yes] [--json]
                                               take a project (<place>/<name> in a group), a code repository
                                               (project/code/name) or a folder out of the map (no file is deleted;
                                               asks first)
${GROUP_USAGE}
${FIND_USAGE}
${TOOL_USAGE}
  hoprig workspace git                         git's name and e-mail, the GitHub sign-in, your workspace on GitHub
  hoprig workspace label [<name>] [--again] [--new-id] [--dry-run] [--json]
                                               this computer's short name in the workspace (given once; its own
                                               file ai_brain/computers/<name>.json says what is here); --again: this
                                               computer IS <name>, set up again after a format; --new-id: it shares
                                               its id with another computer (a copied home folder)
  hoprig workspace auto [--map on|off] [--commit on|off] [--memory on|off] [--sync on|off] [--push on|off]
                       [--push-branches <place>=on|off] [--credentials on|off]
                       [--every <hours>] [--json]
                                               the upkeep the dashboard does by itself: show or set its switches`;

const MARK = { here: 'ok', notHere: 'info', missing: 'warn', notFollowed: 'warn', different: 'warn', unmapped: 'info' };
const SAY = { here: '', missing: 'in the map, not on this computer: get it with  hoprig workspace restore', notFollowed: 'behind a link that leads out: not followed', different: 'another folder is where the map puts it', unmapped: 'not in the map: add it with  hoprig workspace map' };

/** The map against this computer (status). */
export function printMapStatus(ui, ms) {
  if (ms.errors) return ui.line('fail', `the workspace map was refused: ${ms.errors.join('; ')}`);
  ui.out(`\n${bold('Map')}  ${ms.exists ? dim('ai_brain/workspace.json') : dim('none yet: hoprig workspace map')}`);
  const line = (e) => ui.line(MARK[e.state], `${e.label}${e.url ? dim(`  ${e.url}`) : dim('  not on a git server yet')}${SAY[e.state] ? `  ${SAY[e.state]}` : ''}${e.fix ? `  (${e.fix})` : ''}`);
  // Only in the map: the normal state, in a group of its own. A project not here is one line (its code repositories
  // come with it); a code repository missing in a project that IS here has its own line.
  const away = ms.entries.filter((e) => e.state === 'notHere' && !e.tool);
  const awayProjects = new Set(away.filter((e) => e.kind === 'project').map((e) => e.label));
  ms.entries.filter((e) => !e.tool && e.state !== 'notHere').forEach(line);
  const shown = away.filter((e) => e.kind === 'project' || !awayProjects.has(e.project));
  if (shown.length) {
    ui.out(`  ${bold('In the map, not on this computer')}  ${dim('a project comes to a computer when you ask for it')}`);
    for (const e of shown) ui.line('info', `${e.label}${e.url ? dim(`  ${e.url}`) : dim('  not on a git server yet')}  get it with  ${e.fix}`);
  }
  const tools = ms.entries.filter((e) => e.tool);
  if (tools.length) {
    ui.out(`  ${bold('Tools')}  ${dim('restored on a fresh computer, never synced ("sync": false in the map)')}`);
    tools.forEach(line);
  }
  if (ms.blocked) ui.line('fail', `the map cannot be written now, so it is not kept up to date: ${ms.blocked.join('; ')}`);
  for (const l of ms.leftOut || []) ui.line('warn', `${l.entry} is not put into the map: ${l.why}; ${l.fix}`);
  for (const d of ms.duplicates || []) ui.line('warn', `${d.entries.join(' and ')} have the same address (one project is in one place only): forget one, for example  ${d.fix}`);
  // Every link met that leads out (inside.mjs): not followed, with the command that names it as the owner's own.
  for (const l of ms.links || []) ui.line('warn', `${l.path}: ${l.what}: not followed${l.fix ? `  →  if it is yours:  ${l.fix}` : ''}`);
  for (const p of ms.mylinks || []) ui.line('info', `${p}: your own link (hoprig workspace mylink): followed`);
  for (const g of ms.groups || []) {
    if (g.refused) ui.line('warn', `${g.dir}: ${g.refused}`);
    else if (g.unignored.length) ui.line('warn', `${g.dir}: a \`git add\` in the group would take ${g.unignored.join(', ')} (not ignored there):  ${g.fix}`);
    else if (g.missingLines.length) ui.line('info', `${g.dir}: its ignore file lacks ${g.missingLines.join(' ')} (a member put there later would be taken):  ${g.fix}`);
  }
  if (ms.saved && ms.saved.unsaved) ui.line('warn', `the map changed and is not saved in the brain's history yet:  ${ms.saved.command}`);
}

/**
 * `fn` holding the AI brain's lock (src/work/lock.mjs), as the dashboard's upkeep and a save of the Work list hold it:
 * a label or a sync never runs between their steps. Waits for them a while, then says the brain is in use.
 */
async function brainLocked(fn) {
  const [{ withRepoLock }, { workspaceDir }, path] = await Promise.all([import('../work/lock.mjs'), import('./layout.mjs'), import('node:path')]);
  try {
    return await withRepoLock(path.join(workspaceDir(), 'ai_brain'), fn, { wait: 30_000 });
  } catch (e) {
    if (e.code === 'syncing' || e.code === 'busy') throw Object.assign(new Error('the AI brain is in use (the dashboard\'s upkeep, a sync or a save of the Work list): try again in a moment'), { status: 409 });
    throw e;
  }
}

/** A dry run writes nothing, not even the lock's file: it runs as it is. */
const dryOrLocked = (dry, fn) => (dry ? fn() : brainLocked(fn));

const ONOFF = { on: true, off: false };
/** `workspace auto`: the switches of the workspace automation (the setting the dashboard uses: automation.workspace). */
async function auto(args, { ui, json, failed, usage }) {
  const o = flags(args, { map: 'v', commit: 'v', memory: 'v', sync: 'v', push: 'v', 'push-branches': 'v', credentials: 'v', every: 'v', json: 'bool' });
  if (o.errors.length || o._.length) return usage();
  const { loadConfig, saveConfig } = await import('../config.mjs');
  const { cleanSettingsPatch, commitMapState, readSettings } = await import('../automation/settings.mjs');
  const { brainDir, remoteOf } = await import('./layout.mjs');
  const cur = readSettings(loadConfig().automation);
  const patch = {};
  for (const [flag, key] of [['map', 'map'], ['commit', 'commitMap'], ['memory', 'memory'], ['sync', 'sync'], ['push', 'push'], ['credentials', 'credentials']]) {
    if (o[flag] === undefined) continue;
    if (!(o[flag] in ONOFF)) return failed(new Error(`--${flag} is on or off`));
    patch[key] = ONOFF[o[flag]];
  }
  // --push-branches <place>=on|off: one place's switch ("projects" for the projects folder), the others kept.
  if (o['push-branches'] !== undefined) {
    const m = /^([^=]+)=(on|off)$/.exec(o['push-branches']);
    if (!m) return failed(new Error('--push-branches is <place>=on or <place>=off ("projects" for the projects folder)'));
    patch.pushBranches = { ...cur.workspace.pushBranches, [m[1]]: m[2] === 'on' };
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
  const cm = commitMapState(next.workspace, remoteOf(brainDir()));
  const w = { ...next.workspace, commitMap: cm.on };
  if (o.json) return json(w);
  const say = (on, text) => ui.line(on ? 'ok' : 'info', `${on ? 'on ' : 'off'}  ${text}`);
  say(w.map, 'map: the map keeps building itself (only where a map exists; written only when something changed)');
  say(w.commitMap, `commit: a change of the map is saved in the brain's history (that one file only)${cm.chosen ? '' : cm.on ? '; not chosen, on because the brain has a git server address' : '; not chosen, off because the brain has no git server address'}`);
  say(w.sync, 'sync: the AI brain, the groups\' own repositories and the other repositories are fetched and fast-forwarded (tools left alone; never a project)');
  say(w.memory, 'memory: the memory folders of the AI brain and of your groups\' own repositories are committed (and only them)');
  say(w.push, 'push: what is purely ahead is uploaded (the map\'s commit, and sync); a brain that moved on the git server too is brought in step when only the map differs here');
  const places = Object.keys(w.pushBranches || {});
  say(places.length > 0, `push-branches: committed work on branches that are not the default branch is pushed${places.length ? ` in ${places.join(', ')}` : ' (per place: --push-branches projects=on)'}; a default branch never`);
  say(w.credentials, 'credentials: a change in the credentials repository is committed ("Update credentials") and pushed to the address the map names, only while it is private');
  ui.note('a project is never fetched, fast-forwarded or pushed by itself otherwise: hoprig sync <name> does it when you ask');
  ui.note(`every ${w.everyHours} hour${w.everyHours === 1 ? '' : 's'}, and right after the dashboard starts${next.paused ? ' (all automations are paused now)' : ''}. The dashboard runs it: hoprig serve / service.`);
  return 0;
}

/**
 * `workspace label [<name>] [--again] [--new-id]`: this computer's label, shown or given (once). Never guessed: no name, no
 * change. --new-id: this computer shares its id with another (a copied home folder) and gets one of its own.
 */
async function labelMain(args, { ui, json, failed, usage }) {
  const o = flags(args, { again: 'bool', 'new-id': 'bool', 'dry-run': 'bool', json: 'bool' });
  if (o.errors.length || o._.length > 1) return usage();
  const c = await import('./computer.mjs');
  if (!o._.length) {
    const me = c.thisComputer();
    if (o.json) return json({ label: me.label, suggestion: me.label ? undefined : c.suggestLabel() });
    if (me.label) ui.line('ok', `this computer is ${me.label} in the workspace (its file: ai_brain/${c.relFileOf(me.label)})`);
    else ui.line('info', `this computer has no label in the workspace yet: hoprig workspace label <name> (for example ${c.suggestLabel()})`);
    return 0;
  }
  let r;
  try {
    const how = { again: o.again, newId: o['new-id'] };
    r = o['dry-run'] ? await c.setLabel(o._[0], { ...how, dryRun: true }) : await brainLocked(() => c.setLabel(o._[0], how));
  } catch (e) {
    return o.json ? (json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) }), 1) : failed(e);
  }
  if (o.json) return json({ ok: true, ...r });
  const said = { new: `this computer is ${r.label} in the workspace now`, same: `this computer is ${r.label} (its file in the brain is its own)`, kept: `this computer is ${r.label} already`, back: `this computer is ${r.label} again: its file starts again with an empty list of what is here` }[r.state];
  ui.line('ok', r.dryRun ? `(dry run) ${said.replace(/ now$| again:.*$/, '')}: nothing was written` : said);
  if (!r.dryRun && r.why) ui.note(`its file was not written: ${r.why}`);
  else if (!r.dryRun && r.written) ui.note(`commit the brain to share it (or turn on "keep the map on your git server by itself":  hoprig workspace auto --commit on --push on)`);
  return 0;
}

/** `workspace map --upgrade`: say which computers are behind (or that it cannot be known), ask once, upgrade. */
async function upgrade(o, { ui, json, failed }) {
  const { upgradeMap, upgradeWords } = await import('./mapupgrade.mjs');
  let plan;
  try {
    plan = upgradeMap({ dryRun: true });
  } catch (e) {
    return failed(e);
  }
  const show = (r) => {
    if (r.already) return ui.line('ok', 'the map is version 2 already');
    for (const d of r.dropped) ui.line('info', `${r.dryRun ? 'would drop' : 'dropped'} ${d}: its folder here is a linked worktree, not a repository of its own`);
    ui.line('ok', `${r.dryRun ? 'would upgrade' : 'upgraded'} the map from version ${r.from} to ${r.to}${r.dryRun ? '' : ': commit the brain to share it'}`);
  };
  if (plan.already || o['dry-run']) {
    if (o.json) return json(plan);
    if (!plan.already) for (const l of upgradeWords(plan)) ui.note(l);
    show(plan);
    return 0;
  }
  if (!o.json) for (const l of upgradeWords(plan)) ui.out(`  ${l}`);
  // Never yes by default: a computer that never reported cannot be seen from here.
  const sure = o.yes || ui.yes || (!o.json && ui.interactive && (await ui.confirm('Upgrade the map to version 2?', false)));
  if (!sure) return failed(new Error(`the map was not changed${ui.interactive || o.json ? '' : ' (add --yes to upgrade it without a question)'}`));
  let r;
  try {
    r = upgradeMap({});
  } catch (e) {
    return failed(e);
  }
  if (o.json) return json(r);
  show(r);
  return 0;
}

function printMap(ui, r) {
  const d = r.diff;
  if (d.created) ui.line('ok', `${r.dryRun ? 'would write' : 'wrote'} the map: ${r.map.projects.length} project${r.map.projects.length === 1 ? '' : 's'}, ${r.map.others.length} other repositor${r.map.others.length === 1 ? 'y' : 'ies'}`);
  for (const a of d.added) ui.line('ok', `added: ${a}`);
  for (const t of r.takenOut) ui.line('warn', `taken out of ${t.project} by its project.json: ${t.dir} (the project's own project.json is the truth for a project on this computer)`);
  if (r.notHere.length) ui.note(`in the map, not on this computer (kept; only forget takes something out): ${r.notHere.join(', ')}`);
  if (r.notFollowed && r.notFollowed.length) ui.note(`in the map and here, behind a link that leads out (kept, not followed; hoprig workspace status gives the command): ${r.notFollowed.join(', ')}`);
  for (const l of r.left || []) ui.line('warn', `${l.ref} is not put into the map: ${l.why}; rename or move one of the folders`);
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
    const o = flags(args, { 'dry-run': 'bool', json: 'bool', upgrade: 'bool', yes: 'bool' });
    if (o.errors.length || o._.length) return usage();
    if (o.upgrade) return upgrade(o, { ui, json, failed });
    const r = await updateMap({ dryRun: o['dry-run'] }).catch((e) => e);
    if (r instanceof Error) return failed(r);
    // This computer's own file beside the map (with a label only; a dry run writes nothing).
    const own = await (await import('./computer.mjs')).writeOwnFile({ dryRun: o['dry-run'] });
    if (o.json) return json({ ...r, computerFile: own });
    printMap(ui, r);
    if (own.written) ui.note(`this computer's file in the brain was brought up to date: ${own.file}`);
    else if (own.would) ui.note(`(dry run) would bring this computer's file in the brain up to date: ${own.file}`);
    else if (own.why) ui.note(own.why);
    return 0;
  }
  if (sub === 'restore') {
    const o = flags(args, { 'dry-run': 'bool', yes: 'bool', json: 'bool', 'with-projects': 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    ui.yes = ui.yes || o.yes;
    const withProjects = o['with-projects'];
    const plan = await restoreWorkspace(o._[0], { ui, dryRun: true, withProjects }).catch((e) => e);
    if (plan instanceof Error) return failed(plan);
    if (o['dry-run']) {
      if (o.json) return json(plan);
      printPlan(ui, plan);
      return 0;
    }
    if (!o.json) printPlan(ui, plan);
    const todo = plan.plan.filter((e) => e.action === 'clone').length + plan.folders.length;
    if (todo && !o.json && !(await ui.confirm(`Get ${todo === 1 ? 'this' : `these ${todo}`} now?`, true))) return 1;
    const r = await restoreWorkspace(o._[0], { ui, withProjects }).catch((e) => e);
    if (r instanceof Error) return failed(r);
    if (o.json) return json(r);
    ui.out(`\n${bold('Restored')}`);
    for (const e of r.plan.filter((x) => x.action !== 'notHere')) ui.line(String(e.result).startsWith('failed') ? 'fail' : /^(skipped|left alone)/.test(e.result) ? 'warn' : 'ok', `${e.label}: ${e.result}`);
    if (r.notHere) ui.note(`in the map, not on this computer (a project comes when you ask for it):  ${r.notHere.map((n) => `hoprig get ${n}`).join('  ·  ')}`);
    ui.note('Claude Code\'s global rules, skills and home memory: hoprig workspace link');
    return r.ok ? 0 : 1;
  }
  if (sub === 'sync') {
    const o = flags(args, { memory: 'bool', push: 'bool', with: 'v', 'dry-run': 'bool', json: 'bool' });
    if (o.errors.length || o._.length > 1 || (o._.length && o.with !== undefined)) return usage();
    const onLine = o.json ? () => {} : (l) => ui.out(`  ${l}`);
    if (o.with !== undefined) {
      if (o.push || o.memory) return failed(new Error('--with only gets commits from the other computer (pull only); --push and --memory are for the git server'));
      const r = await dryOrLocked(o['dry-run'], () => syncWith(o.with, { dryRun: o['dry-run'], onLine })).catch((e) => e);
      if (r instanceof Error) return failed(r);
      return o.json ? json(r) : r.repos.some((x) => x.todo.length) ? 1 : 0;
    }
    // One project's sync never touches the brain (syncAll leaves it out): it does not wait for the brain's lock.
    const r = await dryOrLocked(o['dry-run'] || Boolean(o._[0]), () => syncAll({ memory: o.memory, push: o.push, dryRun: o['dry-run'], onLine, only: o._[0] || null })).catch((e) => e);
    if (r instanceof Error) return failed(r);
    if (o.json) return json(r);
    for (const m of r.memory) ui.note(`memory of ${m.label}: ${m.committed ? 'committed' : m.why}`);
    if (!r.fromMap) ui.note('no workspace map yet: synced what is on this computer (hoprig workspace map writes one)');
    if (r.notHere.length) ui.note(`${r.notHere.length} in the map, not on this computer (left as they are; hoprig get <name> fetches one)`);
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
    const o = flags(args, { json: 'bool', yes: 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    const no = await needsYes({ yes: o.yes, command: 'hoprig workspace forget', act: `Taking ${o._[0]} out of the map`, question: `Take ${o._[0]} out of the workspace map? It is never added back by itself.`, done: 'changed' });
    if (no !== null) return no;
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
  if (sub === 'label') return labelMain(args, { ui, json, failed, usage });
  if (sub === 'group') return groupMain(args, { ui, write, usage });
  if (sub === 'find') return findMain(args, { ui, write, usage });
  if (sub === 'tool') return toolMain(args, { ui, write, usage });
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
  const ACT = { clone: 'clone', here: 'here already', different: 'left alone', 'no-address': 'skipped', misnamed: 'left alone', link: 'not followed' };
  for (const e of p.plan.filter((x) => x.action !== 'notHere')) ui.line(e.action === 'clone' ? 'info' : e.action === 'here' ? 'ok' : 'warn', `${e.label}  ${dim(e.url || 'no address')}  →  ${e.dest}  ${bold(ACT[e.action])}${e.why ? dim(`  (${e.why})`) : ''}`);
  for (const f of p.folders) ui.line('info', `create ${f.path}`);
  if (p.notHere) ui.note(`in the map, not on this computer, not cloned (hoprig get <name> fetches one; --with-projects gets them all): ${p.notHere.join(', ')}`);
  for (const n of p.notes) ui.note(n);
}

