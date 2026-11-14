// `hoprig workspace …` (docs/WORKSPACE.md). main(args) returns the exit code.
//   workspace status [--json]            the tree: what is there, what each folder is for
//   workspace setup [--dry-run] [--yes]  create only what is missing (asks once, unless --yes)
//   workspace link [--dry-run] [--yes]   link Claude Code's global rules, skills and home memory into the brain
import { bold, dim, makeUi } from '../setup/ui.mjs';
import { workspaceStatus } from './layout.mjs';
import { applyLink, planLink } from './link.mjs';
import { workspaceSetup } from './setup.mjs';

const USAGE = `usage:
  hoprig workspace status [--json]             the workspace: what is there and what each folder is for
  hoprig workspace setup [--dry-run] [--yes]   create only what is missing (nothing that exists is changed)
  hoprig workspace link [--dry-run] [--yes]    let Claude Code read its global rules, skills and home memory
                                               from the AI brain (backs up what is there; overwrites nothing)`;

const flagsOk = (args, known) => args.every((a) => known.includes(a));

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

/** Say what setup did (or would do). */
export function printSetup(ui, r) {
  for (const d of r.did) ui.line('ok', `${r.dryRun ? 'would create' : 'created'} ${d.path}: ${d.what}`);
  for (const l of r.left) ui.note(`${l.path}: ${l.why}`);
  if (r.git) ui.line(r.git.done ? 'ok' : 'info', r.git.done ? 'the brain is a git repository with a first commit' : `the brain: ${r.git.why}`);
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
    if (!flagsOk(rest, ['--json'])) return usage();
    const st = workspaceStatus();
    if (rest.includes('--json')) write(JSON.stringify(st, null, 2) + '\n');
    else printStatus(ui, st);
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
    const plan = planLink();
    for (const p of plan) ui.line(p.action === 'conflict' ? 'warn' : p.action === 'already' ? 'ok' : 'info', `${p.what}: ${p.linkShort} → ${p.targetShort}  ${dim(ACTION[p.action])}${p.why ? `  (${p.why})` : ''}`);
    const todo = plan.filter((p) => !['already', 'conflict'].includes(p.action));
    if (!todo.length || rest.includes('--dry-run')) return plan.some((p) => p.action === 'conflict') ? 1 : 0;
    if (!(await ui.confirm(`Make ${todo.length === 1 ? 'this link' : `these ${todo.length} links`}?`, true))) return 1;
    const done = applyLink();
    for (const d of done) if (!['already', 'conflict'].includes(d.action)) ui.line(d.error ? 'fail' : 'ok', `${d.what}: ${d.error || d.done}`);
    return done.some((d) => d.error || d.action === 'conflict') ? 1 : 0;
  }
  return usage();
}
