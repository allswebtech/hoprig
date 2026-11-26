// Skills on disk: where they live (the user's <claude>/skills, a project's .claude/skills), the manifest next to
// them (.hoprig-skills.json: source, commit, file hashes) and the moves that change them. A change is staged
// beside the skills folder and swapped in with renames, so Claude Code never sees half a skill; the replaced or
// removed version is kept (one step) for undo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { copyTree } from '../copytree.mjs';
import { claudeDir, stateDir } from '../paths.mjs';
import { parseFrontMatter } from './frontmatter.mjs';
import { safeRel } from './scan.mjs';
import { replaceFile } from '../replacefile.mjs';

export const MANIFEST = '.hoprig-skills.json';
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const hubDir = () => path.join(stateDir(), 'skillhub');

const RESERVED = new Set(['synced', 'anthropic-skills']);
/** A skill name that is safe as one folder name (and loads in Claude Code). */
export const safeName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n) && !n.includes('..') && !RESERVED.has(n.toLowerCase());

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The skills folder of a scope: { kind: 'user' | 'project', root (the project, real path), dir }. A project must
 * exist; `allowed(realPath)` (optional) refuses folders outside what the caller may touch.
 */
export function scopeOf({ project = null } = {}, allowed = null) {
  if (!project) return { kind: 'user', root: null, dir: path.join(claudeDir(), 'skills') };
  let root;
  try {
    root = fs.realpathSync(path.resolve(project));
    if (!fs.statSync(root).isDirectory()) throw new Error();
  } catch {
    throw new StoreError(`${project} is not a folder`, 404);
  }
  if (allowed && !allowed(root)) throw new StoreError('that folder is outside the folders this dashboard may use', 403);
  return { kind: 'project', root, dir: path.join(root, '.claude', 'skills') };
}

/** The folder of one skill in a scope; refuses names that could point elsewhere. */
export function skillPath(scope, name) {
  if (!safeName(name)) throw new StoreError(`"${name}" is not a skill name`);
  const p = path.join(scope.dir, name);
  if (path.dirname(p) !== scope.dir) throw new StoreError('bad skill name');
  return p;
}

/**
 * The record of the person's own skills (the user scope) is kept in Hoprig's state folder, not next to them: their
 * folder is often the AI brain's (a git repository of the person's, linked by hoprig workspace link), and only
 * Hoprig reads the record, so it would be a loose change there. A project's record stays in its .claude/skills.
 */
export const userRecordFile = () => path.join(hubDir(), 'user-skills.json');
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const isUserDir = (dir) => realOr(dir) === realOr(path.join(claudeDir(), 'skills'));
/** Where the record of the skills folder `dir` is written. */
export const recordFile = (dir) => (isUserDir(dir) ? userRecordFile() : path.join(dir, MANIFEST));

const readRecord = (file) => {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && m.version === 1 && m.skills && typeof m.skills === 'object') return m;
  } catch {
    /* none yet, or unreadable */
  }
  return null;
};

/**
 * The record of a skills folder. The person's own: the state folder's, else the one an older Hoprig left next to the
 * skills (read only: it is never deleted, moved or committed by Hoprig; the next change writes the state folder's).
 */
export function readManifest(dir) {
  const here = readRecord(path.join(dir, MANIFEST));
  if (!isUserDir(dir)) return here || { version: 1, skills: {} };
  const m = readRecord(userRecordFile()) || { version: 1, skills: {} };
  // An older record next to the skills (also one that came with the brain from another computer) still names the
  // skills it installed, as long as that skill's folder is here and the state folder's record has no word on it.
  for (const [name, rec] of Object.entries((here && here.skills) || {})) if (!m.skills[name] && safeName(name) && fs.existsSync(path.join(dir, name))) m.skills[name] = rec;
  return m;
}

function writeRecord(file, m) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  replaceFile(tmp, file);
}

export function writeManifest(dir, m) {
  writeRecord(recordFile(dir), m);
}

/**
 * A record found in the person's old skills folder (the link moves that folder's skills into the brain): its entries
 * the person's record lacks are added to it, so Hoprig still knows the skills it installed. The file is left alone.
 */
export function foldUserRecord(file) {
  const old = readRecord(file);
  if (!old) return false;
  const m = readManifest(path.join(claudeDir(), 'skills'));
  for (const [name, rec] of Object.entries(old.skills)) if (!m.skills[name]) m.skills[name] = rec;
  writeRecord(userRecordFile(), m);
  return true;
}

/** { rel: sha256 } of every regular file below a folder (symlinks are not followed). */
export function hashFolder(dir) {
  const out = {};
  const visit = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) visit(full, r);
      else if (e.isFile()) out[r] = sha256(fs.readFileSync(full));
      else if (e.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(full)}`;
    }
  };
  visit(dir, '');
  return out;
}

/** Files that differ between the hashes recorded at install and what is on disk now. */
export function localEdits(recorded, onDisk) {
  const out = [];
  for (const [p, h] of Object.entries(onDisk)) if (recorded[p] !== h) out.push(recorded[p] ? `changed ${p}` : `added ${p}`);
  for (const p of Object.keys(recorded)) if (!(p in onDisk)) out.push(`removed ${p}`);
  return out.sort();
}

// The skills CLI (vercel-labs/skills) keeps its own lock; read it (only) to say where such a skill came from.
function skillsCliLock(scope) {
  const file = scope.kind === 'project'
    ? path.join(scope.root, 'skills-lock.json')
    : process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : path.join(path.dirname(claudeDir()), '.agents', '.skill-lock.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j.skills === 'object' ? j.skills : {};
  } catch {
    return {};
  }
}

/**
 * The skills of a scope: [{ name, description, dir, link, managed, source, edited, viaSkillsCli }]. Folders whose
 * name starts with "." and Claude Code's own "synced" folder are not skills.
 */
export function listInstalled(scope) {
  let entries;
  try {
    entries = fs.readdirSync(scope.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const m = readManifest(scope.dir);
  const cli = skillsCliLock(scope);
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.toLowerCase() === 'synced') continue;
    const full = path.join(scope.dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(full, 'SKILL.md'), 'utf8');
    } catch {
      /* a folder without SKILL.md: listed, so the user sees it */
    }
    const fm = parseFrontMatter(text);
    const rec = m.skills[e.name] || null;
    let edited = [];
    if (rec && !e.isSymbolicLink()) {
      try {
        edited = localEdits(rec.files || {}, hashFolder(full));
      } catch {
        edited = ['unreadable'];
      }
    }
    const c = cli[e.name];
    out.push({
      name: e.name,
      description: String(fm.data.description || ''),
      dir: full,
      link: e.isSymbolicLink(),
      hasSkillMd: Boolean(text),
      managed: Boolean(rec),
      source: rec ? rec.source : null,
      license: rec ? rec.license : (fm.data.license ? String(fm.data.license) : ''),
      installedAt: rec ? rec.installedAt : null,
      updatedAt: rec ? rec.updatedAt : null,
      edited,
      canUndo: Boolean(previousOf(scope, e.name)),
      viaSkillsCli: c ? { source: c.source, commit: c.commit || null, path: c.skillPath || null } : null,
      // A skill Hoprig learned from the owner's work (src/skillhub/learned.mjs) says so in its own front matter.
      learned: learnedMark(fm.data.metadata),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** { from, on } of a learned skill's front matter (metadata learned-by: hoprig), else null. */
function learnedMark(m) {
  if (!m || typeof m !== 'object' || m['learned-by'] !== 'hoprig') return null;
  const one = (v) => (typeof v === 'string' ? v.replace(/[^\w .:-]/g, '').slice(0, 80) : '');
  return { from: one(m['learned-from']), on: one(m['learned-on']) };
}

/** Move a folder, also across file systems (rename, else copy by the names' bytes and delete). */
export function moveDir(from, to, { rename = fs.renameSync } = {}) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyTree(from, to, { times: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

const previousDir = (scope, name) => path.join(hubDir(), 'previous', sha256(scope.dir).slice(0, 16), name);

/** Keep `current` (a folder) and its manifest record as the one-step undo of a skill. */
function keepPrevious(scope, name, current, record) {
  const p = previousDir(scope, name);
  fs.rmSync(p, { recursive: true, force: true });
  moveDir(current, path.join(p, 'skill'));
  fs.writeFileSync(path.join(p, 'entry.json'), JSON.stringify({ name, record, keptAt: new Date().toISOString() }));
}

/** What undo would bring back for a skill, or null. */
export function previousOf(scope, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(previousDir(scope, name), 'entry.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Copy the files of a reviewed skill folder into a new folder, regular files only. A symlink is copied as the file
 * it points to, and only when that file is inside the skill; anything else refuses the whole copy.
 */
export function copyReviewed(srcRoot, files, dest) {
  const real = fs.realpathSync(srcRoot);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    if (!safeRel(f.path)) throw new StoreError(`refused: unsafe file name ${JSON.stringify(f.path)}`);
    const from = path.join(real, f.path);
    const to = path.join(dest, f.path);
    if (!to.startsWith(dest + path.sep)) throw new StoreError(`refused: ${f.path} leaves the skill folder`);
    let source = from;
    if (fs.lstatSync(from).isSymbolicLink()) {
      const target = fs.realpathSync(from);
      if (!target.startsWith(real + path.sep) || !fs.statSync(target).isFile()) throw new StoreError(`refused: ${f.path} links outside the skill or to a folder`);
      source = target;
    }
    // Also through a symlinked parent folder: the real file must be inside the skill.
    if (!fs.realpathSync(source).startsWith(real + path.sep)) throw new StoreError(`refused: ${f.path} goes through a link out of the skill`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(source, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, (f.mode || 0o644) & 0o755); // no setuid, no group/world write
  }
}

/**
 * Put a reviewed skill in place: stage it next to the skills folder, swap it in, keep the old one for undo and
 * write the manifest record ({ source, license, files }). Returns the record.
 */
export function placeSkill(scope, name, srcRoot, files, record) {
  const target = skillPath(scope, name);
  fs.mkdirSync(scope.dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(scope.dir), '.hoprig-staging-'));
  try {
    const fresh = path.join(staging, 'new');
    copyReviewed(srcRoot, files, fresh);
    const m = readManifest(scope.dir);
    const old = m.skills[name] || null;
    const now = new Date().toISOString();
    const rec = { ...record, files: hashFolder(fresh), installedAt: old ? old.installedAt : now, updatedAt: now };
    if (fs.existsSync(target) || isLink(target)) {
      const aside = path.join(staging, 'old');
      fs.renameSync(target, aside);
      fs.renameSync(fresh, target);
      keepPrevious(scope, name, aside, old);
    } else fs.renameSync(fresh, target);
    m.skills[name] = rec;
    writeManifest(scope.dir, m);
    return rec;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Remove a skill (kept for undo). A symlinked skill only loses its link. */
export function removeSkill(scope, name) {
  const target = skillPath(scope, name);
  if (!fs.existsSync(target) && !isLink(target)) throw new StoreError(`there is no skill "${name}" in ${scope.dir}`, 404);
  const m = readManifest(scope.dir);
  if (isLink(target)) fs.unlinkSync(target);
  else keepPrevious(scope, name, target, m.skills[name] || null);
  delete m.skills[name];
  writeManifest(scope.dir, m);
}

/** Swap a skill with its kept version (so undo twice is redo). */
export function undoSkill(scope, name) {
  const target = skillPath(scope, name);
  const prevRoot = previousDir(scope, name);
  const prev = previousOf(scope, name);
  if (!prev || !fs.existsSync(path.join(prevRoot, 'skill'))) throw new StoreError(`nothing to undo for "${name}"`, 404);
  const m = readManifest(scope.dir);
  const staging = fs.mkdtempSync(path.join(path.dirname(scope.dir), '.hoprig-staging-'));
  try {
    const current = fs.existsSync(target) && !isLink(target) ? path.join(staging, 'current') : null;
    if (current) fs.renameSync(target, current);
    moveDir(path.join(prevRoot, 'skill'), path.join(staging, 'back'));
    fs.renameSync(path.join(staging, 'back'), target);
    const currentRecord = m.skills[name] || null;
    if (prev.record) m.skills[name] = prev.record;
    else delete m.skills[name];
    writeManifest(scope.dir, m);
    fs.rmSync(prevRoot, { recursive: true, force: true });
    if (current) keepPrevious(scope, name, current, currentRecord);
    return prev.record;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
