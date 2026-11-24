// verify and retire: what comes after apply. verify proves the copy against its original again (the same proof
// lines as apply). retire is the only step that removes an original, and only on the owner's terminal: it checks
// that nothing in the original changed since it was copied (the plan's fingerprint of its tree and of every
// repository's git state, read again now), lists what would go, and needs the project's name typed. A private folder
// is never entered, so it is never known to be unchanged: retire leaves it where it is and says so, at any depth (one
// inside a repository that was copied whole too: everything of that repository goes but the private folder and the
// folders that lead to it). What the plan said stays (not a project) stays too; the old project folder goes only when
// nothing is left in it.
import fs from 'node:fs';
import path from 'node:path';
import { doneFile, copies } from './apply.mjs';
import { recheck } from './recheck.mjs';
import { fingerprint, readPlan } from './plan.mjs';
import { borrowedStores, isPrivate, nameOf, proveRepo, treeDiff, treeOf } from './proof.mjs';
import { SKIP_DIRS, commonDir, projectRepos } from './scan.mjs';

const PRIVATE_STAYS = 'a private folder: Hoprig never looks into it, so it cannot tell it is unchanged. It was copied whole; remove it yourself when you are sure';

// Names are read as bytes, as treeOf reads them: a name that is not UTF-8 would otherwise come back changed, and the
// changed name can be neither listed nor removed (ENOENT), so a private folder below it would not be found and the whole
// repository would go, or a folder would stay that retire says it removed.
const SEP = Buffer.from(path.sep);
const join = (d, n) => Buffer.concat([d, SEP, n]);
const below = (k, d) => k.length > d.length + SEP.length && k.subarray(0, d.length).equals(d) && k.subarray(d.length, d.length + SEP.length).equals(SEP);

/** The private folders at any depth below `p` (none below a file), found by listing folders: none is entered. → [Buffer] */
export function privatesBelow(p) {
  const out = [];
  const walk = (d) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true, encoding: 'buffer' });
    } catch {
      return;
    }
    for (const e of list) {
      if (!e.isDirectory()) continue; // a link is not followed
      if (isPrivate(nameOf(e.name))) out.push(join(d, e.name));
      else walk(join(d, e.name));
    }
  };
  try {
    if (fs.lstatSync(p).isDirectory()) walk(Buffer.from(p));
  } catch {
    /* not there */
  }
  return out;
}

/** Remove `p`, but not the folders of `keep` (byte paths) below it, nor the folders that lead to them. */
function removeKeeping(p, keep) {
  if (!keep.length) return fs.rmSync(p, { recursive: true, force: true });
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true, encoding: 'buffer' })) {
      const q = join(d, e.name);
      if (keep.some((k) => k.equals(q))) continue;
      if (e.isDirectory() && keep.some((k) => below(k, q))) walk(q);
      else fs.rmSync(q, { recursive: true, force: true });
    }
  };
  walk(Buffer.from(p));
}

/**
 * The repositories of the other projects in the scanned place (the folder that holds the old project folder) that borrow
 * objects from one of `stores` (clone --shared or --reference): they break when that store goes. → [{ repo, store }]
 */
function borrowersIn(place, skip, stores) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const want = new Set(stores.map(real));
  const out = [];
  let list = [];
  try {
    list = fs.readdirSync(place, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    if (!e.isDirectory() || isPrivate(e.name) || SKIP_DIRS.has(e.name)) continue;
    const dir = path.join(place, e.name);
    if (dir === skip) continue;
    for (const r of projectRepos(dir)) {
      const hit = borrowedStores(r).find((b) => want.has(real(b)));
      if (hit) out.push({ repo: r, store: hit });
    }
  }
  return out;
}

const SHARED_WORDS = 'A clone made elsewhere with --shared or --reference from one of these borrows its objects and breaks when it goes: in that clone, run git repack -a -d first';

export const NO_TERMINAL = 'retire removes your original folders: it needs the project\'s name typed on a terminal, and there is none here';

/** The record apply left for project `name`, or a refusal. */
export function readDone(name) {
  try {
    return JSON.parse(fs.readFileSync(doneFile(name), 'utf8'));
  } catch {
    throw Object.assign(new Error(`${name} was not arranged by hoprig adopt apply on this computer`), { code: 'ENOTDONE' });
  }
}

/** The copy proved again: [{ what, ok, words }]. A copy you worked in since shows its changes here. */
export async function verifyProject(name, { projects }) {
  readDone(name);
  const plan = readPlan(name, { projects });
  const cs = copies(plan);
  const lines = [];
  for (const c of cs) {
    if (!fs.existsSync(c.to)) lines.push({ what: 'copy', ok: false, words: `${path.relative(plan.to, c.to) || '.'} is not there` });
    if (!fs.existsSync(c.from)) lines.push({ what: 'original', ok: false, words: `${c.from} is not there any more` });
  }
  if (lines.length) return lines;
  const map = cs.filter((c) => c.kind === 'repo' || c.kind === 'worktree').map((c) => [c.from, c.to]);
  for (const c of cs.filter((x) => x.kind === 'repo')) {
    const wtMap = new Map((c.repo.worktrees || []).map((w) => [w.from, w.inside ? path.join(c.to, path.relative(c.from, w.from)) : path.join(plan.to, w.to)]));
    for (const p of await proveRepo(c.from, c.to, { wtMap, map, root: plan.to })) lines.push({ ...p, words: `${path.relative(plan.to, c.to) || '.'}: ${p.words}` });
  }
  for (const c of cs.filter((x) => x.kind === 'neighbour')) {
    const st = fs.lstatSync(c.from);
    const d = st.isDirectory() ? treeDiff(treeOf(c.from, { rewrite: map }), treeOf(c.to)) : fs.readFileSync(c.from).equals(fs.readFileSync(c.to)) ? [] : [{ rel: path.basename(c.from) }];
    lines.push({ what: 'files', ok: !d.length, words: `${path.relative(plan.to, c.to)}: ${d.length ? `${d.length} differ, first: ${d[0].rel}` : 'the same as the original'}` });
  }
  return lines;
}

/**
 * What retire would remove and what stays. → { go: [path], keep: { path: [private folders kept in it, as bytes] }, stay:
 * [{ path, why }], changed: bool, plan }.
 * `changed`: the original is not as it was when it was copied (then nothing may go).
 */
export async function retirePlan(name, { projects }) {
  const done = readDone(name);
  const plan = readPlan(name, { projects });
  const changed = (await fingerprint(plan.from, plan.repos)) !== done.fingerprint;
  const cs = copies(plan);
  const go = cs.filter((c) => c.kind !== 'private').map((c) => c.from);
  const keep = Object.fromEntries(go.map((g) => [g, privatesBelow(g)]).filter(([, k]) => k.length));
  const stay = [
    ...cs.filter((c) => c.kind === 'private').map((c) => ({ path: c.from, why: PRIVATE_STAYS })),
    ...Object.values(keep).flat().map((k) => ({ path: nameOf(k), why: PRIVATE_STAYS })),
    ...plan.neighbours.filter((n) => !n.to).map((n) => ({ path: path.join(plan.from, n.from), why: n.why || 'not part of the project: it stays' })),
  ];
  // A parent in the layout that is a repository: its own history was not copied, so it stays.
  if (!plan.repos.some((r) => r.from === plan.from) && fs.existsSync(path.join(plan.from, '.git'))) stay.push({ path: path.join(plan.from, '.git'), why: 'the old folder\'s own git history: the new project has a history of its own, so this one stays' });
  for (const c of cs) if (!fs.existsSync(c.to)) return { go: [], keep: {}, stay, changed, missing: c.to, plan };
  // A copy that borrows objects from a store outside the new folder breaks when that store goes.
  const inNew = (b) => b === plan.to || b.startsWith(plan.to + path.sep);
  for (const c of cs.filter((x) => x.kind === 'repo')) {
    const out = borrowedStores(c.to).find((b) => !inNew(b));
    if (out) return { go: [], keep: {}, stay, changed, borrows: { copy: c.to, store: out }, plan };
  }
  // Another project's repository that borrows from an original's store (a clone --shared of it) breaks when it goes.
  const stores = cs.filter((x) => x.kind === 'repo').map((x) => commonDir(x.from)).filter(Boolean).map((d) => path.join(d, 'objects'));
  const borrowedBy = borrowersIn(path.dirname(plan.from), plan.from, stores);
  if (borrowedBy.length) return { go: [], keep: {}, stay, changed, borrowedBy, plan };
  return { go, keep, stay, changed, plan };
}

/**
 * Retire: `ask(question)` is the terminal's (null without one: refused). → { ok, removed: [path], words }.
 */
export async function retireProject(name, { projects, ask = null, say = () => {} }) {
  if (!ask) return { ok: false, refused: true, removed: [], words: NO_TERMINAL };
  const r = await retirePlan(name, { projects });
  if (r.missing) return { ok: false, removed: [], words: `${r.missing} (its copy) is not there: nothing is removed` };
  if (r.borrows) return { ok: false, removed: [], words: `${r.borrows.copy} borrows objects from ${r.borrows.store}, outside the project: its history would break without it, so nothing is removed` };
  if (r.borrowedBy) return { ok: false, removed: [], words: `${r.borrowedBy[0].repo} borrows objects from ${r.borrowedBy[0].store}, an original that would go: its history would break, so nothing is removed. In it, run git repack -a -d, then remove its .git/objects/info/alternates, and retire again` };
  if (r.changed) return { ok: false, removed: [], words: `${r.plan.from} changed since it was copied (a file, a commit or a branch), so its copy may not hold everything: nothing is removed. Look with hoprig adopt verify ${name}` };
  say('These originals would be removed (their copies are in the project):');
  for (const g of r.go) say(`  ${g}${r.keep[g] ? `  (all but the private folder${r.keep[g].length === 1 ? '' : 's'} in it)` : ''}`);
  say(SHARED_WORDS);
  say('Before anything goes, Hoprig compares each of them with its copy again: every commit, branch, tag, stash entry, worktree and working file.');
  if (r.stay.length) say('These stay:');
  for (const s of r.stay) say(`  ${s.path}: ${s.why}`);
  const a = await ask(`Type the project's name (${name}) to remove them, or press Enter to stop: `);
  if (a === null || a.trim() !== name) return { ok: false, removed: [], words: a && a.trim() ? `"${a.trim()}" is not ${name}: nothing is removed` : 'stopped: nothing is removed' };
  // Its own check, right before anything goes: nothing said before (the plan, apply's proof) is trusted.
  const done = readDone(name);
  const pairs = (done.copies || []).map((c) => [c.from, c.to]);
  if (!pairs.length) for (const c of copies(r.plan)) pairs.push([c.from, c.to]);
  const again = await recheck({ root: r.plan.from, go: r.go, pairs });
  say(again.words);
  if (!again.ok) return { ok: false, removed: [], words: again.words, counts: again.counts };
  const removed = [];
  for (const g of r.go) {
    removeKeeping(g, r.keep[g] || []);
    removed.push(g);
  }
  // The folders that held only what went (apps/ of apps/site and apps/notes.md), deepest first, then the old folder.
  const ups = new Set();
  for (const g of r.go) for (let d = path.dirname(g); d.startsWith(r.plan.from + path.sep); d = path.dirname(d)) ups.add(d);
  for (const d of [...ups].sort((a, b) => b.length - a.length).concat(r.plan.from)) {
    try {
      if (!fs.readdirSync(d).length) {
        fs.rmdirSync(d);
        removed.push(d);
      }
    } catch {
      /* gone already, or something stays in it */
    }
  }
  return { ok: true, removed, words: `${removed.length} original${removed.length === 1 ? '' : 's'} removed; the project is in ${r.plan.to}` };
}
