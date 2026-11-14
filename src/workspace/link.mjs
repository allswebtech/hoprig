// `hoprig workspace link`: make Claude Code read its global rules, its skills and the home folder's memory from
// the AI brain, so they travel with the brain's git repository:
//
//   <claude dir>/CLAUDE.md                          → ai_brain/claude/CLAUDE.md
//   <claude dir>/skills                             → ai_brain/skills
//   <claude dir>/projects/<home as a name>/memory   → ai_brain/claude-memory/home
//
// (<claude dir> is ~/.claude, or $CLAUDE_CONFIG_DIR.) Nothing is lost and nothing is overwritten, the same way
// project memory is linked (pcsetup/workspace.mjs linkMemories): a real folder's files are merged into the brain
// (a name that is taken gets ".from-<time>" added) and the folder is kept as a dated backup; a rules file is moved
// into the brain only when the brain has none, else it must be the same text; a link that points somewhere else is
// left alone. planLink() says exactly what would happen; applyLink() does it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, tilde } from '../paths.mjs';
import { linkMemories, mergeInto, safeReal, stamp } from '../pcsetup/workspace.mjs';
import { projectSlug } from '../sessions.mjs';
import { brainDir } from './layout.mjs';

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

/** The three links: [{ id, what, link, target, kind: 'file' | 'dir' }]. */
export function linkTargets({ base = claudeDir(), brain = brainDir(), home = os.homedir() } = {}) {
  return [
    { id: 'rules', what: 'the rules Claude gets everywhere', link: path.join(base, 'CLAUDE.md'), target: path.join(brain, 'claude', 'CLAUDE.md'), kind: 'file' },
    { id: 'skills', what: 'your skills', link: path.join(base, 'skills'), target: path.join(brain, 'skills'), kind: 'dir' },
    { id: 'memory', what: 'the memory for work started in your home folder', link: path.join(base, 'projects', projectSlug(home), 'memory'), target: path.join(brain, 'claude-memory', 'home'), kind: 'dir' },
  ];
}

/**
 * What would happen to each link: action is
 *   already   it is linked
 *   link      nothing is there: a new link
 *   merge     a real folder: its files are merged into the brain, the folder kept as a backup, then the link
 *   adopt     a rules file and none in the brain: the file moves into the brain (a backup stays), then the link
 *   backup    a rules file with the same text as the brain's: kept as a backup, then the link
 *   conflict  left alone (`why` says what is in the way)
 */
export function planLink(opts = {}) {
  return linkTargets(opts).map((t) => {
    const out = { ...t, linkShort: tilde(t.link), targetShort: tilde(t.target) };
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
      return { ...out, action: 'conflict', why: `it differs from the brain's ${tilde(t.target)}: keep one (copy what you want into the brain's file and delete or rename this one), then run this again` };
    }
    if (!st) return { ...out, action: 'link' };
    if (st.isDirectory()) return { ...out, action: 'merge' };
    return { ...out, action: 'conflict', why: 'a file is in the way' };
  });
}

/** Do the plan. Returns the plan entries with `done` (what was done, in plain words) or `error`. */
export function applyLink({ platform = process.platform, now = new Date(), home = os.homedir(), ...opts } = {}) {
  return planLink({ home, ...opts }).map((p) => {
    try {
      if (p.action === 'already' || p.action === 'conflict') return { ...p, done: p.action === 'already' ? 'already linked' : 'left alone' };
      if (p.id === 'memory') {
        // The same code that links a project's memory: merge, keep a backup, link (or the Windows setting).
        const r = linkMemories(home, { '.': path.relative(home, p.target) }, { base: opts.base || claudeDir(), platform, now })[0];
        return { ...p, done: r.done };
      }
      const backup = `${p.link}.backup-${stamp(now)}`;
      let said = 'linked';
      if (p.action === 'merge') {
        fs.renameSync(p.link, backup);
        const n = mergeInto(backup, p.target, stamp(now));
        said = `moved ${n} file${n === 1 ? '' : 's'} in, then linked (old folder kept: ${path.basename(backup)})`;
      } else if (p.action === 'adopt' || p.action === 'backup') {
        fs.mkdirSync(path.dirname(p.target), { recursive: true });
        if (p.action === 'adopt') fs.copyFileSync(p.link, p.target, fs.constants.COPYFILE_EXCL);
        fs.renameSync(p.link, backup);
        said = `${p.action === 'adopt' ? 'moved your file into the brain' : 'the same text was in the brain'}, then linked (old file kept: ${path.basename(backup)})`;
      }
      fs.mkdirSync(path.dirname(p.link), { recursive: true });
      if (p.kind === 'dir') fs.mkdirSync(p.target, { recursive: true });
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
