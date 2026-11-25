// This computer in the workspace: its label, its id, and its own file in the brain.
//
//   ai_brain/computers/<label>.json   written by this computer ONLY (one writer per file, so two computers never
//                                     conflict in it): its random id, its Hoprig version, what of the map is checked
//                                     out here, and a description of the four folders that are not in git.
//
// The label is the owner's own short name for the computer (lower-case letters, digits, "-" and "_", the name the
// dashboard's list of computers uses too). It is asked ONCE, at set-up (the host name is only offered as a
// suggestion and is never stored), and kept in Hoprig's own settings with the id: { computer: { label, id } }. The
// id is made once on this computer, at random: a label whose file holds another id belongs to another computer,
// and set-up refuses it unless the owner says this computer IS that one, set up again after a format; its file
// then starts again with an empty list of what is here. The upkeep and every other command never ask: a computer
// without a label writes no file, and `workspace status` says so.
//
// The file holds names and counts only: never a path of this computer, a host name, an address, a token or a
// password. A name that is not plain, that looks like a secret or holds this computer's host name is counted, not
// named. Every file of the folder is read strictly (computersHere): one that fails is named and not used.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { hostName } from '../paths.mjs';
import { looksSecret } from '../assistant/secrets.mjs';
import { VERSION } from '../machines/pairing.mjs';
import { MACHINE_RE } from '../machines/names.mjs';
import { gitIn, kindAt, leaves, leavesWords, mkdirIn, readIn, writeIn } from './inside.mjs';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { DEV_TMP_PREFIX, isDir, isGitRepo, isLinkedWorktree, projectsIn, remoteOf, workspaceDir } from './layout.mjs';
import { devTools } from '../pcsetup/devplaces.mjs';
import { mapTargets } from './groups.mjs';
import { readMap, sameUrl } from './map.mjs';

export const COMPUTERS = 'computers';
/** The four folders of the tree that are never put in git: described, never their content. */
export const DESCRIBED = ['development', 'git', 'database', 'backups'];
const ID_RE = /^[0-9a-f]{32}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}([-+][0-9A-Za-z.-]{1,30})?$/;
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const MAX_ITEMS = 100;
// A file that looks like a credential (a key, a keystore, a token or password file, an .env) is counted, not named.
const KEYISH = /^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks|kdbx|env)$|secret|token|passw|credential|\bauth\b/i;
// The owner's marks of the whole-computer check (leavemarks.mjs), key "leave": folders of the home by a home-relative
// name ("~/.toolx", never a path of this computer), and the database engines that hold test data only.
export const LEAVE_LISTS = ['keep', 'ignore', 'outside'];
export const LEAVE_ENGINES = ['postgresql', 'mysql', 'mariadb'];
export const LEAVE_MAX = 500;
/** This computer's host name as a file of the brain must never hold it (the part before the first dot, lower case). */
export const hostWord = () => String(hostName() || '').split('.')[0].toLowerCase();
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/** A label as typed: trimmed and in lower case, then the computers list's own rule. → the label, or null. */
export function cleanLabel(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return MACHINE_RE.test(s) ? s : null;
}
export const LABEL_RULE = 'a label is 1 to 32 lower-case letters, digits, "-" and "_", starting with a letter or a digit';

/**
 * This computer's label and id from Hoprig's own settings: { label: string|null, id: string|null, wrote: [hash] } (`wrote`:
 * the hashes of the last versions of its own file it wrote, newest first).
 */
export function thisComputer() {
  try {
    const c = loadConfig().computer;
    const wrote = c && Array.isArray(c.wrote) ? c.wrote.filter((h) => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)) : [];
    return { label: c && cleanLabel(c.label) === c.label ? c.label : null, id: c && ID_RE.test(c.id || '') ? c.id : null, wrote };
  } catch {
    return { label: null, id: null, wrote: [] };
  }
}

// How many versions of its own file a computer remembers having written. A version the git server holds may be older
// than the newest here (the map's rule moves the brain to the server's commit, which brings that older version back).
const WROTE_KEPT = 20;
const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Remember that this computer wrote `text` as its own file. `kept`: the hash of the version the brain's git server
 * holds (as the last fetch saw it). When it is one this computer wrote, it is never dropped from the list, however many
 * versions were saved here since without reaching the server (pushing off, offline): the map's rule may bring exactly
 * that version back, and it is still this computer's own.
 */
function rememberWrote(text, kept = null) {
  const c = loadConfig().computer || {};
  const before = thisComputer().wrote;
  const wrote = [hashOf(text), ...before.filter((h) => h !== hashOf(text))].slice(0, WROTE_KEPT);
  if (kept && before.includes(kept) && !wrote.includes(kept)) wrote[WROTE_KEPT - 1] = kept;
  saveConfig({ computer: { ...c, wrote } });
}

/** The hash of this label's file in the brain's upstream branch, as the last fetch brought it (no fetch): or null. */
async function upstreamHash(brain, label) {
  if (!isGitRepo(brain)) return null;
  const r = await gitRead(brain, ['show', `@{u}:${relFileOf(label)}`]);
  return r.ok ? hashOf(r.stdout) : null;
}

/** The host name, as a label: only ever offered, never stored without the owner's word. */
export function suggestLabel(host = hostName()) {
  const s = String(host || '').split('.')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 32);
  return MACHINE_RE.test(s) ? s : 'computer';
}

const folderOf = (dir) => path.join(dir, 'ai_brain', COMPUTERS);
export const fileOf = (label, dir = workspaceDir()) => path.join(folderOf(dir), `${label}.json`);
/** The file's name inside the brain, as git and the commit see it. */
export const relFileOf = (label) => `${COMPUTERS}/${label}.json`;

// ---- reading ----

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why a name of a home folder may not be a mark, in one sentence; null when it may. */
export function leaveNameWhy(name, host = hostWord()) {
  if (typeof name !== 'string' || !name.startsWith('~/') || name.length > 300) return 'a folder is named from the home folder, starting with "~/"';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'a folder\'s name may not hold a control character';
  if (name.slice(2).split('/').some((p) => p === '..' || p === '.' || p === '')) return 'a folder\'s name may not hold ".", ".." or an empty part';
  if (host && host.length >= 3 && name.toLowerCase().includes(host)) return 'a folder\'s name may not hold this computer\'s host name (the file is shared through the brain)';
  return null;
}

function leaveWhy(v, host) {
  if (!isObj(v) || Object.keys(v).some((k) => ![...LEAVE_LISTS, 'testData'].includes(k))) return '"leave" holds other things than keep, ignore, outside and testData';
  for (const k of LEAVE_LISTS) {
    const l = v[k];
    if (l !== undefined && (!Array.isArray(l) || l.length > LEAVE_MAX || l.some((n) => leaveNameWhy(n, host)))) return `"leave.${k}" is not a list of at most ${LEAVE_MAX} folders of the home ("~/…")`;
  }
  if (v.testData !== undefined && (!Array.isArray(v.testData) || v.testData.some((e) => !LEAVE_ENGINES.includes(e)))) return `"leave.testData" names an engine other than ${LEAVE_ENGINES.join(', ')}`;
  return null;
}

/** The marks as the file keeps them: each list sorted, without repeats; empty lists left out; null when none. */
export function leaveOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of [...LEAVE_LISTS, 'testData']) if (Array.isArray(v[k]) && v[k].length) out[k] = [...new Set(v[k])].sort();
  return Object.keys(out).length ? out : null;
}

/**
 * The strict check of one computer's file. A key a later Hoprig adds is kept, never a refusal. `host`: this computer's
 * host name, handed in for its OWN file only (another computer's mark that happens to hold it is that computer's word,
 * and must not make its whole file unreadable here). → { ok, file?, why? }
 */
export function checkComputerFile(raw, label, host = null) {
  if (!isObj(raw)) return { ok: false, why: 'it is not a JSON object' };
  if (raw.label !== label) return { ok: false, why: 'its label is not its file name' };
  if (!ID_RE.test(raw.id || '')) return { ok: false, why: 'its id is not 32 hexadecimal digits' };
  if (raw.hoprig !== undefined && (typeof raw.hoprig !== 'string' || !VERSION_RE.test(raw.hoprig))) return { ok: false, why: 'its Hoprig version is not a version' };
  if (!Array.isArray(raw.here) || raw.here.length > 5000 || raw.here.some((x) => typeof x !== 'string' || !ENTRY_RE.test(x) || x.split('/').includes('..'))) return { ok: false, why: '"here" is not a list of names of the map' };
  if (raw.folders !== undefined && (!isObj(raw.folders) || Object.keys(raw.folders).some((k) => !DESCRIBED.includes(k)))) return { ok: false, why: '"folders" describes other folders than development, git, database and backups' };
  const lw = raw.leave === undefined ? null : leaveWhy(raw.leave, host);
  if (lw) return { ok: false, why: lw };
  return { ok: true, file: raw };
}

/**
 * Every computer's file in the brain, read strictly. The folder and each file are read only really inside the brain,
 * never through a link. → { files: [{ label, id, hoprig, here, folders }], refused: [{ name, why }], folderWhy? }
 */
export function computersHere(dir = workspaceDir()) {
  const brain = path.join(dir, 'ai_brain');
  const folder = folderOf(dir);
  const out = { files: [], refused: [] };
  const mine = thisComputer().label;
  if (kindAt(folder) === 'none') return out;
  const b = leaves(brain, folder, { dir }, { below: true });
  if (b || kindAt(folder) !== 'other') return { ...out, folderWhy: b ? `${leavesWords(b)}: not read` : `ai_brain/${COMPUTERS} is not a folder: not read` };
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { ...out, folderWhy: `ai_brain/${COMPUTERS} could not be read` };
  }
  for (const name of names) {
    const label = name.slice(0, -5);
    if (!MACHINE_RE.test(label)) {
      out.refused.push({ name, why: LABEL_RULE });
      continue;
    }
    const buf = readIn({ root: brain, dir }, path.join(folder, name), { below: true });
    if (!buf) {
      out.refused.push({ name, why: 'it is a link or cannot be read' });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      out.refused.push({ name, why: 'it is not valid JSON' });
      continue;
    }
    // The host name is checked when a mark is written (leavemarks.mjs), not here: a host renamed later must not make
    // this computer's own file unreadable (readMarks leaves such a mark out instead).
    const c = checkComputerFile(raw, label);
    // A refused file still says which Hoprig wrote it, when it does (the version gate reads it, mapupgrade.mjs).
    if (!c.ok) out.refused.push({ name, why: c.why, ...(isObj(raw) && typeof raw.hoprig === 'string' && VERSION_RE.test(raw.hoprig) ? { hoprig: raw.hoprig } : {}) });
    else out.files.push({ label, id: raw.id, hoprig: raw.hoprig || null, here: [...raw.here], folders: raw.folders || {}, ...(leaveOf(raw.leave) ? { leave: leaveOf(raw.leave) } : {}) });
  }
  return out;
}

// ---- describing the four folders ----

/** A name that may be written into the file: plain, not secret-looking, without this computer's host name. */
function nameable(name, host) {
  if (!PLAIN.test(name) || looksSecret(name) || KEYISH.test(name)) return false;
  return !(host && host.length >= 3 && name.toLowerCase().includes(host));
}

const count = (d) => {
  try {
    return fs.readdirSync(d).length;
  } catch {
    return 0;
  }
};

/**
 * One of the four folders, in words and counts: { there, items: [{ name, kind, entries?, repository? }], unnamed? }.
 * One level below it (and the entries of each folder counted), nothing opened, nothing followed: a link is said as
 * a link. `there: false` when it is not here; a folder that is itself a link is not looked into.
 */
export function describeFolder(dir, rel, host = hostName().split('.')[0].toLowerCase()) {
  const d = path.join(dir, rel);
  const k = kindAt(d);
  if (k === 'none') return { there: false };
  if (k === 'link') return { there: true, link: true };
  if (k !== 'other' || !isDir(d)) return { there: true, notFolder: true };
  let names = [];
  try {
    names = fs.readdirSync(d).sort();
  } catch {
    return { there: true, unreadable: true };
  }
  const items = [];
  let unnamed = 0;
  for (const name of names) {
    // A download that is still running (or one a crash left) is Hoprig's own, not the owner's: not described.
    if (rel === 'development' && name.startsWith(DEV_TMP_PREFIX)) continue;
    if (!nameable(name, host) || items.length >= MAX_ITEMS) {
      unnamed++;
      continue;
    }
    const kind = kindAt(path.join(d, name));
    const p = path.join(d, name);
    if (kind === 'other' && isDir(p)) items.push({ name, kind: 'folder', entries: count(p), ...(isGitRepo(p) ? { repository: true } : {}) });
    else items.push({ name, kind: kind === 'link' ? 'link' : 'file' });
  }
  return { there: true, items, ...(unnamed ? { unnamed } : {}) };
}

// ---- what is here ----

/**
 * The names of the map's entries checked out on this computer (the brain left out: every computer has it): a group's
 * own repository, each project (a member that comes with its group: its folder), each code repository, each other
 * repository. A folder counts when it is that repository (its address), never a linked worktree, never one behind a
 * link that is not followed. No git process: the addresses are read from each repository's config.
 */
export async function hereOnThisComputer(map, { dir = workspaceDir(), projects = projectsIn() } = {}) {
  if (!map) return [];
  const out = [];
  const isIt = (d, url) => isGitRepo(d) && !isLinkedWorktree(d) && (!url || sameUrl(remoteOf(d) || '', url));
  for (const t of await mapTargets(map, { dir, projects })) {
    if (t.blocked) continue;
    const e = t.entry || {};
    if (t.kind === 'group') {
      if (e.url && isIt(t.dir, e.url)) out.push(t.label);
    } else if (t.kind === 'project') {
      if (e.url ? isIt(t.dir, e.url) : isDir(t.dir)) out.push(t.label);
    } else if ((t.kind === 'repo' || t.kind === 'other') && isIt(t.dir, e.url)) out.push(t.label);
  }
  return [...new Set(out)].sort();
}

/** The file's content for this computer (sorted keys, so its git history shows real changes only). */
export function fileContent({ label, id, here, folders, leave = null }) {
  const sorted = (o) => (Array.isArray(o) ? o.map(sorted) : isObj(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  const marks = leaveOf(leave); // a file without marks keeps its old form
  return JSON.stringify(sorted({ folders, here, hoprig: VERSION, id, label, ...(marks ? { leave: marks } : {}) }), null, 2) + '\n';
}

/**
 * Write this computer's own file, only when something in it changed. Never asks, never guesses a label. A file under
 * this label with another computer's id is never written, unless `again` (set-up: the owner said this computer IS
 * that one, set up again). → { written, file?, why? } (why: the reason nothing was written, for status and the
 * upkeep's line). `leave`: the owner's new marks (leavemarks.mjs); left out, the marks the file holds are kept.
 */
export async function writeOwnFile({ dir = workspaceDir(), projects = projectsIn(), dryRun = false, again = false, leave } = {}) {
  const me = thisComputer();
  if (!me.label || !me.id) return { written: false, why: `this computer has no label in the workspace yet:  hoprig workspace label <name>` };
  const brain = path.join(dir, 'ai_brain');
  if (!isDir(brain)) return { written: false, why: 'there is no AI brain on this computer' };
  const file = fileOf(me.label, dir);
  const theirs = computersHere(dir);
  if (theirs.folderWhy) return { written: false, file, why: theirs.folderWhy };
  const now = theirs.files.find((f) => f.label === me.label);
  if (now && now.id !== me.id && !again) return { written: false, file, why: `ai_brain/${relFileOf(me.label)} holds another computer's id: two computers took the label ${me.label}, and this one does not write that file. Give this computer another label:  hoprig workspace label <name>  (only if this IS that computer, set up again after a format, take its file over:  hoprig workspace label ${me.label} --again)` };
  if (!now && theirs.refused.some((r) => r.name === `${me.label}.json`)) return { written: false, file, why: `ai_brain/${relFileOf(me.label)} was refused (${theirs.refused.find((r) => r.name === `${me.label}.json`).why}): fix it in the brain` };
  const old = readIn({ root: brain, dir }, file, { below: true });
  // Its own id in a file this computer never wrote: another computer has the same id and label (a home folder copied
  // to another computer). Neither writes over the other: this one stops until it has an id of its own.
  if (old && now && now.id === me.id && !again && me.wrote.length && !me.wrote.includes(hashOf(old.toString('utf8')))) {
    return { written: false, file, twin: true, why: `ai_brain/${relFileOf(me.label)} holds this computer's id, but this computer did not write what is in it: two computers use one id (a home folder copied to another computer?). This computer no longer writes that file; give it an id and a label of its own:  hoprig workspace label <another name> --new-id` };
  }
  const m = readMap(dir);
  // A label coming back after a format: its file starts again with nothing here (never what the old disk had).
  const here = again ? [] : await hereOnThisComputer(m.map, { dir, projects });
  const folders = Object.fromEntries(DESCRIBED.map((f) => [f, describeFolder(dir, f)]));
  // The toolchains at development/'s places (pcsetup/devplaces.mjs), by name and version only: never a path.
  const tools = folders.development.there && !folders.development.link ? devTools(dir) : [];
  if (tools.length) folders.development.tools = tools;
  // The marks stay as they are unless new ones are handed in; a label taken over after a format starts without them.
  const marks = again ? null : leave !== undefined ? leave : now ? now.leave || null : null;
  const text = fileContent({ label: me.label, id: me.id, here, folders, leave: marks });
  if (old && old.toString('utf8') === text) {
    if (!me.wrote.length) rememberWrote(text); // a computer from before this check: what is there is its own
    return { written: false, file, same: true };
  }
  if (dryRun) return { written: false, file, would: true };
  try {
    mkdirIn({ root: brain, dir }, folderOf(dir));
    writeIn({ root: brain, dir }, file, text, { atomic: true });
  } catch (e) {
    return { written: false, file, why: e.message };
  }
  rememberWrote(text, await upstreamHash(brain, me.label));
  return { written: true, file };
}

/**
 * This label's file on the brain's git server (after a fetch; a dry run fetches nothing and reads what the last fetch
 * brought), when it is there and passes the check: { label, id } | null.
 */
async function serverFile(dir, label, run, { fetch = true } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) return null;
  const up = await gitRead(brain, ['rev-parse', '--verify', '-q', '@{u}'], { run });
  if (!up.ok) return null;
  if (fetch) await gitIn({ root: brain, dir }, brain, ['fetch', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const r = await gitRead(brain, ['show', `@{u}:${relFileOf(label)}`], { run });
  if (!r.ok) return null;
  try {
    const c = checkComputerFile(JSON.parse(r.stdout), label);
    return c.ok ? { label, id: c.file.id } : null;
  } catch {
    return null;
  }
}

/**
 * Give this computer its label (set-up, `hoprig workspace label`). `again`: the owner says this computer IS the one
 * that had this label (set up again after a format): its file starts again with an empty list of what is here.
 * → { label, id, state: 'same' | 'new' | 'back' | 'kept', written?, dryRun }. Throws { status, code: 'ETAKEN' } for a
 * label another computer's file holds, here or on the brain's git server, and { code: 'ELABELLED' } when this computer
 * has another label already whose file is its own. `newId`: a new id too (two computers shared one), and the label
 * may change.
 */
export async function setLabel(typed, { dir = workspaceDir(), projects = projectsIn(), again = false, dryRun = false, run = capture, newId = false } = {}) {
  const label = cleanLabel(typed);
  if (!label) throw fail(400, `"${String(typed).slice(0, 40)}": ${LABEL_RULE}`);
  const me = thisComputer();
  const theirs = computersHere(dir);
  if (theirs.folderWhy) throw fail(409, theirs.folderWhy);
  // The label is given once. The one exception: this computer's file under its label is not its own (another computer
  // took the same label and its file came first), or it never wrote one: then it picks another.
  if (me.label && me.label !== label) {
    const old = theirs.files.find((f) => f.label === me.label);
    const lost = newId || (old ? old.id !== me.id : !theirs.refused.some((r) => r.name === `${me.label}.json`));
    if (!lost) throw fail(409, `this computer is ${me.label} in the workspace already; its label is given once`, 'ELABELLED');
  }
  // `newId`: this computer shares its id with another (a copied home folder): it gets one of its own.
  const id = (!newId && me.id) || crypto.randomBytes(16).toString('hex');
  const bad = theirs.refused.find((r) => r.name === `${label}.json`);
  if (bad) throw fail(409, `ai_brain/${relFileOf(label)} is there and was refused (${bad.why}): fix or remove it in the brain first`);
  // Another computer may have taken the label and pushed its file since this brain was fetched: the git server's
  // copy is read too (nothing here changes; a brain that cannot be fetched is judged by what it has).
  const file = theirs.files.find((f) => f.label === label) || (await serverFile(dir, label, run, { fetch: !dryRun }));
  let state = me.label === label ? 'kept' : 'new';
  if (file && file.id !== id) {
    if (!again) throw fail(409, `the label ${label} is taken: another computer's file (ai_brain/${relFileOf(label)}) holds another id. Pick another label; or, if this computer IS ${label} set up again after a format, say so (hoprig workspace label ${label} --again)`, 'ETAKEN');
    state = 'back';
  } else if (file) state = 'same';
  if (dryRun) return { label, id: me.id || null, state, dryRun: true };
  saveConfig({ computer: { label, id, ...(id === me.id ? { wrote: me.wrote } : {}) } });
  const w = await writeOwnFile({ dir, projects, again: state === 'back' });
  return { label, id, state, written: w.written, ...(w.why ? { why: w.why } : {}), dryRun: false };
}

/**
 * Which computer has what, from every computer's file: { computers: [{ label, hoprig, here, mine }], refused,
 * folderWhy?, label: this computer's or null }.
 */
export function whoHasWhat(dir = workspaceDir()) {
  const me = thisComputer();
  const c = computersHere(dir);
  return { label: me.label, computers: c.files.map((f) => ({ label: f.label, hoprig: f.hoprig, here: f.here, folders: f.folders, mine: f.label === me.label && f.id === me.id })), refused: c.refused, ...(c.folderWhy ? { folderWhy: c.folderWhy } : {}) };
}
