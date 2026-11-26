// The walk of an extra folder's links (needs.mjs): run once per session start, its result handed on to the settings.
//
// A shell command of the session follows links (`grep -R`), and deny rules cannot hold a shell command, so a folder is
// not opened when one of its links leads to the credentials folder as a whole or into the brain, to a folder that holds
// either, to a folder that holds a link into them, or out of the workspace (unless it is a link the owner named as his
// own: `hoprig workspace mylink add`). Allowed: its own credential links (a link to a file or a folder inside the
// credentials folder, what its own project sees too), on which Read is denied.
//
// A private folder (PRIVATE_DIRS: no-ai, ignore, ai-ignore-dir) is NEVER entered: not listed, not looked through, also
// when it is itself a link, also when a link leads into one elsewhere, and no name from inside one is ever shown. What
// keeps a link inside it from the session is that Read is denied to the file tools on the whole private folder
// (extraSettings); a shell command could still follow it, as it could in a session of that project itself. A link (not in
// a private folder) that leads into a private folder elsewhere is not walked either: it is returned (`privLinks`) and
// Read is denied on it and on where it leads.
//
// Every folder is walked, .git and node_modules too (git keeps links, so a cloned project can bring one anywhere), in
// pieces: the server's one thread is given back every PIECE entries and every SLICE_MS, and a folder that cannot be
// walked within WALK_MS is not opened ("too large to check").
import fs from 'node:fs';
import path from 'node:path';
import { FOLD, PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { myLinkCommand, realOf } from './inside.mjs';
import { isDir } from './layout.mjs';

export const WALK_MS = 5000;
export const PIECE = 1000;
const SLICE_MS = 20;

const fold = (p) => (FOLD ? String(p).toLowerCase() : String(p));
const within = (p, top) => {
  const a = fold(p);
  const b = fold(top);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
const overlap = (a, b) => within(a, b) || within(b, a);
// What a path in a rule of the coding tool may hold: its rules read * ? [ ] { } ( ) \ themselves.
export const RULE_SAFE = /^[A-Za-z0-9._/~+@ -]+$/;
/**
 * The absolute path `p` in the form a rule of the coding tool names it, before RULE_SAFE is asked. Elsewhere it is `p`
 * itself. On Windows Claude Code reads a path in a rule in POSIX form ("On Windows, paths are normalized to POSIX form
 * before matching. `C:\Users\alice` becomes `/c/Users/alice`", code.claude.com/docs/en/permissions), so `C:\a\b` is
 * `/c/a/b` (and `Read(//c/a/b)` its rule). → that form | null (on Windows, a path with no drive letter: a share
 * `\\server\share`, a `\\?\` path, one rooted without a drive; it cannot be named).
 */
export function ruleForm(p, platform = process.platform) {
  const s = String(p);
  if (platform !== 'win32') return s;
  const m = /^([A-Za-z]):[\\/]/.exec(s);
  if (!m) return null;
  return `/${[m[1].toLowerCase(), ...s.slice(3).split(/[\\/]+/).filter(Boolean)].join('/')}`;
}
/** Whether the absolute path `p` can be named in a rule of the coding tool on `platform`. */
export const nameable = (p, platform = process.platform) => {
  const f = ruleForm(p, platform);
  return f !== null && RULE_SAFE.test(f);
};
export const shown = (n) => String(n).slice(0, 100).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
export const isPrivate = (name) => PRIVATE_DIRS.includes(fold(name));
const LINK_SEP = process.platform === 'win32' ? /[\\/]/ : /\//;

/**
 * Where the link `p` leads, as realOf (inside.mjs) resolves it, but it stops BEFORE a private folder: no part named
 * like one is looked at (no lstat, no readlink), unless it is the workspace's or a folder's own place (`bases` lie in
 * it). → { real } | { at, rest } (the real folder that holds the private one, and the private part on) | null (a loop)
 */
export function resolveLink(p, bases = []) {
  const abs = path.resolve(p);
  const { root } = path.parse(abs);
  const todo = abs.slice(root.length).split(path.sep).filter(Boolean).reverse();
  let cur = root;
  let hops = 0;
  while (todo.length) {
    const part = todo.pop();
    if (part === '.') continue;
    if (part === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, part);
    if (isPrivate(part) && !bases.some((b) => within(b, next))) return { at: cur, rest: [part, ...todo.reverse()] };
    let st;
    try {
      st = fs.lstatSync(next);
    } catch {
      return { real: path.join(next, ...todo.reverse()) };
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops > 40) return null;
    let to;
    try {
      to = fs.readlinkSync(next);
    } catch {
      return null;
    }
    const top = path.isAbsolute(to) ? path.parse(to).root : '';
    if (top) cur = top;
    todo.push(...to.slice(top.length).split(LINK_SEP).filter(Boolean).reverse());
  }
  return { real: cur };
}

/**
 * The owner's own links as the walk meets them: their real parent folder and name → where each pointed when he named
 * it. `entries`: [{ path, to }] (inside.mjs myLinkEntries).
 */
export function mineOf(entries) {
  const out = new Map();
  for (const e of entries || []) {
    const parent = realOf(path.dirname(e.path)) || path.dirname(e.path);
    out.set(fold(path.join(parent, path.basename(e.path))), e.to);
  }
  return out;
}

/**
 * Walk the extra folder `d` (its real path). `creds`, `brain`: their real paths; `bounds`: the real workspace and
 * projects folder; `mine`: mineOf(). → { credLinks, privLinks: [{ link: path relative to d, to: real path }] } |
 * { why, mylink? }
 */
export async function linkWalk(d, { creds, brain, bounds = [], mine = new Map(), limitMs = WALK_MS, now = () => performance.now(), platform = process.platform }) {
  const credLinks = [];
  const privLinks = [];
  // `d`, then each folder it does not hold that one of its links leads to (`via`: that link, from d).
  const tops = [{ dir: d, via: '' }];
  const fence = [[creds, 'the credentials folder'], [brain, 'the AI brain']].filter(([x]) => x);
  // Inside, for a link: the workspace, the projects folder, the folder itself, and where an owner's own link leads.
  const owned = [d];
  const inside = (to) => bounds.some((b) => within(to, b)) || owned.some((o) => within(to, o));
  const start = now();
  let last = start;
  let count = 0;
  // A turn given back to the server's thread now and then; true when the walk took too long.
  const turn = async () => {
    if (++count % PIECE !== 0 && now() - last < SLICE_MS) return false;
    await new Promise((r) => setImmediate(r));
    last = now();
    return last - start > limitMs;
  };
  const tooLarge = { why: `it is too large to check where its links lead within ${Math.round(limitMs / 1000)} seconds` };
  for (let i = 0; i < tops.length; i++) {
    const { dir: top, via } = tops[i];
    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      let dir;
      try {
        dir = fs.opendirSync(path.join(top, rel), { bufferSize: 256 });
      } catch {
        continue;
      }
      try {
        for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
          if (await turn()) return tooLarge;
          if (isPrivate(e.name)) continue; // never entered, never looked through: as a folder or as a link
          const r = rel ? `${rel}/${e.name}` : e.name;
          const name = shown(via ? `${via}/${r}` : r);
          if (e.isSymbolicLink()) {
            const link = path.join(top, r);
            const at = via ? `${via}/${r}` : r;
            const res = resolveLink(link, [...bounds, d]);
            if (!res) continue; // a loop of links: nothing is read through it
            const own = mine.has(fold(link)) && (res.at !== undefined || mine.get(fold(link)) === res.real);
            if (res.at !== undefined) {
              // It leads into a private folder: never entered. Read is denied on the link and on where it leads.
              const priv = path.join(res.at, res.rest[0]);
              const to = path.join(res.at, ...res.rest);
              if (!own && !inside(priv)) return { why: `its link ${name} leads out of the workspace (into ${shown(priv)})`, mylink: myLinkCommand(link) };
              for (const [x, what] of fence) if (overlap(priv, x)) return { why: `its link ${name} leads into ${what}` };
              if (!RULE_SAFE.test(at) || !nameable(to, platform)) return { why: `its link ${name} leads into a private folder and has a character the coding tool's rules cannot name` };
              privLinks.push({ link: at, to });
              continue;
            }
            const to = res.real;
            const hit = fence.find(([x]) => overlap(to, x));
            if (hit) {
              const into = within(to, hit[0]) && fold(to) !== fold(hit[0]);
              if (i === 0 && into && hit[0] === creds) {
                if (!RULE_SAFE.test(r)) return { why: `its credential link ${name} has a character the coding tool's rules cannot name` };
                credLinks.push(r);
                continue;
              }
              return { why: `its link ${name} leads ${into ? 'into' : fold(to) === fold(hit[0]) ? 'to' : 'to a folder that holds'} ${hit[1]}` };
            }
            if (own) owned.push(to);
            else if (!inside(to)) return { why: `its link ${name} leads out of the workspace (to ${shown(to)})`, mylink: myLinkCommand(link) };
            if (!tops.some((t) => within(to, t.dir)) && isDir(to)) tops.push({ dir: to, via: at });
          } else if (e.isDirectory()) stack.push(r);
        }
      } finally {
        dir.closeSync();
      }
    }
  }
  return { credLinks, privLinks };
}
