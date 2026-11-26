// Arrange (hoprig adopt apply): a project of the workspace made from a plan, by COPYING, never moving. The parent
// comes from the product's own template with the commit identity given for this command (handed to git for its own
// commits only; nothing global is set); each repository is copied WHOLE (its worktrees, stashes, uncommitted and
// untracked work, ignored files) and each neighbour to its place; then the copy is PROVED against the original
// (proof.mjs) before anything is said done. A mismatch stops there and removes only the folder this run made. The
// originals are never changed, renamed or deleted here.
//
// What comes after the proof: project.json, a table in AGENTS.md of what was where and where it is now, the first
// commit of the parent (Hoprig's own files only: what was copied stays uncommitted for the owner to look at), the
// coding tool's memory into the project's own memory folder and its conversations under the new folders' keys
// (sessions.mjs), a pointer for each other tool's skill, and what still needs the owner: the old paths in the
// copy's git settings, hooks, launch and tool files (file and line), rules files to read with him, hooks that need
// their equal, and the count of secret-shaped values in what a first push would take (never a value).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../setup/system.mjs';
import { filedProcess, system } from '../procid.mjs';
import { pathRules } from '../server/platform/common.mjs';
import { MANIFEST, builtinFiles, linkMemories, mergeInto, readManifest, writeManifest, writeTemplate } from '../pcsetup/workspace.mjs';
import { parseRepo } from '../pcsetup/projects.mjs';
import { insideOr, mkdirIn, readIn, removeIn, writeIn } from '../workspace/inside.mjs';
import { copySessions, projectDir } from '../sessions.mjs';
import { MOVED_FILE, addsOf, bitingIn, fingerprint, plansDir, readPlan, takenWords } from './plan.mjs';
import { alternatesIn, asGitWrote, isPrivate, movedPath, proveRepo, rewritten, treeDiff, treeOf } from './proof.mjs';
import { withoutAWord } from '../workspace/dropsilent.mjs';
import { RECENT_MS, noSignIn, walk } from './scan.mjs';
import { secretCount } from './secrets.mjs';
import { copyTree } from '../copytree.mjs';

export const doneFile = (name) => path.join(plansDir(), `${name}.done.json`);
export const MOVED_BEGIN = '<!-- hoprig: moved here -->';
export const MOVED_END = '<!-- /hoprig: moved here -->';

// What is known of a private folder after its copy: Hoprig never enters it, so its contents are not compared, and a
// special file in it (a pipe, a socket) is not copied by the copy at all.
export const PRIVATE_COPY = 'a private folder: copied, but Hoprig never looks into it, so its contents are not checked; a special file in it, such as a pipe, is not copied';
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Processes working in one of `dirs` now (Linux: their working folder), or null where this system cannot say. */
export async function busyIn(dirs, platform = process.platform) {
  if (platform !== 'linux') return null;
  return (await import('../server/platform/linux.mjs')).workingIn(dirs);
}

/** The folders a plan leaves out of the copy (installed packages and build output), as a Set of absolute paths. */
export const leftOutOf = (plan) => new Set((plan.leftOut || []).map((l) => l.dir));

/** What a plan's original folders are, absolute: [{ from, to, kind }] (to: absolute inside the new folder). */
export function copies(plan) {
  const root = plan.to;
  const out = [];
  for (const r of plan.repos) {
    out.push({ kind: 'repo', from: r.from, to: r.to === '.' ? root : path.join(root, r.to), repo: r });
    for (const w of r.worktrees || []) if (!w.inside) out.push({ kind: 'worktree', from: w.from, to: path.join(root, w.to), repo: r });
  }
  for (const n of plan.neighbours) if (n.to) out.push({ kind: n.private ? 'private' : 'neighbour', from: path.join(plan.from, n.from), to: path.join(root, n.to), neighbour: n });
  return out;
}

/** One entry's listing (a file or a folder's whole tree), for the neighbours' proof. */
function listing(p, rewrite) {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) return treeOf(p, { rewrite });
  const dir = path.dirname(p);
  const all = treeOf(dir, { rewrite, skipDirs: new Set(fs.readdirSync(dir)) });
  return { entries: { [path.basename(p)]: all.entries[path.basename(p)] }, privates: 0 };
}

/**
 * A linked worktree's two link files, and a repository's alternates (a store it borrows objects from), rewritten from
 * the original folders to the copy's (`map`: [[old, new]]).
 */
function relink(c, map) {
  const fix = (file) => {
    let t;
    try {
      t = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const m = /^gitdir:\s*(.+)$/m.exec(t);
    const line = m ? m[1].trim() : t.trim();
    const abs = path.resolve(path.dirname(file), line);
    const moved = rewritten(abs, map);
    const now = asGitWrote(moved, line); // in the form git wrote it (on Windows C:/a/b)
    if (moved !== abs) rewrite(file, m ? t.replace(m[1], now) : `${now}\n`);
  };
  for (const r of c.filter((x) => x.kind === 'repo')) {
    const admin = path.join(r.to, '.git', 'worktrees');
    let names = [];
    try {
      names = fs.readdirSync(admin);
    } catch {
      /* no worktrees */
    }
    for (const n of names) fix(path.join(admin, n, 'gitdir'));
    const alt = path.join(r.to, '.git', 'objects', 'info', 'alternates');
    const was = alternatesIn(alt);
    const now = was.map((a) => movedPath(a, map));
    if (now.some((a, i) => a !== was[i])) fs.writeFileSync(alt, `${now.join('\n')}\n`);
    // Each worktree's copy where copies() put it (never worked out again from the repository's place).
    for (const w of r.repo.worktrees || []) fix(path.join(w.inside ? path.join(r.to, path.relative(r.from, w.from)) : c.find((x) => x.kind === 'worktree' && x.from === w.from).to, '.git'));
  }
}

/**
 * A file written anew in place: opened as it is, then cut to its new text. Git for Windows marks a worktree's .git file
 * hidden, and Windows refuses to open a hidden file for a new write (EPERM) but not for a change in place.
 */
function rewrite(file, text) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text, 0);
  } finally {
    fs.closeSync(fd);
  }
}

/** The table of what was where and where it is now, for the parent's AGENTS.md. */
export function movedTable(plan, when = new Date()) {
  const rows = [['Was', 'Now'], ...copies(plan).map((c) => [c.from, path.relative(plan.to, c.to).split(path.sep).join('/') || '.'])];
  return [MOVED_BEGIN, `## Moved here (${when.toISOString().slice(0, 10)})`, '',
    'This project was arranged from folders that were elsewhere on this computer. Older notes and sessions name the',
    'old places; this table says where each one is now. The old folders were copied, not moved: they stay until the',
    `owner retires them (hoprig adopt retire ${plan.name}).`, '',
    ...rows.map((r, i) => (i === 1 ? ['| --- | --- |', `| \`${r[0]}\` | \`${r[1]}\` |`] : [`| ${i ? `\`${r[0]}\`` : r[0]} | ${i ? `\`${r[1]}\`` : r[1]} |`])).flat(), MOVED_END, ''].join('\n');
}

/** A pointer for another tool's skill, as the product's skills read one: name and description, then where it is. */
export function pointerSkill(text, rel, tool) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text));
  const keep = fm ? fm[1].split('\n').filter((l) => /^(name|description):/.test(l)) : [];
  return `---\n${keep.join('\n')}\n---\n\nThis skill came from ${tool} and stays where it was copied: \`${rel}/\`. Read \`${rel}/SKILL.md\` and follow it; its\nreferences are beside it. (A pointer made by hoprig adopt apply; the skill itself is not changed.)\n`;
}

/**
 * Apply the plan of project `name`. `projects`, `workspace`: where the project goes (the workspace's folders).
 * `identity`: { name, email } for the parent's first commit (else git's own). `dryRun`: only what would be done.
 * `hooks.afterCopy(copies)`: for tests (a copy changed before its proof). `say(line)`: each line as it happens.
 * → { ok, lines: [{ what, ok, words }], needs: [...], plan } ; throws { code } for a refusal before anything.
 */
export async function applyPlan(name, { projects, workspace, identity = null, dryRun = false, cleanStopped = false, say = () => {}, hooks = {}, now = new Date() } = {}) {
  const plan = readPlan(name, { projects });
  const root = plan.to;
  const adds = addsOf(plan);
  const at = { root: projects, dir: workspace, projects };
  // The run's marker, taken before anything else and only by one run at a time: it names the folder this run makes, its
  // process (pid and identity: a pid is handed out again after a restart) and a token that this run also writes into
  // that folder. A run that was stopped (killed, a power cut) leaves it behind: the folder is its half-made copy only
  // while the folder holds the same token. A folder made by anyone else is never called that, nor removed.
  const marker = path.join(plansDir(), `${name}.applying`);
  const token = crypto.randomUUID();
  let held = false;
  const take = () => {
    held = takeMarker(marker, `${root}\n${process.pid}\n${system.self() || ''}\n${token}\n`);
    if (held) active.add(marker);
    return held;
  };
  const release = () => {
    if (!held) return;
    held = false;
    active.delete(marker);
    if (readMarker(marker)?.token === token) fs.rmSync(marker, { force: true });
  };
  let made = false; // this run made `root` (only then may it remove it)
  if (!dryRun) {
    fs.mkdirSync(plansDir(), { recursive: true, mode: 0o700 });
    take();
  }
  try {
    return await applyHeld();
  } finally {
    release();
  }

  async function applyHeld() {
    if (!held) {
      const rec = readMarker(marker);
      if (rec) {
        if (runOf(marker, rec) !== 'stopped') throw fail('ERUNNING', `an apply of ${name} is running now (process ${rec.pid}, making ${rec.root}): wait until it ends. If none runs (after a restart, for example), remove ${marker} and run this again`);
        // The run that held it may end, and take its marker away, while it was read.
        const st = fs.statSync(marker, { throwIfNoEntry: false });
        const when = st ? `started ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'its marker went away meanwhile';
        if (path.resolve(rec.root) === path.resolve(root) && rec.token && tokenIn(root) === rec.token) {
          if (!cleanStopped || dryRun) throw fail('ESTOPPED', `${root} is a half-made copy: an earlier apply of ${name} stopped partway (${when}). Your originals were not touched. To remove only that folder and arrange again: hoprig adopt apply ${name} --clean-stopped`);
          removeIn(at, root, { recursive: true, writable: true });
          say({ what: 'cleaned', ok: true, words: `removed ${root}, the half-made copy of the apply that stopped (${when})` });
        }
      }
      if (!dryRun) {
        // The folder there now is not the stopped run's: it stays, and so does the marker; the words name both.
        if (fs.existsSync(root)) {
          if (rec) throw fail('EEXISTS', `${root} is there already, and it is not the half-made copy of the apply of ${name} that stopped (${rec.root === root ? '' : `that one made ${rec.root}; `}its marker is ${marker}). Hoprig never removes a folder it cannot tell is its own: if this one is yours, it stays (move it aside, or arrange the project under another name). If it is what the stopped run left, remove it yourself, then remove ${marker} and run this again. Your originals were not touched`);
          throw fail('EEXISTS', `${root} is there already: apply makes a new project folder and never writes into one that exists`);
        }
        // Only the stopped run's marker goes (another run may have taken a new one since it was read).
        if (rec && readMarker(marker)?.token === rec.token) fs.rmSync(marker, { force: true });
        if (!take()) throw fail('ERUNNING', `another apply of ${name} started just now: wait until it ends`);
      }
    }
    if (fs.existsSync(root)) throw fail('EEXISTS', `${root} is there already: apply makes a new project folder and never writes into one that exists`);
    if ((await fingerprint(plan.from, plan.repos)) !== plan.fingerprint) throw fail('ECHANGED', `${plan.from} changed since its plan was made (a file, a commit or a branch): make a new plan with hoprig adopt plan ${plan.from}`);
    const cs = copies(plan);
    for (const c of cs) if (!fs.existsSync(c.from)) throw fail('ECHANGED', `${c.from} is not there any more: make a new plan`);
    // A folder left out must still be one git ignores as a whole, of installed packages or build output (an edited
    // plan, or a .gitignore changed since): else nothing is copied.
    const leave = leftOutOf(plan);
    const checkouts = plan.repos.flatMap((r) => [r.from, ...(r.worktrees || []).map((w) => w.from)]);
    for (const d of leave) if (!fs.existsSync(d) || !(await withoutAWord(d, { repos: checkouts, isDir: true }))) throw fail('ECHANGED', `${d} is not a folder of installed packages or build output that git ignores as a whole: make a new plan with hoprig adopt plan ${plan.from}`);
    const busy = await busyIn([plan.from, ...cs.map((c) => c.from)]);
    if (busy) throw fail('EBUSY', `a program is working in ${plan.from} now (${busy} process${busy === 1 ? '' : 'es'}): a copy is not safe while it writes. End it, then run this again`);
    const recent = cs.reduce((n, c) => n + (fs.lstatSync(c.from).isDirectory() ? walk(c.from, { since: now.getTime() - RECENT_MS }).recent : 0), 0);
    // The commit identity, handed to git for this command's commits only.
    let who = identity && identity.name && identity.email ? identity : null;
    if (!who) {
      const g = await Promise.all(['user.name', 'user.email'].map((k) => capture(['git', 'config', '--get', k], { cwd: os.tmpdir() }).then((r) => r.stdout.trim())));
      if (g[0] && g[1]) who = { name: g[0], email: g[1] };
    }
    if (!who) throw fail('ENOIDENTITY', 'the parent\'s first commit needs a name and an e-mail: give them for this command (--name "Your Name" --email you@example.com); nothing global is set');
    const lines = [];
    // A line is ok, failed, or a warning (warn: it did not stop the run, but it is something to look at).
    const line = (what, ok, words, warn = false) => {
      const l = warn ? { what, ok, words, warn: true } : { what, ok, words };
      lines.push(l);
      say(l);
    };
    if (dryRun) {
      line('plan', true, `would make ${root} ${madeWords(plan, adds)}, with commits by ${who.name}`);
      for (const c of cs) line('copy', true, `would copy ${c.from} to ${path.relative(root, c.to) || '.'}${c.kind === 'private' ? ` (${PRIVATE_COPY})` : ''}`);
      for (const l of plan.leftOut || []) line('left out', true, leftLine(plan, l, true));
      if (recent) line('recent', true, recentWords(recent), true);
      line('proof', true, 'would prove each copy against its original (HEAD, every ref, status and diff by hash, stashes, remote, each worktree, the file set, git fsck), then commit the parent, bring the sessions and the memory');
      return { ok: true, dryRun: true, lines, needs: [], plan };
    }
    const undo = (why) => {
      removeIn(at, root, { recursive: true, writable: true });
      line('undone', true, `${why}: the folder this run made (${root}) was removed; the originals were not touched`);
    };
    try {
      if (recent) line('recent', true, recentWords(recent), true);
      // The new folder is made here and only here, exclusively: one that appeared meanwhile is someone else's.
      mkdirIn(at, path.dirname(root));
      try {
        fs.mkdirSync(insideOr(projects, root, at));
      } catch (e) {
        throw e.code === 'EEXIST' ? fail('EEXISTS', `${root} is there already: apply makes a new project folder and never writes into one that exists`) : e;
      }
      made = true;
      fs.writeFileSync(path.join(root, RUN_TOKEN), `${token}\n`, { flag: 'wx', mode: 0o600 });
      writeTemplate(root, builtinFiles().filter((f) => adds.includes(f.rel)), plan.name, at, { into: true });
      line('template', true, `made ${root} ${madeWords(plan, adds)}`);
      for (const c of cs) {
        insideOr(projects, path.dirname(c.to), at);
        // The plan's own check (readPlan) already refuses a place of the template; this is the second line, for what is
        // there anyway: the copy never merges into a folder or writes over a file (src/copytree.mjs refuses both).
        const there = fs.lstatSync(c.to, { throwIfNoEntry: false });
        if (there) throw fail('ETAKEN', takenWords(path.relative(root, c.to), c.from, there.isDirectory()));
        mkdirIn(at, path.dirname(c.to));
        // By the names' bytes, times kept (src/copytree.mjs): a name that is not UTF-8 too; without the folders left out.
        copyTree(c.from, c.to, { skip: c.kind === 'repo' || c.kind === 'worktree' ? leave : null });
        line('copy', true, `copied ${c.from} to ${path.relative(root, c.to) || '.'}${c.kind === 'private' ? ` (${PRIVATE_COPY})` : ''}`);
      }
      for (const l of plan.leftOut || []) line('left out', true, leftLine(plan, l, false));
      const map = cs.filter((c) => c.kind === 'repo' || c.kind === 'worktree').map((c) => [c.from, c.to]);
      relink(cs, map);
      if (hooks.afterCopy) await hooks.afterCopy(cs);
      let ok = true;
      for (const c of cs.filter((x) => x.kind === 'repo')) {
        const wtMap = new Map((c.repo.worktrees || []).map((w) => [w.from, w.inside ? path.join(c.to, path.relative(c.from, w.from)) : path.join(root, w.to)]));
        for (const p of await proveRepo(c.from, c.to, { wtMap, map, root, leave })) {
          line(p.what, p.ok, `${path.relative(root, c.to) || '.'}: ${p.words}`, !!p.warn);
          ok &&= p.ok;
        }
      }
      for (const c of cs.filter((x) => x.kind === 'neighbour')) {
        const d = treeDiff(listing(c.from, map), listing(c.to, []));
        line('files', !d.length, `${path.relative(root, c.to)}: ${d.length ? `${d.length} entr${d.length === 1 ? 'y differs' : 'ies differ'}, first: ${d[0].rel}` : 'the same as the original'}`);
        ok &&= !d.length;
      }
      if (!ok) {
        undo('a copy is not the same as its original');
        return { ok: false, lines, needs: [], plan };
      }
      // Hoprig's own files of the parent, then its first commit (only those: what was copied is the owner's to commit).
      const repos = plan.repos.map((r) => ({ r, url: gitUrl(r.from) })).filter((x) => x.url && parseRepo(x.url) && x.r.to !== '.').map((x) => ({ dir: x.r.to, url: x.url }));
      // A file of the old folder's own (its project.json, its AGENTS.md) is never written into: only what Hoprig added.
      if (adds.includes(MANIFEST)) {
        const mem = (await readManifest(root)).manifest.memories;
        writeManifest(root, { name: plan.name, repos, memories: mem }, at);
      }
      if (adds.includes('AGENTS.md')) {
        const agents = path.join(root, 'AGENTS.md');
        const cur = (readIn(at, agents) || Buffer.from('')).toString('utf8');
        writeIn(at, agents, `${cur.replace(/\n*$/, '\n\n')}${movedTable(plan, now)}`);
      } else if (adds.includes(MOVED_FILE)) {
        mkdirIn(at, path.dirname(path.join(root, MOVED_FILE)));
        writeIn(at, path.join(root, MOVED_FILE), `${movedTable(plan, now)}`, { excl: true });
      }
      const run = (argv, o = {}) => capture(argv, { ...o, env: { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } });
      // Only what Hoprig added: a file of the old folder's own at the same place is what was copied, and stays uncommitted.
      const init = await initOwn(root, `Arrange ${plan.name} from ${path.basename(plan.from)}`, adds, run, { ...at, root });
      if (!init.ok) throw fail('ECOMMIT', `git could not make the parent's first commit: ${init.error}`);
      line('commit', true, init.none ? 'the parent is a new git repository with no commit yet: Hoprig added none of its files, and what was copied stays uncommitted for you to look at' : `the parent's first commit holds Hoprig's own files, by ${who.name}; what was copied stays uncommitted for you to look at`);
    } catch (e) {
      if (made) undo(`stopped: ${e.message}`);
      if (e.code) throw e;
      return { ok: false, lines, needs: [], plan, error: e.message };
    }
    // The run's token stays in the folder until the done record is written: a run killed anywhere before that (the
    // memory, the sessions, the pointers) still leaves a folder that the next apply knows as its half-made copy.
    const needs = await afterProof(plan, cs, line);
    if (hooks.beforeDone) await hooks.beforeDone(root);
    fs.writeFileSync(doneFile(name), `${JSON.stringify({ name, at: now.toISOString(), from: plan.from, to: root, fingerprint: plan.fingerprint, copies: cs.map((c) => ({ kind: c.kind, from: c.from, to: c.to })), leftOut: [...leave] }, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(path.join(root, RUN_TOKEN), { force: true });
    line('done', true, `${plan.name} is arranged in ${root}. Your old folders are untouched: ${plan.from} is as it was`);
    return { ok: true, lines, needs, plan };
  }
}

/** How the new folder is made, in words: the whole template, or (a project in the layout) only what it lacked. */
export function madeWords(plan, adds) {
  if (!plan.layout) return 'from Hoprig\'s own template';
  return adds.length ? `keeping every file of the old folder's own, adding only what the layout lacked: ${adds.join(', ')}` : 'keeping every file of the old folder\'s own: the layout lacked nothing';
}

/** Where a folder that is left out would be in the copy (relative to the new folder). */
export function leftAt(plan, dir) {
  const map = copies(plan).filter((c) => c.kind === 'repo' || c.kind === 'worktree').map((c) => [c.from, c.to]);
  return path.relative(plan.to, movedPath(dir, map)).split(path.sep).join('/');
}

/** One folder left out, in words: where, its size, and the command that makes it again (in the folder beside it). */
export function leftLine(plan, l, would) {
  const at = leftAt(plan, l.dir);
  const size = `${l.bytes < 1e6 ? `${Math.max(1, Math.round(l.bytes / 1e3))} KB` : l.bytes < 1e9 ? `${(l.bytes / 1e6).toFixed(1)} MB` : `${(l.bytes / 1e9).toFixed(1)} GB`}, ${l.files} file${l.files === 1 ? '' : 's'}`;
  const again = l.remake ? `make it again with ${l.remake} in ${path.posix.dirname(at)}` : 'the project\'s own build or install makes it again';
  return `${at} (${size}): installed packages or build output, ${would ? 'would be left out' : 'left out'} of the copy; ${again}`;
}

const recentWords = (n) => `${n} file${n === 1 ? ' was' : 's were'} changed within the hour in what this copies (its repositories, worktrees and neighbours together): if someone is still writing, the proof after the copy shows that change as a difference and the run is undone`;

// The file in a folder a run is making that holds the run's token (removed when the run is done).
export const RUN_TOKEN = '.hoprig-applying';
const active = new Set(); // the markers this process holds now

/** Take the marker with its whole text, or not at all (a link of a full file: no other run sees it half written). */
function takeMarker(marker, text) {
  const tmp = `${marker}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(tmp, marker);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(e.code)) throw e;
    // A disk without hard links: an exclusive create of the marker itself.
    try {
      fs.writeFileSync(marker, text, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (x) {
      if (x.code === 'EEXIST') return false;
      throw x;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A marker's record: { root, pid, proc, token } (null fields where an older one has none), or null. */
function readMarker(marker) {
  let t;
  try {
    t = fs.readFileSync(marker, 'utf8');
  } catch {
    return null;
  }
  const [root = '', pid = '', proc = '', token = ''] = t.split('\n').map((x) => x.trim());
  return { root, pid: /^\d+$/.test(pid) ? Number(pid) : null, proc: proc || null, token: token || null };
}

/** The token in a folder a run was making, or null. */
function tokenIn(root) {
  try {
    const f = path.join(root, RUN_TOKEN);
    return fs.lstatSync(f).isFile() ? fs.readFileSync(f, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Whether the run of a marker goes on: 'running' (this process holds it, or its process is the one that wrote it),
 * 'unknown' (its pid lives and nothing tells it apart: a marker without an identity), or 'stopped'.
 */
function runOf(marker, rec) {
  if (active.has(marker)) return 'running';
  if (rec.pid === null || rec.pid === process.pid) return 'stopped';
  const owned = filedProcess(marker, { pid: rec.pid, proc: rec.proc });
  return owned === false ? 'stopped' : owned ? 'running' : 'unknown';
}

/** origin's address without any sign-in part, read from the repository's own config file (nothing is run). */
function gitUrl(repo) {
  try {
    const t = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(t);
    return m ? noSignIn(m[1]) : null;
  } catch {
    return null;
  }
}

/** git init, then a commit of only `files` (those that are there), with `run` (the command's identity). */
async function initOwn(dir, message, files, run, at) {
  const { gitIn } = await import('../workspace/inside.mjs');
  const i = await gitIn(at, dir, ['init', '-q', '-b', 'main'], run);
  if (!i.ok) return { ok: false, error: i.stderr.trim() };
  const there = [...new Set(files)].filter((f) => fs.existsSync(path.join(dir, f)));
  if (!there.length) return { ok: true, none: true };
  const a = await gitIn(at, dir, ['add', '--', ...there], run);
  if (!a.ok) return { ok: false, error: a.stderr.trim() };
  const c = await gitIn(at, dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', message], run);
  return c.ok ? { ok: true } : { ok: false, error: (c.stderr || c.stdout).trim().split('\n').pop() };
}

/** After the proof: memory, sessions, skill pointers, and what needs the owner. → [{ kind, words }] */
async function afterProof(plan, cs, line) {
  const root = plan.to;
  const at = { root };
  const needs = [];
  const rules = pathRules();
  // The coding tool's memory of each old folder into the project's own memory folder, then linked as project new does.
  // Each old folder to where its content went: a folder that was itself the repository to its copy in code/<name>,
  // else to the project's parent; each repository (and linked worktree) to its copy.
  const self = cs.find((c) => c.kind === 'repo' && c.from === plan.from);
  const olds = [[plan.from, self ? self.to : root], ...cs.filter((c) => (c.kind === 'repo' || c.kind === 'worktree') && c.from !== plan.from).map((c) => [c.from, c.to])];
  let mem = 0;
  for (const [o] of olds) {
    const m = path.join(projectDir(o), 'memory');
    if (fs.existsSync(m)) mem += mergeInto(m, path.join(root, 'ai_brain', 'claude-memory'), 'adopt', at);
  }
  line('memory', true, mem ? `${mem} memory file${mem === 1 ? '' : 's'} of the coding tool copied into ai_brain/claude-memory` : 'the coding tool had no memory for these folders');
  try {
    linkMemories(root, { '.': 'ai_brain/claude-memory' }, { ref: plan.name });
  } catch (e) {
    needs.push({ kind: 'memory', words: `the memory link was not made: ${e.message} (hoprig project link ${plan.name})` });
  }
  let n = 0;
  for (const [o, nw] of olds) {
    const r = copySessions(o, nw);
    n += r.copied.length;
    if (r.differ.length) needs.push({ kind: 'sessions', words: `${r.differ.length} conversation file${r.differ.length === 1 ? '' : 's'} under ${nw}'s key differ from the old ones and were left as they are` });
  }
  line('sessions', true, n ? `${n} conversation file${n === 1 ? '' : 's'} of the coding tool copied under the new folders (the old ones stay)` : 'no conversations of the coding tool named these folders');
  // Other tools' skills: a pointer the product's skills read, in the parent's .claude/skills.
  for (const s of plan.tools.skills) {
    const where = locate(plan, s.file);
    if (!where) continue;
    const relDir = path.relative(root, path.dirname(where)).split(path.sep).join('/');
    if (relDir.startsWith('.claude/skills/')) continue;
    const dest = path.join(root, '.claude', 'skills', s.name, 'SKILL.md');
    // A folder of that name is there (his own skill, copied): nothing is written into it.
    if (fs.lstatSync(path.dirname(dest), { throwIfNoEntry: false })) {
      needs.push({ kind: 'skill', words: `the skill ${s.name} (${s.tool}) has no pointer: .claude/skills/${s.name} is there already` });
      continue;
    }
    mkdirIn(at, path.dirname(dest));
    writeIn(at, dest, pointerSkill(fs.readFileSync(where, 'utf8'), relDir, s.tool), { excl: true });
    line('skill', true, `the ${s.tool} skill ${s.name}: a pointer in .claude/skills/${s.name} to ${relDir}/`);
  }
  for (const r of plan.tools.rules) needs.push({ kind: 'rules', words: `${locateRel(plan, r.file)} (${r.tool}): a rules file to read with the owner: what is about him goes to the brain's rules, what is about the project stays` });
  for (const h of plan.tools.hooks) needs.push({ kind: 'hook', words: `${locateRel(plan, h.file)}${h.event ? ` (${h.event})` : ''}: a hook of ${h.tool}. If it guards something, Claude Code needs its equal; it was not run and not dropped` });
  for (const l of plan.leftOut || []) needs.push({ kind: 'left out', words: leftLine(plan, l, false) });
  for (const n of plan.nested || []) needs.push({ kind: 'another project inside', words: `${locateRel(plan, n)}: an untracked folder that looks like another project (its own git folder or project file). It came along as it was; decide whether it belongs in this repository before any first push` });
  // The old paths where they bite, in the copy.
  const forms = [...new Set(cs.flatMap((c) => rules.forms(c.from)).concat(rules.forms(plan.from)))];
  for (const c of cs.filter((x) => x.kind === 'repo')) {
    const prefix = `${path.relative(root, c.to).split(path.sep).join('/')}/`.replace(/^\/$/, '');
    for (const b of bitingIn(c.to, forms, prefix)) needs.push({ kind: 'old path', words: `${b.file}:${b.line} names an old folder` });
  }
  for (const b of plan.breaks.filter((x) => x.tracked)) needs.push({ kind: 'old path', words: `${locateRel(plan, b.file)}:${b.line} (tracked) names an old folder: listed, not rewritten` });
  // A neighbour that was copied (a script, a note, an AI file) and still names an old folder.
  const inRepo = (f) => plan.repos.some((r) => r.rel === '.' || f === r.rel || f.startsWith(`${r.rel}/`));
  for (const b of plan.breaks.filter((x) => !x.tracked && !inRepo(x.file))) needs.push({ kind: 'old path', words: b.link ? `${locateRel(plan, b.file)} is a link into an old folder` : `${locateRel(plan, b.file)}:${b.line} names an old folder: listed, not rewritten` });
  // Secrets: their count in what a first push would take, never a value.
  // Each checkout a first push could be made from: the repository and each of its linked worktrees (one outside it,
  // and one inside it, which the repository's own list shows only as one folder entry).
  const counts = [];
  for (const c of cs.filter((x) => x.kind === 'repo')) {
    counts.push({ c, n: await secretCount(c.to) });
    for (const w of c.repo.worktrees || []) {
      const to = w.inside ? path.join(c.to, path.relative(c.from, w.from)) : cs.find((x) => x.kind === 'worktree' && x.from === w.from).to;
      counts.push({ c: { to }, n: await secretCount(to) });
    }
  }
  const total = counts.reduce((s, x) => s + x.n.total, 0);
  const privates = cs.some((c) => c.kind === 'private') || cs.some((c) => c.kind === 'repo' && privatesIn(c.to));
  // Clean is said only of what was searched: a plan that copies no repository, or a listing that failed, never reads
  // as a push with nothing in it.
  const failed = counts.filter((x) => x.n.error).length;
  const clean = counts.length && !failed
    ? 'no secret-shaped value in the files a first push would take (tracked, and untracked ones that are not ignored)'
    : counts.length
      ? `${failed} of ${counts.length} checkout${counts.length === 1 ? '' : 's'} could not be searched: look before a first push`
      : 'no repository was copied, so nothing was searched for secret-shaped values: look before a first push';
  line('secrets', true, `${total ? `${total} secret-shaped value${total === 1 ? '' : 's'} in files a first push would take, tracked or not (${counts.filter((x) => x.n.total).map((x) => `${path.relative(root, x.c.to)}: ${x.n.files.join(', ')}`).join('; ')}): look before a first push` : clean}${privates ? ' (a private folder was not searched)' : ''}`, !total && !(counts.length && !failed));
  // Beside the secret count: where a first push would go, as the server said when the plan was made.
  for (const c of cs.filter((x) => x.kind === 'repo' && x.repo.visibility)) {
    const v = c.repo.visibility;
    line('visibility', true, `${path.relative(root, c.to) || '.'}${v.state === 'local' ? ': ' : ' on its server: '}${v.words}`, !['private', 'local'].includes(v.state));
    if (v.state === 'public') needs.push({ kind: 'public', words: `${path.relative(root, c.to)} is public on GitHub: before any first push, look at what it would take (the secret count above, and untracked folders that look like another project)` });
  }
  if (!total && !(counts.length && !failed)) needs.push({ kind: 'secrets', words: counts.length ? 'some checkouts could not be searched for secret-shaped values: look before a first push' : 'nothing was searched for secret-shaped values (no repository was copied): look before a first push' });
  if (total) needs.push({ kind: 'secrets', words: `${total} secret-shaped value${total === 1 ? '' : 's'} in files a first push would take (tracked, and untracked ones that are not ignored): look before a first push (no value is shown)` });
  return needs;
}

/** True when a private folder lies anywhere below `dir` (folders are listed, none is entered). */
function privatesIn(dir) {
  const stack = [dir];
  while (stack.length) {
    let list = [];
    try {
      list = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (isPrivate(e.name)) return true;
      stack.push(path.join(e.parentPath ?? e.path, e.name));
    }
  }
  return false;
}

/** Where a plan's file (relative to the scanned folder, a repository's rel first) is in the new folder. */
function locate(plan, file) {
  const rel = locateRel(plan, file);
  const p = path.join(plan.to, rel);
  return fs.existsSync(p) ? p : null;
}
function locateRel(plan, file) {
  for (const r of [...plan.repos].sort((a, b) => b.rel.length - a.rel.length)) {
    if (r.rel === '.') return r.to === '.' ? file : `${r.to}/${file}`;
    if (file === r.rel || file.startsWith(`${r.rel}/`)) return `${r.to}${file.slice(r.rel.length)}`;
  }
  const n = plan.neighbours.filter((x) => x.to && (file === x.from || file.startsWith(`${x.from}/`))).sort((a, b) => b.from.length - a.from.length)[0];
  return n ? `${n.to}${file.slice(n.from.length)}` : file;
}
