// What a role's session may run in the box besides the tests (boxtool.mjs): each a closed choice, each built here as an
// argument array, never a line the session wrote. The build is the owner's command for the project (settings.mjs
// projects.<name>.build); a script is one the project's package.json names, run as `npm run <name>`. Before any run the
// wall (src/wall.mjs wallHeld, called, never changed) reads the line, and for a script also what the script runs: a
// held one is not run, and the session is told why in one line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../paths.mjs';
import { WALL_TITLE, wallHeld } from '../wall.mjs';

// A script's name: lowercase words with : . _ - between them, as package scripts are named. No space, no separator of
// a shell, no option, no path: what npm gets is one name it looks up in the project's own list.
export const SCRIPT_RE = /^[a-z0-9][a-z0-9:._-]{0,49}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const shown = (v) => JSON.stringify(String(v).slice(0, 60)).replace(CONTROL, '?');

/** One word as a POSIX shell reads it: a plain word as it is, any other in single quotes. */
const quoted = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
/** The line the wall reads for an argument array: the same words, quoted where they need it. */
export const lineOf = (argv) => argv.map((w) => quoted(String(w))).join(' ');

/** The scripts a package.json names (own names only). → Map name → its text, or null when there is none to read. */
function scriptsIn(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const s = pkg && typeof pkg.scripts === 'object' && pkg.scripts && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
    return new Map(Object.keys(s).filter((k) => typeof s[k] === 'string').map((k) => [k, s[k]]));
  } catch {
    return null;
  }
}

// A package runner reads the project's package.json and runs a script's text, with its pre and post scripts, not the
// line it was given: the forms of each runner that run a script, by their words. Any other form is one Hoprig does
// not read (an install also runs the project's own scripts), so it is held.
const RUNNERS = Object.freeze({
  npm: { test: ['test', 't', 'tst'], start: ['start'], stop: ['stop'], run: ['run', 'run-script', 'rum', 'urn'] },
  pnpm: { test: ['test', 't'], start: ['start'], stop: ['stop'], run: ['run', 'run-script'] },
  yarn: { test: ['test'], start: ['start'], run: ['run'] },
});
const QUIET = new Set(['-s', '--silent']);
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,99}$/;
const bare = (w) => String(w).replace(/^['"]+|['"]+$/g, '');
const runnerOf = (w) => {
  const b = path.basename(bare(w));
  return Object.hasOwn(RUNNERS, b) ? b : null;
};

/** The script a runner's words run (the words after the runner). → { name } or { why } */
function scriptOf(runner, words) {
  const forms = RUNNERS[runner];
  const end = words.indexOf('--');
  const own = (end < 0 ? words : words.slice(0, end)).map(bare).filter((w) => !QUIET.has(w));
  if (own.some((w) => w.startsWith('-'))) return { why: 'an option of the runner can change which package.json or script it uses' };
  const [sub, next] = own;
  if (forms.run.includes(sub)) return next !== undefined && NAME_OK.test(next) ? { name: next } : { why: 'the script\'s name is not a plain word' };
  for (const k of ['test', 'start', 'stop']) if (forms[k] && forms[k].includes(sub)) return { name: k };
  return { why: 'it is not a form of running a script that Hoprig reads' };
}

/** The runners a script's text calls, each with the words after it up to the end of its command; moved: it changes
 * its folder somewhere (then a runner it calls reads another package.json). */
function runsIn(body) {
  const out = [];
  let moved = false;
  for (const part of body.split(/\$\(|[;&|()`\n]+/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.some((w) => ['cd', 'pushd', 'popd'].includes(bare(w)))) moved = true;
    const i = words.findIndex((w) => runnerOf(w));
    if (i >= 0) out.push([runnerOf(words[i]), words.slice(i + 1)]);
  }
  return { runs: out, moved };
}

/** The task's branch's own scripts, as written (a plain package.json file only). → the object, or null */
function treeScripts(tree) {
  try {
    const file = path.join(tree, 'package.json');
    if (!fs.lstatSync(file).isFile()) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
    if (pkg.scripts === undefined) return {};
    return pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : null;
  } catch {
    return null;
  }
}

/**
 * What the wall reads for a command the box is about to run in `tree`: its line, and where npm, pnpm or yarn runs a
 * script, the text of that script and of its pre and post scripts as the task's branch has them (the session may
 * have written them), and so on for each script those call. → { reads } or { why } (one line: nothing runs).
 */
export function readsOf(argv, tree) {
  const line = lineOf(argv);
  const no = (why) => ({ why: `Not run: Hoprig cannot read what ${shown(line)} runs (${why}), so its wall holds it: it stays the owner's. Nothing ran.` });
  if (!runnerOf(argv[0])) return argv.slice(1).some((w) => runnerOf(w)) ? no('a package runner behind another program') : { reads: [line] };
  const scripts = treeScripts(tree);
  if (!scripts) return no('the task\'s branch has no package.json Hoprig can read');
  const reads = [line];
  const seen = new Set();
  const todo = [[runnerOf(argv[0]), argv.slice(1).map(String)]];
  while (todo.length) {
    const [runner, words] = todo.shift();
    const s = scriptOf(runner, words);
    if (s.why) return no(s.why);
    if (typeof scripts[s.name] !== 'string' || !Object.hasOwn(scripts, s.name)) return no(`the task's branch has no script ${shown(s.name)}`);
    for (const n of [`pre${s.name}`, s.name, `post${s.name}`]) {
      if (seen.has(n) || !Object.hasOwn(scripts, n)) continue;
      seen.add(n);
      if (typeof scripts[n] !== 'string') return no(`its script ${shown(n)} is not a line of text`);
      if (seen.size > 60) return no('it runs too many scripts');
      reads.push(scripts[n]);
      const more = runsIn(scripts[n]);
      if (more.moved && more.runs.length) return no(`its script ${shown(n)} changes its folder before it runs another`);
      todo.push(...more.runs);
    }
  }
  return { reads };
}

/** The project's script names the box may run (its checkout's package.json, names of the pattern). */
export const scriptNames = (top) => [...(scriptsIn(top) || new Map()).keys()].filter((k) => SCRIPT_RE.test(k)).slice(0, 40);

/**
 * The argument array of a run that is not the tests. kind 'build': the owner's build command; 'scripts': `given` is a
 * script's name, which the project's own checkout (`top`, what he merged) names. → { argv, what, reads } or { why }.
 * `reads`: the lines the wall reads (the command, and a script's own text from the task's worktree, which runs).
 */
export function commandOf(kind, given, { top, tree, build }) {
  if (kind === 'build') {
    if (!Array.isArray(build) || !build.length) return { why: 'This project has no build command: the owner sets one on Work → Team. Nothing ran.', plain: true };
    const r = readsOf(build, tree);
    return r.why ? { why: r.why } : { argv: [...build], what: 'build', reads: r.reads };
  }
  if (typeof given !== 'string') return { why: 'Refused: name one script of the project, by its name; nothing ran.' };
  if (!SCRIPT_RE.test(given)) return { why: `Refused: ${shown(given)} is not a script name (lowercase letters, digits and : . _ -); nothing ran.` };
  const own = scriptsIn(top);
  if (!own || !own.has(given)) return { why: `Refused: the project has no script "${given}"; nothing ran.` };
  const inTree = scriptsIn(tree);
  const body = inTree && inTree.has(given) ? inTree.get(given) : null;
  if (body === null) return { why: `Refused: the task's branch has no script "${given}"; nothing ran.` };
  const argv = ['npm', 'run', given];
  const r = readsOf(argv, tree);
  return r.why ? { why: r.why } : { argv, what: `script ${given}`, reads: r.reads };
}

/** The wall's word on lines a session's tool is about to run in `tree`. → null, or the one line that says why not. */
export function wallSays(lines, tree) {
  const places = { home: os.homedir(), hoprig: [configDir()], own: tree, cwd: tree, relative: true };
  for (const command of lines) {
    let held;
    try {
      held = wallHeld({ tool: 'Bash', input: { command }, cwd: tree, places });
    } catch {
      held = { why: 'unreadable', part: command };
    }
    if (held) {
      const part = String(held.part || command).replace(CONTROL, ' ').slice(0, 120);
      return `Not run: Hoprig's wall holds "${part}" (${WALL_TITLE[held.why] || WALL_TITLE.unreadable}): it stays the owner's. Nothing ran.`;
    }
  }
  return null;
}
