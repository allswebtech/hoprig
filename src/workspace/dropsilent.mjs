// What `hoprig drop` removes without a word (docs/WORKSPACE.md, "Drop"). The promise of drop is that nothing is lost:
// what is not on the git server is listed, and the owner types the project's name. This module is the ONE place that
// decides what is not listed: every check of drop asks withoutAWord(), and nothing else in the code leaves a path off
// the list (test/workspace/dropsilent.test.mjs greps for a second place). Three things only:
//
//   - a folder a build or an install makes again (REBUILT, by its name) that git ignores AS A WHOLE in the repository
//     that holds it (`git check-ignore -q -- <folder>/`: a folder with a tracked file in it, or only partly ignored, is
//     not), by a rule of its own (inside another folder git ignores, test-data/build/, it is that folder's content and
//     listed with it), and everything inside such a folder up to the next repository (a repository inside has commits
//     and ignored files of its own: it is checked on its own, and its own files are judged by it). It is said ("drop
//     would delete with it ..."), never asked;
//   - a credential link that is provably one: a symbolic link that the project's project.json names under
//     "credentials" and that points to the very place project.json names in the workspace's credentials folder. The
//     check is get's own (credlinks.mjs planCredLinks: its state "ok"), so get makes the link again from project.json
//     and nothing is lost. Its count is said, never its target;
//   - a file a system makes by itself (SYSTEM_FILES), by its exact name and only as a plain file.
//
// Everything else a drop would remove that is not on the git server is on the typed list: every other ignored file or
// folder, every other link (one project.json does not name, one that points elsewhere), a real file or a folder where
// a credential link should be, and every private folder that is not inside a folder of build output git ignores.
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { planCredLinks } from './credlinks.mjs';

/** The folder names a build or an install makes again. Only here: no other module reads or copies this list. */
const REBUILT = ['node_modules', 'vendor', '.next', '.nuxt', '.svelte-kit', '.turbo', '.dart_tool', '.gradle', 'Pods', 'build', 'dist', 'target', '__pycache__', '.pytest_cache', '.venv', 'coverage'];
/** The files a system makes by itself in any folder (macOS, Windows): only as a plain file of that exact name. */
const SYSTEM_FILES = ['.DS_Store', 'Thumbs.db'];

/** Whether a folder of this name is made again by a build or an install (for a walk outside git: pc leave's sizes). */
export const isRebuiltName = (name) => REBUILT.includes(name);
/** Whether a plain file of this name is one a system makes by itself. */
export const isSystemFile = (name) => SYSTEM_FILES.includes(name);

const inside = (p, top) => p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);

/** The repository of `repos` that holds `abs` (the nearest one above it), or null. */
export const holderOf = (abs, repos) => repos.filter((r) => inside(abs, r)).sort((a, b) => b.length - a.length)[0] || null;

/**
 * Does `abs` go without a word? `repos`: every working tree of the project. The kind of `abs`, from lstat (never through
 * a link): `isDir` a real folder, `isLink` a link, `isFile` a plain file. `project`: { root, manifest, at } of the
 * project whose credential links count (its project.json, as readManifest checked it; `at`: { dir, projects } of the
 * workspace). `memo`: a Map one check shares (each folder is asked of git once, the links planned once). A repository
 * itself is never without a word (it is checked on its own). An answer git does not give clearly (an error, an old
 * git) is "no": the path is listed.
 * → { why: 'rebuilt', repo, folder: 'rel/of/folder/' } | { why: 'credential link' } | { why: 'system file' } | null
 */
export async function withoutAWord(abs, { repos, isDir = false, isLink = false, isFile = false, project = null, memo = new Map(), run = capture }) {
  const p = path.resolve(abs);
  if (isLink && project && project.manifest && project.manifest.credentials) {
    const key = `\0credentials\0${project.root}`;
    if (!memo.has(key)) memo.set(key, await planCredLinks(project.root, project.manifest, { at: project.at, run }).catch(() => []));
    if (memo.get(key).some((e) => e.state === 'ok' && e.link && path.resolve(e.link) === p)) return { why: 'credential link' };
  }
  if (isFile && !isLink && !isDir && SYSTEM_FILES.includes(path.basename(p))) return { why: 'system file' };
  if (repos.includes(p)) return null;
  const repo = holderOf(p, repos);
  if (!repo) return null;
  const parts = path.relative(repo, p).split(path.sep);
  const dirs = isDir ? parts.length : parts.length - 1; // a file or a link named like a folder of the list is none
  // From the top down, the first folder git ignores decides: one of the list goes with all in it; any other (test-data/)
  // is listed whole, and a folder of the list inside it (test-data/build/) is test data, not build output.
  for (let i = 0; i < dirs; i++) {
    const folder = `${parts.slice(0, i + 1).join('/')}/`;
    const key = `${repo}\0${folder}`;
    if (!memo.has(key)) memo.set(key, (await gitRead(repo, ['check-ignore', '--quiet', '--', folder], { run })).code === 0);
    if (memo.get(key)) return REBUILT.includes(parts[i]) ? { why: 'rebuilt', repo, folder } : null;
  }
  return null;
}

