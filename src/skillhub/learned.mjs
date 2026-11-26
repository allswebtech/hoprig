// Drafts of learned skills, and the owner's three presses: Install, Discard, Undo.
//
// A draft is made from a look's answer (learnlook.mjs) and lands in quarantine in Hoprig's state folder,
// <state>/skillhub/learned/drafts/<id>/ (draft.json, and skill/SKILL.md), never in a skills folder. It goes through
// the draft scan (learnscan.mjs). A draft the scan marks risky cannot be installed at all.
//
// Install puts the one SKILL.md into the AI brain's skills folder and makes ONE commit of that file alone, the way
// Hoprig saves the brain (src/workspace/upkeep.mjs commitMap): under the brain's lock (src/work/lock.mjs, shared with
// a save of Work and the upkeep), never while the brain has staged changes, never over a change of the owner's in
// that skill, never pushed, never in the middle of a git operation of the owner's. Undo is a `git revert` of that
// commit (nothing is deleted: the commit stays in the history, and a new skill's text is also kept in
// <state>/skillhub/learned/archive/). Discard removes the draft and keeps only its idea's key, so it is not offered
// again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { RUN_ID_RE } from '../work/runs.mjs';
import { capture } from '../setup/system.mjs';
import { withLock, takeRepoLock } from '../work/lock.mjs';
import { gitIn } from '../workspace/inside.mjs';
import { brainDir, isGitRepo } from '../workspace/layout.mjs';
import { folderDiff } from './diff.mjs';
import { parseFrontMatter } from './frontmatter.mjs';
import { HOPRIG_LEARNED, addDeclined, learnDir } from './learnset.mjs';
import { scanDraft } from './learnscan.mjs';
import { readManifest, safeName, sha256 } from './store.mjs';
import { replaceFile } from '../replacefile.mjs';

export const STOP_ENV = 'HOPRIG_TEST_LEARN_STOP_AFTER'; // tests: "tmp", "write", "add" or "commit" stops an install there
const ID_RE = /^[a-f0-9]{24}$/;
const DRAFTS_KEPT = 200;
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const draftsRoot = () => path.join(learnDir(), 'drafts');
const draftDir = (id) => {
  if (!ID_RE.test(String(id || ''))) throw fail(400, 'that is not a draft');
  return path.join(draftsRoot(), id);
};
const draftFile = (id) => path.join(draftDir(id), 'draft.json');

export { scanDraft };

// ---------- the brain's skills ----------

const brainOf = (o = {}) => o.brain || brainDir();
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** The brain's skills folder, when it is a real folder inside the brain (a link that leads out is refused). */
function skillsDirOf(brain) {
  const dir = path.join(brain, 'skills');
  const st = lstat(dir);
  if (st && st.isSymbolicLink()) throw fail(409, 'the AI brain\'s skills folder is a link; learned skills go only into a real folder', 'skills-link');
  if (st && !st.isDirectory()) throw fail(409, 'the AI brain\'s skills is not a folder', 'skills-not-folder');
  const rb = real(brain);
  if (st && (!rb || !real(dir).startsWith(rb + path.sep))) throw fail(409, 'the AI brain\'s skills folder is not inside the brain', 'skills-outside');
  return dir;
}

/**
 * The owner's own skills in the brain that a look may change: a real folder (not a link) whose SKILL.md is a file
 * kept in git with no change waiting, and not one Hoprig installed from a source (the bundled skill, a catalog
 * one). → [{ name, description }]. Nothing when the brain is not a git repository.
 */
export async function ownSkills(o = {}) {
  const brain = brainOf(o);
  const run = o.run || capture;
  if (!isGitRepo(brain)) return [];
  let dir;
  try {
    dir = skillsDirOf(brain);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tracked = await gitRead(brain, ['ls-files', '-z', '--', 'skills'], { run });
  const dirty = await gitRead(brain, ['status', '--porcelain', '-z', '--untracked-files=all', '--', 'skills'], { run });
  if (!tracked.ok || !dirty.ok) return [];
  const kept = new Set(tracked.stdout.split('\0').filter(Boolean));
  const changed = dirty.stdout.split('\0').filter(Boolean).map((l) => l.slice(3));
  const fromSource = readManifest(dir).skills;
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !safeName(e.name) || e.name === 'hoprig' || fromSource[e.name]) continue;
    const rel = `skills/${e.name}/SKILL.md`;
    const st = lstat(path.join(dir, e.name, 'SKILL.md'));
    if (!st || !st.isFile() || !kept.has(rel) || changed.some((c) => c === rel || c.startsWith(`skills/${e.name}/`))) continue;
    const fm = parseFrontMatter(fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'));
    out.push({ name: e.name, description: String(fm.data.description || '').replace(/\s+/g, ' ').slice(0, 300) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a lesson about using Hoprig goes (learnlook.mjs lessonOf): null when the brain is not a git repository (no
 * learned skill can be saved), { body: null } when hoprig-learned is not there yet, { body } when it is one of `own`
 * (ownSkills(): kept in git, no change waiting), else { blocked: true }.
 */
export function hoprigLearnedPlace(own, o = {}) {
  const brain = brainOf(o);
  if (!isGitRepo(brain)) return null;
  let dir;
  try {
    dir = skillsDirOf(brain);
  } catch {
    return null;
  }
  const folder = path.join(dir, HOPRIG_LEARNED);
  if (!lstat(folder)) return { body: null };
  if (!own.some((s) => s.name === HOPRIG_LEARNED)) return { blocked: true };
  return { body: parseFrontMatter(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8')).body.trim() };
}

// ---------- drafts ----------

function writeDraft(d) {
  const tmp = `${draftFile(d.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
  replaceFile(tmp, draftFile(d.id));
}

export function readDraft(id) {
  try {
    return JSON.parse(fs.readFileSync(draftFile(id), 'utf8'));
  } catch (e) {
    if (e.status) throw e;
    throw fail(404, 'that draft is gone (discarded, or never made)', 'gone');
  }
}

/**
 * The SKILL.md of a new learned skill: our own front matter (name, description, where it came from) and the body. It
 * is committed into the brain, so "where it came from" is the run's id only (a time and a random part): the task's id
 * is made from its title, which may name a person, a host or a customer. The title stays in draft.json, in the state
 * folder.
 */
function newSkillMd(p, source, now) {
  const from = RUN_ID_RE.test(String(source && source.run)) ? `work run ${source.run}` : 'work';
  return ['---', `name: ${p.name}`, `description: ${JSON.stringify(p.description)}`, 'metadata:', '  learned-by: hoprig',
    `  learned-from: ${JSON.stringify(from)}`, `  learned-on: "${new Date(now).toISOString().slice(0, 10)}"`, '---', '', p.body, ''].join('\n');
}

/**
 * Make a draft from a parsed look (kind new or patch). `source`: { run, item, title, trigger, words }; `cost`:
 * { usd, tokens }. → the draft (state "trying": its test requests are tried next; "ready" for a draft no model made, which
 * has no test requests to try).
 */
export function makeDraft(p, { source, cost = null, brain = brainDir(), now = Date.now(), state = 'trying' } = {}) {
  let skillMd;
  let before = null;
  if (p.kind === 'patch') {
    const file = path.join(skillsDirOf(brain), p.target, 'SKILL.md');
    before = fs.readFileSync(file, 'utf8');
    const fm = parseFrontMatter(before);
    if (!fm.ok) throw fail(409, `the skill "${p.target}" has no front matter to keep`);
    skillMd = `---\n${fm.raw}\n---\n\n${p.body}\n`;
  } else skillMd = newSkillMd(p, source, now);
  const id = crypto.randomBytes(12).toString('hex');
  const dir = draftDir(id);
  fs.mkdirSync(path.join(dir, 'skill'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'skill', 'SKILL.md'), skillMd, { mode: 0o600 });
  const scan = scanDraft(path.join(dir, 'skill'), skillMd, { before });
  const entry = (t) => ({ 'SKILL.md': { sha256: sha256(Buffer.from(t)), text: t } });
  const d = {
    v: 1, id, createdAt: new Date(now).toISOString(), state, kind: p.kind,
    name: p.kind === 'patch' ? p.target : p.name, description: p.kind === 'new' ? p.description : String(parseFrontMatter(before).data.description || ''),
    why: p.why, body: p.body, source, skillMd, sha: sha256(Buffer.from(skillMd)), before, beforeSha: before === null ? null : sha256(Buffer.from(before)),
    diff: folderDiff(before === null ? {} : entry(before), entry(skillMd)), ...scan,
    tests: p.tests.map((prompt) => ({ prompt, without: null, with: null })), cost, installed: null, undone: null,
    ...(typeof p.lesson === 'string' ? { lesson: p.lesson } : {}), // a lesson about Hoprig: its idea when discarded
  };
  writeDraft(d); // counted for the week's drafts by the look that made it (learnset.mjs settleLook)
  prune();
  return d;
}

// A draft still "trying" this long after it was made was stopped by the dashboard (the tries take minutes at most).
export const STALE_TRYING_MS = 15 * 60_000;
const NOT_TRIED = '(not tried: the dashboard stopped)';

/** The draft as it is to be read: one stopped while trying is ready, its tries not made said so. Writes nothing. */
export function settledView(d, now = Date.now()) {
  if (!d || d.state !== 'trying' || now - Date.parse(d.createdAt) < STALE_TRYING_MS) return d;
  return { ...d, state: 'ready', tests: d.tests.map((t) => ({ ...t, without: t.without || NOT_TRIED, with: t.with || NOT_TRIED })) };
}

/** Change a draft under its lock: fn(draft) → the new draft (written) or undefined (nothing written). */
export function changeDraft(id, fn) {
  return withLock(draftFile(id), async () => {
    const d = readDraft(id);
    const next = await fn(d);
    if (next) writeDraft(next);
    return next || d;
  });
}

/** Every draft, newest first. */
export function listDrafts() {
  let ids;
  try {
    ids = fs.readdirSync(draftsRoot()).filter((n) => ID_RE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    try {
      out.push(readDraft(id));
    } catch {
      /* half made: left out */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep at most DRAFTS_KEPT drafts: the oldest undone ones go first (an installed one keeps its Undo). */
function prune() {
  const all = listDrafts();
  const over = all.length - DRAFTS_KEPT;
  if (over <= 0) return;
  for (const d of all.filter((x) => x.state === 'undone').reverse().slice(0, over)) fs.rmSync(draftDir(d.id), { recursive: true, force: true });
}

// ---------- Install and Undo ----------

const stop = (step) => {
  if (process.env[STOP_ENV] === step) throw fail(500, `stopped after ${step} (test)`);
};
const marker = (id) => `(draft ${id})`;

async function commitWith(brain, run, id) {
  const r = await gitRead(brain, ['log', '-n', '50', `--grep=${marker(id)}`, '--format=%H'], { run });
  return r.ok ? r.stdout.trim().split('\n').filter(Boolean)[0] || null : null;
}

/** git's own reason from a failed command: its last lines, or a plain word when it gave none. */
const gitWhy = (r) => {
  const lines = `${(r && r.stderr) || ''}\n${(r && r.stdout) || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-2).join(' ').slice(0, 300) : 'git gave no reason (a hook of the brain may have refused it)';
};

// A git operation the owner has begun, by the file git keeps for it: his to finish, never ours to commit into or end.
const MIDWAY = [['sequencer', 'a revert or cherry-pick of several commits'], ['REVERT_HEAD', 'a revert'], ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase']];

/** Refused while the brain is in the middle of a git operation, or not on a branch. `what`: the end of the sentence ("nothing was …"). */
async function brainReady(brain, run, what) {
  const gd = await gitRead(brain, ['rev-parse', '--absolute-git-dir'], { run });
  if (!gd.ok) throw fail(409, `git could not read the AI brain: ${gitWhy(gd)}`, 'git');
  // A commit on a detached HEAD lands on no branch: it drops out of sight when he checks his branch out again.
  const branch = await gitRead(brain, ['symbolic-ref', '-q', 'HEAD'], { run });
  if (!branch.ok) throw fail(409, `the AI brain is not on a branch (a detached HEAD): check its branch out first; ${what}`, 'detached');
  const m = MIDWAY.find(([n]) => fs.existsSync(path.join(gd.stdout.trim(), n)));
  if (m) throw fail(409, `the AI brain is in the middle of ${m[1]}: finish it first (in a terminal), then press it again; ${what}`, 'midway');
}

async function noStaged(brain, run) {
  const staged = await gitRead(brain, ['diff', '--cached', '--quiet'], { run });
  if (!staged.ok) throw fail(409, 'the AI brain has staged changes: commit or unstage them first; nothing was changed', 'staged');
}

// A temporary file of an install, in the skill's folder until it is renamed into place: named by the draft, so a
// later press knows it as this draft's own.
const tmpName = (id) => `.SKILL.md.${id}.tmp`;

/**
 * Take back what an install of draft `d` left in the brain without its commit (stopped, or refused by git): its file
 * unstaged when the index holds exactly its text, its temporary file, a new skill's file when it is this draft's
 * text and not kept in git (and the folder when that leaves it empty), a changed skill's text from HEAD when the file
 * holds this draft's text. Nothing else is touched. Called under the brain's lock.
 */
async function takeBack(d, brain, run) {
  const at = { root: brain, dir: path.dirname(brain) };
  const rel = `skills/${d.name}/SKILL.md`;
  const target = path.join(skillsDirOf(brain), d.name);
  const file = path.join(target, 'SKILL.md');
  const staged = await gitRead(brain, ['diff', '--cached', '--name-only', '--', rel], { run });
  if (staged.ok && staged.stdout.trim()) {
    const blob = await gitRead(brain, ['show', `:${rel}`], { run });
    if (blob.ok && blob.stdout === d.skillMd) await gitIn(at, brain, ['reset', '-q', '--', rel], run);
  }
  const tmp = path.join(target, tmpName(d.id));
  if (lstat(tmp)) fs.rmSync(tmp, { force: true });
  // A new skill's folder that this install made and that holds nothing now goes too.
  const emptyFolder = () => {
    const ts = lstat(target);
    if (d.kind === 'new' && ts && ts.isDirectory() && !fs.readdirSync(target).length) fs.rmdirSync(target);
  };
  const st = lstat(file);
  if (!st || !st.isFile() || fs.readFileSync(file, 'utf8') !== d.skillMd) return emptyFolder();
  const kept = await gitRead(brain, ['ls-files', '--error-unmatch', '--', rel], { run });
  if (d.kind === 'new' && !kept.ok) {
    fs.rmSync(file);
    emptyFolder();
  } else if (d.kind === 'patch' && kept.ok) {
    const head = await gitRead(brain, ['show', `HEAD:${rel}`], { run });
    if (head.ok && sha256(Buffer.from(head.stdout)) === d.beforeSha) await gitIn(at, brain, ['checkout', 'HEAD', '--', rel], run);
  }
}

/**
 * A draft left "installing" (the dashboard stopped, or git refused): its commit there → it is installed; else what it
 * left is taken back and it is ready again. → the draft as it is now. Called under the draft's and the brain's lock.
 */
async function settleInstalling(d, brain, run) {
  if (d.state !== 'installing') return d;
  const done = await commitWith(brain, run, d.id);
  if (done) return finish(d, done).draft;
  await takeBack(d, brain, run);
  const next = { ...d, state: 'ready' };
  writeDraft(next);
  return next;
}

/** Discard: the draft goes, and its idea is not offered again. One stopped while installing is taken back first. */
export async function discard(id, o = {}) {
  const brain = brainOf(o);
  const run = o.run || capture;
  return withLock(draftFile(id), async () => {
    let cur = readDraft(id);
    if (cur.state === 'installing' && isGitRepo(brain)) {
      const release = await takeRepoLock(brain, { who: 'learn', ...(o.repoWait === undefined ? {} : { wait: o.repoWait }) });
      try {
        cur = await settleInstalling(cur, brain, run);
      } finally {
        release();
      }
    }
    if (cur.state === 'installed' || cur.state === 'installing') throw fail(409, 'that draft is installed: use Undo', 'installed');
    addDeclined(cur);
    fs.rmSync(draftDir(id), { recursive: true, force: true });
    return { id, discarded: true };
  });
}

/**
 * Install a ready draft: its SKILL.md into <brain>/skills/<name>/, one commit of that file. Pressed again after it
 * was stopped at any step, or after git refused the commit, it takes back what it left and starts again. →
 * { name, commit }.
 */
export async function install(id, o = {}) {
  const brain = brainOf(o);
  const run = o.run || capture;
  return withLock(draftFile(id), async () => {
    let d = settledView(readDraft(id));
    if (d.state === 'installed') throw fail(409, `"${d.name}" is installed already`, 'installed');
    if (d.state !== 'ready' && d.state !== 'installing') throw fail(409, d.state === 'trying' ? 'its test requests are still being tried' : 'that draft cannot be installed now', 'not-ready');
    if (d.risky) throw fail(409, `this draft cannot be installed: ${d.riskyWhy.join('; ')}`, 'risky');
    const text = fs.readFileSync(path.join(draftDir(id), 'skill', 'SKILL.md'), 'utf8');
    if (sha256(Buffer.from(text)) !== d.sha || text !== d.skillMd) throw fail(409, 'the draft changed after it was made; nothing was installed', 'changed');
    // The scan again, with this version's rules: a rule added since the draft was made reaches it too.
    const now = scanDraft(path.join(draftDir(id), 'skill'), text, { before: d.before });
    if (now.risky) {
      writeDraft({ ...d, ...now });
      throw fail(409, `this draft cannot be installed: ${now.riskyWhy.join('; ')}`, 'risky');
    }
    if (!isGitRepo(brain)) throw fail(409, 'the AI brain is not a git repository, so a learned skill cannot be saved in it', 'no-brain');
    const dir = skillsDirOf(brain);
    if (!safeName(d.name)) throw fail(400, 'bad skill name');
    const target = path.join(dir, d.name);
    const file = path.join(target, 'SKILL.md');
    const rel = `skills/${d.name}/SKILL.md`;
    const release = await takeRepoLock(brain, { who: 'learn', ...(o.repoWait === undefined ? {} : { wait: o.repoWait }) });
    try {
      d = await settleInstalling(d, brain, run);
      if (d.state === 'installed') return { name: d.name, commit: d.installed.commit };
      await brainReady(brain, run, 'nothing was installed');
      await noStaged(brain, run);
      const tst = lstat(target);
      if (tst && !tst.isDirectory()) throw fail(409, `skills/${d.name} is not a plain folder; nothing was changed`, 'not-folder');
      const fst = lstat(file);
      if (fst && !fst.isFile()) throw fail(409, `${rel} is not a plain file; nothing was changed`, 'not-file');
      const onDisk = fst ? fs.readFileSync(file, 'utf8') : null;
      if (d.kind === 'patch') {
        const tracked = await gitRead(brain, ['ls-files', '--error-unmatch', '--', rel], { run });
        const status = await gitRead(brain, ['status', '--porcelain', '--untracked-files=all', '--', `skills/${d.name}`], { run });
        if (!tracked.ok || onDisk === null) throw fail(409, `"${d.name}" is not a skill kept in the brain's git any more; nothing was changed`, 'not-kept');
        if (status.stdout.trim()) throw fail(409, `"${d.name}" has changes of yours not committed yet; they are left as they are and nothing was changed`, 'yours');
        if (sha256(Buffer.from(onDisk)) !== d.beforeSha) throw fail(409, `"${d.name}" changed after this draft was made; discard it, the next look starts from the new text`, 'moved');
      } else if (tst) throw fail(409, `a skill folder "${d.name}" is there already; nothing was changed`, 'taken');
      writeDraft({ ...d, state: 'installing' });
      fs.mkdirSync(target, { recursive: true });
      const tmp = path.join(target, tmpName(id));
      fs.writeFileSync(tmp, text);
      stop('tmp');
      replaceFile(tmp, file);
      stop('write');
      const at = { root: brain, dir: path.dirname(brain) };
      const msg = `Learned skill: ${d.name}\n\nMade from a Work task and installed by its owner ${marker(id)}.`;
      const add = await gitIn(at, brain, ['add', '--', rel], run);
      stop('add');
      const c = add.ok ? await gitIn(at, brain, ['commit', '--quiet', '-m', msg, '--', rel], run) : null;
      if (!add.ok || !c.ok) {
        // git refused (a hook, a broken index): what this press left is taken back, and the draft is ready again.
        await takeBack(d, brain, run);
        writeDraft({ ...d, state: 'ready' });
        throw fail(409, `git could not ${add.ok ? 'commit' : 'add'} the skill: ${gitWhy(add.ok ? c : add)}; nothing was installed`, 'git');
      }
      stop('commit');
      const { name, commit } = finish(d, await commitWith(brain, run, id));
      return { name, commit };
    } finally {
      release();
    }
  });
}

function finish(d, commit) {
  const next = { ...d, state: 'installed', installed: { commit, at: new Date().toISOString() } };
  writeDraft(next);
  return { name: d.name, commit, draft: next };
}

/** Undo an installed draft: a revert of its one commit (refused when the skill changed since). → { name, commit }. */
export async function undo(id, o = {}) {
  const brain = brainOf(o);
  const run = o.run || capture;
  return withLock(draftFile(id), async () => {
    const d = readDraft(id);
    if (d.state !== 'installed' || !d.installed || !/^[0-9a-f]{40,64}$/.test(String(d.installed.commit))) throw fail(409, 'that draft is not installed (undone already?)', 'not-installed');
    const sha = d.installed.commit;
    const rel = `skills/${d.name}`;
    const release = await takeRepoLock(brain, { who: 'learn' });
    try {
      await brainReady(brain, run, 'nothing was undone');
      await noStaged(brain, run);
      const anc = await gitRead(brain, ['merge-base', '--is-ancestor', sha, 'HEAD'], { run });
      if (!anc.ok) throw fail(409, 'the commit of this skill is not on the brain\'s branch now; nothing was undone', 'elsewhere');
      const later = await gitRead(brain, ['log', '--format=%H', `${sha}..HEAD`, '--', rel], { run });
      if (later.stdout.trim()) throw fail(409, `"${d.name}" was changed in a later commit; undo it by hand so that change is not lost`, 'changed-since');
      const status = await gitRead(brain, ['status', '--porcelain', '--untracked-files=all', '--', rel], { run });
      if (status.stdout.trim()) throw fail(409, `"${d.name}" has changes of yours not committed yet; nothing was undone`, 'yours');
      if (d.kind === 'new') {
        const keep = path.join(learnDir(), 'archive', d.id);
        fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(keep, 'SKILL.md'), d.skillMd, { mode: 0o600 });
      }
      // The revert is made without its commit, then committed as the skill's folder alone. When either fails, only what
      // this Undo began is taken back: its revert is forgotten (--quit) and the skill's folder gets HEAD's text again.
      // Never --abort: that resets the branch to where a revert began, also one that was not ours.
      const at = { root: brain, dir: path.dirname(brain) };
      const r = await gitIn(at, brain, ['revert', '--no-commit', sha], run);
      const msg = `Revert "Learned skill: ${d.name}"\n\nThis reverts commit ${sha}, as its owner pressed Undo ${marker(id)}.`;
      const c = r.ok ? await gitIn(at, brain, ['commit', '--quiet', '-m', msg, '--', rel], run) : null;
      if (!r.ok || !c.ok) {
        await gitIn(at, brain, ['revert', '--quit'], run);
        await gitIn(at, brain, ['checkout', 'HEAD', '--', rel], run);
        throw fail(409, `git could not ${r.ok ? 'commit the revert' : 'revert it'}: ${gitWhy(r.ok ? c : r)}; nothing was undone`, 'git');
      }
      const head = await gitRead(brain, ['rev-parse', 'HEAD'], { run });
      writeDraft({ ...d, state: 'undone', undone: { commit: head.stdout.trim(), at: new Date().toISOString() } });
      return { name: d.name, commit: head.stdout.trim() };
    } finally {
      release();
    }
  });
}

