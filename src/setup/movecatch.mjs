// After the switch of `hoprig move-to-user`: root's old sessions may have written more lines into their conversation
// files since the copy (a session writes when its dashboard stops, and again when its terminal ends). Every file of
// root's Claude Code project folders that differs from the user's copy is brought over when the copy is a clean
// beginning of it, byte for byte; a copy that is not is never overwritten: it is listed. Only then are root's idle
// terminals ended, each by its own tmux socket and session name (never by a process name or a pattern), and the files
// are compared again by content. Both places of a project in the user's Claude folder (its old name and its new
// path's name) are caught up. `io` is handed in by tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claudeSlug } from './movecopy.mjs';
import { capture } from './system.mjs';
import { appendIn, createIn } from './movesafe.mjs';

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Every file under `dir`, as paths relative to it, at any depth. */
function files(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names;
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** Is `a` (Buffer) a clean beginning of `b`: the same bytes, and no more of them? */
const beginsWith = (b, a) => a.length <= b.length && b.subarray(0, a.length).equals(a);

/** The pairs to compare: root's project folder → each of its places in the user's Claude folder. */
export function projectPairs(oldClaude, newClaude, oldHome, newHome) {
  const oldSlug = claudeSlug(oldHome);
  const newSlug = claudeSlug(newHome);
  let names = [];
  try {
    names = fs.readdirSync(path.join(oldClaude, 'projects'), { withFileTypes: true }).filter((e) => e.isDirectory() && (e.name === oldSlug || e.name.startsWith(`${oldSlug}-`))).map((e) => e.name);
  } catch {
    /* none */
  }
  return names.flatMap((name) => {
    const from = path.join(oldClaude, 'projects', name);
    return [name, newSlug + name.slice(oldSlug.length)].map((to) => ({ from, to: path.join(newClaude, 'projects', to), name: to }));
  });
}

/**
 * Bring over what root's side wrote after the copy. → { added: [names], grown: [names], kept: [names that are not a
 * clean beginning: listed, never overwritten], same }. `own(path)` gives a new file to the user.
 */
export function catchUp(pairs, { own = () => {}, home = null } = {}) {
  const r = { added: [], grown: [], kept: [], same: 0 };
  // The user's home: written there only through plain folders, never through a link (movesafe.mjs).
  const top = (to) => home || path.dirname(path.dirname(path.dirname(to)));
  for (const { from, to, name } of pairs) {
    for (const rel of files(from)) {
      const a = path.join(from, rel);
      const b = path.join(to, rel);
      const label = `${name}/${rel}`;
      const root = fs.readFileSync(a);
      let copy = null;
      let st = null;
      try {
        st = fs.lstatSync(b);
        copy = st.isFile() ? fs.readFileSync(b) : null;
      } catch {
        /* none: written by root's side after the copy */
      }
      try {
        if (st && !st.isFile()) r.kept.push(label); // a link or a folder put there: never written through
        else if (copy === null) {
          createIn(top(to), b, root, { mode: fs.statSync(a).mode & 0o777, own });
          r.added.push(label);
        } else if (copy.equals(root)) r.same += 1;
        else if (beginsWith(root, copy)) {
          appendIn(top(to), b, root.subarray(copy.length));
          r.grown.push(label);
        } else r.kept.push(label);
      } catch {
        r.kept.push(label); // something in the way (a link the user's side put there): listed, never written through
      }
    }
  }
  return r;
}

/** Compare every file of the pairs by content: { same, total, differ: [names] }. */
export function compareAll(pairs) {
  const r = { same: 0, total: 0, differ: [] };
  for (const { from, to, name } of pairs) {
    for (const rel of files(from)) {
      r.total += 1;
      let ok = false;
      try {
        ok = hash(path.join(from, rel)) === hash(path.join(to, rel));
      } catch {
        /* missing */
      }
      if (ok) r.same += 1;
      else r.differ.push(`${name}/${rel}`);
    }
  }
  return r;
}

/**
 * End root's idle terminals the look listed, each by its own socket and session: `tmux -S <socket> kill-session -t
 * =<session>` (the "=" takes the name exactly, never a start of it). → [{ socket, session, ok }].
 */
export async function endTerminals(terminals, { run = capture } = {}) {
  const out = [];
  for (const t of terminals || []) {
    if (!t || typeof t.socket !== 'string' || !path.isAbsolute(t.socket) || typeof t.session !== 'string' || !t.session) continue;
    const r = await run(['tmux', '-S', t.socket, 'kill-session', '-t', `=${t.session}`], { timeout: 10_000 });
    out.push({ socket: t.socket, session: t.session, ok: !!r.ok });
  }
  return out;
}

/** The lines of the catch-up, the ending and the second comparison, for the command line and the page's job. */
export function catchLines(c, ended, again) {
  const lines = [];
  lines.push(`Conversation lines written by root's side after the copy: ${c.grown.length + c.added.length ? `brought over in ${c.grown.length + c.added.length} file(s)` : 'none'}.`);
  if (c.kept.length) lines.push(`Not brought over, because the copy is not a clean beginning of root's file (both are kept as they are): ${c.kept.join(', ')}`);
  for (const t of ended) lines.push(`Root's terminal ${t.session} ${t.ok ? 'ended' : 'could not be ended'} (tmux -S ${t.socket} kill-session -t =${t.session}).`);
  lines.push(`Conversation files compared by content: ${again.same} of ${again.total} the same.`);
  return lines;
}
