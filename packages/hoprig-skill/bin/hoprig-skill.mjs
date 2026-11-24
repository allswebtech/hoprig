#!/usr/bin/env node
// hoprig-skill: puts the Hoprig skill into a coding tool's skills folder, without installing Hoprig. No dependency.
//
// The skill's files (skill/) are the ones Hoprig's own build makes (tools/build-skill.mjs in its repository). A
// record of what was written (the version and a SHA-256 per file) goes beside SKILL.md, so a later run can tell a
// copy that was edited from one it wrote itself, and never overwrites the edited one unless the owner says --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'hoprig';
const RECORD = '.hoprig-skill.json';
const SKILL_DIR = fileURLToPath(new URL('../skill/', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

const USAGE = `usage: npx hoprig-skill <where> [--dry-run] [--force]
       npx hoprig-skill <where> --remove [--dry-run] [--force]
       npx hoprig-skill --print

  where:  --claude           your own Claude Code skills (~/.claude/skills, or $CLAUDE_CONFIG_DIR/skills)
          --agents           the skills folder coding tools share (~/.agents/skills; OpenCode reads it)
          --project <dir>    that project's own skills (<dir>/.claude/skills)

  --dry-run   say what would be written or removed, and write nothing
  --force     replace or remove a copy that was edited, or that this tool did not write (your word for it)
  --remove    take the skill away again
  --print     print the skill's text (SKILL.md)

  The Hoprig skill ${VERSION}. With Hoprig installed, "hoprig skills add hoprig --user" does the same.`;

class Refused extends Error {}

function parseArgs(argv) {
  const o = { where: [], dryRun: false, force: false, remove: false, print: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claude' || a === '--agents') o.where.push({ kind: a.slice(2) });
    else if (a === '--project') {
      const dir = argv[++i];
      if (!dir || dir.startsWith('--')) return { error: '--project needs a folder' };
      o.where.push({ kind: 'project', dir });
    } else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--remove') o.remove = true;
    else if (a === '--print') o.print = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else return { error: `unknown argument "${a.slice(0, 40)}"` };
  }
  if (o.help || o.print) return o;
  if (o.where.length !== 1) return { error: o.where.length ? 'one place at a time' : 'say where: --claude, --agents or --project <dir>' };
  return o;
}

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

/** Hoprig's state folder, by the same rule as Hoprig's own (src/paths.mjs stateDir). */
function hoprigStateDir() {
  const e = process.env;
  if (e.HOPRIG_STATE_DIR) return e.HOPRIG_STATE_DIR;
  if (e.XDG_STATE_HOME) return path.join(e.XDG_STATE_HOME, 'hoprig');
  if (process.platform === 'win32' && e.LOCALAPPDATA) return path.join(e.LOCALAPPDATA, 'hoprig', 'state');
  return path.join(os.homedir(), '.local', 'state', 'hoprig');
}

/** The skills folder of a place, as { dir, shown }. A project's own folders must not be links that lead elsewhere. */
function skillsFolder(where) {
  const home = os.homedir();
  if (where.kind === 'claude') return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills');
  if (where.kind === 'agents') return path.join(home, '.agents', 'skills');
  const project = path.resolve(where.dir);
  const st = lstat(project);
  if (!st || !fs.statSync(project).isDirectory()) throw new Refused(`There is no folder ${project}.`);
  for (const p of [path.join(project, '.claude'), path.join(project, '.claude', 'skills')]) {
    if (lstat(p)?.isSymbolicLink()) throw new Refused(`${p} is a link: it is not followed out of the project. Nothing was written.`);
  }
  return path.join(project, '.claude', 'skills');
}

/** Every file below `dir` as { 'rel/path': Buffer }. A link anywhere in it stops everything: it is never followed. */
function readTree(dir, { skip = [] } = {}) {
  const files = {};
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip.includes(r)) continue;
      const p = path.join(abs, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Refused(`${p} is a link: it is not followed. Nothing was written.`);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) files[r] = fs.readFileSync(p);
      else throw new Refused(`${p} is not a plain file. Nothing was written.`);
    }
  };
  walk(dir, '');
  return files;
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hashes = (files) => Object.fromEntries(Object.entries(files).map(([r, b]) => [r, sha256(b)]));

/** The first folder on the way to `p` (itself included) that is a link to nothing, or null. */
function brokenLink(p) {
  for (let at = p; ; at = path.dirname(at)) {
    const st = lstat(at);
    if (st) return st.isSymbolicLink() && !fs.existsSync(at) ? at : null;
    if (path.dirname(at) === at) return null;
  }
}

/** What is in the skills folder now: { target, real, files, record, managed } (files null when no copy is there). */
function inspect(skillsDir) {
  const broken = brokenLink(skillsDir);
  if (broken) throw new Refused(`${broken} is a link to a folder that does not exist. Nothing was written.`);
  const st = lstat(skillsDir);
  if (st && !fs.statSync(skillsDir).isDirectory()) throw new Refused(`${skillsDir} is not a folder.`);
  // The skills folder itself may be a link the owner made (to an AI brain, for one): that is where it writes then.
  const real = st ? fs.realpathSync(skillsDir) : skillsDir;
  const target = path.join(real, NAME);
  let managed = false;
  // Hoprig's record: next to the skills (a project's, or an older Hoprig's), and for the person's own skills in
  // Hoprig's state folder (Hoprig keeps it out of the skills folder, which is often the AI brain's git repository).
  const records = [path.join(real, '.hoprig-skills.json'), ...(skillsDir === skillsFolder({ kind: 'claude' }) ? [path.join(hoprigStateDir(), 'skillhub', 'user-skills.json')] : [])];
  for (const manifest of records) {
    if (!lstat(manifest)?.isFile()) continue;
    try {
      managed = managed || Boolean(JSON.parse(fs.readFileSync(manifest, 'utf8')).skills?.[NAME]);
    } catch { /* not Hoprig's: ignored */ }
  }
  const tst = lstat(target);
  if (!tst) return { target, real, files: null, record: null, managed };
  if (tst.isSymbolicLink()) throw new Refused(`${target} is a link: it is not followed. Nothing was written.`);
  if (!tst.isDirectory()) throw new Refused(`${target} is not a folder. Nothing was written.`);
  const files = readTree(target, { skip: [RECORD] });
  let record = null;
  const rst = lstat(path.join(target, RECORD));
  if (rst) {
    if (!rst.isFile()) throw new Refused(`${path.join(target, RECORD)} is not a plain file. Nothing was written.`);
    try {
      record = JSON.parse(fs.readFileSync(path.join(target, RECORD), 'utf8'));
    } catch {
      record = null;
    }
    if (!record || typeof record.files !== 'object' || record.files === null) record = null;
  }
  return { target, real, files, record, managed };
}

/** The files changed, added or removed since the record was written; null when there is no record. */
function editedSince(files, record) {
  if (!record) return null;
  const now = hashes(files);
  return [...new Set([...Object.keys(now), ...Object.keys(record.files)])].sort().filter((r) => now[r] !== record.files[r]);
}

/** A short line diff (longest common subsequence), as "- old" and "+ new" lines with a little context. */
function lineDiff(a, b, { context = 2, max = 60 } = {}) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([' ', x[i++], j++]);
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push(['+', y[j++]]);
    else ops.push(['-', x[i++]]);
  }
  const keep = ops.map((op, k) => op[0] !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o[0] !== ' '));
  const out = [];
  ops.forEach((op, k) => {
    if (keep[k]) out.push(`${op[0]} ${op[1]}`);
    else if (keep[k - 1]) out.push('  …');
  });
  return out.length > max ? [...out.slice(0, max), `  … and ${out.length - max} more lines`] : out;
}

function showDiff(say, from, to) {
  for (const rel of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    const a = from[rel] ? from[rel].toString('utf8') : '';
    const b = to[rel] ? to[rel].toString('utf8') : '';
    if (a === b) continue;
    say(`--- ${rel} ${from[rel] ? 'here now' : '(not here)'}`);
    say(`+++ ${rel} ${to[rel] ? `in the Hoprig skill ${VERSION}` : '(not in it)'}`);
    for (const l of lineDiff(a, b)) say(l);
  }
}

const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([r, buf]) => b[r] && b[r].equals(buf));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const WORK = /^\.hoprig-skill-tmp-(\d+)-[0-9a-f]{12}$/;

/**
 * Where this run's work folder goes. A coding tool loads every folder of the skills folder that holds a SKILL.md, a
 * hidden one too, so a run that is killed half-way must not leave a second copy of the skill there: the work folder
 * goes beside the skills folder. The swap is renames, so it must be on the same disk; and the folder above may be one
 * the owner keeps read-only (or the skills folder a mount of its own). Then the work folder goes inside the skills
 * folder, and holds no SKILL.md of its own (place() stages it under another name).
 */
function workPlace(real) {
  const parent = path.dirname(real);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    if (fs.statSync(parent).dev === fs.statSync(real).dev) return { dir: parent, inside: false };
  } catch { /* not writable, or not readable: inside */ }
  return { dir: real, inside: true };
}

/** The work folders of other runs, in both places one can be: [{ dir, pid }]. */
function otherRuns(real) {
  const found = [];
  for (const at of [path.dirname(real), real]) {
    let names = [];
    try {
      names = fs.readdirSync(at);
    } catch { /* not there or not readable: none */ }
    for (const name of names) {
      const m = WORK.exec(name);
      if (m && Number(m[1]) !== process.pid) found.push({ dir: path.join(at, name), pid: Number(m[1]) });
    }
  }
  return found;
}

/**
 * This run's own work folder, named with the process id: a later run removes the work folders of runs that ended
 * without removing their own (killed), and leaves those of a run that is still going.
 */
function workFolder(real) {
  for (const run of otherRuns(real)) if (!alive(run.pid)) fs.rmSync(run.dir, { recursive: true, force: true });
  const where = workPlace(real);
  const dir = path.join(where.dir, `.hoprig-skill-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir);
  return { dir, inside: where.inside };
}

/**
 * A run that ended half-way (killed between its renames, or both failed) can have left the copy that was in place in
 * its work folder, with nothing in its place. That copy is put back before anything else, never removed with the work
 * folder: it may hold the owner's own edits, and the failed run told the owner it is there.
 */
function putBack(skillsDir, o, say) {
  if (brokenLink(skillsDir) || !lstat(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return;
  const real = fs.realpathSync(skillsDir);
  const target = path.join(real, NAME);
  if (lstat(target)) return;
  for (const run of otherRuns(real)) {
    const old = path.join(run.dir, 'old');
    if (alive(run.pid) || !lstat(old)?.isDirectory()) continue;
    if (o.dryRun) {
      say(`A run that stopped half-way left the copy that was in ${target} in ${old}. A run without --dry-run puts it back first.`);
      return;
    }
    fs.renameSync(old, target);
    say(`Put back the copy that a run which stopped half-way had left in ${old}.`);
    dropWork({ dir: run.dir, inside: path.dirname(run.dir) === real }, say); // what is left is that run's own files
    return;
  }
}

/** The first place this run needs to write in and may not (null when it may): checked before anything is written. */
function cannotWrite(insp) {
  // The skills folder (its work folder can always go there), or the nearest folder that is there on the way to it.
  let at = insp.real;
  while (!lstat(at) && path.dirname(at) !== at) at = path.dirname(at);
  const need = [insp.files ? insp.target : null, at];
  for (const p of need.filter(Boolean)) {
    try {
      fs.accessSync(p, fs.constants.W_OK);
    } catch {
      return p;
    }
  }
  return null;
}

/** Remove this run's work folder; a failure there is said, not an error: the skill is in place already. */
function dropWork(work, say) {
  try {
    fs.rmSync(work.dir, { recursive: true, force: true });
  } catch (e) {
    say(`Note: ${work.dir} could not be removed (${e.code || e.message}). ${work.inside ? 'It is in the skills folder' : 'It is outside the skills folder, so no coding tool loads it'}; remove it by hand.`);
  }
}

// Inside the skills folder a staged SKILL.md has another name until just before the swap.
const STAGED = '.part';

/** Write `files` and the record (last) into the work folder, then swap it in with renames; on a failure the old copy is put back. */
function place(insp, files, say) {
  fs.mkdirSync(insp.real, { recursive: true });
  const work = workFolder(insp.real);
  const stage = path.join(work.dir, 'new');
  const old = path.join(work.dir, 'old');
  const hidden = (rel) => work.inside && path.basename(rel) === 'SKILL.md';
  try {
    fs.mkdirSync(stage);
    for (const [rel, buf] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
      fs.writeFileSync(path.join(stage, rel) + (hidden(rel) ? STAGED : ''), buf, { flag: 'wx' });
    }
    const record = { tool: 'hoprig-skill', name: NAME, version: VERSION, files: hashes(files) };
    fs.writeFileSync(path.join(stage, RECORD), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    for (const rel of Object.keys(files).filter(hidden)) fs.renameSync(path.join(stage, rel) + STAGED, path.join(stage, rel));
    if (insp.files) fs.renameSync(insp.target, old);
    try {
      fs.renameSync(stage, insp.target);
    } catch (e) {
      if (insp.files) {
        try {
          fs.renameSync(old, insp.target);
        } catch {
          e.kept = old; // the old copy stays where it is, and the work folder with it
        }
      }
      throw e;
    }
  } catch (e) {
    if (e.kept) throw new Refused(`The new copy could not be put in place (${e.code || e.message}), nor the old one back: it is in ${e.kept}. Move it back to ${insp.target}, or run hoprig-skill again: it puts it back first.`);
    fs.rmSync(work.dir, { recursive: true, force: true });
    throw e;
  }
  dropWork(work, say);
}

function install(o, insp, say) {
  const files = readTree(SKILL_DIR);
  if (insp.files) {
    if (insp.managed && !o.force) {
      throw new Refused(`Hoprig itself manages ${insp.target}: update it with "hoprig skills update ${NAME}". Nothing was written.`);
    }
    const edited = editedSince(insp.files, insp.record);
    if (same(insp.files, files) && insp.record && insp.record.version === VERSION && !edited.length) {
      say(`The Hoprig skill ${VERSION} is already in ${insp.target}. Nothing to do.`);
      return 0;
    }
    if (!o.force && !same(insp.files, files) && (!edited || edited.length)) {
      say(edited
        ? `The copy in ${insp.target} was edited here (${edited.join(', ')}). It is not replaced.`
        : `A skill folder ${insp.target} is there that hoprig-skill did not write. It is not replaced.`);
      say('What would change:');
      showDiff(say, insp.files, files);
      throw new Refused(`Nothing was written. To replace it with the Hoprig skill ${VERSION} anyway: add --force.`);
    }
  }
  const blocked = cannotWrite(insp);
  if (blocked) throw new Refused(`Cannot write in ${blocked} (no permission). Nothing was written.`);
  if (o.dryRun) {
    say(`Would ${insp.files ? 'replace' : 'write'} the Hoprig skill ${VERSION} in ${insp.target}:`);
    for (const [rel, buf] of Object.entries(files)) say(`  ${rel} (${buf.length} bytes)`);
    say(`  ${RECORD} (what was written: the version and a SHA-256 per file)`);
    if (insp.files) showDiff(say, insp.files, files);
    say('Dry run: nothing was written.');
    return 0;
  }
  if (insp.files && !same(insp.files, files)) showDiff(say, insp.files, files);
  place(insp, files, say);
  say(`${insp.files ? 'Updated' : 'Added'} the Hoprig skill ${VERSION} in ${insp.target}.`);
  say('Your coding tool loads it in its next session. Take it away again with --remove.');
  return 0;
}

function remove(o, insp, say) {
  if (!insp.files) {
    say(`There is no Hoprig skill in ${insp.real}. Nothing to remove.`);
    return 0;
  }
  if (insp.managed && !o.force) throw new Refused(`Hoprig itself manages ${insp.target}: remove it with "hoprig skills rm ${NAME}". Nothing was removed.`);
  const edited = editedSince(insp.files, insp.record);
  if (!o.force && (!edited || edited.length)) {
    throw new Refused(edited
      ? `The copy in ${insp.target} was edited here (${edited.join(', ')}). Nothing was removed; --force removes it anyway.`
      : `${insp.target} was not written by hoprig-skill. Nothing was removed; --force removes it anyway.`);
  }
  const blocked = cannotWrite(insp);
  if (blocked) throw new Refused(`Cannot write in ${blocked} (no permission). Nothing was removed.`);
  if (o.dryRun) {
    say(`Would remove ${insp.target} (${Object.keys(insp.files).length} files and ${RECORD}).`);
    say('Dry run: nothing was removed.');
    return 0;
  }
  const work = workFolder(insp.real);
  try {
    fs.renameSync(insp.target, path.join(work.dir, 'old'));
  } catch (e) {
    fs.rmSync(work.dir, { recursive: true, force: true });
    throw e;
  }
  dropWork(work, say);
  say(`Removed the Hoprig skill from ${insp.target}.`);
  return 0;
}

export function main(argv = process.argv.slice(2), { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const o = parseArgs(argv);
  if (o.error) {
    err(`hoprig-skill: ${o.error}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  if (o.print) {
    out(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').trimEnd());
    return 0;
  }
  try {
    const dir = skillsFolder(o.where[0]);
    putBack(dir, o, out);
    const insp = inspect(dir);
    return o.remove ? remove(o, insp, out) : install(o, insp, out);
  } catch (e) {
    const said = e instanceof Refused ? e.message : plainError(e);
    if (!said) throw e;
    err(said);
    return 1;
  }
}

/** The first path on the way to `p` that is there and is not a folder (`p` itself when none is found). */
function fileInTheWay(p) {
  const up = [];
  for (let at = path.dirname(p); path.dirname(at) !== at; at = path.dirname(at)) up.unshift(at);
  for (const at of up) {
    try {
      if (!fs.statSync(at).isDirectory()) return at;
    } catch {
      return p;
    }
  }
  return p;
}

/** An error of the system said in plain words (null for one that is not expected here). Every change is undone by then. */
function plainError(e) {
  const at = e.dest || e.path;
  const nothing = 'Nothing was changed.';
  if (e.code === 'ENOENT') return `${at} is not there (a folder on the way may be a link to nothing). ${nothing}`;
  if (e.code === 'EACCES' || e.code === 'EPERM') return `Cannot write in ${at} (no permission). ${nothing}`;
  if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return `Another hoprig-skill run is writing in ${path.dirname(at)} right now: try again. ${nothing}`;
  if (e.code === 'EXDEV') return `${at} is on another disk than the folder around it, so it cannot be swapped in one step. ${nothing}`;
  if (e.code === 'ENOSPC') return `The disk is full. ${nothing}`;
  if (e.code === 'ENOTDIR') return `${fileInTheWay(at)} is a file where a folder should be. ${nothing}`;
  return null;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`hoprig-skill: ${e.message}\n`);
    process.exitCode = 1;
  }
}
