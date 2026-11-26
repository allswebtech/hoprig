// `hoprig workspace …` (docs/WORKSPACE.md). main(args) returns the exit code.
//   workspace status [--json]            the tree: what is there, what each folder is for
//   workspace setup [--dry-run] [--yes]  create only what is missing (asks once, unless --yes)
//   workspace link [--dry-run] [--yes]   link every coding tool's global rules, skills and memory to the brain
//   workspace map | restore | sync | set | forget | git      the git side (cli-git.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { bold, dim, makeUi, yours } from '../setup/ui.mjs';
import { GIT_COMMANDS, GIT_USAGE, gitMain, printMapStatus } from './cli-git.mjs';
import { isLinkedWorktree, workspaceStatus } from './layout.mjs';
import { mapStatus } from './map.mjs';
import { placesHere, projectsHere } from './where.mjs';
import { findTool } from '../codetools/index.mjs';
import { applyLink, planLink } from './link.mjs';
import { workspaceSetup } from './setup.mjs';
import { NEEDS_USAGE, needsMain } from './needsyes.mjs';
import { RULES_USAGE, currentWorkspaceRules, notWrittenWhy, rulesFileState, rulesMain, workspaceRulesState } from '../pcsetup/wsrules.mjs';

export const USAGE = `usage:
  hoprig workspace status [--all] [--json]     the workspace: what is there and what each folder is for;
                                               --all: which computer has what (each computer's own file);
                                               names each project's "needs" that are not on this computer
  hoprig workspace setup [--dry-run] [--yes]   create only what is missing (nothing that exists is changed)
  hoprig workspace link [--dry-run] [--yes]    let every coding tool that is on (Claude Code, OpenCode) read
                                               the same rules, skills and memory from the AI brain (backs up what
                                               is there; overwrites nothing); and make the credential links each
                                               project's project.json names
${RULES_USAGE}
${NEEDS_USAGE}
  hoprig workspace mylink [list] [--json]      the links you named as your own on this computer (Hoprig follows
                                               them; any other link that leads out of its folder is not followed)
  hoprig workspace mylink add|remove <path>    name a link in the workspace as yours (a project folder kept on
                                               another disk), or take it off the list; never in the map, never synced
  hoprig workspace credentials [--json]       the credentials folder: a local folder, or a repository (its address)
  hoprig workspace credentials --repo <address> | --github [<name>] [--dry-run]
                                               make it your own private repository and push it (off by default;
                                               you confirm by typing the repository's name)
${GIT_USAGE}`;

const flagsOk = (args, known) => args.every((a) => known.includes(a));

/**
 * The top folder of a repository that tracks the link `p` (git ls-files), or null. The link may lie in a member that is
 * a repository of its own while the group's repository around it tracks it: each repository up from it is asked.
 * Reads through gitread.mjs.
 */
async function trackedBy(p) {
  const { gitRead } = await import('../gitread.mjs');
  const { realOf } = await import('./inside.mjs');
  const real = path.join(realOf(path.dirname(p)) || path.dirname(p), path.basename(p)); // git answers with real paths
  let d = path.dirname(p);
  for (let i = 0; i < 8; i++) {
    const top = await gitRead(d, ['rev-parse', '--show-toplevel']);
    // git writes the folder with / on Windows too (C:/Users/…): named in the system's own form, as every other path.
    const root = top.ok && top.stdout.trim() ? path.resolve(top.stdout.trim()) : '';
    if (!root) return null;
    const r = await gitRead(root, ['ls-files', '--', path.relative(root, real)]);
    if (r.ok && r.stdout.trim()) return root;
    if (path.dirname(root) === root) return null;
    d = path.dirname(root);
  }
  return null;
}

/**
 * `hoprig workspace mylink [list|add|remove] …`: the links the owner names as his own on this computer (inside.mjs).
 * Kept in Hoprig's own settings, never in the map. → exit code
 */
async function mylinkMain(args, { ui, write, usage }) {
  const { addMyLink, myLinkCommand, myLinkEntries, realOf, removeMyLink } = await import('./inside.mjs');
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const [sub = 'list', p, ...more] = rest;
  if (more.length || (sub === 'list' ? p !== undefined : !p)) return usage();
  try {
    if (sub === 'list') {
      const links = myLinkEntries().map((x) => {
        const there = fs.existsSync(x.path);
        const now = there ? realOf(x.path) : null;
        return { path: x.path, to: x.to, there, ...(there && now !== x.to ? { now } : {}) };
      });
      if (json) write(JSON.stringify({ links }, null, 2) + '\n');
      else if (!links.length) ui.note('no link of yours yet: hoprig workspace status names each link that leads out, with the command');
      else {
        for (const l of links) {
          const why = !l.there ? '  (not on this computer now)' : l.now ? `  (it points to ${l.now} now, not to ${l.to}: not followed;  ${myLinkCommand(l.path)}  follows it again)` : `  → ${l.to}`;
          ui.line(l.there && !l.now ? 'ok' : 'warn', `${l.path}${why}`);
        }
      }
      return 0;
    }
    if (sub === 'add') {
      const r = addMyLink(p);
      // A link a repository tracks can be pointed elsewhere by a pull: said once, here, never a reason to refuse.
      const tracked = await trackedBy(r.path);
      if (json) write(JSON.stringify({ ok: true, ...r, ...(tracked ? { trackedBy: tracked } : {}) }, null, 2) + '\n');
      else {
        ui.line('ok', r.added ? `${r.path} is your own link now (it points to ${r.to}): Hoprig follows it on this computer while it points there` : `${r.path} was yours already`);
        if (r.moved) ui.note(`it pointed to ${r.moved} before`);
        if (tracked) ui.note(`the repository ${tracked} tracks this link: when a pull points it elsewhere, Hoprig stops following it and says so`);
      }
      return 0;
    }
    if (sub === 'remove') {
      const r = removeMyLink(p);
      if (json) write(JSON.stringify({ ok: true, ...r }, null, 2) + '\n');
      else ui.line(r.removed ? 'ok' : 'info', r.removed ? `${r.path} is off your list: Hoprig no longer follows it` : `${r.path} was not on your list`);
      return 0;
    }
  } catch (e) {
    if (json) write(JSON.stringify({ ok: false, error: e.message }, null, 2) + '\n');
    else ui.line('fail', e.message);
    return 1;
  }
  return usage();
}

/** The tree, one line per folder. */
export function printStatus(ui, st) {
  ui.out(`\n${bold('Workspace')}  ${st.short}${st.source === 'default' ? '' : dim(`  (from ${st.source === 'env' ? 'HOPRIG_WORKSPACE_DIR' : 'the workspaceDir setting'})`)}`);
  const w = Math.max(...st.folders.map((f) => f.rel.length)) + 1;
  for (const f of st.folders) {
    const extra = f.id === 'ai_brain' && f.exists ? (f.git ? '  git' : '  not in git') : '';
    ui.line(f.warning ? 'warn' : f.exists ? 'ok' : 'info', `${`${f.rel}/`.padEnd(w)}  ${f.exists ? '' : dim('missing  ')}${dim(f.purpose)}${extra}${f.note ? dim(`  (${f.note})`) : ''}${f.warning ? `  ${f.warning}` : ''}`);
  }
  if (st.projects.length) ui.note(`projects in ${st.projectsShort}: ${st.projects.map((p) => `${p.name}${p.git ? '' : ' (not in git)'}`).join(', ')}`);
}

/** `status --all`: which computer has what, from each computer's own file in the brain. */
export function printComputers(ui, who) {
  ui.out(`\n${bold('Computers')}  ${dim('from each computer\'s own file in ai_brain/computers/')}`);
  if (who.folderWhy) ui.line('warn', who.folderWhy);
  if (!who.computers.length) ui.note('no computer has written its file yet (a computer with a label writes it at its next upkeep or hoprig workspace map)');
  for (const c of who.computers) {
    const dev = (c.folders.development && c.folders.development.items) || [];
    ui.line(c.old ? 'warn' : 'ok', `${c.label}${c.mine ? ' (this computer)' : `  ${c.written ? `as of ${new Date(c.written).toISOString().slice(0, 10)}` : 'as of an unknown time'}${c.old ? ' (old)' : ''}`}  ${dim(`Hoprig ${c.hoprig || 'unknown'}`)}  ${c.here.length ? c.here.join(', ') : 'no project'}${dev.length ? dim(`  · development: ${dev.map((d) => d.name).join(', ')}`) : ''}`);
  }
  for (const n of who.unknown || []) {
    const u = (who.unjoined || []).find((x) => x.name === n);
    ui.line('info', u ? `${n}  unknown: not joined with a file (its Hoprig has not said its workspace label); it may be ${u.maybe.join(' or ')}` : `${n}  unknown: it has written no file in the brain`);
  }
  for (const r of who.refused) ui.line('warn', `ai_brain/computers/${r.name} was refused: ${r.why}`);
}

/** Say what setup did (or would do). */
export function printSetup(ui, r) {
  for (const d of r.did) ui.line('ok', `${r.dryRun ? 'would create' : 'created'} ${d.path}: ${d.what}`);
  for (const l of r.left) ui.note(`${l.path}: ${l.why}`);
  // Inside set-up the first commit waiting for the git name and e-mail is one item of its closing list, after theirs.
  if (r.git && r.git.needsIdentity && ui.todo) yours(ui, 'info', 'the brain: no first commit yet (it waits for your name and e-mail)', 'brainCommit', { step: r.git.steps });
  else if (r.git) ui.line(r.git.done ? 'ok' : 'info', r.git.done ? 'the brain is a git repository with a first commit' : `the brain: ${r.git.why}`);
  if (!r.did.length) ui.line('ok', 'nothing is missing');
}

const ACTION = {
  already: 'already linked',
  link: 'link',
  merge: 'merge the folder\'s files into the brain (nothing overwritten), keep the folder as a backup, then link',
  adopt: 'move your file into the brain (a backup stays), then link',
  backup: 'same text as the brain\'s: keep it as a backup, then link',
  conflict: 'left alone',
};

export async function main(args = [], { ui = makeUi({}), write = (s) => process.stdout.write(s) } = {}) {
  const [sub, ...rest] = args;
  const usage = () => {
    ui.out(USAGE);
    return 2;
  };
  if (sub === 'status' || sub === undefined) {
    if (!flagsOk(rest, ['--json', '--all'])) return usage();
    const st = workspaceStatus();
    // This computer in the workspace (computer.mjs): its label, and with --all which computer has what.
    const comp = await import('./computer.mjs');
    const who = comp.whoHasWhat();
    const computer = { label: who.label, ...(who.label ? { file: `ai_brain/${comp.relFileOf(who.label)}` } : { fix: 'hoprig workspace label <name>' }) };
    // The map against this computer: in the map and here, missing here ("get it"), here but not in the map.
    const ms = await mapStatus({ projects: st.projectsDir }).catch((e) => ({ exists: false, errors: [e.message], entries: [], counts: {} }));
    // The groups of a map of version 2: the projects in each, as the projects folder's are listed.
    const places = placesHere({ projects: st.projectsDir });
    const here = await projectsHere({ projects: st.projectsDir });
    // A project of a group is a repository (or, where members come with the group, a folder that is none); a plain
    // folder, a linked worktree, is no project.
    const isProject = (f) => (f.members === 'group' ? !f.git : f.git && !isLinkedWorktree(f.dir));
    const groups = places.filter((pl) => pl.id).map((pl) => ({ id: pl.id, dir: pl.dir, projects: here.filter((f) => f.place === pl.id && isProject(f)).map((f) => f.name) }));
    // What `hoprig get` left in every place it clones into: clones under a temporary name (a killed run, a folder name
    // that was taken) and locks (a run going on, or one that ended without removing its lock).
    const lo = await import('../pcsetup/leftovers.mjs');
    const own = places.filter((pl) => pl.members === 'own');
    const leftovers = (await Promise.all(own.map((pl) => lo.findLeftovers(pl.dir, undefined, { place: pl.id }).catch(() => [])))).flat();
    const locks = own.flatMap((pl) => lo.findLocks(pl.dir));
    // Clones that were cut off and moved aside under a dated name (inside.mjs cloneInto, hoprig get): never deleted by
    // Hoprig, so said here until the owner looks at them and removes them.
    const ASIDE = /^\..+\.broken-\d{8}-\d{6}$/;
    const asideIn = (d) => {
      try {
        return fs.readdirSync(d).filter((n) => ASIDE.test(n)).map((n) => path.join(d, n));
      } catch {
        return [];
      }
    };
    // What a drop cut off after its rename left (it had passed its whole check): the next drop or get finishes it.
    const { droppingIn } = await import('./dropfind.mjs');
    const dropping = [...places.flatMap((pl) => droppingIn(pl.dir).map((d) => ({ ...d, ref: pl.id ? `${pl.id}/${d.name}` : d.name }))), ...here.filter((f) => f.members === 'group').flatMap((f) => droppingIn(path.join(f.dir, 'code')).map((d) => ({ ...d, ref: f.ref })))].map((d) => ({ path: d.path, fix: `hoprig drop ${d.ref}` }));
    // The workspace folder itself too: restore moves a cut-off brain or credentials clone aside there.
    const brokenAside = [...new Set([...asideIn(st.dir), ...places.flatMap((pl) => asideIn(pl.dir)), ...here.filter((f) => f.git).flatMap((f) => asideIn(path.join(f.dir, 'code')))])];
    // Groups are said only where there are some: a workspace without them shows nothing of them.
    const some = (k, v) => (v && v.length ? { [k]: v } : {});
    // A group's own command: made, or waiting for the yes on this computer, and the programs it needs that are missing.
    const { toolsState } = await import('./grouptool.mjs');
    let tools = [];
    try {
      tools = (await toolsState({ projects: st.projectsDir })).map(({ group, name, run, state, changed, why, fix, missing }) => ({ group, name, run, state, ...(changed || why ? { ...(changed ? { changed } : {}), why } : {}), ...(fix ? { fix } : {}), missing }));
    } catch {
      /* a refused map: said below */
    }
    // The workspace rules file (wsrules.mjs): its state against what the map says now.
    const wr = workspaceRulesState({ text: (await currentWorkspaceRules({ projects: st.projectsDir })).text });
    const workspaceRules = { file: wr.file, state: rulesFileState(wr), ...(wr.folderLink ? { leadsTo: wr.folderLink } : {}) };
    // Credential links each project's project.json names that are not right (credlinks.mjs): missing, waiting for the
    // credentials folder, broken, refused. Their place and target as project.json names them, never a content.
    const cl = await import('./credlinks.mjs');
    const credLinks = (await cl.credLinksHere({ projects: st.projectsDir }).catch(() => [])).flatMap((c) => cl.shownLinks(c.plan).filter((e) => e.state !== 'ok').map((e) => ({ project: c.ref, ...e })));
    // Each project's needs (its project.json's "needs", workspace/needs.mjs): those not on this computer, with the get.
    const needs = await (await import('./needs.mjs')).needsHere({ projects: st.projectsDir }).catch(() => []);
    // --all: the one reader of which computer has what (whohas.mjs), the same answer the page and get --list give.
    const wh = rest.includes('--all') ? await (await import('./whohas.mjs')).whoHas({ projects: st.projectsDir, machines: await (await import('./whohas.mjs')).machineNames() }) : null;
    const all = wh ? { computers: wh.computers.map(({ label, hoprig, here, written, old, mine, listedAs }) => ({ label, hoprig, here, folders: (who.computers.find((c) => c.label === label) || {}).folders || {}, written, old, ...(mine ? { mine } : {}), ...(listedAs ? { listedAs } : {}) })), unknown: wh.unknown, ...some('unjoined', wh.unjoined || []), ...some('refused', who.refused), ...(who.folderWhy ? { folderWhy: who.folderWhy } : {}) } : {};
    if (rest.includes('--json')) write(JSON.stringify({ ...st, computer, ...all, ...some('groups', groups), ...some('tools', tools), map: { exists: ms.exists, errors: ms.errors, counts: ms.counts, entries: ms.entries, ...some('groups', ms.groups) }, leftovers: leftovers.map(({ path: p, url, complete, aside, fix }) => ({ path: p, url, complete, aside, fix })), locks, ...some('credLinks', credLinks), ...some('brokenAside', brokenAside), ...some('dropping', dropping), ...some('needs', needs), workspaceRules }, null, 2) + '\n');
    else {
      printStatus(ui, st);
      for (const g of groups) ui.note(`projects in ${g.id}/: ${g.projects.length ? g.projects.join(', ') : 'none yet'}`);
      const { toolLines } = await import('./grouptool.mjs');
      for (const t of tools) {
        if (t.state === 'made') ui.line('ok', `${t.name}: the command of ${t.group}`);
        else for (const l of toolLines([t])) ui.line(['blocked', 'stale'].includes(t.state) ? 'warn' : 'info', l);
        for (const m of t.missing) ui.line('warn', `${t.name} (${t.group}) needs ${m.program}, which this computer does not have${m.fix ? `:  ${m.fix}` : ''}`);
      }
      printMapStatus(ui, ms);
      for (const n of needs) {
        for (const x of n.notAccepted || []) ui.line('info', `${n.project} names ${x.name} as a need: not opened to its sessions until you allow it on this computer:  ${x.allow}`);
        if (n.missingNeeds.length) ui.line('info', `${n.project} needs ${n.missingNeeds.map((x) => x.name).join(', ')}, not on this computer:  hoprig get ${n.missingNeeds.map((x) => x.name).join(' ')}`);
        for (const r of n.refused) ui.line('warn', `${n.project}: ${r.name ? `the need "${r.name}" is not used: ` : ''}${r.why}`);
      }
      if (who.label) ui.line('ok', `this computer is ${who.label} in the workspace`);
      else ui.line('info', 'this computer has no label in the workspace yet, so it writes no file of its own in the brain:  hoprig workspace label <name>');
      if (rest.includes('--all')) printComputers(ui, { ...who, computers: who.computers.map((c) => ({ ...c, ...(wh.computers.find((x) => x.label === c.label) || {}) })), unknown: wh.unknown, unjoined: wh.unjoined || [] });
      // The workspace rules file, only when the owner wrote it once: older than what the map says now.
      if (wr.exists && wr.ours && !wr.current) ui.line('info', `${wr.file} is older than what the workspace map says now:  hoprig workspace rules --write`);
      else if (notWrittenWhy(wr)) ui.line('warn', notWrittenWhy(wr));
      for (const d of dropping) ui.line('warn', `${d.path}  a drop that was cut off (it had passed its whole check): finish it with  ${d.fix}`);
      if (credLinks.length) ui.out(`\n${bold('Credential links')}  ${dim('from each project\'s project.json:  hoprig workspace link  makes what can be made')}`);
      for (const e of credLinks) ui.line(cl.linkMark(e), cl.linkLine(e, e.project));
      if (leftovers.length || locks.length || brokenAside.length) ui.out(`\n${bold('Left by hoprig get')}  ${dim('clones under a temporary name, not projects yet')}`);
      for (const b of brokenAside) ui.line('warn', `${b}  a clone that was cut off, kept aside (it was cloned again): look at it, then remove it yourself`);
      for (const l of leftovers) ui.line('warn', `${l.path}${l.url ? dim(`  ${l.url}`) : ''}  ${l.complete ? 'a complete clone: finish it with' : l.aside ? 'kept aside:' : l.fix.startsWith('hoprig get') ? 'an unfinished clone:' : 'not finished by hoprig get:'}  ${l.fix}`);
      for (const l of locks) ui.line(l.running ? 'info' : 'warn', `${l.path}  a lock of hoprig get: ${l.running ? `its run goes on (process ${l.pid})` : 'its run has ended; the next hoprig get takes it over, and removing it is safe'}`);
    }
    return 0;
  }
  if (sub === 'setup') {
    if (!flagsOk(rest, ['--dry-run', '--yes'])) return usage();
    ui.yes = ui.yes || rest.includes('--yes');
    const plan = await workspaceSetup({ dryRun: true });
    if (!plan.did.length) {
      printSetup(ui, plan);
      return 0;
    }
    if (rest.includes('--dry-run')) {
      printSetup(ui, plan);
      return 0;
    }
    for (const d of plan.did) ui.out(`  ${d.path}: ${dim(d.what)}`);
    if (!(await ui.confirm('Create these?', true))) return 1;
    const r = await workspaceSetup();
    printSetup(ui, r);
    return 0;
  }
  if (sub === 'link') {
    if (!flagsOk(rest, ['--dry-run', '--yes'])) return usage();
    ui.yes = ui.yes || rest.includes('--yes');
    const dry = rest.includes('--dry-run');
    const plan = planLink();
    const who = (p) => (p.tools || [p.tool]).filter(Boolean).map((t) => findTool(t)?.name || t).join(' + ');
    for (const p of plan) ui.line(p.action === 'conflict' ? 'warn' : p.action === 'already' ? 'ok' : 'info', `${who(p) ? `${who(p)} · ` : ''}${p.what}: ${p.linkShort} → ${p.targetShort}  ${dim(p.how && p.action === 'link' ? p.how : ACTION[p.action])}${p.why ? `  (${p.why})` : ''}`);
    // The credential links every project here names in its project.json (credlinks.mjs).
    const cl = await import('./credlinks.mjs');
    const creds = await cl.credLinksHere();
    for (const c of creds) for (const e of c.plan) ui.line(cl.linkMark(e), cl.linkLine(e, c.ref, { dry }));
    const credTodo = creds.reduce((k, c) => k + c.plan.filter((e) => e.state === 'make').length, 0);
    const credBad = () => creds.some((c) => c.plan.some((e) => ['refused', 'broken'].includes(cl.kindOf(e.state))));
    const todo = plan.filter((p) => !['already', 'conflict'].includes(p.action));
    const all = todo.length + credTodo;
    if (!all || dry) return plan.some((p) => p.action === 'conflict') || credBad() ? 1 : 0;
    if (!(await ui.confirm(`Make ${all === 1 ? 'this link' : `these ${all} links`}?`, true))) return 1;
    const done = todo.length ? applyLink() : [];
    for (const d of done) if (!['already', 'conflict'].includes(d.action)) ui.line(d.error ? 'fail' : 'ok', `${who(d) ? `${who(d)} · ` : ''}${d.what}: ${d.error || d.done}`);
    for (const c of creds) {
      const made = c.plan.filter((e) => e.state === 'make');
      cl.makeCredLinks(c.root, c.plan);
      for (const e of made) ui.line(cl.linkMark(e), cl.linkLine(e, c.ref));
    }
    return done.some((d) => d.error || d.action === 'conflict') || credBad() ? 1 : 0;
  }
  if (sub === 'credentials') return (await import('./credrepo.mjs')).credentialsMain(rest, { ui, write, usage });
  if (sub === 'mylink') return mylinkMain(rest, { ui, write, usage });
  if (sub === 'needs') return needsMain(rest, { ui, write, usage });
  if (sub === 'rules') return rulesMain(rest, { ui, write, usage });
  if (GIT_COMMANDS.includes(sub)) return gitMain(sub, rest, { ui, write, usage });
  return usage();
}
