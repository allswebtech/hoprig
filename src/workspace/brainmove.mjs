// The save sheet's way out of its key refusal: the files a save refuses (brainsave.mjs, a key file or a text that
// holds a key-shaped value, or one too large to check) are MOVED out of the AI brain on the owner's press, never
// deleted (POST /api/workspace/git/brain/moveout { files }). They go to a folder beside the brain that the sheet names
// before the press: `<the brain folder's name>-moved-out` in the brain's parent folder, each file keeping its path
// inside the brain; a file of the same name there is never overwritten (" (2)", " (3)" before its extension). A file
// git keeps already is also taken out of git (its removal is staged, so the next save takes it off the git server;
// its old versions stay in the history, which the sheet says).
//
// What the request names is checked here again, at the moment of the press, and nothing is moved unless every name
// passes: a plain path inside the brain (no "..", not absolute), never in or under a private folder (no-ai, ignore,
// ai-ignore-dir), no link on the way that leads out and not a link itself, a regular file, and one this server's own
// refusal list of that moment names (never more than the sheet showed). Nothing here runs by itself: only the
// workspace routes import it.
import fs from 'node:fs';
import path from 'node:path';
import { brainChanges, movedOutDir, refusedSeen } from './brainsave.mjs';
import { gitIn, leaves, mkdirIn, moveNoReplaceIn } from './inside.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { FOLD, PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { capture } from '../setup/system.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const MOVE_MAX = 500; // as many as the sheet lists
const fold = (s) => (FOLD ? s.toLowerCase() : s);
const PRIVATE = new Set(PRIVATE_DIRS.map(fold));

/** Why a name from the request is not a plain path inside the brain, or null. Read before anything on the disk. */
function badName(f) {
  if (typeof f !== 'string' || !f || f.length > 4096 || /[\0\\]/.test(f) || path.isAbsolute(f) || path.win32.isAbsolute(f)) return 'is not a path inside the AI brain';
  const parts = f.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return 'is not a path inside the AI brain';
  if (parts.slice(0, -1).some((p) => PRIVATE.has(fold(p)))) return 'is in a private folder, which Hoprig never touches';
  if (PRIVATE.has(fold(parts[parts.length - 1]))) return 'is a private folder, which Hoprig never touches';
  return null;
}

/** `dest` when nothing is there, else "name (2).ext", "name (3).ext", … : never one that exists. */
function freeName(dest) {
  const there = (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  if (!there(dest)) return dest;
  const ext = path.extname(dest) && path.extname(dest) !== path.basename(dest) ? path.extname(dest) : '';
  const stem = dest.slice(0, dest.length - ext.length);
  for (let n = 2; n < 10_000; n++) if (!there(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  throw fail(409, `${dest} and 9998 more of its name are there already: nothing more was moved`);
}

/**
 * Move the named files out of the brain (the owner's press). `files`: the paths inside the brain the sheet showed;
 * `seen`: the fingerprint of the refusal list it showed (brainChanges' moveSeen).
 * → { ok, folder, moved: [{ from, to }], untracked: [paths taken out of git] }. Throws a plain 400 or 409 before
 * anything is moved when one name does not pass.
 */
export async function moveOut({ dir = workspaceDir(), files, seen, run = capture } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MOVE_MAX) throw fail(400, `name the files to move (1 to ${MOVE_MAX})`);
  if (typeof seen !== 'string' || !/^[0-9a-f]{64}$/.test(seen)) throw fail(400, 'seen is the list the sheet showed: open the save again');
  const names = [...new Set(files)];
  for (const f of names) {
    const why = badName(f);
    if (why) throw fail(400, `${String(f).slice(0, 200)} ${why}: nothing was moved`);
  }
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) throw fail(409, 'the AI brain is not in git yet');
  const at = { dir, projects: projectsIn(), root: brain };
  for (const f of names) {
    const p = path.join(brain, ...f.split('/'));
    const out = leaves(brain, path.dirname(p), at);
    if (out) throw fail(409, `${f} lies behind a link that leads out of the AI brain: nothing was moved`);
    let st = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      /* not there */
    }
    if (!st) throw fail(409, `${f} is not in the AI brain any more: nothing was moved. Open the save again to see what is there now.`);
    if (st.isSymbolicLink()) throw fail(409, `${f} is a link, not a file: nothing was moved`);
    if (!st.isFile()) throw fail(409, `${f} is not a file: nothing was moved`);
  }
  // The server's own refusal list of this moment: a name it does not refuse is not moved by this press.
  const now = await brainChanges({ dir, run });
  // The list the sheet showed (its fingerprint): a file the save refuses that came after it is never moved unseen.
  if (refusedSeen(now.secret) !== seen) throw fail(409, 'the files the save refuses changed since the sheet was opened: nothing was moved. Open the save again to see them.');
  const refused = new Set(now.secret);
  const not = names.filter((f) => !refused.has(f));
  if (not.length) throw fail(409, `${not.slice(0, 5).join(', ')}${not.length > 5 ? ` and ${not.length - 5} more` : ''}: not a file the save refuses, so nothing was moved. Open the save again to see what it refuses now.`);
  const tracked = new Set(now.secretTracked || []);
  const folder = movedOutDir(brain);
  const there = { dir, projects: at.projects, root: folder };
  const moved = [];
  const untracked = [];
  for (const f of names) {
    const from = path.join(brain, ...f.split('/'));
    const want = path.join(folder, ...f.split('/'));
    mkdirIn(there, path.dirname(want));
    if (leaves(folder, path.dirname(want), there)) throw fail(409, `${path.dirname(want)} leads out through a link: ${moved.length ? `${moved.length} moved before it, ` : ''}nothing more was moved`);
    const to = freeName(want);
    moveNoReplaceIn(at, from, there, to);
    moved.push({ from: f, to });
    if (tracked.has(f)) {
      // Its removal staged: the next save takes it off the git server. The file itself is in the folder beside.
      const r = await gitIn(at, brain, ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', f], run);
      if (!r.ok) throw fail(409, `${f} was moved to ${to}, but git could not take it out of the AI brain's history: ${(r.stderr || '').trim().split('\n').pop() || 'git rm failed'}`);
      untracked.push(f);
    }
  }
  return { ok: true, folder, moved, untracked };
}
