// Files' trash: what Files deletes goes into a folder of Hoprig's own (<state>/trash/<id>/, the entry under
// "item" and where it came from in info.json), so it can be put back; "Empty" removes it for good. It is this
// computer's: another computer's Files has its own. The trash is inside the dashboard's own folders, which no route
// lists or opens; only these functions reach it, by an id they made.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { fsError } from './files.mjs';
import { freeName, moveEntry, pathList } from './manage.mjs';
import { fail, locate, mayChangeFolderAsync } from './paths.mjs';

const ID = /^[a-z0-9]{6,12}-[0-9a-f]{8}$/;
export const trashDir = () => path.join(stateDir(), 'trash');
const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

// The trash is on the disk of the dashboard's own folder. Something on another disk (a second disk, a USB stick, a
// memory-backed /tmp) cannot be renamed into it: it is copied, then removed. Past this size that would fill the home
// disk and outlast the wait of a hub, so it is refused and "Delete for good" is offered instead.
export const TRASH_COPY_MAX = 512 * 1024 * 1024;

/** The size of `abs` (a file, or a folder with everything in it; links as links), or Infinity once past `max`. */
export async function sizeUpTo(abs, max) {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const p = stack.pop();
    const st = await fs.promises.lstat(p);
    total += st.isDirectory() ? 0 : st.size;
    if (total > max) return Infinity;
    if (st.isDirectory()) for (const n of await fs.promises.readdir(p)) stack.push(path.join(p, n));
  }
  return total;
}

/** Move `paths` into the trash: { done: [{ path, id }], failed: [{ path, error, code? }] }. */
export async function toTrash(paths, roots, { copyMax = TRASH_COPY_MAX } = {}) {
  const list = pathList(paths);
  const done = [];
  const failed = [];
  fs.mkdirSync(trashDir(), { recursive: true, mode: 0o700 });
  const trashDev = fs.statSync(trashDir()).dev;
  for (const p of list) {
    try {
      const at = locate(p, roots, { mode: 'entry' });
      await mayChangeFolderAsync(at.abs);
      const st = fs.lstatSync(at.abs);
      if (st.dev !== trashDev && (await sizeUpTo(at.abs, copyMax)) > copyMax) {
        throw fail(409, `it is on another disk than the trash, which would copy more than ${Math.round(copyMax / 1048576)} MB of it: delete it for good instead`, { code: 'other-disk' });
      }
      const id = newId();
      const box = path.join(trashDir(), id);
      fs.mkdirSync(box, { recursive: true, mode: 0o700 });
      const info = { name: path.basename(at.abs), from: at.abs, at: Date.now(), kind: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : null };
      fs.writeFileSync(path.join(box, 'info.json'), JSON.stringify(info), { mode: 0o600 });
      try {
        await moveEntry(at.abs, path.join(box, 'item'));
      } catch (e) {
        fs.rmSync(box, { recursive: true, force: true });
        throw e;
      }
      done.push({ path: at.abs, id });
    } catch (e) {
      const err = fsError(e);
      failed.push({ path: p, error: err.message, ...(err.details && err.details.code ? { code: err.details.code } : {}) });
    }
  }
  return { done, failed };
}

/**
 * Delete `paths` for good, with everything in them (a link, not what it points to); `confirm` must be true. The same
 * refusals as the trash: a folder that holds a private folder or a sign-in file, the tops of the reach.
 * { done: [{ path }], failed: [{ path, error }] }.
 */
export async function deleteForGood(paths, roots, confirm) {
  if (confirm !== true) throw fail(400, 'confirm the delete');
  const done = [];
  const failed = [];
  for (const p of pathList(paths)) {
    try {
      const at = locate(p, roots, { mode: 'entry' });
      await mayChangeFolderAsync(at.abs);
      await fs.promises.rm(at.abs, { recursive: true });
      done.push({ path: at.abs });
    } catch (e) {
      failed.push({ path: p, error: fsError(e).message });
    }
  }
  return { done, failed };
}

function readInfo(id) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(trashDir(), id, 'info.json'), 'utf8'));
    if (!info || typeof info.name !== 'string' || typeof info.from !== 'string' || !fs.existsSync(path.join(trashDir(), id, 'item'))) return null;
    return info;
  } catch {
    return null;
  }
}

/** What is in the trash, the newest first: { items: [{ id, name, from, at, kind, size }] }. */
export function listTrash() {
  let ids = [];
  try {
    ids = fs.readdirSync(trashDir()).filter((d) => ID.test(d));
  } catch {
    /* nothing deleted yet */
  }
  const items = [];
  for (const id of ids) {
    const i = readInfo(id);
    if (i) items.push({ id, name: i.name, from: i.from, at: i.at, kind: i.kind === 'dir' ? 'dir' : 'file', size: Number.isFinite(i.size) ? i.size : null });
  }
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, 2000) };
}

/**
 * Put item `id` back where it came from. That place is checked again as for any new file (how far Files reaches may
 * have changed); a name taken meanwhile gets a free one ("x (2).txt"). Returns { path }.
 */
export async function restore(id, roots) {
  if (typeof id !== 'string' || !ID.test(id)) throw fail(400, 'that is not an item of the trash');
  const info = readInfo(id);
  if (!info) throw fail(404, 'that is not in the trash any more');
  const dir = path.dirname(info.from);
  if (!fs.existsSync(dir)) throw fail(409, `the folder it came from (${dir}) is not there any more: make it again, then put it back`);
  const at = locate(path.join(dir, freeName(dir, info.name)), roots, { mode: 'new', typed: false });
  try {
    await moveEntry(path.join(trashDir(), id, 'item'), at.abs);
  } catch (e) {
    throw fsError(e);
  }
  fs.rmSync(path.join(trashDir(), id), { recursive: true, force: true });
  return { path: at.abs };
}

/** Remove everything in the trash for good. `confirm` must be true. Returns { removed }. */
export async function emptyTrash(confirm) {
  if (confirm !== true) throw fail(400, 'confirm emptying the trash');
  const { items } = listTrash();
  let ids = [];
  try {
    ids = fs.readdirSync(trashDir()).filter((d) => ID.test(d));
  } catch {
    return { removed: 0 };
  }
  for (const id of ids) await fs.promises.rm(path.join(trashDir(), id), { recursive: true, force: true });
  return { removed: items.length };
}
