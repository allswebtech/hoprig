// The command `hoprig drop <name>… [--check] [--dry-run] [--json]` (drop.mjs does the work): the questions on the
// terminal, the words of every refusal and of the dry run, and --json. Several names: each on its own; one refusal
// does not stop the others, and the exit code is 1 when any was refused (`--check`: 1 when anything is only here).
import path from 'node:path';
import { bold, dim, makeUi } from '../setup/ui.mjs';
import { showCommand } from '../setup/system.mjs';
import { flags } from '../pcsetup/project.mjs';
import { projectsDir } from '../pcsetup/projects.mjs';
import { brainDir, isGitRepo, remoteOf, workspaceDir } from './layout.mjs';
import { NO_TERMINAL, dropProject } from './drop.mjs';
import { sizeWords } from './dropfind.mjs';
import { relFileOf, thisComputer } from './computer.mjs';

export const DROP_USAGE = 'usage: hoprig drop <name | place/name>… [--check] [--dry-run] [--json]\n       --check     only say what exists only on this computer (exit 1 when anything does)\n       --dry-run   show every step a drop would take; nothing is changed\n       when another project here names it in "needs", drop asks first (--check and --json: neededBy)';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The one line for the credential links that go: their count only, never a place or a target. */
const credLinkWords = (n) => `drop would take away ${plural(n, 'credential link')} that project.json names (only the link${n === 1 ? '' : 's'}: the credentials stay in their folder), and hoprig get makes ${n === 1 ? 'it' : 'them'} again`;

/** The words of each question, the same in a terminal and on the Workspace page's sheet (dropweb.mjs). */
export const QUESTION = {
  work: (n) => `Commit this work on a new branch of its own (wip/…) in ${n === 1 ? 'that repository' : 'each of them'}, from where it stands, and push that branch? The branch you are on does not move.`,
  defaultBranch: (c) => `This pushes ${c.def.branch} of ${c.label}: ${plural(c.def.count, 'commit')}`,
  defaultMemory: ' (with the commit of its memory folder)',
  release: (branch) => `A push to ${branch} can be a release (a site that goes live, a server that follows it).`,
  choices: (branch) => [['push', `push them to ${branch}`], ['wip', `push them as a branch of their own (wip/…) instead; ${branch} on the git server does not move`], ['stop', 'stop: nothing is dropped']],
  confirm: (name) => `Type the project's name (${name}) to delete them with it, or press Enter to stop`,
  // The page's sheet is no terminal: Enter does nothing there, so its ending names what does.
  confirmPage: (name) => `Type the project's name (${name}) to delete them with it; leave it empty and press Cancel to stop`,
  // Another project here names it in "needs" (asked first, before any fetch or other question).
  neededWho: (ref, by) => `${by.join(', ')} ${by.length === 1 ? 'needs' : 'need'} ${ref}`,
  neededRead: (by) => `${by.length === 1 ? 'it names' : 'they name'} it in "needs" and ${by.length === 1 ? 'its sessions read' : 'their sessions read'} it.`,
  neededWhy: (ref, by) => `${QUESTION.neededWho(ref, by)}: ${QUESTION.neededRead(by)}`,
  neededLater: (ref, by) => `Without it here, ${by.length === 1 ? 'a session there' : 'their sessions'} cannot read it until  hoprig get ${ref}  brings it back.`,
  needed: (ref) => `Drop ${ref} all the same?`,
};

/** The questions, asked on the terminal (`ui.ask`); never answered by a flag. */
export function terminalAsk(ui) {
  const yes = async (q) => {
    const a = await ui.ask(`  ${q} (y/N) `);
    return a !== null && /^y(es)?$/i.test(a.trim());
  };
  return {
    needed: async (ref, by) => {
      ui.out(`\n  ${bold(QUESTION.neededWho(ref, by))}: ${QUESTION.neededRead(by)}`);
      ui.out(`  ${dim(QUESTION.neededLater(ref, by))}`);
      return yes(QUESTION.needed(ref));
    },
    work: async (checks) => {
      ui.out(`\n  ${bold('Work that is not committed')} (it would be lost with the folder):`);
      for (const c of checks) {
        ui.out(`    ${c.label}:`);
        for (const w of c.work.slice(0, 20)) ui.out(`      ${w.from ? `${w.from} -> ` : ''}${w.path}`);
        if (c.work.length > 20) ui.out(`      … and ${c.work.length - 20} more`);
      }
      return yes(QUESTION.work(checks.length));
    },
    defaultBranch: async (c) => {
      ui.out(`\n  ${bold(QUESTION.defaultBranch(c))}${c.memoryChanged && c.current === c.def.branch ? QUESTION.defaultMemory : ''}.`);
      ui.out(`  ${dim(QUESTION.release(c.def.branch))}`);
      for (;;) {
        QUESTION.choices(c.def.branch).forEach(([, words], i) => ui.out(`    ${bold(String(i + 1))}  ${words}`));
        const a = await ui.ask('  > ');
        if (a === null || a.trim() === '' || a.trim() === '3') return 'stop';
        if (a.trim() === '1') return 'push';
        if (a.trim() === '2') return 'wip';
        ui.out(`  "${a.trim()}" is not one of 1, 2 or 3.`);
      }
    },
    confirm: async (name, items) => {
      ui.out('');
      printConfirm(ui, items, '  ');
      const a = await ui.ask(`  ${QUESTION.confirm(name)}: `);
      if (a !== null && a.trim() !== name && a.trim() !== '') ui.out(`  "${a.trim()}" is not ${name}: nothing is dropped.`);
      return a !== null && a.trim() === name;
    },
  };
}

/**
 * Share this computer's file after a drop by the upkeep's own path: committed with the map when "commit" is on
 * (commitOwnFiles), uploaded when "push" is on (keepMapInStep), holding the brain's lock. Else the words say how.
 */
export async function shareOwnFile(dir) {
  const brain = brainDir(dir);
  const me = thisComputer();
  if (!me.label || !isGitRepo(brain)) return { done: false };
  const { loadConfig } = await import('../config.mjs');
  const { effectiveSettings, readSettings } = await import('../automation/settings.mjs');
  const w = effectiveSettings(readSettings(loadConfig().automation), () => remoteOf(brain)).workspace;
  const how = showCommand(['git', '-C', brain, 'commit', '-m', 'Update the workspace map', '--', relFileOf(me.label)]);
  if (!w.commitMap) return { done: false, why: `this computer's file is written, not committed (the "commit" switch is off): to share it,  ${how}  and push the brain` };
  const { withRepoLock } = await import('../work/lock.mjs');
  const { commitOwnFiles, keepMapInStep } = await import('./mapkeep.mjs');
  try {
    return await withRepoLock(brain, async () => {
      const c = await commitOwnFiles({ dir, mapToo: false });
      if (!c.done && !c.nothing) return { done: false, why: `this computer's file was not committed (${c.staged ? 'the brain has other staged changes' : c.why}): to share it,  ${how}  and push the brain, or${c.staged ? ', once those staged changes are committed or unstaged,' : ''} the upkeep's next round shares it` };
      if (!w.push) return { done: c.done, why: c.done ? 'this computer\'s file is committed in the brain, not pushed (the "push" switch is off): it goes up with the next push of the brain' : '' };
      const k = await keepMapInStep({ dir, projects: projectsDir() });
      return { done: true, pushed: Boolean(k.done), ...(k.done ? {} : { why: `this computer's file is committed, not pushed: ${k.stopped || 'nothing to upload'}` }) };
    }, { wait: 30_000 });
  } catch (e) {
    return { done: false, why: `this computer's file is written, not committed: ${e.message}` };
  }
}

const isPrivate = (i) => i.kind.startsWith('private folder');
const itemLine = (i) => `${i.repo}/${i.path}  ${dim(`${i.kind}${isPrivate(i) ? '' : `, ${sizeWords(i.size)}`}${i.files ? `, ${plural(i.files, 'file')}` : ''}`)}`;

/** The list the owner confirms by typing the name: the ignored files, then the private folders, each under true words. */
function printConfirm(ui, items, pad) {
  const files = items.filter((i) => !isPrivate(i));
  const privates = items.filter(isPrivate);
  if (files.length) {
    ui.out(`${pad}${bold('Files git ignores that cannot be made again')}: they are on no git server and are deleted with the project:`);
    for (const i of files) ui.out(`${pad}  ${itemLine(i)}`);
  }
  if (privates.length) {
    ui.out(`${pad}${bold('Private folders Hoprig does not look into')}: whatever in them is not committed and pushed is lost with the project:`);
    for (const i of privates) ui.out(`${pad}  ${itemLine(i)}`);
  }
}

/** One project's result, as the owner reads it. `share`: what sharing this computer's file would do (a dry run). */
export function printResult(ui, r, mode, { share = '' } = {}) {
  ui.out(`\n${bold(r.ref || r.spec)}${r.folder ? `  ${dim(r.folder)}` : ''}`);
  for (const d of r.did) ui.line('ok', d);
  for (const n of r.notes) ui.line('info', n);
  for (const x of r.refusals) {
    if (x.what === NO_TERMINAL) continue; // said below, with each answer it needs
    ui.line('fail', `${x.repo}: ${x.what}${x.command ? `\n      ${x.command}` : ''}`);
  }
  if (r.noTerminal) {
    ui.line('fail', `${NO_TERMINAL}: run  hoprig drop ${r.ref}  in a terminal. It asks:`);
    for (const a of r.asks) ui.out(`      - ${askWords(a)}`);
  }
  // --check says everything it found, refusals or not; a dry run stops where the drop would stop.
  if (mode === 'check') {
    for (const a of r.asks) {
      if (a.ask === 'needed') ui.line('info', `${a.by.join(', ')} ${a.by.length === 1 ? 'needs' : 'need'} it (named in "needs"): a drop asks about that first`);
      else ui.line('warn', `it asks: ${askWords(a)}`);
    }
    for (const p of r.pushes) ui.line('info', `drop would ${pushWords(p)}`);
    if (r.rebuilt && r.rebuilt.length) ui.line('info', `drop would delete with it what git ignores and a build or an install makes again: ${listWords(r.rebuilt)}`);
    if (r.credLinks) ui.line('info', credLinkWords(r.credLinks));
  }
  if (mode === 'dry-run' && !r.refusals.length) {
    ui.note('(dry run) would fetch every repository of it from its git server, then check it all');
    // In the order the drop goes: every question first, then the acts.
    for (const a of r.asks) ui.line('warn', `(dry run) would ask: ${askWords(a)}`);
    for (const p of r.pushes.filter((x) => x.memory)) ui.line('info', `(dry run) would ${pushWords(p)}`);
    const work = r.asks.find((a) => a.ask === 'work');
    if (work) ui.line('info', `(dry run) on your yes, would commit the work of ${work.repos.map((x) => x.repo).join(', ')} on a new wip/ branch and push it`);
    for (const p of r.pushes.filter((x) => !x.memory)) ui.line('info', `(dry run) would ${pushWords(p)}`);
    for (const a of r.asks.filter((x) => x.ask === 'default branch')) ui.line('info', `(dry run) as you answer, would push ${a.branch} of ${a.repo}${a.memory ? ' (with the commit of its memory folder)' : ''}, or push it as a wip/ branch`);
    if (r.result === 'would drop') {
      ui.note(`(dry run) would check everything again, then rename ${r.removes.map((x) => path.basename(x)).join(', ')} aside, take away its memory links, write this computer's file without it and delete it; the workspace map keeps it (hoprig get ${r.ref} brings it back)`);
      if (r.rebuilt && r.rebuilt.length) ui.note(`(dry run) would delete with it what git ignores and a build or an install makes again: ${listWords(r.rebuilt)}`);
      if (r.credLinks) ui.note(`(dry run) ${credLinkWords(r.credLinks)}`);
      if (share) ui.note(`(dry run) would ${share}`);
    }
  }
  if ((mode === 'check' || r.noTerminal) && r.confirm.length) printConfirm(ui, r.confirm, '    ');
  const words = {
    dropped: `dropped: it is in the workspace map, not on this computer (hoprig get ${r.ref} brings it back)`,
    finished: 'a drop that was cut off is finished',
    'would finish': mode === 'check' ? 'a drop that was cut off would be finished' : '(dry run) a drop that was cut off would be finished',
    'not here': 'it is not on this computer: nothing to drop',
    'nothing only here': 'nothing of it exists only here: it can be dropped',
    'only here': 'something of it exists only here (above)',
    'would drop': '(dry run) nothing was changed',
    stopped: `stopped${r.stoppedAt ? ` at the question about the ${r.stoppedAt}` : ''}: ${r.did.length ? 'what is done above stays done; ' : ''}the project stays here`,
    busy: 'it is busy: the project stays here',
    failed: 'the project stays here',
    'left over': `it is off the workspace and on its git server (hoprig get ${r.ref} brings it back), but a folder is left to delete by hand (above)`,
    refused: 'nothing was dropped',
  };
  if (r.shared && r.shared.why) ui.line('info', r.shared.why);
  ui.line(r.result === 'only here' ? 'warn' : r.ok ? 'ok' : 'fail', words[r.result] || r.result);
}

const listWords = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? `, and ${list.length - 8} more` : ''}`;

function pushWords(p) {
  if (p.memory) return `commit the memory folder of ${p.repo}${p.branch ? ` and push ${p.branch}` : ''}`;
  return `push ${p.branch} of ${p.repo} (${plural(p.commits, 'commit')})${p.to !== p.branch ? ` to ${p.to}` : ''}${p.newOnServer ? ', a new branch on the git server' : ''}`;
}

function askWords(a) {
  if (a.ask === 'needed') return `${a.by.join(', ')} ${a.by.length === 1 ? 'needs' : 'need'} it (named in "needs"): drop it all the same?`;
  if (a.ask === 'work') return `commit the work not committed in ${a.repos.map((x) => `${x.repo} (${plural(x.files.length, 'file')})`).join(', ')} on a new wip/ branch and push it`;
  if (a.ask === 'default branch') return `push ${a.branch} of ${a.repo} (${plural(a.commits, 'commit')}${a.memory ? ', with the memory commit' : ''}), push it as a wip/ branch instead, or stop`;
  return `delete the ${plural(a.items, 'item')} listed below with it, which cannot be made again (you type ${a.name} to confirm the list)`;
}

/** What sharing this computer's file after a drop would do under the switches as they are now (read only). */
export async function shareWords(dir) {
  const brain = brainDir(dir);
  if (!thisComputer().label || !isGitRepo(brain)) return '';
  const { loadConfig } = await import('../config.mjs');
  const { effectiveSettings, readSettings } = await import('../automation/settings.mjs');
  const w = effectiveSettings(readSettings(loadConfig().automation), () => remoteOf(brain)).workspace;
  if (!w.commitMap) return 'not commit this computer\'s file (the "commit" switch is off): the words would say how to share it';
  return w.push ? 'commit this computer\'s file in the brain (that file only) and push the brain' : 'commit this computer\'s file in the brain (that file only), not push it (the "push" switch is off)';
}

export async function main(args, { ui = makeUi({}), write = (s) => process.stdout.write(s), ctx = null, run, onStep } = {}) {
  const o = flags(args, { check: 'bool', 'dry-run': 'bool', json: 'bool', help: 'bool' });
  if (o.help) {
    write(`${DROP_USAGE}\n`);
    return 0;
  }
  if (o.errors.length || !o._.length || (o.check && o['dry-run'])) {
    (o.json ? process.stderr.write.bind(process.stderr) : write)(`${o.errors.length ? `${o.errors.join('; ')}\n` : o.check && o['dry-run'] ? '--check and --dry-run are two different commands: give one\n' : ''}${DROP_USAGE}\n`);
    return 2;
  }
  const mode = o.check ? 'check' : o['dry-run'] ? 'dry-run' : 'drop';
  const startedAt = Date.now();
  const u = o.json ? makeUi({ interactive: false, write: (s) => process.stderr.write(s) }) : ui;
  if (mode !== 'drop') u.dryRun = true;
  const c = ctx || { dir: workspaceDir(), projects: projectsDir() };
  const ask = mode === 'drop' && !o.json && u.interactive ? terminalAsk(u) : null;
  const results = [];
  for (const spec of [...new Set(o._)]) {
    const r = await dropProject(spec, { ctx: c, mode, ask, ui: u, ...(run ? { run } : {}), ...(onStep ? { onStep } : {}), share: mode === 'drop' ? () => shareOwnFile(c.dir) : null });
    results.push(r);
    if (!o.json) printResult(u, r, mode, { share: mode === 'dry-run' && r.result === 'would drop' ? await shareWords(c.dir).catch(() => '') : '' });
  }
  const ok = mode === 'check' ? results.every((r) => r.ok && r.result !== 'only here') : results.every((r) => r.ok);
  if (mode === 'drop') (await import('../field/wire.mjs')).reportDrop(results, startedAt); // a field report (src/field)
  if (o.json) write(`${JSON.stringify({ ok, mode, projects: results }, null, 2)}\n`);
  return ok ? 0 : 1;
}
