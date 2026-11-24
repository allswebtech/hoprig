// The AI brain's files that are not saved to its git server yet (a session wrote a memory, Hoprig added a skill): what
// they are, and saving them on the owner's press only (POST /api/workspace/git/brain { save: true }, the page's sheet).
// Saving gets the server's newer changes first by the same engine as Sync (pcsetup/workspace.mjs syncRepo: fetch, a
// fast-forward when the brain is only behind), commits every change of the brain in one commit, and uploads it by
// that engine again. A brain on a git server whose branch here is not linked to one there is linked on the same press:
// to the server's branch of that name when there is one (then as above); his branch goes there (push -u) only when the
// server has no branch yet, else it is said and nothing is done. When the brain here and on the git server have both
// moved, nothing is committed or forced: it says so in plain words.
// Nothing here runs by itself: no automation imports it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { looksSecret } from '../assistant/secrets.mjs';
import { gitRead } from '../gitread.mjs';
import { repoInfo, stageMine, syncRepo } from '../pcsetup/workspace.mjs';
import { gitIn, leaves } from './inside.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { STATUS_EXCLUDES } from '../pcsetup/projects.mjs';
import { BRANCH_RE } from './mapcheck.mjs';
import { capture } from '../setup/system.mjs';

export const SAVE_MESSAGE = 'Save the AI brain';
const SHOWN = 5;
const LISTED = 500; // every changed path goes to the sheet's full list, up to this many
// The key check reads a changed file in pieces of CHUNK, each overlapping the one before by OVERLAP (a key cut at a
// piece's edge is whole in the next one), up to CHECK_MAX. A larger file cannot be checked, so it is refused by name.
const CHUNK = 1 << 20;
const OVERLAP = 8 << 10;
export const CHECK_MAX = 50 << 20;
// The brain's own folders that are private (no-ai, …) and installed packages: never listed, read, saved or uploaded,
// the same folders repoInfo leaves out of its count. Every status of a save is limited by them, and what it stages
// (stageMine).
const MINE = ['--', '.', ...STATUS_EXCLUDES];

// A key file or an .env by its name only: a word such as "token" in a note's name is no reason to refuse. A shared
// pattern of an .env (.env.example, .env.sample, .env.template, .env.dist) holds names, not values: judged by what it holds.
const KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)$|^\.env(?!\.(example|sample|template|dist)$)(\..+)?$|\.(pem|key|p12|pfx|keystore|jks|kdbx)$|^credentials(\.[a-z]+)?$/i;

/** Whether the file at `p` (`size` bytes) holds a secret-shaped value, read piece by piece with a turn between. */
async function holdsSecret(p, size) {
  const fh = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    for (let at = 0; at < size; at += CHUNK - OVERLAP) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, at);
      if (!bytesRead) break;
      if (looksSecret(buf.toString('utf8', 0, bytesRead))) return true;
      if (at + bytesRead >= size) break;
      await new Promise((r) => setImmediate(r));
    }
    return false;
  } finally {
    await fh.close();
  }
}

/**
 * The changed paths a save refuses: { secret (by their name, or a text that holds a secret-shaped value: looksSecret,
 * the shapes the product masks everywhere), large (over CHECK_MAX, so never checked: refused as well) }. A file in a
 * private folder never comes here (MINE). Nothing of that kind goes to a git server on a press, also not one beyond
 * the names the sheet shows first.
 */
export async function checkPaths(brain, files) {
  const secret = [];
  const large = [];
  for (const f of files) {
    if (KEY_FILE.test(path.basename(f))) {
      secret.push(f);
      continue;
    }
    // One file at a time, with a turn of the event loop between (and between the pieces of a large one): hundreds of
    // large changed files must not hold up the dashboard's other answers (terminals, chats) for seconds.
    await new Promise((r) => setImmediate(r));
    try {
      const p = path.join(brain, f);
      const st = await fs.promises.lstat(p);
      if (!st.isFile()) continue;
      if (st.size > CHECK_MAX) large.push(f);
      else if (await holdsSecret(p, st.size)) secret.push(f);
    } catch {
      /* removed meanwhile: nothing of it is uploaded */
    }
  }
  return { secret, large };
}

/** Every changed path a save refuses (checkPaths), in the order given. */
export async function secretPaths(brain, files) {
  const { secret, large } = await checkPaths(brain, files);
  const no = new Set([...secret, ...large]);
  return files.filter((f) => no.has(f));
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "team/ai_brain on git.example.test" from the brain's address (no sign-in part ever). */
export function repoWords(url) {
  const u = String(url || '').trim().replace(/^(https?:\/\/)[^/@]*@/, '$1');
  const host = (/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(u) || [])[1] || '';
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  const name = m ? `${m[1]}/${m[2]}` : path.basename(u).replace(/\.git$/, '');
  return host && name ? `${name} on ${host}` : name || host || 'your git server';
}

/** The folder beside the brain that the save sheet's Move out puts refused files in (brainmove.mjs): `<brain>-moved-out`
 * in the brain's parent folder, named on the sheet before the press. */
export const movedOutDir = (brain) => path.join(path.dirname(brain), `${path.basename(brain)}-moved-out`);

/** The fingerprint of the refusal list a sheet showed (brainChanges' moveSeen): Move out sends it back, and moves
 * nothing when the list the save refuses is no longer that one (brainmove.mjs). */
export const refusedSeen = (secret) => crypto.createHash('sha256').update(JSON.stringify(['refused', [...secret].sort()])).digest('hex');

/** The entries of git status --porcelain -z: [{ xy, path }] (a rename names its new path once). */
export function statusEntries(z) {
  const out = [];
  const parts = String(z || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    out.push({ xy: e.slice(0, 2), path: e.slice(3) });
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return out;
}
/** The changed paths of git status --porcelain -z (a rename names its new path once). */
export const changedPaths = (z) => statusEntries(z).map((e) => e.path);
// A removal: what a save uploads for it is that the file is gone (git add -A records the folder as it is). A file
// taken out of git and left on disk has a second entry ("??") of its own, which is judged.
const removed = (xy) => xy.includes('D');

/**
 * What a save would take: { count (every change), files (the first few that go up), more, all (every path that goes up,
 * for the full list), removed (paths only deleted here: the save takes them off the server too), secret (paths that
 * look like a key or a password, or too large to check: a save refuses; a removal never), secretTracked (those of them
 * git keeps already), secretLarge (those too large to check),
 * secretAdvice (what to do with them, for the sheet), repo, ahead, behind, upstream, elsewhere (not linked and the
 * server keeps the brain on other branches only: why a press cannot link it, and what to ask), seen (the whole list's
 * fingerprint, for the press) }; read only.
 */
export const brainChanges = async (o = {}) => (await lookAt(o)).view;

/** brainChanges' answer (`view`), with every path that goes up as a file (`files`) and every one only removed (`gone`). */
async function lookAt({ dir = workspaceDir(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) throw fail(409, 'the AI brain is not in git yet');
  const [st, remote, s] = await Promise.all([
    // No renames: a renamed file is its new path that goes up and its old one taken off, as the staged list says them
    // after the press (checkStaged compares the two).
    gitRead(brain, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', ...MINE], { run }),
    gitRead(brain, ['config', '--get', 'remote.origin.url'], { run }),
    repoInfo(brain, run),
  ]);
  if (!st.ok) throw fail(409, 'git could not read the AI brain');
  const brainLeaves = leaves(brain, brain, { dir, projects: projectsIn() });
  const entries = statusEntries(st.stdout);
  const judged = entries.filter((e) => !removed(e.xy));
  // What goes to the server as a file, and what is taken off it (a path with only a removal): said apart on the sheet.
  const files = [...new Set(judged.map((e) => e.path))];
  const up = new Set(files);
  const gone = [...new Set(entries.filter((e) => removed(e.xy) && !up.has(e.path)).map((e) => e.path))];
  const paths = files;
  const found = await checkPaths(brain, paths);
  const large = found.large;
  const secret = paths.filter((f) => found.secret.includes(f) || large.includes(f));
  // The ones git keeps already: a .gitignore does not apply to them, so the advice differs (secretWords).
  const tracked = new Set(judged.filter((e) => e.xy !== '??').map((e) => e.path));
  // Not linked, and the server (as the last fetch saw it) keeps the brain on other branches only: the press would
  // refuse (linkBranch), so the sheet says why first and offers nothing to press.
  const repo = remote.ok && remote.stdout.trim() ? repoWords(remote.stdout) : null;
  let elsewhere = null;
  if (repo && s.ok && !s.upstream && s.branch && s.branch !== '(detached)') {
    const names = await serverBranches(brain, run);
    if (names && names.length && !names.includes(s.branch)) elsewhere = otherBranchWords(s.branch, names, repo);
  }
  const view = {
    count: files.length + gone.length, files: files.slice(0, SHOWN), more: Math.max(0, files.length - SHOWN), all: files.slice(0, LISTED),
    removed: gone.slice(0, LISTED),
    secret, secretTracked: secret.filter((f) => tracked.has(f)), ...(large.length ? { secretLarge: large } : {}),
    ...(secret.length ? { secretAdvice: secretWays(secret, secret.filter((f) => tracked.has(f)), large) } : {}),
    // Move out only where Hoprig may act: a brain folder that is a link to another place (not one the owner named as
    // his) gets no button that could only fail; the sheet says why instead.
    ...(secret.length && !brainLeaves ? { movedOut: movedOutDir(brain), moveSeen: refusedSeen(secret) } : {}),
    ...(secret.length && brainLeaves ? { brainIsLink: true } : {}),
    repo, ...(elsewhere ? { elsewhere } : {}),
    // What the sheet shows, as one value the press sends back: a file that came after it was opened is never saved
    // unnamed (saveBrain refuses when the list differs).
    seen: crypto.createHash('sha256').update(JSON.stringify([files.slice().sort(), gone.slice().sort()])).digest('hex'),
    ahead: s.ok ? s.ahead : 0, behind: s.ok ? s.behind : 0, upstream: s.ok ? s.upstream || null : null,
  };
  return { view, files, gone };
}

/** What to do with files that look like a key (`list`), `tracked` of them kept by git already: a .gitignore does
 * nothing for those; `large` of them too large to check. One sentence per kind; with more than one kind each sentence
 * names its files. The sheet gets it with the list (secretAdvice), so the page and the refusal say the same. */
export function secretWays(list, tracked = [], large = []) {
  const big = list.filter((f) => large.includes(f));
  const kept = list.filter((f) => tracked.includes(f) && !large.includes(f));
  const loose = list.filter((f) => !tracked.includes(f) && !large.includes(f));
  const kinds = [big, kept, loose].filter((l) => l.length).length;
  const it = (l) => (l.length === 1 ? 'it' : 'them');
  const names = (l) => `${l.slice(0, SHOWN).join(', ')}${l.length > SHOWN ? ` and ${l.length - SHOWN} more` : ''}`;
  const lead = (l, verb) => (kinds > 1 ? `For ${names(l)}: ${verb}` : `${verb[0].toUpperCase()}${verb.slice(1)}`);
  return [
    // The way through is always a press or a sentence to his coding tool; a file's name in .gitignore comes second.
    big.length ? `${lead(big, 'ask')} your coding tool in a session to move ${it(big)} out of the AI brain: a file over ${CHECK_MAX >> 20} MB is too large to check for a key.` : '',
    loose.length ? `${lead(loose, 'ask')} your coding tool in a session to move ${it(loose)} out of the AI brain (naming ${it(loose)} in the AI brain's .gitignore works too).` : '',
    kept.length ? `${lead(kept, 'take')} the key or password out of ${it(kept)}, or ask your coding tool in a session to move ${it(kept)} out of the AI brain (a .gitignore alone does nothing for a file that was saved before).` : '',
  ].filter(Boolean).join(' ');
}

/** The refusal for files that look like a key or a password, or are too large to check: named, and what to do. */
export const secretWords = (list, tracked = [], large = []) => {
  const what = list.every((f) => large.includes(f)) ? `${list.length === 1 ? 'is' : 'are'} too large to check for a key`
    : `${list.length === 1 ? 'looks' : 'look'} like a key or a password${large.length ? ', or too large to check' : ''}`;
  return `Nothing was saved or uploaded: ${list.slice(0, SHOWN).join(', ')}${list.length > SHOWN ? ` and ${list.length - SHOWN} more` : ''} ${what}. ${secretWays(list, tracked, large)} Then save again.`;
};

/** Why an upload did not happen, in the page's words (the sync engine's reasons name git's own terms). */
export function uploadWords(why, repo) {
  const w = String(why || '');
  if (/^push failed: /.test(w)) return `${repo} refused the upload (${w.slice('push failed: '.length)})`;
  if (/^fetch failed: /.test(w)) return `${repo} could not be reached (${w.slice('fetch failed: '.length)})`;
  if (/no upstream/.test(w)) return 'the AI brain here is not linked to its copy on the git server';
  if (/both moved/.test(w)) return `it was changed here and on ${repo}: Sync on the Workspace page says what to do`;
  return w;
}

/** The server's branches as the last fetch left them (refs/remotes/origin/*), or null when git could not read them. */
async function serverBranches(brain, run) {
  const refs = await gitRead(brain, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'], { run });
  if (!refs.ok) return null;
  return refs.stdout.split('\n').map((l) => l.trim().replace(/^refs\/remotes\/origin\//, '')).filter((n) => n && n !== 'HEAD');
}

/** Why a press cannot link the brain on `branch` when the server keeps it on `names` only; what to ask instead. */
export const otherBranchWords = (branch, names, repo) => `the AI brain here is on "${branch}", and ${repo} keeps it on ${names.slice(0, 3).map((n) => `"${n}"`).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}. Ask your coding tool in a session to move the AI brain here onto the server's branch, then open this again.`;

/**
 * Link the brain's branch here to its copy on the git server: fetch, then follow the server's branch of the same name
 * when there is one (→ null: the usual get and save follow); when the server has no branch at all → the branch's name
 * (it is uploaded with -u later); a server with other branches only: refused, nothing done.
 */
async function linkBranch(brain, at, repo, run, onLine) {
  const s = await repoInfo(brain, run);
  if (!s.ok) throw fail(409, 'git could not read the AI brain');
  // A detached or odd head cannot be linked by a press: said, nothing done.
  if (!BRANCH_RE.test(s.branch || '') || s.branch === '(detached)') throw fail(409, 'the AI brain here is not on a branch that can be linked, so nothing was done: your coding tool can sort it out, ask it in a session');
  onLine(`Linking the AI brain here to its copy on ${repo}…`);
  const f = await gitIn(at, brain, ['fetch', '--prune', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (!f.ok) throw fail(409, `Nothing was done: ${uploadWords(`fetch failed: ${(f.stderr || '').trim().split('\n').pop() || 'git fetch failed'}`, repo)}`);
  const there = await gitRead(brain, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${s.branch}`], { run });
  if (!there.ok) {
    // Only a server with no branch at all gets his branch as a new one: one that keeps the brain under another name
    // (main, where this one is master) would get a second branch, and the two computers would drift apart on them.
    const names = await serverBranches(brain, run);
    if (!names) throw fail(409, 'git could not read the AI brain');
    if (!names.length) return s.branch;
    throw fail(409, `Nothing was done: ${otherBranchWords(s.branch, names, repo)}`);
  }
  const u = await gitIn(at, brain, ['branch', '--quiet', `--set-upstream-to=origin/${s.branch}`], run);
  if (!u.ok) throw fail(409, `the AI brain could not be linked: ${(u.stderr || '').trim().split('\n').pop() || 'git failed'}`);
  onLine(`Linked to ${repo}`);
  return null;
}

const CHANGED = 'Nothing was saved or uploaded: the files changed since you opened this. Open it again to see what goes.';

/**
 * What the commit takes, read from git after staging, against what was checked before the fetch (`before`: lookAt's
 * files and gone). A session may write a file at any moment of a press, and the fetch between the first check and the
 * staging is a network call of seconds. Throws a plain 409 when a staged file looks like a key or is too large to
 * check, when a staged path is not one the sheet named in the same way (a file to go up among its files, a removal
 * among its removals), or when a staged file changed on disk again after it was staged (the content checked is then
 * not the content committed). A new file the sheet named that is gone again is no refusal: it is simply not staged.
 */
async function checkStaged(brain, before, run) {
  const d = await gitRead(brain, ['diff', '--cached', '--name-status', '-z', '--no-renames', ...MINE], { run });
  if (!d.ok) throw fail(409, 'git could not read the AI brain');
  const parts = d.stdout.split('\0');
  const staged = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) staged.push({ st: parts[i], path: parts[i + 1] });
  const up = staged.filter((e) => e.st !== 'D').map((e) => e.path);
  const off = staged.filter((e) => e.st === 'D').map((e) => e.path);
  const found = await checkPaths(brain, up);
  const no = up.filter((f) => found.secret.includes(f) || found.large.includes(f));
  if (no.length) throw fail(409, secretWords(no, staged.filter((e) => e.st === 'M' || e.st === 'T').map((e) => e.path), found.large));
  const files = new Set(before.files);
  const gone = new Set(before.gone);
  if (up.some((f) => !files.has(f)) || off.some((f) => !gone.has(f))) throw fail(409, CHANGED);
  const w = await gitRead(brain, ['diff', '--name-only', '-z', '--no-renames', ...MINE], { run });
  if (!w.ok) throw fail(409, 'git could not read the AI brain');
  const again = new Set(w.stdout.split('\0').filter(Boolean));
  if (up.some((f) => again.has(f))) throw fail(409, CHANGED);
}

/**
 * Save and upload, as the owner's job: `onLine` gets each step; `seen`: the fingerprint of the list his sheet showed
 * (brainChanges), refused when the changes are no longer those. → { ok: true, saved, uploaded }; throws a plain 409.
 */
export async function saveBrain({ dir = workspaceDir(), run = capture, onLine = () => {}, seen } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) throw fail(409, 'the AI brain is not in git yet');
  const at = { dir, projects: projectsIn(), root: brain };
  const look = await lookAt({ dir, run });
  const before = look.view;
  if (before.secret.length) throw fail(409, secretWords(before.secret, before.secretTracked, before.secretLarge || []));
  if (seen !== undefined && seen !== before.seen) throw fail(409, CHANGED);
  if (!before.repo) throw fail(409, 'the AI brain is not on a git server yet: Get started\'s Git and GitHub step does that');
  const fresh = before.upstream ? null : await linkBranch(brain, at, before.repo, run, onLine); // its branch, new there
  onLine(`Getting what is new on ${before.repo}…`);
  await syncRepo(brain, '.', run, { push: false, root: brain, at });
  const s = await repoInfo(brain, run);
  if (!s.ok) throw fail(409, 'git could not read the AI brain');
  if (s.ahead && s.behind) throw fail(409, `The AI brain was changed here and on ${before.repo} (${plural(s.behind, 'change')} there you do not have here). Nothing was saved or uploaded, so nothing is lost: Sync on the Workspace page says what to do.`);
  if (s.behind) throw fail(409, `${before.repo} has ${plural(s.behind, 'newer change')} that touch the same files as yours here. Nothing was saved or uploaded: Sync on the Workspace page says what to do.`);
  let saved = 0;
  if (s.changes) {
    // Never a private folder, also one staged by hand before (stageMine); the commit names no paths, so a file he
    // took out of git stays out and only its removal goes up. What is staged is checked again (checkStaged); on a
    // refusal the staging is put back as it was (the index as a tree, written before), also what he staged by hand.
    const kept = await gitIn(at, brain, ['write-tree'], run);
    const tree = kept.ok ? kept.stdout.trim() : '';
    const a = await stageMine(at, brain, run);
    if (!a.ok) throw fail(409, `the files could not be saved: ${(a.stderr || '').trim().split('\n').pop() || 'git add failed'}`);
    try {
      await checkStaged(brain, look, run);
    } catch (e) {
      await gitIn(at, brain, /^[0-9a-f]{40,64}$/.test(tree) ? ['read-tree', tree] : ['reset', '-q'], run);
      throw e;
    }
    const c = await gitIn(at, brain, ['commit', '--quiet', '-m', SAVE_MESSAGE], run);
    if (!c.ok) throw fail(409, `the files could not be saved: ${(c.stderr || c.stdout || '').trim().split('\n').pop() || 'git commit failed'}`);
    saved = s.changes;
    onLine(`Saved ${plural(saved, 'file')} in the AI brain's history`);
  }
  onLine(`Uploading to ${before.repo}…`);
  if (fresh) {
    // A branch the server does not have yet: it goes there, and the two stay linked from now on.
    const p = await gitIn(at, brain, ['push', '--quiet', '-u', 'origin', fresh], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (!p.ok) throw fail(409, `${saved ? 'Saved here, but not uploaded' : 'Not uploaded'}: ${uploadWords(`push failed: ${(p.stderr || '').trim().split('\n').pop() || 'git push failed'}`, before.repo)}`);
    onLine(`Uploaded to ${before.repo}; the AI brain here is linked to it`);
    return { ok: true, saved, uploaded: true, linked: true };
  }
  const up = await syncRepo(brain, '.', run, { push: true, root: brain, at });
  const left = up.todo.filter((t) => !/uncommitted/.test(t.why));
  if (left.length) throw fail(409, `${saved ? 'Saved here, but not uploaded' : 'Not uploaded'}: ${left.map((t) => uploadWords(t.why, before.repo)).join('; ')}`);
  const pushed = up.did.find((d) => /^pushed/.test(d));
  onLine(pushed ? `Uploaded to ${before.repo}` : `${before.repo} has everything already`);
  return { ok: true, saved, uploaded: Boolean(pushed) };
}
