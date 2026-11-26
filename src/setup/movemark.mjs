// The move's mark of its own copy: a file in ROOT's state folder (root's to write, never the user's), written when the
// copy starts, when the move's own writes into it ended (madeUntil), when it was checked, just before root's dashboard stops ('switching'), when the
// switch went through ('switched') and after a step back ('back'). A later run of the move reads it: while the user's
// dashboard may run on the copy ('switching' or 'switched', no step back) the move stops; a part of a copy it began is
// taken away and made again only when nothing in it changed since the copy ended, else it is set aside, never deleted.
// What the move did not make is never written over or taken away.
import fs from 'node:fs';
import path from 'node:path';
import { replaceFile } from '../replacefile.mjs';

/** The mark's file name in root's state folder (left behind by the copy: moveplan.mjs STATE_LEFT). */
export const MARK_FILE = 'move-copy.json';

/**
 * The mark of `stateDir`, or null: { user, home, parts: [paths in the user's home], at, state, madeUser, madeUntil,
 * switchingAt, switchedAt, backAt, kept: [what a run set aside beside its part, never to be offered for removal] }.
 */
export function readMark(stateDir, { readFile = fs.readFileSync } = {}) {
  try {
    const m = JSON.parse(readFile(path.join(stateDir, MARK_FILE), 'utf8'));
    if (!m || typeof m.user !== 'string' || typeof m.home !== 'string' || !Array.isArray(m.parts)) return null;
    return { ...m, parts: m.parts.filter((p) => typeof p === 'string'), kept: Array.isArray(m.kept) ? m.kept.filter((p) => typeof p === 'string') : [] };
  } catch {
    return null;
  }
}

/** Writes the mark whole (mode 600). */
export function writeMark(stateDir, mark) {
  const file = path.join(stateDir, MARK_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(mark, null, 2)}\n`, { mode: 0o600 });
  replaceFile(tmp, file);
}

/**
 * The mark of `plan`'s copy, with `state` and more facts (`at`: when this copy began; `madeUntil`: when the move's own
 * writes into it ended, after which a change is someone else's). An earlier copy's switch is not carried over: that
 * copy was set aside before this one began. That the user's dashboard ran in this home once is (`usedBefore`): no later
 * stop then says that nothing left there is in use (leftLines).
 */
export const markOf = (plan, state, more = {}) => ({
  user: plan.user.name,
  home: plan.user.home,
  parts: plan.parts.filter((p) => p.id !== 'ssh').map((p) => p.to),
  at: new Date().toISOString(),
  madeUser: !!(plan.madeUser || plan.again?.madeUser),
  ...((usedCopy(plan.again) || plan.again?.usedBefore) && { usedBefore: true }),
  state,
  ...more,
});

/** Is every folder from `home` down to `p`'s parent a real folder (no link the user could have put in its way)? */
function plainPath(home, p, lstat) {
  const rel = path.posix.relative(home, p);
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) return false;
  let at = home;
  for (const part of rel.split('/').slice(0, -1)) {
    at = path.posix.join(at, part);
    try {
      if (!lstat(at).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The states in which the user's dashboard may run on the copy: the move stops until a step back. */
export const LIVE_STATES = ['switching', 'switched'];
export const isLive = (mark) => !!mark && LIVE_STATES.includes(mark.state);

/**
 * Did anything under `p` change after `sinceMs`? By ctime, which every write, chmod, rename or delete sets and no user
 * can set back (mtime he can), and by mtime. Links are looked at, never followed. A walk that cannot read counts as
 * changed: the doubt keeps the part.
 */
export function changedSince(p, sinceMs, { lstat = fs.lstatSync, readdir = fs.readdirSync } = {}) {
  if (!Number.isFinite(sinceMs)) return true;
  const stack = [p];
  while (stack.length) {
    const at = stack.pop();
    let st;
    try {
      st = lstat(at);
    } catch (e) {
      if (e.code === 'ENOENT' && at !== p) continue; // gone meanwhile
      return true;
    }
    if (st.ctimeMs > sinceMs || st.mtimeMs > sinceMs) return true;
    if (st.isDirectory()) {
      try {
        for (const n of readdir(at)) stack.push(path.join(at, n));
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * Clears the way for a new copy where an earlier run of the move made one (the mark's parts that are also this
 * plan's, and only those). A part of a copy that was never switched to, and in which nothing changed since the move's
 * own writes ended (mark.madeUntil), is the move's alone: taken away. Any other (the user's dashboard ran on it, it changed since,
 * or the end is not known) is set aside beside it as `<name>.before-<time>`, never deleted.
 * → { gone: [paths], aside: [[from, to, why ('switched' | 'changed')]] }. `rm`, `rename`, `lstat` and `readdir` are
 * handed in by tests.
 */
export function clearOwnCopy(plan, mark, { rm = (p) => fs.rmSync(p, { recursive: true, force: true }), rename = fs.renameSync, lstat = fs.lstatSync, readdir = fs.readdirSync, now = () => new Date() } = {}) {
  const ours = new Set(mark.parts);
  const stamp = now().toISOString().slice(0, 19).replace(/[-:]/g, '');
  const since = Date.parse(mark.madeUntil || '');
  const out = { gone: [], aside: [] };
  for (const p of plan.parts) {
    if (p.id === 'ssh' || !ours.has(p.to) || !plainPath(plan.user.home, p.to, lstat)) continue;
    try {
      lstat(p.to);
    } catch {
      continue; // not made that far
    }
    const why = mark.switchedAt || mark.switchingAt ? 'switched' : changedSince(p.to, since, { lstat, readdir }) ? 'changed' : null;
    if (why) {
      const to = `${p.to}.before-${stamp}`;
      rename(p.to, to);
      out.aside.push([p.to, to, why]);
    } else {
      rm(p.to);
      out.gone.push(p.to);
    }
  }
  return out;
}

/**
 * Did the user's dashboard (maybe) run on the copy of `mark`: it switched, was switching, or went back after that? Such a
 * copy may hold the user's own work, so it is set aside, never taken away, and no line offers a command that would.
 */
export const usedCopy = (mark) => !!mark && !!(mark.switchedAt || mark.switchingAt || ['switching', 'switched', 'back'].includes(mark.state));

/** The paths of `plan`'s parts (not .ssh, whose files sit beside the user's own) that a copy made (copyParts `made`). */
export const madeParts = (plan, made = []) => plan.parts.filter((p) => p.id !== 'ssh' && made.includes(p.to)).map((p) => p.to);

/**
 * What a stop leaves behind and the commands that go on and take it away, as lines: the one place that says them for
 * every stop of the move (runMove). A command that takes something away names only what this run made and no dashboard
 * of the user ran on: the parts this run's copy made (`made`, copyParts), and the user with its home only when this run
 * made the user, no earlier move's copy is in that home (plan.again; what was set aside, `kept`, comes from one) and
 * no dashboard of the user ran there (this run's switch stopped root's: `did` 'stop-root'). An earlier move's user,
 * home and copy are never offered: the user may have worked there since, and its dashboard may have run there
 * (usedCopy). `early`: a stop before this run cleared or made anything (the network look), where the copy left is the
 * earlier move's. `did`: what of the switch ran ('linger', 'install', 'stop-root').
 */
export function leftLines(plan, { did = [], made = [], kept = [], early = false } = {}) {
  const { user } = plan;
  const usedBefore = usedCopy(plan.again);
  const usedLine = `The earlier move's copy in ${user.home}, which ${user.name}'s dashboard ran on, is kept as it is: nothing of it is taken away, and the user ${user.name} stays.`;
  const keptLine = kept.length ? [`Kept as they were, never taken away: ${kept.join(', ')}.`] : [];
  if (early && usedBefore) return [usedLine, ...keptLine, `To go on: hoprig move-to-user --yes --user ${user.name} (it sets that copy aside beside it, never deleted, and copies again)`];
  const ranHere = did.includes('stop-root');
  const ranOnce = ranHere || usedBefore || !!plan.again?.usedBefore;
  const own = early ? [] : madeParts(plan, made);
  const copy = early ? !!plan.again : own.length > 0;
  const left = [];
  if (copy) left.push(`the copy in ${user.home}`);
  if (did.includes('install')) left.push(`Hoprig installed for ${user.name}`);
  const madeBy = plan.madeUser ? 'this move' : plan.again?.madeUser ? 'an earlier move' : null;
  if (did.includes('linger') || madeBy) left.push(`lingering for ${user.name}`);
  if (madeBy) left.push(`the user ${user.name} (made by ${madeBy})`);
  const out = [];
  if (left.length) out.push(`Left behind${ranOnce ? '' : ', none of it in use'}: ${left.join(', ')}. Root's installation works as before.`);
  if (ranHere) out.push(`${user.name}'s dashboard may have run on this copy (root's was stopped for the switch): it is kept as it is, and the user ${user.name} stays.`);
  else if (usedBefore) out.push(usedLine);
  out.push(...keptLine);
  // What the next run does: it reads this run's mark (runMove), which names only the parts this run's copy made.
  const goOn = ranHere
    ? 'it sets this copy aside beside it, never deleted, and copies again'
    : usedBefore
      ? `${own.length ? 'it takes away first what this run copied, unless it changed since, and copies again' : 'it copies again'}; the earlier copy stays as it is`
      : copy
        ? 'it takes this copy away first and copies again; a part changed since is set aside beside it, never deleted'
        : `it copies again; nothing in ${user.home} is written over or taken away`;
  out.push(`To go on: hoprig move-to-user --yes --user ${user.name} (${goOn})`);
  if (plan.madeUser && !plan.again && !kept.length && !ranHere) out.push(`To take it all away: rm -f /etc/sudoers.d/90-hoprig-${user.name} && loginctl disable-linger ${user.name} && userdel --remove ${user.name}`);
  else if (!ranHere && own.length) out.push(`To take the copy away: rm -r ${own.join(' ')}`);
  return out;
}
