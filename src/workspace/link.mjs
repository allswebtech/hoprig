// `hoprig workspace link`: make every coding tool that is on read the same global rules, skills and memory from
// the AI brain, so they travel with the brain's git repository. Each tool's descriptor says what it reads
// (src/codetools: brainLinks); the entries of the tools that are on (config.json "codingTools", only offered tools:
// src/codetools/index.mjs) are linked. Codex's entries are kept for when it is offered again:
//
//   Claude Code   <claude dir>/CLAUDE.md                          → ai_brain/claude/CLAUDE.md
//                 <claude dir>/skills                             → ai_brain/skills
//                 <claude dir>/projects/<home as a name>/memory   → ai_brain/claude-memory/home
//   Codex         <codex home>/AGENTS.md                          → ai_brain/claude/CLAUDE.md (the same file)
//                 ~/.agents/skills                                → ai_brain/skills
//   OpenCode      <opencode config>/AGENTS.md                     → ai_brain/claude/CLAUDE.md
//                 ~/.agents/skills (one link, shared with Codex)  → ai_brain/skills
//                 <opencode config>/opencode.json "instructions"  + Claude Code's rules folder, each project's memory index
//   Codex and OpenCode keep no memory of their own: a short section in the shared rules file tells them where each
//   project's memory is and to keep it (id "memory-note", added at the end of the file, never over the owner's text).
//
// (<claude dir> is ~/.claude, or $CLAUDE_CONFIG_DIR.) Nothing is lost and nothing is overwritten, the same way
// project memory is linked (pcsetup/workspace.mjs linkMemories): a real folder's files are merged into the brain
// (a name that is taken gets ".from-<time>" added) and the folder is kept as a dated backup; a rules file is moved
// into the brain only when the brain has none, else it must be the same text; a link that points somewhere else is
// left alone. planLink() says exactly what would happen; applyLink() does it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anyTool, enabledToolIds } from '../codetools/index.mjs';
import { MEMORY_INDEX } from '../codetools/opencode.mjs';
import { loadConfig } from '../config.mjs';
import { claudeDir, tilde } from '../paths.mjs';
import { linkMemories, mergeInto, safeReal, stamp } from '../pcsetup/workspace.mjs';
import { MANIFEST as SKILLS_RECORD, foldUserRecord } from '../skillhub/store.mjs';
import { brainDir } from './layout.mjs';
import { copyIn, kindAt, leaves, leavesWords, mkdirIn, readIn, writeIn } from './inside.mjs';

/** The section the shared rules file gets for tools without a memory of their own (kept to a few lines). */
export const MEMORY_BEGIN = '<!-- hoprig: memory for coding tools without their own -->';
export const MEMORY_END = '<!-- /hoprig: memory -->';
export const MEMORY_SECTION = `${MEMORY_BEGIN}
## Memory

Each project keeps its AI memory in \`${path.posix.dirname(MEMORY_INDEX)}/\` (in the project's own folder); \`${path.posix.basename(MEMORY_INDEX)}\` there is
the index. Read the index when you start work in a project. When you learn something that will matter next time
(a decision, a fact about the project, how the owner wants things done), keep it: a short file in that folder and one
line for it in the index. Claude Code keeps this memory by itself; other coding tools keep it by these lines.
${MEMORY_END}
`;

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const sameText = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

/** Each tool's own folder, from `home` and the variables the tools themselves read. */
export function toolHomes(home = os.homedir(), env = process.env) {
  return {
    codex: env.CODEX_HOME || path.join(home, '.codex'),
    opencode: env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
  };
}

/**
 * The entries of the tools that are on: [{ id, tool, tools, what, short (a word or two for a count), link, target,
 * kind: 'file'|'dir'|'json'|'section' }].
 * Claude Code's ids are the short ones ("rules", "skills", "memory") older pages filter on; the others are
 * "<tool>:<id>". One place linked for two tools (~/.agents/skills) is one entry with both in `tools`.
 * `tools`: the tool ids (default: config.json "codingTools"); `homes`: { codex, opencode } folders.
 */
export function linkTargets({ base = claudeDir(), brain = brainDir(), home = os.homedir(), tools = null, homes = null } = {}) {
  const ids = tools || enabledToolIds(loadConfig()); // offered tools only, unless a caller (a test) names others
  const where = { ...toolHomes(home), ...(homes || {}) };
  const out = [];
  for (const id of ids) {
    const t = anyTool(id);
    if (!t || !t.brainLinks) continue;
    for (const e of t.brainLinks({ base, brain, home, toolHome: where[id] })) {
      const same = e.kind !== 'json' && out.find((o) => o.link === e.link);
      if (same) {
        same.tools.push(id);
        same.what = `your skills, for ${same.tools.map((x) => anyTool(x).name).join(' and ')}`; // short stays "skills"
        continue;
      }
      out.push({ ...e, id: id === 'claude' ? e.id : `${id}:${e.id}`, tool: id, tools: [id] });
    }
  }
  const forgetful = ids.filter((id) => anyTool(id) && anyTool(id).ownMemory === false);
  if (forgetful.length) {
    const names = forgetful.map((x) => anyTool(x).name).join(' and ');
    const keep = forgetful.length === 1 ? 'reads and keeps' : 'read and keep';
    out.push({
      id: 'memory-note', tool: forgetful[0], tools: forgetful, kind: 'section', short: 'memory note', what: `a Memory section in the shared rules, so ${names} ${keep} each project's memory`,
      link: path.join(brain, 'claude', 'CLAUDE.md'), target: 'a short "Memory" section at its end',
    });
  }
  return out;
}

const readJson = (file) => {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: e.code === 'ENOENT', value: null };
  }
};

/** A settings entry (kind json): the values it must hold, which are missing, or why it cannot be changed. */
function planJson(t, out) {
  if (fs.existsSync(`${t.link}c`)) return { ...out, action: 'conflict', why: `its settings are in ${path.basename(t.link)}c (with comments): add ${t.values.join(', ')} to "${t.key}" there yourself` };
  const st = lstat(t.link);
  if (st && !st.isFile()) return { ...out, action: 'conflict', why: 'it is not a file' };
  const r = readJson(t.link);
  if (!r.ok || (r.value !== null && (typeof r.value !== 'object' || Array.isArray(r.value)))) return { ...out, action: 'conflict', why: 'it is not a settings file Hoprig can read (JSON): add them yourself' };
  const cur = r.value ? r.value[t.key] : undefined;
  if (cur !== undefined && !Array.isArray(cur)) return { ...out, action: 'conflict', why: `its "${t.key}" is not a list` };
  const missing = t.values.filter((v) => !(cur || []).includes(v));
  return missing.length ? { ...out, action: 'link', missing, how: r.value ? `${missing.join(' and ')} added to its "${t.key}"` : `a new settings file naming ${t.values.join(' and ')}` } : { ...out, action: 'already' };
}

// The brain is a repository from a git server: its claude/CLAUDE.md or skills may be a link it tracks, to anywhere.
// What Hoprig writes into the brain, and every link it makes from a coding tool's folder to a file or folder of the
// brain, stays really inside the brain (inside.mjs): else a coding tool would read (and Hoprig write) a file outside.
const inBrainOf = (brain) => ({ root: brain, dir: path.dirname(brain) });
const brainWhy = (b) => `${leavesWords(b)}: Hoprig never links a coding tool to it or writes through it`;

/** The memory section (kind section): already there, to be added, or no rules file to add it to. */
function planSection(t, out, brain) {
  const b = leaves(brain, t.link, inBrainOf(brain));
  if (b) return { ...out, action: 'conflict', why: brainWhy(b) };
  if (kindAt(t.link) === 'link') return { ...out, action: 'conflict', why: `the brain's ${path.basename(t.link)} is a link: Hoprig never writes through one, add the section yourself` };
  const buf = readIn(inBrainOf(brain), t.link);
  if (!buf) return { ...out, action: 'conflict', why: `the brain has no ${path.basename(t.link)} yet (link the rules first)` };
  return buf.toString('utf8').includes(MEMORY_BEGIN) ? { ...out, action: 'already' } : { ...out, action: 'link', how: 'a short "Memory" section is added at the end of the shared rules file' };
}

/** The plan of one entry (see planLink). `brain`: the brain's folder. */
function planOne(t, brain) {
  const out = { ...t, linkShort: tilde(t.link), targetShort: t.kind === 'json' ? t.values.join(', ') : t.kind === 'section' ? t.target : tilde(t.target) };
  if (t.kind === 'json') return planJson(t, out);
  if (t.kind === 'section') return planSection(t, out, brain);
  const b = leaves(brain, t.target, inBrainOf(brain));
  if (b) return { ...out, action: 'conflict', why: brainWhy(b) };
  const st = lstat(t.link);
  if (st && st.isSymbolicLink()) {
    const to = path.resolve(path.dirname(t.link), fs.readlinkSync(t.link));
    if (to === t.target || safeReal(to) === safeReal(t.target)) return { ...out, action: 'already' };
    return { ...out, action: 'conflict', why: `it is a link to ${tilde(to)}: remove it yourself if the brain's copy should be used` };
  }
  if (t.kind === 'file') {
    if (!st) return fs.existsSync(t.target) ? { ...out, action: 'link' } : { ...out, action: 'conflict', why: `the brain has no ${path.basename(t.target)} to link to` };
    if (!st.isFile()) return { ...out, action: 'conflict', why: 'it is not a file' };
    if (!fs.existsSync(t.target)) return { ...out, action: 'adopt' };
    if (sameText(t.link, t.target)) return { ...out, action: 'backup' };
    return { ...out, action: 'conflict', why: `it differs from the brain's ${tilde(t.target)}: keep one (copy what you want into the brain's file and delete or rename this one), then link again` };
  }
  if (!st) return { ...out, action: 'link' };
  if (st.isDirectory()) return { ...out, action: 'merge' };
  return { ...out, action: 'conflict', why: 'a file is in the way' };
}

/**
 * What would happen to each link: action is
 *   already   it is linked
 *   link      nothing is there: a new link
 *   merge     a real folder: its files are merged into the brain, the folder kept as a backup, then the link
 *   adopt     a rules file and none in the brain: the file moves into the brain (a backup stays), then the link
 *   backup    a rules file with the same text as the brain's: kept as a backup, then the link
 *   conflict  left alone (`why` says what is in the way)
 * A settings entry (json) and the memory section are "link" when something is to be added (`how` says what).
 */
export function planLink(opts = {}) {
  const brain = opts.brain || brainDir();
  return linkTargets(opts).map((t) => planOne(t, brain));
}

/** What will happen to one plan entry, in plain words for the page. */
export function planWords(p) {
  return {
    already: 'already linked',
    link: p.how || 'a new link',
    merge: 'its files are merged into the brain, with a backup of the folder kept',
    adopt: 'the rules file is moved into the brain, with a backup kept',
    backup: 'it has the same text as the brain\'s, so it is kept as a backup and linked',
    conflict: `left alone, because ${p.why || 'something is in the way'}`,
  }[p.action] || p.action;
}

/** Do the plan. Returns the plan entries with `done` (what was done, in plain words) or `error`. */
export function applyLink({ platform = process.platform, now = new Date(), home = os.homedir(), ...opts } = {}) {
  // Each entry is planned again right before it is done: an earlier one may have made the brain's rules file.
  // What is written into the brain stays inside it, never through a link (inside.mjs); the links themselves live in
  // the coding tools' own folders, outside the workspace.
  const brain = opts.brain || brainDir();
  const inBrain = inBrainOf(brain);
  return linkTargets({ home, ...opts }).map((t) => {
    const p = planOne(t, brain);
    try {
      if (p.action === 'already' || p.action === 'conflict') return { ...p, done: p.action === 'already' ? 'already linked' : 'left alone' };
      if (p.id === 'memory') {
        // The same code that links a project's memory: merge, keep a backup, link (or the Windows setting).
        const r = linkMemories(home, { '.': path.relative(brain, p.target) }, { base: opts.base || claudeDir(), platform, now, root: brain, at: inBrain })[0];
        return { ...p, done: r.done };
      }
      const backup = `${p.link}.backup-${stamp(now)}`;
      if (p.kind === 'json') {
        const cur = readJson(p.link).value;
        if (cur) fs.copyFileSync(p.link, backup, fs.constants.COPYFILE_EXCL);
        const next = { ...(cur || {}), [p.key]: [...((cur && cur[p.key]) || []), ...p.missing] };
        fs.mkdirSync(path.dirname(p.link), { recursive: true });
        // The file can hold the tool's provider keys: it keeps its own mode, and a new one is the owner's only.
        const mode = cur ? fs.statSync(p.link).mode & 0o777 : 0o600;
        fs.rmSync(`${p.link}.tmp`, { force: true });
        fs.writeFileSync(`${p.link}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode });
        fs.chmodSync(`${p.link}.tmp`, mode); // the umask must not widen or narrow it
        fs.renameSync(`${p.link}.tmp`, p.link);
        return { ...p, done: cur ? `added to its settings (old file kept: ${path.basename(backup)})` : 'its settings file was made with them' };
      }
      if (p.kind === 'section') {
        // Read and written inside the brain, never through a link: written beside it and renamed over it.
        const buf = readIn(inBrain, p.link);
        if (!buf) throw new Error(`${p.link} is not a regular file of the brain: left alone`);
        const text = buf.toString('utf8');
        writeIn(inBrain, p.link, `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${MEMORY_SECTION}`, { atomic: true, mode: fs.statSync(p.link).mode & 0o777 });
        return { ...p, done: 'the Memory section was added at the end' };
      }
      let said = 'linked';
      if (p.action === 'merge') {
        fs.renameSync(p.link, backup);
        // Hoprig's record of the skills it installed is its own, not a skill: it goes to Hoprig's state folder
        // (store.mjs), never into the brain as a loose file or a dated copy. The backup keeps it as it was.
        const record = p.id === 'skills' ? path.join(backup, SKILLS_RECORD) : null;
        if (record && path.resolve(p.link) === path.join(opts.base || claudeDir(), 'skills')) foldUserRecord(record);
        const n = mergeInto(backup, p.target, stamp(now), inBrain, record ? [SKILLS_RECORD] : []);
        said = `moved ${n} file${n === 1 ? '' : 's'} in, then linked (old folder kept: ${path.basename(backup)})`;
      } else if (p.action === 'adopt' || p.action === 'backup') {
        mkdirIn(inBrain, path.dirname(p.target)); // inside the brain, never through a link (inside.mjs)
        if (p.action === 'adopt' && !copyIn(inBrain, p.link, p.target, { from: null })) throw new Error(`${p.link} is not a regular file: left alone`);
        fs.renameSync(p.link, backup);
        said = `${p.action === 'adopt' ? 'moved your file into the brain' : 'the same text was in the brain'}, then linked (old file kept: ${path.basename(backup)})`;
      }
      fs.mkdirSync(path.dirname(p.link), { recursive: true });
      if (p.kind === 'dir') mkdirIn(inBrain, p.target);
      try {
        fs.symlinkSync(p.target, p.link, p.kind === 'dir' ? (platform === 'win32' ? 'junction' : 'dir') : 'file');
      } catch (e) {
        // No link could be made (Windows without the right to make one): put the original back where it was.
        if (fs.existsSync(backup) && !lstat(p.link)) fs.renameSync(backup, p.link);
        throw e;
      }
      return { ...p, done: said };
    } catch (e) {
      return { ...p, error: e.message };
    }
  });
}
