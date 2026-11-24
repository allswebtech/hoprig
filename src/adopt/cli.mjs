// `hoprig adopt …` and `hoprig sessions move`: a computer that already has projects, in three steps (scan.mjs,
// plan.mjs, apply.mjs) and two after them (retire.mjs). The words of each step and of every refusal are here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../setup/system.mjs';
import { bold, dim, makeUi } from '../setup/ui.mjs';
import { flags } from '../pcsetup/project.mjs';
import { projectsDir } from '../pcsetup/projects.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { claudeDir } from '../paths.mjs';
import { scanPlaces } from './scan.mjs';
import { makePlan, planFile, writePlan } from './plan.mjs';
import { applyPlan } from './apply.mjs';
import { retireProject, verifyProject } from './retire.mjs';

export const ADOPT_USAGE = `usage: hoprig adopt scan [--in <folder>]… [--json]     look at the projects in the folders you name (changes nothing)
       hoprig adopt plan <folder | all --in <folder>…> [--json]   a plan per project, as a file; nothing else is written
                    (it asks GitHub, with this computer's sign-in, whether each repository there is public or private)
       hoprig adopt apply <project> [--dry-run] [--name <n> --email <e>]   copy it into your workspace and prove the copy
                    [--clean-stopped]                    first remove the half-made copy of an apply that stopped partway
       hoprig adopt verify <project>                         prove the copy against the original again
       hoprig adopt retire <project>                         remove the originals (on a terminal, with the name typed)
A scan never fetches and never enters a private folder; apply copies, never moves; the originals stay until retire.`;
export const SESSIONS_USAGE = 'usage: hoprig sessions move <old folder> <new folder> [--dry-run]\n       copies the coding tool\'s conversations of the old folder under the new one (the old ones stay)';

/**
 * The usual places a person keeps projects in, those that are there (each only stat'ed: none is entered). A folder
 * reached by two names is proposed once, by the first: it is known by its device and inode, not its path, since on a
 * disk that ignores letter case (macOS's usual one) `Code` and `code` are one folder and a realpath keeps the case it
 * was given. `stat` is handed in by a test that plays such a disk.
 */
export function usualPlaces(home = os.homedir(), platform = process.platform, { stat = fs.statSync, realpath = fs.realpathSync } = {}) {
  const names = ['code', 'Code', 'projects', 'Projects', 'src', 'dev', 'work', 'repos', 'git', path.join('Documents', 'GitHub'), path.join('Documents', 'Projects')];
  const out = names.map((n) => path.join(home, n));
  if (platform === 'win32') for (const d of 'DEF') for (const n of ['work', 'projects', 'code', 'dev']) out.push(`${d}:\\${n}`);
  const seen = new Set();
  return out.filter((p) => {
    try {
      const st = stat(p, { bigint: true });
      // A file system that gives no inode numbers (0: some network and Windows ones) is told apart by the real path.
      const k = st.ino ? `${st.dev}:${st.ino}` : `path:${realpath(p)}`;
      if (seen.has(k) || !st.isDirectory()) return false;
      seen.add(k);
      return true;
    } catch {
      return false;
    }
  });
}

/** A proof line's mark on the terminal: a warning, a pass or a failure. */
export const mark = (l) => (!l.ok ? 'fail' : l.warn ? 'warn' : 'ok');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A size in plain words: KB below a megabyte. */
export const sizeText = (b) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(1)} GB`);

/** One repository's state in plain words. */
export function repoWords(r) {
  if (!r.ok) return `cannot be read by git: ${r.error}`;
  const bits = [`on ${r.branch}`];
  bits.push(r.remote ? `remote ${r.remote}` : 'no remote');
  if (r.upstream) bits.push(r.ahead || r.behind ? `${r.ahead} ahead, ${r.behind} behind (as of its last fetch)` : 'in step with its remote as of its last fetch');
  if (r.uncommitted) bits.push(`${plural(r.uncommitted, 'uncommitted change')} (copied as they are, never committed)`);
  if (r.eolOnly) bits.push(`${plural(r.eolOnly, 'file')} that git shows as changed but that differ${r.eolOnly === 1 ? 's' : ''} in line endings only (copied as they are)`);
  if (r.stashes) bits.push(plural(r.stashes, 'stash', 'stashes'));
  if (r.otherBranches) bits.push(plural(r.otherBranches, 'other branch', 'other branches'));
  if (r.worktrees) bits.push(plural(r.worktrees, 'linked worktree'));
  bits.push(`${sizeText(r.bytes)} without dependencies`);
  return bits.join(', ');
}

/** What makes a copy unsafe now, in words, or ''. */
export const unsafeWords = (r) => (r.busy ? `not safe to copy now: ${plural(r.busy, 'program')} working in it (arrange waits until it ends)` : r.recent ? `${plural(r.recent, 'file')} changed within the hour: if you are still working in it, finish first` : '');

async function scanCmd(o, ui, write) {
  const places = [].concat(o.in || []);
  if (!places.length) {
    const usual = usualPlaces();
    if (o.json) write(`${JSON.stringify({ places: [], proposed: usual, projects: [] }, null, 2)}\n`);
    else {
      ui.out('Nothing was looked at: a scan looks only in the folders you name.');
      if (usual.length) {
        ui.out('Folders where projects are often kept, found here (none was entered):');
        for (const u of usual) ui.out(`  ${u}`);
        ui.out(`Look in one: ${bold(`hoprig adopt scan --in ${usual[0].includes(' ') ? `"${usual[0]}"` : usual[0]}`)}`);
      } else ui.out(`Name a folder: ${bold('hoprig adopt scan --in <folder>')}`);
    }
    return 0;
  }
  const r = await scanPlaces(places);
  const { busyIn } = await import('./apply.mjs');
  for (const p of r.projects) for (const x of p.repos) x.busy = (await busyIn([x.dir])) || 0;
  if (o.json) {
    write(`${JSON.stringify(r, null, 2)}\n`);
    return r.places.every((p) => p.ok) ? 0 : 1;
  }
  for (const p of r.places) if (!p.ok) ui.line('fail', `${p.dir}: ${p.error}`);
  ui.out(`Looked in ${r.places.filter((p) => p.ok).map((p) => p.dir).join(', ')}: ${plural(r.projects.length, 'project')} found. Nothing was changed and nothing was fetched.`);
  for (const p of r.projects) {
    ui.out(`\n${bold(p.name)}  ${dim(p.dir)}${p.layout ? dim('  (already in the workspace layout)') : ''}`);
    for (const x of p.repos) {
      ui.out(`  ${path.relative(p.dir, x.dir) || '.'}: ${repoWords(x)}`);
      const u = unsafeWords(x);
      if (u) ui.line('warn', u);
    }
    if (p.ai.length) ui.out(`  AI tools' files: ${p.ai.join(', ')}`);
    if (p.neighbours.length) ui.out(`  beside it: ${p.neighbours.join(', ')}`);
    if (p.privates) ui.out(`  ${plural(p.privates, 'private folder')} (not looked into; it travels whole)`);
  }
  if (r.privates) ui.out(`\n${plural(r.privates, 'private folder')} in the places themselves: not looked into.`);
  if (r.projects.length) ui.out(`\nNext: ${bold(`hoprig adopt plan ${r.projects[0].dir.includes(' ') ? `"${r.projects[0].dir}"` : r.projects[0].dir}`)}  ${dim('(a plan file for one project; nothing else is written)')}`);
  return 0;
}

/** A plan in words, for the terminal. */
export function printPlan(ui, p) {
  ui.out(`\n${bold(`Plan for ${p.name}`)}  ${dim(`from ${p.from}`)}`);
  ui.out(`  into ${p.to}${p.exists ? '  (that folder is there already: apply will refuse)' : ''}`);
  for (const r of p.repos) ui.out(`  repository ${r.rel} -> ${r.to}  ${dim('(copied whole: history, stashes, uncommitted and ignored files)')}${r.worktrees.length ? `\n    with ${r.worktrees.map((w) => `the worktree ${path.basename(w.from)} -> ${w.to}`).join(', ')}` : ''}`);
  for (const n of p.neighbours) ui.out(`  ${n.from} -> ${n.private ? `${n.to}  ${dim('(a private folder: copied, never looked into, so its contents are not checked)')}` : n.to ? `${n.to}${n.why ? dim(`  (${n.why})`) : n.read ? dim('  (to be read: is it the plan the project came from, or a log with secrets?)') : ''}` : `stays where it is${n.why ? dim(`  (${n.why})`) : ''}`}`);
  for (const r of p.repos) if (r.visibility) ui.out(`  ${r.rel === '.' ? 'the repository' : r.rel}${r.visibility.state === 'local' ? ': ' : ' on its server: '}${r.visibility.words}`);
  for (const s of p.tools.skills) ui.out(`  skill ${s.name} (${s.tool}): copied, and a pointer in .claude/skills/${s.name}`);
  for (const r of p.tools.rules) ui.out(`  rules file ${r.file}: to read with you (what is about you, what is about the project)`);
  for (const h of p.tools.hooks) ui.out(`  hook ${h.file}${h.event ? ` (${h.event})` : ''}: copied, not run; if it guards something, Claude Code needs its equal`);
  for (const s of p.sessions) ui.out(`  ${plural(s.count, `${s.tool} session`)}${s.moves ? ': copied under the new folders' : ': stay in that tool\'s own folder (not brought)'}`);
  if (p.breaks.length) {
    ui.out('  These name an old folder and would break when it goes (listed, never rewritten):');
    for (const b of p.breaks.slice(0, 30)) ui.out(`    ${b.file}${b.line ? `:${b.line}` : ' (a link)'}`);
    if (p.breaks.length > 30) ui.out(`    … and ${p.breaks.length - 30} more`);
  }
  for (const n of p.nested || []) ui.out(`  ${n}: an untracked folder that looks like another project; it is copied with its repository. Decide whether it belongs there before any first push`);
  for (const n of p.notes) ui.out(`  ${dim(n)}`);
}

async function planCmd(o, ui, write) {
  const target = o._[1];
  if (!target) {
    ui.out(ADOPT_USAGE);
    return 2;
  }
  let dirs;
  if (target === 'all') {
    const places = [].concat(o.in || []);
    if (!places.length) {
      ui.line('fail', 'plan all needs the folders to look in: hoprig adopt plan all --in <folder>');
      return 2;
    }
    dirs = (await scanPlaces(places)).projects.map((p) => p.dir);
  } else {
    const d = path.resolve(target);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
      ui.line('fail', `${d} is not a folder`);
      return 2;
    }
    dirs = [d];
  }
  const plans = [];
  for (const d of dirs) {
    const p = await makePlan(d, { projects: projectsDir(), home: os.homedir(), claude: claudeDir(), ask: capture });
    writePlan(p);
    plans.push(p);
  }
  if (o.json) {
    write(`${JSON.stringify({ plans: plans.map((p) => ({ ...p, file: planFile(p.name) })) }, null, 2)}\n`);
    return 0;
  }
  for (const p of plans) {
    printPlan(ui, p);
    ui.out(`  ${dim(`The plan is the file ${planFile(p.name)}: you may edit it. Nothing else was written.`)}`);
  }
  if (plans.length) ui.out(`\nNext: ${bold(`hoprig adopt apply ${plans[0].name} --dry-run`)}  ${dim('(what apply would do; then without --dry-run)')}`);
  return 0;
}

async function applyCmd(o, ui, write) {
  const name = o._[1];
  if (!name) {
    ui.out(ADOPT_USAGE);
    return 2;
  }
  if ((o.name && !o.email) || (!o.name && o.email)) {
    ui.line('fail', '--name and --email go together (the identity of the parent\'s first commit)');
    return 2;
  }
  let r;
  const startedAt = Date.now();
  const report = async (x) => (await import('../field/wire.mjs')).reportAdopt(x, startedAt); // a field report (src/field)
  try {
    r = await applyPlan(name, {
      projects: projectsDir(),
      workspace: workspaceDir(),
      dryRun: !!o['dry-run'],
      cleanStopped: !!o['clean-stopped'],
      identity: o.name ? { name: String(o.name), email: String(o.email) } : null,
      say: o.json ? () => {} : (l) => ui.line(mark(l), l.words),
    });
  } catch (e) {
    if (!o['dry-run']) await report({ code: e.code });
    if (o.json) write(`${JSON.stringify({ ok: false, code: e.code || null, error: e.message }, null, 2)}\n`);
    else ui.line('fail', e.message);
    return 1;
  }
  await report(r);
  if (o.json) {
    write(`${JSON.stringify({ ok: r.ok, dryRun: !!r.dryRun, lines: r.lines, needs: r.needs, error: r.error || null }, null, 2)}\n`);
    return r.ok ? 0 : 1;
  }
  if (r.dryRun) ui.out(`\n${dim('A dry run: nothing was written.')} Next: ${bold(`hoprig adopt apply ${name}`)}`);
  else if (r.ok) {
    if (r.needs.length) {
      ui.out(`\n${bold('What still needs you')} (nothing of it was changed by itself):`);
      for (const n of r.needs) ui.out(`  ${n.kind}: ${n.words}`);
    }
    ui.out(`\nNext: ${bold(`hoprig adopt verify ${name}`)} any time; your old folders stay until ${bold(`hoprig adopt retire ${name}`)}.`);
  } else ui.line('fail', r.error || 'the copy was not the same as its original: nothing was kept, and the originals were not touched');
  return r.ok ? 0 : 1;
}

export async function main(args, { ui = makeUi({}), write = (s) => process.stdout.write(s) } = {}) {
  const o = flags(args, { in: 'v', json: 'bool', 'dry-run': 'bool', 'clean-stopped': 'bool', name: 'v', email: 'v', help: 'bool' });
  // --in is repeatable: flags() keeps the last, so it is read again here.
  o.in = args.flatMap((a, i) => (a === '--in' ? [args[i + 1]] : a.startsWith('--in=') ? [a.slice(5)] : [])).filter(Boolean);
  const sub = o._[0];
  if (o.help || !sub) {
    write(`${ADOPT_USAGE}\n`);
    return o.help ? 0 : 2;
  }
  if (o.errors.length) {
    write(`${o.errors.join('; ')}\n${ADOPT_USAGE}\n`);
    return 2;
  }
  const u = o.json ? makeUi({ interactive: false, write: (s) => process.stderr.write(s) }) : ui;
  if (sub === 'scan') return scanCmd(o, u, write);
  if (sub === 'plan') return planCmd(o, u, write);
  if (sub === 'apply') return applyCmd(o, u, write);
  if (sub === 'verify') {
    if (!o._[1]) return (write(`${ADOPT_USAGE}\n`), 2);
    let lines;
    try {
      lines = await verifyProject(o._[1], { projects: projectsDir() });
    } catch (e) {
      u.line('fail', e.message);
      return 1;
    }
    if (o.json) write(`${JSON.stringify({ ok: lines.every((l) => l.ok), lines }, null, 2)}\n`);
    else for (const l of lines) u.line(mark(l), l.words);
    if (!o.json && !lines.every((l) => l.ok)) u.out(dim('A difference here is a change made in the copy or in the original since apply (yours, or a program\'s).'));
    return lines.every((l) => l.ok) ? 0 : 1;
  }
  if (sub === 'retire') {
    if (!o._[1] || o.json) return (write(`${o.json ? 'retire takes no --json: it asks on the terminal\n' : ''}${ADOPT_USAGE}\n`), 2);
    let r;
    const startedAt = Date.now();
    const report = async (x) => (await import('../field/wire.mjs')).reportRetire(x, startedAt); // a field report (src/field)
    try {
      r = await retireProject(o._[1], { projects: projectsDir(), ask: u.interactive ? (q) => u.ask(`  ${q}`) : null, say: (s) => u.out(`  ${s}`) });
    } catch (e) {
      await report({ code: e.code });
      u.line('fail', e.message);
      return 1;
    }
    await report(r);
    u.line(r.ok ? 'ok' : 'fail', r.words);
    return r.ok ? 0 : 1;
  }
  write(`unknown step "${sub}"\n${ADOPT_USAGE}\n`);
  return 2;
}

/** `hoprig sessions move <old> <new> [--dry-run]`. */
export async function sessionsMain(args, { ui = makeUi({}), write = (s) => process.stdout.write(s) } = {}) {
  const o = flags(args, { 'dry-run': 'bool', help: 'bool' });
  if (o.help || o._[0] !== 'move' || o._.length !== 3 || o.errors.length) {
    write(`${o.errors.length ? `${o.errors.join('; ')}\n` : ''}${SESSIONS_USAGE}\n`);
    return o.help ? 0 : 2;
  }
  const { copySessions } = await import('../sessions.mjs');
  const [from, to] = [path.resolve(o._[1]), path.resolve(o._[2])];
  if (from === to) {
    ui.line('fail', 'the two folders are the same');
    return 2;
  }
  const r = copySessions(from, to, { dryRun: !!o['dry-run'] });
  const n = r.copied.length;
  ui.line(r.differ.length ? 'warn' : 'ok', `${o['dry-run'] ? 'would copy' : 'copied'} ${plural(n, 'file')} of the coding tool's conversations of ${from} under ${to}${r.same.length ? ` (${r.same.length} were there already, the same)` : ''}; the old ones stay`);
  for (const d of r.differ) ui.line('warn', `${d} is there under the new folder already and differs: left as it is`);
  return r.differ.length ? 1 : 0;
}
