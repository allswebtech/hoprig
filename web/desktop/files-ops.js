// The changes Files makes (files.js): new folder or file, rename, copy and move, the trash, pack, unpack, upload.
// Each says what it did in a toast, or why not, and reads the folder again.
import { api, at, confirmSheet, promptSheet, toast } from '../lib.js';
import { pickFolder, splitPath, uploadFile } from './files-parts.js';
import { errorText } from './native.js';

const NAME_RE = /^[^/\\\0]+$/;
/** Why `v` cannot be a file name, or ''. */
export const nameProblem = (v) => {
  const n = v.trim();
  if (!n) return 'Type a name.';
  if (!NAME_RE.test(n) || n === '.' || n === '..') return 'A name cannot hold "/" or "\\".';
  if (n.startsWith('-')) return 'A name cannot start with "-".';
  return '';
};

/**
 * The changes of one Files window. f: { machine, busy (a status element), cur() (the folder's answer), chosen()
 * (the entries chosen), isFind(), clear() (choose none), after(message, name to choose) (read again), load() }.
 */
export function fileOps(f) {
  const { machine, busy, after, load, clear, chosen, isFind } = f;
  const call = (p, body) => api(at(machine, p), body);
  const failText = (r) => r.failed.map((x) => `${splitPath(x.path).name}: ${x.error}`).join('\n');

  async function make(kind) {
    const name = await promptSheet({ title: kind === 'dir' ? 'New folder' : 'New file', text: `In ${f.cur().path}`, ok: 'Make it', label: 'Name', check: nameProblem });
    if (name === null) return;
    try {
      await call('/api/files/new', { dir: f.cur().path, name: name.trim(), kind });
      after(null, name.trim());
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 7000 });
    }
  }
  async function renameIt(e) {
    const name = await promptSheet({ title: `Rename ${e.name}`, value: e.name, ok: 'Rename', label: 'New name', check: nameProblem });
    if (name === null || name.trim() === e.name) return;
    try {
      const r = await call('/api/files/rename', { path: e.path, name: name.trim() });
      clear();
      after(null, isFind() ? null : splitPath(r.path).name);
    } catch (err) {
      toast(errorText(err), { kind: 'error', ms: 7000 });
    }
  }
  async function transfer(copy) {
    const items = chosen();
    if (!items.length) return;
    const to = await pickFolder(machine, f.cur().path, { title: `${copy ? 'Copy' : 'Move'} ${items.length === 1 ? items[0].name : `${items.length} items`} to…`, ok: copy ? 'Copy here' : 'Move here' });
    if (!to) return;
    busy.textContent = copy ? 'Copying…' : 'Moving…';
    try {
      const r = await call(`/api/files/${copy ? 'copy' : 'move'}`, { paths: items.map((e) => e.path), to });
      if (r.failed.length) toast(failText(r), { kind: 'error', ms: 9000 });
      if (r.done.length) toast(`${copy ? 'Copied' : 'Moved'} ${r.done.length === 1 ? splitPath(r.done[0].to).name : `${r.done.length} items`} to ${splitPath(to).name || to}`);
      clear();
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 7000 });
    } finally {
      busy.textContent = '';
    }
    load();
  }
  async function trashIt() {
    const items = chosen();
    if (!items.length) return;
    try {
      const r = await call('/api/files/trash', { paths: items.map((e) => e.path) });
      // Too big to copy into the trash from another disk: deleting it for good is offered, and asked first.
      const far = r.failed.filter((x) => x.code === 'other-disk');
      const rest = { failed: r.failed.filter((x) => x.code !== 'other-disk') };
      if (rest.failed.length) toast(failText(rest), { kind: 'error', ms: 9000 });
      if (far.length) await deleteForGood(far.map((x) => x.path));
      if (r.done.length) {
        const undo = async () => {
          const back = await Promise.allSettled(r.done.map((d) => call('/api/files/trash/restore', { id: d.id })));
          const lost = back.filter((x) => x.status === 'rejected');
          if (lost.length) toast(`${lost.length} could not be put back: ${errorText(lost[0].reason)}`, { kind: 'error', ms: 8000 });
          load();
        };
        toast(`Moved ${r.done.length === 1 ? items[0].name : `${r.done.length} items`} to the trash.`, { ms: 8000, action: { label: 'Undo', run: undo } });
      }
      clear();
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 7000 });
    }
    load();
  }
  async function deleteForGood(paths) {
    const what = paths.length === 1 ? splitPath(paths[0]).name : `${paths.length} items`;
    const yes = await confirmSheet({ title: `Delete ${what} for good?`, text: `${paths.length === 1 ? 'It is' : 'They are'} on another disk than the trash and too big to copy there, so ${paths.length === 1 ? 'it' : 'they'} cannot go to the trash. Deleting for good cannot be undone.`, ok: 'Delete for good', danger: true });
    if (!yes) return;
    try {
      const r = await call('/api/files/delete', { paths, confirm: true });
      if (r.failed.length) toast(failText(r), { kind: 'error', ms: 9000 });
      if (r.done.length) toast(`Deleted ${r.done.length === 1 ? splitPath(r.done[0].path).name : `${r.done.length} items`} for good.`);
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 7000 });
    }
  }
  async function packIt() {
    const items = chosen();
    const name = await promptSheet({ title: 'Pack into an archive', text: `${items.length === 1 ? items[0].name : `${items.length} items`} into a .tar.gz in this folder.`, value: items.length === 1 ? items[0].name : 'Archive', ok: 'Pack', label: 'Name of the archive', check: nameProblem });
    if (name === null) return;
    busy.textContent = 'Packing…';
    try {
      const r = await call('/api/files/pack', { paths: items.map((e) => e.path), name: name.trim() });
      clear();
      after(`Packed into ${splitPath(r.path).name}`, splitPath(r.path).name);
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 8000 });
    } finally {
      busy.textContent = '';
    }
  }
  async function unpackIt(e) {
    busy.textContent = 'Unpacking…';
    try {
      const r = await call('/api/files/unpack', { path: e.path });
      after(`Unpacked into ${splitPath(r.path).name}`, splitPath(r.path).name);
    } catch (err) {
      toast(errorText(err), { kind: 'error', ms: 9000 });
    } finally {
      busy.textContent = '';
    }
  }
  async function uploadAll(files) {
    if (!f.cur() || !files.length) return;
    const dir = f.cur().path;
    let last = null;
    for (const f of files) {
      try {
        const r = await uploadFile(machine, dir, f, busy);
        if (r) last = r.name;
      } catch (e) {
        toast(`${f.name}: ${e.message}`, { kind: 'error', ms: 8000 });
      }
    }
    if (last) after(`Uploaded ${files.length === 1 ? last : `${files.length} files`}`, last);
  }


  return { make, renameIt, transfer, trashIt, packIt, unpackIt, uploadAll };
}
