// Credentials move from one computer of the owner's to another by his press only (docs/WORKSPACE.md, "Credentials").
// The four legs, each for the owner's own page only (credweb.mjs routes; never Tia, a script's or a session's token):
//   expect   on the RECEIVER: a one-time nonce (valid a few minutes, used once) and its public keys;
//   pack     on the SENDER: the files (one project's credential targets, or everything), sealed for the receiver whose
//            key is the pinned one from the AI brain (transferkeys.mjs), the nonce in the header;
//   (relay)  the main computer, or the browser, carries only the sealed bytes: never a key, a name or a value in clear;
//   receive  on the RECEIVER: opens it in memory (receiver, sender's signature, age, nonce), says what would happen (a
//            dry run: names, sizes, new / same / different; never a value or a hash), and on the owner's second call
//            writes through a temporary folder inside the credentials folder: 600 in 700, never over a different file
//            unless the owner asks to replace, never through a link, then makes the project's credential links.
// A computer the owner marked as not his own gets no "everything": one project at a time, its name typed each time.
// The log (state folder, credmove.log) and the Activity line say what moved in counts and the computer's name, never a
// file's content or hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { recordHubActivity } from '../machines/tokenaudit.mjs';
import { replaceFile } from '../replacefile.mjs';
import { capture } from '../setup/system.mjs';
import { cleanLabel, computersHere, thisComputer } from './computer.mjs';
import { credLinksHere, credsDir, makeCredLinks } from './credlinks.mjs';
import { ensureKeys, open, peerKeys, seal } from './transferkeys.mjs';

// `details`: what the server puts in its answer besides the message, so a page can tell a changed key from a stale list.
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code, details: { code } } : {}) });

export const MAX_SEALED = 8 * 1024 * 1024;
const MAX_PLAIN = 6 * 1024 * 1024;
const MAX_FILES = 3000;
export const NONCE_MS = 5 * 60 * 1000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TMP = '.credmove-';

// ---- the receiver's one-time nonce ----

const noncesFile = () => path.join(stateDir(), 'credmove-nonces.json');
function readNonces(now) {
  let n = {};
  try {
    n = JSON.parse(fs.readFileSync(noncesFile(), 'utf8'));
  } catch {
    /* none yet */
  }
  const live = {};
  for (const [k, v] of Object.entries(n && typeof n === 'object' ? n : {})) if (v && Number.isFinite(v.exp) && v.exp > now) live[k] = v;
  return live;
}
function writeNonces(n) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${noncesFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(n), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  replaceFile(tmp, noncesFile());
}

/** A new one-time nonce, for the computer `from` (a label) or for any. → { nonce, expires } */
export function issueNonce({ from = null, now = Date.now() } = {}) {
  const n = readNonces(now);
  const nonce = crypto.randomBytes(16).toString('hex');
  n[nonce] = { exp: now + NONCE_MS, ...(from ? { from } : {}) };
  writeNonces(n);
  return { nonce, expires: now + NONCE_MS };
}

/** Is this nonce good now (known, not used, not expired, for this sender)? Throws 403 when not. Uses nothing. */
export function checkNonce(nonce, { from, now = Date.now() } = {}) {
  const v = typeof nonce === 'string' && NONCE_RE.test(nonce) ? readNonces(now)[nonce] : null;
  if (!v) throw fail(403, 'the one-time number of this move is used or too old: start it again', 'nonce');
  if (v.from && v.from !== from) throw fail(403, 'the one-time number of this move was made for another computer', 'nonce');
  return v;
}

/** The nonce is used up: it never works again. */
export function useNonce(nonce, opts = {}) {
  checkNonce(nonce, opts);
  const n = readNonces(opts.now ?? Date.now());
  delete n[nonce];
  writeNonces(n);
}

// ---- the log, without a value ----

const logFile = () => path.join(stateDir(), 'credmove.log');
/** One line per leg: when, which leg, who asked (page or hub), the other computer, counts, the outcome. No name of a file. */
export function logLeg(entry) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* a log is a convenience */
  }
}

// ---- files ----

const SEG = /^[A-Za-z0-9._@+=,~ -]{1,120}$/;
/** A relative path inside the credentials folder: plain segments, none `.`, `..` or a `.git`, never a hidden move folder. */
export function cleanRel(p) {
  if (typeof p !== 'string' || p.length > 300 || p.startsWith('/') || p.includes('\\')) return null;
  const parts = p.split('/');
  return parts.every((s) => SEG.test(s) && s !== '.' && s !== '..' && s !== '.git' && !s.startsWith(TMP)) ? parts.join('/') : null;
}

const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** The files under `rel` of `root` (a real folder), as { p, size, mode }; a link or a special file is skipped and counted. */
function walk(root, rel, out, skipped) {
  const here = path.join(root, ...rel.split('/').filter(Boolean));
  const st = lst(here);
  if (!st) return;
  if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return void skipped.n++;
  if (st.isFile()) {
    if (cleanRel(rel)) out.push({ p: rel });
    else skipped.n++;
    return;
  }
  for (const name of fs.readdirSync(here).sort()) {
    if (name === '.git' || name.startsWith(TMP)) continue;
    walk(root, rel ? `${rel}/${name}` : name, out, skipped);
  }
}

/** What a scope sends: [{ p, data }] and how many were left out (links, special files, names that are not plain). */
async function collect({ dir, projects, scope, run }) {
  const creds = credsDir(dir);
  let root;
  try {
    root = fs.realpathSync(creds);
  } catch {
    throw fail(409, 'there is no credentials folder on this computer', 'no-creds');
  }
  const found = [];
  const skipped = { n: 0 };
  if (scope.all) walk(root, '', found, skipped);
  else {
    const { projectsHere } = await import('./where.mjs');
    const { readManifest } = await import('../pcsetup/workspace.mjs');
    const f = (await projectsHere({ dir, projects })).find((x) => (x.ref || x.name) === scope.project);
    if (!f) throw fail(404, `${scope.project} is not a project on this computer`);
    const m = await readManifest(f.dir, run);
    const targets = Object.values((m.manifest && m.manifest.credentials) || {});
    if (!targets.length) throw fail(409, `${scope.project} names no credentials in its project.json`);
    for (const t of targets) {
      const rel = String(t).split('/').filter(Boolean).join('/');
      if (!rel || rel.split('/').some((s) => s === '..' || s === '.')) continue;
      walk(root, rel, found, skipped);
    }
  }
  const files = [];
  let bytes = 0;
  const seen = new Set();
  for (const { p } of found) {
    if (seen.has(p)) continue;
    seen.add(p);
    // Each component is checked again as it is read: a link on the way is never followed.
    let cur = root;
    let ok = true;
    for (const part of p.split('/')) {
      cur = path.join(cur, part);
      const st = lst(cur);
      if (!st || st.isSymbolicLink()) ok = false;
    }
    if (!ok) {
      skipped.n++;
      continue;
    }
    const data = fs.readFileSync(cur);
    bytes += data.length;
    if (bytes > MAX_PLAIN || files.length >= MAX_FILES) throw fail(413, 'there is more than one move can carry (6 MB, 3000 files): move one project at a time', 'too-big');
    files.push({ p, data });
  }
  if (!files.length) throw fail(409, 'there are no credential files to send for that', 'empty');
  return { files, bytes, skipped: skipped.n };
}

// ---- who is not the owner's own ----

/** Is the computer `label` marked as not the owner's own? By its file in the brain, or by this main computer's own list (`machine`). */
export function notOwn({ dir, label, machineOwn = null }) {
  if (machineOwn === false) return true;
  const f = computersHere(dir).files.find((x) => x.label === label);
  return Boolean(f && f.own === false);
}

// ---- pack (the sender) ----

/**
 * The sealed message for the computer `to`. scope: { all: true } | { project: name }. `machineOwn`: the main computer's
 * own mark of that computer (store.mjs), false = not the owner's own. `typed`: for a computer that is not his own, its
 * name as the owner typed it. → { sealed (bytes), files, bytes, skipped }
 */
export async function packFor({ dir, projects, to, nonce, scope, typed, machineOwn = null, by = 'page', now = Date.now(), run = capture }) {
  const me = thisComputer();
  if (!me.label || !me.id) throw fail(409, 'this computer has no label in the workspace yet: give it one first (hoprig workspace label)');
  const target = cleanLabel(to);
  if (!target || target === me.label) throw fail(400, 'say the other computer by its label');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw fail(400, 'the one-time number is missing: start the move again');
  const sc = scope && scope.all === true && !scope.project ? { all: true } : scope && typeof scope.project === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(scope.project) && !scope.all ? { project: scope.project } : null;
  if (!sc) throw fail(400, 'say what to send: all, or one project');
  const strange = notOwn({ dir, label: target, machineOwn });
  if (strange && sc.all) throw fail(403, `${target} is marked as not your own computer: it gets credentials one project at a time, never everything`, 'not-own');
  if (strange && typed !== target) throw fail(400, `${target} is marked as not your own computer: type its name (${target}) to send it a project`, 'type-name');
  ensureKeys();
  const peer = peerKeys({ label: target, dir });
  const c = await collect({ dir, projects, scope: sc, run });
  const plain = Buffer.from(JSON.stringify({ files: c.files.map((f) => ({ p: f.p, d: f.data.toString('base64') })) }));
  const sealed = seal({ me: { label: me.label, id: me.id }, to: { label: target, id: peer.id, x25519: peer.x25519 }, nonce, scope: sc, plain, now });
  if (sealed.length > MAX_SEALED) throw fail(413, 'there is more than one move can carry (8 MB): move one project at a time', 'too-big');
  logLeg({ leg: 'pack', by, to: target, scope: sc.all ? 'all' : `project ${sc.project}`, files: c.files.length, bytes: c.bytes, skipped: c.skipped });
  return { sealed, files: c.files.length, bytes: c.bytes, skipped: c.skipped };
}

// ---- receive (the receiver) ----

/** The files of an opened message, checked: [{ p, data }]. */
function filesOf(plain) {
  let j;
  try {
    j = JSON.parse(plain.toString('utf8'));
  } catch {
    throw fail(400, 'the message holds no list of files');
  }
  if (!j || !Array.isArray(j.files) || j.files.length > MAX_FILES) throw fail(400, 'the message holds no list of files');
  const seen = new Set();
  return j.files.map((f) => {
    const p = f && cleanRel(f.p);
    if (!p || typeof f.d !== 'string' || seen.has(p.toLowerCase())) throw fail(400, 'a file of the message has a name that is not allowed');
    seen.add(p.toLowerCase());
    return { p, data: Buffer.from(f.d, 'base64') };
  });
}

/** What would happen to each file here: [{ p, size, state: new | same | different | blocked }], read only. */
function plan(root, files) {
  return files.map((f) => {
    let cur = root;
    const parts = f.p.split('/');
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      const st = lst(cur);
      if (!st) return { p: f.p, size: f.data.length, state: 'new' };
      if (st.isSymbolicLink()) return { p: f.p, size: f.data.length, state: 'blocked' };
      if (i < parts.length - 1) {
        if (!st.isDirectory()) return { p: f.p, size: f.data.length, state: 'blocked' };
      } else if (!st.isFile()) return { p: f.p, size: f.data.length, state: 'blocked' };
      else return { p: f.p, size: f.data.length, state: fs.readFileSync(cur).equals(f.data) ? 'same' : 'different' };
    }
    return { p: f.p, size: f.data.length, state: 'blocked' };
  });
}

const seenOf = (items) => crypto.createHash('sha256').update(JSON.stringify(items.map((i) => [i.p, i.size, i.state]))).digest('hex').slice(0, 16);

/** Write what the plan says, through a temporary folder inside the credentials folder: every file 600, every new folder 700. */
function write(root, items, files, replace) {
  const tmp = path.join(root, `${TMP}${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { mode: 0o700 });
  fs.chmodSync(tmp, 0o700);
  const todo = items.map((it, i) => ({ it, f: files[i], i })).filter(({ it }) => it.state === 'new' || (it.state === 'different' && replace));
  try {
    for (const { f, i } of todo) {
      const t = path.join(tmp, String(i));
      fs.writeFileSync(t, f.data, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(t, 0o600);
    }
    for (const { f, i } of todo) {
      const parts = f.p.split('/');
      let cur = root;
      for (const part of parts.slice(0, -1)) {
        cur = path.join(cur, part);
        const st = lst(cur);
        if (!st) {
          fs.mkdirSync(cur, { mode: 0o700 });
          fs.chmodSync(cur, 0o700);
        } else if (st.isSymbolicLink() || !st.isDirectory()) throw fail(409, 'a folder on the way is not a plain folder: nothing more was written', 'blocked');
      }
      const dest = path.join(root, ...parts);
      const st = lst(dest);
      if (st && (st.isSymbolicLink() || !st.isFile())) throw fail(409, 'something that is not a plain file is in the way: nothing more was written', 'blocked');
      replaceFile(path.join(tmp, String(i)), dest);
      fs.chmodSync(dest, 0o600);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return todo.length;
}

/** Make the links of the projects the message was for (all projects here, for everything). → how many were made */
async function linkAfter({ dir, projects, scope, run }) {
  let made = 0;
  try {
    for (const e of await credLinksHere({ dir, projects, run })) {
      if (scope.project && e.ref !== scope.project) continue;
      makeCredLinks(e.root, e.plan, { at: { dir, projects } });
      made += e.plan.filter((x) => x.state === 'made').length;
    }
  } catch {
    /* the links are made by the next get or workspace link */
  }
  return made;
}

/**
 * The receiving leg. `dryRun`: open it and say what would happen (names, sizes, states; the nonce is not used, nothing
 * is written). Real: `seen` is the id of the list the owner saw; the nonce is used up first, then it is written, then
 * the links are made. `replace`: different files are replaced too (the owner's second press), else they are left.
 * → { ok, from, scope, items, seen, ... }
 */
export async function receiveSealed({ dir, projects, sealed, dryRun = true, replace = false, seen, by = 'page', now = Date.now(), run = capture }) {
  if (!Buffer.isBuffer(sealed) || !sealed.length || sealed.length > MAX_SEALED) throw fail(400, 'there is no sealed message, or it is too large');
  const me = thisComputer();
  if (!me.label || !me.id) throw fail(409, 'this computer has no label in the workspace yet: give it one first (hoprig workspace label)');
  ensureKeys();
  const { header, plain } = open(sealed, {
    me: { label: me.label, id: me.id },
    peerOf: (label, id) => {
      const p = peerKeys({ label, dir });
      if (p.id !== id) throw fail(403, 'the sender\'s id is not the one in your AI brain', 'key-changed');
      return p.ed25519;
    },
    now,
  });
  checkNonce(header.nonce, { from: header.from, now });
  const sc = header.scope && header.scope.all === true ? { all: true } : header.scope && typeof header.scope.project === 'string' ? { project: header.scope.project } : null;
  if (!sc) throw fail(400, 'the message says nothing about what it holds');
  if (me.notMine && sc.all) throw fail(403, 'this computer is marked as not yours: it takes credentials one project at a time, never everything', 'not-own');
  const files = filesOf(plain);
  const creds = credsDir(dir);
  let root;
  try {
    root = fs.realpathSync(creds);
  } catch {
    root = null;
  }
  // A credentials folder that is not here is made (700) only by a real call; a dry run reads.
  const items = plan(root || path.join(creds, '.none'), files);
  const id = seenOf(items);
  const base = { ok: true, from: header.from, scope: sc, items, seen: id, differ: items.filter((i) => i.state === 'different').length };
  if (dryRun) return { ...base, dryRun: true };
  if (seen !== id) throw fail(409, 'what would land changed since you looked: look again', 'stale');
  useNonce(header.nonce, { from: header.from, now });
  if (!root) {
    fs.mkdirSync(creds, { recursive: true, mode: 0o700 });
    root = fs.realpathSync(creds);
    fs.chmodSync(root, 0o700);
  }
  let wrote = 0;
  try {
    wrote = write(root, items, files, replace === true);
  } catch (e) {
    logLeg({ leg: 'receive', by, from: header.from, scope: sc.all ? 'all' : `project ${sc.project}`, result: 'stopped', why: e.code || 'error' });
    throw e;
  }
  const linked = await linkAfter({ dir, projects, scope: sc, run });
  const counts = { wrote, replaced: replace ? items.filter((i) => i.state === 'different').length : 0, same: items.filter((i) => i.state === 'same').length, kept: replace ? 0 : base.differ, blocked: items.filter((i) => i.state === 'blocked').length, linked };
  logLeg({ leg: 'receive', by, from: header.from, scope: sc.all ? 'all' : `project ${sc.project}`, result: 'ok', ...counts });
  recordHubActivity(`Credentials came from ${header.from}: ${wrote} ${wrote === 1 ? 'file' : 'files'} written${counts.kept ? `, ${counts.kept} left as they were` : ''}`);
  return { ...base, ...counts, kept: counts.kept };
}
