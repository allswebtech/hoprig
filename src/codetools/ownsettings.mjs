// An endpoint address in Claude Code's OWN settings file (<claude dir>/settings.json, its "env") wins over every
// profile: Claude Code applies that env after the one Hoprig starts it with. So a gateway once set there by hand gets
// every session, the Providers page says "Claude account" while requests go elsewhere, and with the gateway down a
// chat only says the provider did not answer. This module names it, and on the owner's press takes it out of the
// file (a backup beside it first) or makes that gateway a provider of its own.
//
// What is shown is what is removed: the same key names, read from the file as it is at the press. A file that changed
// since it was shown (another hash), does not parse, is a link or cannot be written is refused, and nothing changes.
// A key in that env is never returned, shown, logged or put in a file name: only its variable name is.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { claudeDir } from '../paths.mjs';

/** The address variable, and the key variables that belong to it (left alone, they would go to Anthropic's own API). */
export const ADDRESS_VAR = 'ANTHROPIC_BASE_URL';
export const KEY_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
// What else is set for that gateway: left behind, a model name meant for it would go to Anthropic for every session and
// still win over every provider's model, and headers may hold a key. Taken out together with the address.
export const MODEL_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
export const HIDDEN_VARS = [...KEY_VARS, 'ANTHROPIC_CUSTOM_HEADERS'];
const WITH_ADDRESS = [...KEY_VARS, ...MODEL_VARS, 'ANTHROPIC_CUSTOM_HEADERS'];

export const settingsFile = (dir = claudeDir()) => path.join(dir, 'settings.json');

const LOOPBACK = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);

/** "127.0.0.1:20017" of an address, or null: host and port only, never a path, a user or a password. */
export function hostPort(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

/**
 * The address as the page may show it: scheme, host and port; a user, a password, a path or a query (any may hold a
 * secret) only named, never shown.
 */
export function shownAddress(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '(an address that is not a web address, not shown)';
    const who = u.username || u.password ? '(user and password, not shown)@' : '';
    const rest = (u.pathname && u.pathname !== '/') || u.search || u.hash ? '/(path, not shown)' : '';
    return `${u.protocol}//${who}${u.host}${rest}`;
  } catch {
    return '(an address that is not a web address, not shown)';
  }
}

/**
 * Where the members of a JSON object text are: { open, close, list: [{ key, start, end, sub }] } of the top object
 * (start: its key's quote, end: just after its value; sub: the same for a value that is an object). Throws on text
 * that is not JSON. Only for finding what to cut: nothing is ever re-serialized, so numbers, escapes, duplicate keys
 * and the layout of the rest stay exactly as they are.
 */
export function jsonMembers(text) {
  let i = 0;
  const bad = () => {
    throw new Error(`not JSON at ${i}`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const str = () => {
    const from = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) bad();
    return JSON.parse(text.slice(from, ++i));
  };
  const atom = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const value = () => {
    ws();
    if (text[i] === '{') return obj();
    if (text[i] === '"') return (str(), null);
    if (text[i] === '[') {
      i++;
      ws();
      if (text[i] === ']') return (i++, null);
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return (i++, null);
        else bad();
      }
    }
    atom.lastIndex = i;
    const m = atom.exec(text);
    if (!m) bad();
    i += m[0].length;
    return null;
  };
  const obj = () => {
    const open = i++;
    const list = [];
    ws();
    if (text[i] === '}') return { open, close: i++, list };
    for (;;) {
      ws();
      if (text[i] !== '"') bad();
      const start = i;
      const key = str();
      ws();
      if (text[i++] !== ':') bad();
      const sub = value();
      list.push({ key, start, end: i, sub });
      ws();
      if (text[i] === ',') i++;
      else if (text[i] === '}') return { open, close: i++, list };
      else bad();
    }
  };
  ws();
  if (text[i] !== '{') bad();
  const top = obj();
  ws();
  if (i !== text.length) bad();
  return top;
}

/** `text` without the member `idx` of the object `o` (jsonMembers), its comma and the line it was on. */
function cutMember(text, o, idx) {
  const { list } = o;
  if (list.length === 1) return text.slice(0, o.open + 1) + text.slice(o.close);
  if (idx < list.length - 1) return text.slice(0, list[idx].start) + text.slice(list[idx + 1].start);
  return text.slice(0, list[idx - 1].end) + text.slice(list[idx].end);
}

/** The settings text with every member of "env" named in `vars` cut out, or null when "env" is not one plain object. */
export function withoutVars(text, vars) {
  let t = text;
  for (;;) {
    const envs = jsonMembers(t).list.filter((m) => m.key === 'env');
    if (envs.length !== 1 || !envs[0].sub) return null;
    const idx = envs[0].sub.list.findIndex((m) => vars.includes(m.key));
    if (idx < 0) return t;
    t = cutMember(t, envs[0].sub, idx);
  }
}

const hashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const BOM = '﻿';

/**
 * What the file says, or null when it names no address: { file, where, local, vars, lines, hasKey, stamp }. `where` is host and
 * port; `local` true for this computer; `vars` the names that would be removed; `lines` how they read in the file, a
 * key's value hidden; `stamp` a hash of the whole file, handed back with the press.
 */
// A settings file is a few kilobytes. One far bigger is not read: the Providers page asks at every refresh, and reading
// and hashing it would hold the dashboard's one thread.
export const MAX_BYTES = 1 << 20;

/** The file's bytes, or null when it is not there, cannot be read or is bigger than MAX_BYTES. */
function readSmall(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export function ownEndpoint(dir = claudeDir()) {
  const file = settingsFile(dir);
  const bytes = readSmall(file);
  if (!bytes) return null;
  // A BOM in front (Windows PowerShell 5.1's Set-Content -Encoding utf8 writes one) is not part of the JSON.
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return null;
  }
  const env = s && typeof s.env === 'object' && s.env ? s.env : null;
  const url = env && typeof env[ADDRESS_VAR] === 'string' ? env[ADDRESS_VAR].trim() : '';
  if (!url) return null;
  const where = hostPort(url) || 'an address that is not a web address';
  const host = where.split(':').slice(0, -1).join(':');
  // Every one that is there, whatever its type (a number where a key belongs is taken out too).
  const vars = [ADDRESS_VAR, ...WITH_ADDRESS.filter((k) => Object.hasOwn(env, k))];
  const shown = (k) => {
    if (k === ADDRESS_VAR) return JSON.stringify(shownAddress(env[k]));
    if (HIDDEN_VARS.includes(k)) return k === 'ANTHROPIC_CUSTOM_HEADERS' ? '"(headers, not shown)"' : '"(a key, not shown)"';
    return typeof env[k] === 'string' && /^[A-Za-z0-9._:/@+\-[\]]{1,120}$/.test(env[k]) ? JSON.stringify(env[k]) : '"(not shown)"';
  };
  const lines = vars.map((k) => `"${k}": ${shown(k)}`);
  const hasKey = KEY_VARS.some((k) => typeof env[k] === 'string' && env[k].trim());
  return { file, where, local: LOOPBACK(host), vars, lines, hasKey, stamp: hashOf(bytes) };
}

/**
 * The settings file when it names the address variable but could not be read as JSON (a comment, a trailing comma):
 * ownEndpoint() cannot say where it points, so doctor names the file instead. null otherwise.
 */
export function unreadSettings(dir = claudeDir()) {
  const file = settingsFile(dir);
  const bytes = readSmall(file);
  if (!bytes) return null;
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  if (!text.includes(ADDRESS_VAR)) return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    return { file };
  }
}

/** The sentence doctor and the page say. */
export function ownEndpointWords(o) {
  const to = o.local ? `a gateway on this computer (${o.where})` : o.where;
  return `Claude Code's own settings send every session to ${to}; your providers cannot change that`;
}

/** Whether the folder `dir` is itself a link (its real path is not its real parent's path with its own name). */
function folderIsLink(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return true;
    const abs = path.resolve(dir);
    return fs.realpathSync(abs) !== path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {
    return true; // cannot be told: not written
  }
}

/** A file name for the backup: beside the file, with the time, never anything of its content. */
const backupName = (file, now) => `${file}.hoprig-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;

/**
 * Take the shown variables out of the file. `stamp`: what the page was shown (ownEndpoint().stamp). Returns
 * { ok: true, backup, removed } or { ok: false, why } (why: words for a person; nothing changed then).
 */
export function removeOwnEndpoint({ dir = claudeDir(), stamp, now = Date.now() } = {}) {
  const file = settingsFile(dir);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { ok: false, why: 'The settings file is not there any more.' };
  }
  if (st.isSymbolicLink()) return { ok: false, why: `${file} is a link to another file: change it there yourself.` };
  if (!st.isFile()) return { ok: false, why: `${file} is not a file.` };
  // The Claude folder itself a link (a dotfiles repository, a folder kept elsewhere): the file and a backup holding the
  // key would land in the link's target, where git may pick the backup up. Only the folder itself counts: a link
  // further up (a home reached through a link) changes nothing of where the file is.
  if (folderIsLink(dir)) return { ok: false, why: `${dir} is a link to another folder: change ${file} there yourself.` };
  // Made read-only by its owner or a tool that keeps it: not gone round.
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch {
    return { ok: false, why: `${file} is read-only: nothing was changed.` };
  }
  // A second name of the same file (a hard link) would keep the address: the new file would be another one.
  if (st.nlink > 1) return { ok: false, why: `${file} has another name too (a hard link): nothing was changed. Change it yourself.` };
  const bytes = fs.readFileSync(file);
  if (!stamp || hashOf(bytes) !== stamp) return { ok: false, why: 'The settings file changed since it was shown. Look at it again, then press once more.' };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { ok: false, why: `${file} is not plain UTF-8 text: nothing was changed. Change it yourself.` };
  const o = ownEndpoint(dir);
  if (!o) return { ok: false, why: 'The settings file names no address any more.' };
  const bom = text.startsWith(BOM) ? BOM : '';
  let out;
  try {
    out = withoutVars(text.slice(bom.length), o.vars);
  } catch {
    out = null;
  }
  // What is left must be the file as it was, less those variables, and nothing else.
  const want = JSON.parse(text.slice(bom.length));
  for (const k of o.vars) delete want.env[k];
  let same = false;
  try {
    same = out !== null && JSON.stringify(JSON.parse(out)) === JSON.stringify(want);
  } catch {
    same = false;
  }
  if (!same) return { ok: false, why: `${file} could not be changed line by line: nothing was changed. Change it yourself.` };
  const backup = backupName(file, now);
  try {
    // The backup first, the very bytes of the file: if it cannot be made, the file is not touched.
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, st.mode & 0o777);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bom + out, { mode: st.mode & 0o777 });
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, why: `The settings file could not be written (${e.code || e.message}); it is as it was.` };
  }
  return { ok: true, backup, removed: o.vars };
}

const BACKUP_RE = /^settings\.json\.hoprig-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
// A note on the page offers the way back for this long after a press.
export const BACKUP_SHOWN_MS = 14 * 24 * 3600_000;

/**
 * The newest backup a press left beside the settings file, while the file names no address, made within
 * BACKUP_SHOWN_MS: { name, folder, at, stamp } (stamp: a hash of the settings file now, '' when it is not there), else
 * null. The backup holds the key: only its name and folder are returned, never its content.
 */
export function lastBackup(dir = claudeDir(), now = Date.now()) {
  if (ownEndpoint(dir)) return null;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => BACKUP_RE.test(n)).sort();
  } catch {
    return null;
  }
  const name = names.at(-1);
  if (!name) return null;
  const at = Date.parse(name.slice('settings.json.hoprig-backup-'.length).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
  if (!Number.isFinite(at) || now - at > BACKUP_SHOWN_MS) return null;
  const cur = readSmall(settingsFile(dir));
  return { name, folder: path.resolve(dir), at, stamp: cur ? hashOf(cur) : '' };
}

/**
 * Put a backup back as the settings file (the owner's "Put it back"). `name`: a backup's file name (lastBackup().name),
 * `stamp`: the settings file as it was shown. The file as it is now is kept beside it first
 * (settings.json.hoprig-before-restore-<time>). → { ok: true, kept } or { ok: false, why } (nothing changed then).
 */
export function restoreBackup({ dir = claudeDir(), name, stamp, now = Date.now() } = {}) {
  if (typeof name !== 'string' || !BACKUP_RE.test(name)) return { ok: false, why: 'That is not a backup Hoprig made.' };
  const file = settingsFile(dir);
  const backup = path.join(dir, name);
  if (folderIsLink(dir)) return { ok: false, why: `${dir} is a link to another folder: put ${backup} back there yourself.` };
  let bst;
  try {
    bst = fs.lstatSync(backup);
  } catch {
    return { ok: false, why: 'That backup is not there any more.' };
  }
  if (!bst.isFile()) return { ok: false, why: `${backup} is not a file.` };
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    /* no settings file now: the backup becomes it */
  }
  if (st && (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)) return { ok: false, why: `${file} is a link or has another name: put the backup back yourself.` };
  const cur = st ? readSmall(file) : null;
  if (st && !cur) return { ok: false, why: `${file} could not be read: nothing was changed.` };
  if ((cur ? hashOf(cur) : '') !== (stamp || '')) return { ok: false, why: 'The settings file changed since it was shown. Look at it again, then press once more.' };
  if (st) {
    try {
      fs.accessSync(file, fs.constants.W_OK);
    } catch {
      return { ok: false, why: `${file} is read-only: nothing was changed.` };
    }
  }
  const kept = st ? `${file}.hoprig-before-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}` : null;
  try {
    if (kept) {
      fs.copyFileSync(file, kept, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(kept, st.mode & 0o777);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.copyFileSync(backup, tmp);
    fs.chmodSync(tmp, (st ? st.mode : bst.mode) & 0o777);
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, why: `The settings file could not be written (${e.code || e.message}); it is as it was.` };
  }
  return { ok: true, kept };
}

/**
 * The address and key of the file, for a provider of its own: { baseUrl, key, auth, model, smallModel } (server side only: the key
 * goes straight into a profile file and is never returned). null when there is no address or no key.
 */
export function ownGatewaySecret(dir = claudeDir()) {
  try {
    const env = JSON.parse(readSmall(settingsFile(dir)).toString('utf8').replace(/^\ufeff/, '')).env || {};
    const baseUrl = typeof env[ADDRESS_VAR] === 'string' ? env[ADDRESS_VAR].trim() : '';
    const str = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
    const key = str('ANTHROPIC_AUTH_TOKEN') || str('ANTHROPIC_API_KEY');
    if (!baseUrl || !key) return null;
    // The models it worked with, so the new provider keeps them (the caller checks each name).
    return { baseUrl, key, auth: str('ANTHROPIC_AUTH_TOKEN') ? 'bearer' : 'x', model: str('ANTHROPIC_MODEL'), smallModel: str('ANTHROPIC_DEFAULT_HAIKU_MODEL') || str('ANTHROPIC_SMALL_FAST_MODEL') };
  } catch {
    return null;
  }
}

/** Does anything answer at host:port? (a plain TCP connect, at most `ms`). */
export function answers(where, ms = 1500) {
  const i = String(where).lastIndexOf(':');
  const host = where.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(where.slice(i + 1));
  if (!host || !Number.isInteger(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * The cause behind a chat's "the provider did not answer": when Claude Code's own settings name an address and
 * nothing answers there, that sentence; else null.
 */
export async function retryCause(dir = claudeDir(), probe = answers) {
  const o = ownEndpoint(dir);
  if (!o || (await probe(o.where))) return null;
  return `Claude Code's own settings send it to ${o.where}, and nothing answers there. Start that gateway, or take the address out on the Providers page.`;
}
