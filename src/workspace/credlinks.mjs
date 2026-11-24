// Credential links (docs/WORKSPACE.md, "Credentials"): which file or folder of <workspace>/credentials a project sees,
// and under which name. The list is the project's own project.json:
//
//   "credentials": { "code/shop/.env.local": "shop/shop.env.local" }
//
// the key is where the link is, relative to the project; the value is what it points at, relative to the credentials
// folder (both checked strictly by pcsetup/workspace.mjs checkCredLinks). A link is made by a fresh clone's finish
// step (finish.mjs: hoprig get, restore --with-projects, project setup) and by `hoprig workspace link`, never anything
// else, and only where it is safe:
//   - in a place git ignores (asked of the repository that holds the place); a tracked place, or one not ignored, is
//     refused with the line for that repository's .gitignore (a commit would carry the link, and a later edit through
//     it would carry the key);
//   - never over anything: a real file or folder there is named and left, a link that points elsewhere is reported and
//     left, a link that points at the right target is left as it is;
//   - only to a target that is there, really inside the credentials folder (no link on the way to it leads out): no
//     link to nothing, nothing ever written into the credentials folder, nothing replaced by an empty file;
//   - when the credentials are not here (no folder, an empty one, set-up's starting folder, a cut-off clone:
//     credentialsHere), each link is "waiting for the credentials" and is made by the next get or workspace link.
// What is said names the place and the target as project.json names them, never anything else in the credentials
// folder and never a content.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { credLinkIn, inGitFolder, kindAt, leaves, realOf } from './inside.mjs';
import { isDir, isGitRepo, workspaceDir } from './layout.mjs';
import { CREDENTIALS_README } from './setup.mjs';

export const credsDir = (dir = workspaceDir()) => path.join(dir, 'credentials');

// state → [kind for status, words]
const STATES = {
  ok: ['ok', 'linked'],
  make: ['missing', 'not linked yet'],
  made: ['ok', 'linked now'],
  waiting: ['waiting', 'waiting for the credentials (the credentials folder is not here): the next hoprig get or hoprig workspace link makes it'],
  nofolder: ['waiting', 'waiting: the folder it goes in is not here yet (a repository not cloned?)'],
  broken: ['broken', 'broken: its target is not in the credentials folder'],
  'no-target': ['broken', 'not made: its target is not in the credentials folder'],
  wrong: ['refused', 'left as it is: a link there points elsewhere'],
  open: ['refused', 'linked, but in a place git does not ignore: a commit could carry it (the link is left as it is)'],
  'in-the-way': ['refused', 'not made: something that is not this link is there, and nothing is ever replaced'],
  refused: ['refused', 'refused'],
};
export const kindOf = (state) => STATES[state][0];

/** The credentials folder `workspace setup` makes, untouched: its README with setup's text and nothing else. */
export function untouchedCredentials(cdir) {
  try {
    return fs.lstatSync(cdir).isDirectory() && fs.readdirSync(cdir).join('\n') === 'README.md' && fs.lstatSync(path.join(cdir, 'README.md')).isFile() && fs.readFileSync(path.join(cdir, 'README.md'), 'utf8') === CREDENTIALS_README;
  } catch {
    return false;
  }
}

// What is said or returned names paths as project.json does, relative to the project (or to the workspace for the
// credentials folder), never the computer's own path: `base` is the folder they are relative to.
function relName(base, p) {
  for (const b of [base, realOf(base)]) {
    if (!b) continue;
    const r = path.relative(b, p);
    if (!path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`)) return r.split(path.sep).join('/');
  }
  return null;
}
/** leaves()'s answer in words, with the path relative to `base` (`prefix` before it: "credentials/"). */
const leftWords = (b, base, prefix = '') => {
  const r = relName(base, b.path);
  const where = r === null ? 'a folder outside it' : r === '' ? prefix.replace(/\/$/, '') || 'the project' : `${prefix}${r}`;
  return `${where} ${b.what}${b.now ? ' (your own link, but it points elsewhere now)' : ''}`;
};

/** Is there a .git (a folder, a file, a link) in `d` or a folder above it, up to the project's root `root`? */
function gitOnTheWay(root, d) {
  const top = path.resolve(root);
  for (let x = path.resolve(d); ; x = path.dirname(x)) {
    if (kindAt(path.join(x, '.git')) !== 'none') return true;
    if (x === top || path.dirname(x) === x || path.relative(top, x).startsWith('..')) return false;
  }
}

/** The place a git repository must ignore, asked of the repository that holds it. → '' | { why, fix? } */
async function notIgnored(root, link, run) {
  const d = path.dirname(link);
  const top = await gitRead(d, ['rev-parse', '--show-toplevel'], { run, timeout: 20_000 });
  if (!top.ok) {
    // In no git repository only when git says exactly that and no .git is on the way up to the project: a broken
    // setting, a .git that points nowhere, a refused read or a time-out may hide a repository that would commit it.
    if (/not a git repository/i.test(`${top.stderr || ''}`) && !gitOnTheWay(root, d)) return '';
    return { why: /must be run in a work tree/i.test(`${top.stderr || ''}`) ? 'it is inside a git folder' : 'git could not read the repository that holds it (a broken setting, or a .git that points nowhere?), so it cannot say whether it ignores it' };
  }
  const repo = top.stdout.trim();
  const rel = path.relative(repo, path.join(realOf(d) || d, path.basename(link))).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return { why: 'git places it outside its own repository' };
  // The repository by its folder in the project: the project's own, code/shop-api, or one that holds the project.
  const inside = relName(root, repo);
  const who = inside === '' ? 'the project' : inside ? `the repository ${inside}` : 'the repository that holds the project';
  const ignoreFile = inside === '' ? "the project's .gitignore" : inside ? `${inside}/.gitignore` : 'the .gitignore of the repository that holds the project';
  const tracked = await gitRead(repo, ['ls-files', '--', rel], { run, timeout: 20_000 });
  if (!tracked.ok) return { why: 'git could not say whether it tracks it' };
  if (tracked.stdout.trim()) return { why: `${who} tracks ${rel}: a link there would be committed`, fix: `run git rm --cached -- ${rel} in ${inside ? inside : who}, then add the line /${rel} to its .gitignore` };
  const ig = await gitRead(repo, ['check-ignore', '-q', '--', rel], { run, timeout: 20_000 });
  if (ig.ok) return '';
  if (ig.code === 1) return { why: `${who} does not ignore ${rel}: a link there could be committed`, fix: `add the line /${rel} to ${ignoreFile}` };
  return { why: 'git could not say whether it ignores it' };
}

/**
 * Are the credentials in the folder `creds`? Not when it is missing, empty (what a failed clone leaves, owner-only, for
 * the next restore to clone into), the starting folder of workspace setup (its README only: restore clones over it),
 * or a clone that was cut off (a repository with no index, and nothing beside .git or a commit that was never checked
 * out in full: restore moves it aside and clones again). Read only.
 */
export async function credentialsHere(creds, run = capture) {
  let names;
  try {
    names = isDir(creds) ? fs.readdirSync(creds) : [];
  } catch {
    return false;
  }
  if (!names.length || untouchedCredentials(creds)) return false;
  const g = path.join(creds, '.git');
  if (kindAt(g) !== 'other' || kindAt(path.join(g, 'index')) !== 'none') return true; // git writes the index only once the first commit is checked out
  if (names.every((x) => x === '.git')) return false;
  return !(await gitRead(creds, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { run, timeout: 20_000 })).ok;
}

/**
 * The credential links of the project at `root`, read only: [{ place, target, state, why?, fix?, link, to }] (`link`,
 * `to`: the absolute paths, for makeCredLinks; `shown()` leaves them out). `at`: { dir, projects } of the workspace.
 */
export async function planCredLinks(root, manifest, { at = {}, run = capture } = {}) {
  const ctx = { ...at, dir: at.dir || workspaceDir() };
  const creds = credsDir(ctx.dir);
  const out = (manifest.credentialsRefused || []).map((r) => ({ place: r.place, target: r.target, state: 'refused', why: r.why }));
  const links = Object.entries(manifest.credentials || {});
  if (!links.length) return out;
  // The credentials folder itself: there, really where the workspace has it (no link on the way, unless the owner
  // named it as his own: inside.mjs).
  const credsOut = kindAt(creds) === 'none' ? null : leaves(creds, creds, ctx);
  // The credentials are not here yet, and each link waits, when the folder is missing or holds what is not them yet.
  const credsHere = !credsOut && (await credentialsHere(creds, run));
  for (const [place, target] of links) {
    const link = path.join(root, ...place.split('/'));
    const to = path.join(creds, ...target.split('/'));
    const e = { place, target, link, to };
    out.push(e);
    const pb = leaves(root, path.dirname(link), ctx);
    if (pb) {
      Object.assign(e, { state: 'refused', why: `its place: ${leftWords(pb, root)}` });
      continue;
    }
    // Nothing in a .git folder, also through a link inside the project (cfg -> .git): a hook there would run.
    if (inGitFolder(root, link)) {
      Object.assign(e, { state: 'refused', why: 'its place is inside a git folder (through a link on the way)' });
      continue;
    }
    // Inside a code repository that is not cloned yet: its own .gitignore decides, so the link waits for the clone
    // (the parent's rules say nothing about it, and a link made now would be in the clone's way).
    const holder = (manifest.repos || []).find((r) => place.toLowerCase().startsWith(`${String(r.dir).toLowerCase()}/`));
    if (holder && !isGitRepo(path.join(root, ...holder.dir.split('/')))) {
      Object.assign(e, { state: 'nofolder', why: `${holder.dir} is not cloned yet` });
      continue;
    }
    if (credsOut) {
      Object.assign(e, { state: 'refused', why: `the credentials folder: ${leftWords(credsOut, ctx.dir)}` });
      continue;
    }
    const tb = credsHere ? leaves(creds, to, ctx) : null;
    if (tb) {
      Object.assign(e, { state: 'refused', why: `its target leaves the credentials folder (${leftWords(tb, creds, 'credentials/')})` });
      continue;
    }
    const k = kindAt(link);
    if (k === 'link') {
      const now = realOf(link);
      const want = realOf(to);
      if (!now || !want || now !== want) e.state = 'wrong';
      else e.state = !credsHere ? 'waiting' : fs.existsSync(to) ? 'ok' : 'broken';
      // A right link is still asked of git: one the owner made where git does not ignore it is said, never removed.
      if (e.state === 'ok') {
        const ig = await notIgnored(root, link, run);
        if (ig) Object.assign(e, { state: 'open', ...ig });
      }
      continue;
    }
    if (k !== 'none') {
      Object.assign(e, { state: 'in-the-way', why: `${place} is a real ${k === 'file' ? 'file' : 'folder or other thing'} in the project` });
      continue;
    }
    if (!isDir(path.dirname(link))) e.state = 'nofolder';
    else if (!credsHere) e.state = 'waiting';
    else if (!fs.existsSync(to)) e.state = 'no-target'; // a link inside the folder that leads nowhere counts as missing
    else {
      const ig = await notIgnored(root, link, run);
      if (ig) Object.assign(e, { state: 'refused', ...ig });
      else e.state = 'make';
    }
  }
  return out;
}

/** Make the links a plan has as "make". Each is checked again as it is made (inside.mjs credLinkIn). → the plan */
export function makeCredLinks(root, plan, { at = {} } = {}) {
  const ctx = { ...at, dir: at.dir || workspaceDir() };
  for (const e of plan.filter((x) => x.state === 'make')) makeOne(root, e, ctx);
  return plan;
}

/** Make one planned link. → the entry, "made" or "refused" with why */
export function makeOne(root, e, ctxGiven = {}) {
  const ctx = { ...ctxGiven, dir: ctxGiven.dir || workspaceDir() };
  try {
    credLinkIn({ ...ctx, root }, e.link, e.to, credsDir(ctx.dir));
    e.state = 'made';
  } catch (err) {
    // Plain words only: a system error's own text would carry paths.
    const why = err.code === 'EEXIST' ? `${e.place} came there before the link was made: left as it is` : err.code === 'ELEAVES' ? 'it would lead out of the credentials folder' : err.code === 'EGITDIR' ? 'its place is inside a git folder' : err.code === 'ENOENT' ? 'its target is not in the credentials folder' : `the link could not be made (${err.code || 'error'})`;
    Object.assign(e, { state: 'refused', why });
  }
  return e;
}

/** A plan as it is shown or returned (--json, the dashboard): no absolute path. */
export const shownLinks = (plan) => plan.map(({ link, to, ...e }) => ({ ...e, kind: kindOf(e.state) }));

/** One line: "shop/code/shop/.env.local → credentials/shop/shop.env.local: linked". `dry`: a dry run's words. */
export function linkLine(e, ref, { dry = false } = {}) {
  const words = e.state === 'make' && dry ? 'would link' : e.state === 'refused' ? `refused: ${e.why}` : STATES[e.state][1];
  const why = e.state !== 'refused' && e.why ? ` (${e.why})` : '';
  // The one refusal for the entries past the limit names no link: no arrow between two empty paths.
  if (!e.place && !e.target) return `${ref}: credentials: ${words}${why}`;
  return `${ref}/${e.place} → credentials/${e.target}: ${words}${why}${e.fix ? `;  ${e.fix}` : ''}`;
}

/** The mark of a line: ok, warn or info. */
export const linkMark = (e) => (['ok', 'made'].includes(e.state) ? 'ok' : e.state === 'make' || kindOf(e.state) === 'waiting' ? 'info' : 'warn');

/**
 * The credential links of every project here that has a project.json: [{ ref, root, plan }] (only projects that name
 * links). For `hoprig workspace link` and status. Read only.
 */
export async function credLinksHere({ dir = workspaceDir(), projects, run = capture } = {}) {
  const [{ projectsHere }, { readManifest, MANIFEST }, { projectsIn }] = await Promise.all([import('./where.mjs'), import('../pcsetup/workspace.mjs'), import('./layout.mjs')]);
  const pdir = projects || projectsIn();
  const at = { dir, projects: pdir };
  const out = [];
  for (const f of await projectsHere({ dir, projects: pdir })) {
    if (kindAt(path.join(f.dir, MANIFEST)) !== 'file' || leaves(f.dir, f.dir, at)) continue;
    const m = await readManifest(f.dir, run);
    if (!m.manifest || (!m.manifest.credentials && !m.manifest.credentialsRefused)) continue;
    const plan = await planCredLinks(f.dir, m.manifest, { at, run });
    if (plan.length) out.push({ ref: f.ref || f.name, root: f.dir, plan });
  }
  return out;
}
