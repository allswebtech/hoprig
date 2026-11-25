// `hoprig pc leave …`: the check before a computer is formatted (leave.mjs does the look), and the owner's marks
// (leavemarks.mjs). A help word reads nothing: it is answered before anything is loaded or looked at. The look is
// loaded only when it runs, so this module's usage costs nothing to import.
import os from 'node:os';
import path from 'node:path';

export const LEAVE_USAGE = `usage:
  hoprig pc leave --check [--also <folder>]… [--json]   what exists only on this computer, before a format (reads only)
       exit 0: nothing is only here; 1: something is (the list says what to do with each); 2: a word not understood
       --also <folder>   an older layout outside the workspace: its repositories and folders in no git too
  hoprig pc leave --outside <folder>… | --keep <dot-folder>… | --ignore <dot-folder>… | --test-data <engine>… | --unmark <name>…
       marks kept in this computer's own file: a folder you keep your own way, a dot-folder you back up or that does
       not matter, a database engine that holds test data only; --unmark takes a mark away
  hoprig pc leave help | --help | -h                     this help (reads nothing)`;

export const NOTHING_LINE = 'Nothing is only here: this computer can be formatted.';
export const somethingLine = (n) => (n === 1 ? '1 thing exists only on this computer (above).' : `${n} things exist only on this computer (above).`);

const HELP = ['help', '--help', '-h'];
const MARKS = { '--outside': 'outside', '--keep': 'keep', '--ignore': 'ignore', '--test-data': 'testData', '--unmark': 'unmark' };
const GROUPS = [
  ['Git repositories', ['branch', 'work', 'stash', 'noserver']],
  ['Folders in no git', ['folder']],
  ['Backups and databases in the workspace', ['described']],
  ['Outside the workspace', null], // every other kind (the home part)
];

/** A folder as typed: "~/x" in the home, a relative one from the folder the command runs in. */
const typedPath = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(p));

/** The words → { check, also, json } | { marks: [[kind, what]] } | { usage } */
export function parseLeave(args) {
  if (args.some((a) => HELP.includes(a))) return { help: true };
  const out = { check: false, also: [], json: false, marks: [] };
  let mark = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--also') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) return { usage: true };
      out.also.push(args[++i]);
      mark = null;
      continue;
    } else if (Object.hasOwn(MARKS, a)) {
      if (!args[i + 1] || args[i + 1].startsWith('-')) return { usage: true };
      mark = MARKS[a];
      continue;
    } else if (!a.startsWith('-') && mark) out.marks.push([mark, a]);
    else return { usage: true };
    if (a.startsWith('-')) mark = null;
  }
  // A look and a mark are two commands: a mark changes the computer's file, a look reads only.
  if (out.marks.length && (out.check || out.also.length || out.json)) return { usage: true };
  if (!out.check && !out.marks.length) return { usage: true };
  if (!out.check && (out.also.length || out.json)) return { usage: true };
  return out;
}

/** The printed report: a heading per group, a line per thing with its size and what to do, then exactly one last line. */
export function reportText(r, { sizeWords, bold = (s) => s, dim = (s) => s }) {
  const out = [];
  const size = (n) => (n === null || n === undefined ? '' : ` (${sizeWords(n)})`);
  const named = new Set(GROUPS.flatMap(([, k]) => k || []));
  for (const [title, kinds] of GROUPS) {
    const list = r.items.filter((i) => (kinds ? kinds.includes(i.kind) : !named.has(i.kind)));
    if (!list.length) continue;
    out.push('', bold(title));
    for (const i of list) {
      out.push(`  ${i.where}: ${i.what}${size(i.size)}`);
      out.push(`    ${i.todo}${i.command ? `:  ${i.command}` : ''}`);
    }
  }
  if (r.asks.length) {
    out.push('', bold('Asked once: keep it (you back it up) or ignore it'));
    for (const a of r.asks) {
      out.push(`  ${a.where}${size(a.size)}: ${a.question}`);
      out.push(`    hoprig pc leave --keep ${a.where}   or   hoprig pc leave --ignore ${a.where}`);
    }
  }
  if (r.notChecked.length) {
    out.push('', bold('Not looked at, so not counted as safe'));
    for (const n of r.notChecked) out.push(`  ${n.where}: ${n.why}`);
  }
  if (r.outside.length) {
    out.push('');
    for (const o of r.outside) out.push(`${o.why}: ${o.where}`);
  }
  for (const n of r.notes || []) out.push(dim(n));
  const n = r.items.length + r.asks.length + r.notChecked.length;
  out.push('', r.nothingOnlyHere ? NOTHING_LINE : somethingLine(n));
  return `${out.join('\n').replace(/^\n+/, '')}\n`;
}

/**
 * `hoprig pc leave <args>` → the exit code. `ctx` ({ dir, projects }), `home`, `look` (more options of leaveCheck),
 * `check`, `marks` (the modules' functions): what a test hands in instead of this computer's.
 */
export async function leaveMain(args, { write = (s) => process.stdout.write(s), ctx = null, home = os.homedir(), look = {}, check = null, marks = null } = {}) {
  const p = parseLeave(args);
  if (p.help) {
    write(`${LEAVE_USAGE}\n`);
    return 0;
  }
  if (p.usage) {
    write(`${LEAVE_USAGE}\n`);
    return 2;
  }
  const { projectsIn, workspaceDir } = await import('./layout.mjs');
  const at = ctx || { dir: workspaceDir(), projects: projectsIn() };
  if (p.marks.length) {
    const m = marks || (await import('./leavemarks.mjs'));
    let ok = true;
    for (const [kind, typed] of p.marks) {
      const what = kind === 'testData' || (kind === 'unmark' && !/[/~]|^\./.test(typed)) ? typed : typedPath(typed, home);
      const r = kind === 'unmark' ? await m.unmark({ dir: at.dir, home, what }) : await m.setMark({ dir: at.dir, home, kind, what });
      if (r.ok) write(kind === 'unmark' ? `${typed}: no longer marked.\n` : `${typed}: marked ${kind === 'testData' ? 'as test data only' : kind}.\n`);
      else {
        ok = false;
        write(`${typed}: not marked: ${r.why}\n`);
      }
    }
    return ok ? 0 : 1;
  }
  const leaveCheck = check || (await import('./leave.mjs')).leaveCheck;
  const r = await leaveCheck({ ...at, home, also: p.also.map((a) => typedPath(a, home)), ...look });
  if (p.json) write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    const { sizeWords } = await import('./leavewalk.mjs');
    const { bold, dim } = await import('../setup/ui.mjs');
    write(reportText(r, { sizeWords, bold, dim }));
  }
  return r.nothingOnlyHere ? 0 : 1;
}
