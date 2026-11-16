// Parts of Files (files.js): what a file is by its name, the folder picker of "Copy to" and "Move to", the picture
// viewer, an upload with its progress, a download, and the trash's own view with "Put back" and "Empty".
import { icon } from '../icons.js';
import { add, api, at, bytes, confirmSheet, fill, h, openSheet, toast, url } from '../lib.js';
import { errorLine, errorText, sortBy, table, when } from './native.js';

export const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
export const ARCHIVE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|zip)$/i;
// Kinds that are never text: offered as a download (an archive also to unpack), never opened in the editor.
const BINARY = /\.(pdf|exe|dll|so|dylib|bin|iso|img|dmg|deb|rpm|apk|ipa|jar|class|o|a|wasm|pyc|mp3|wav|flac|ogg|mp4|mkv|mov|avi|webm|ico|bmp|tiff?|psd|heic|woff2?|ttf|otf|eot|sqlite3?|db|7z|rar|xz|gz|bz2|zst|docx?|xlsx?|pptx?|odt|ods)$/i;
export const EDITOR_MAX = 5 * 1024 * 1024; // the editor opens files up to this size

/** How Files opens a file: 'picture' | 'archive' | 'download' | 'editor'. */
export function openKind(e) {
  if (PICTURE.test(e.name)) return 'picture';
  if (ARCHIVE.test(e.name)) return 'archive';
  if (BINARY.test(e.name) || (e.size || 0) > EDITOR_MAX) return 'download';
  return 'editor';
}

/** What an entry is, in a word for the Kind column. */
export function kindWord(e) {
  if (e.kind === 'dir') return 'Folder';
  if (PICTURE.test(e.name)) return 'Picture';
  if (ARCHIVE.test(e.name)) return 'Archive';
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(e.name);
  return ext ? `${ext[1].toUpperCase()} file` : 'File';
}

/** The parent folder and the name of a full path (either slash). */
export function splitPath(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return { dir: i <= 0 ? p.slice(0, i + 1) || p : p.slice(0, i), name: p.slice(i + 1) };
}
export const joinPath = (dir, name) => (/[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`);

/** The address of a file's bytes on computer `m`: shown (a picture) or always as a download. */
export const rawUrl = (m, p, download) => url(at(m, `/api/files/raw?${new URLSearchParams({ path: p, ...(download ? { download: '1' } : {}) })}`));

/** Save the file at `p` as a download (the server sends it as an attachment: it is never shown as a page). */
export function download(m, p) {
  const a = h('a', { href: rawUrl(m, p, true), download: splitPath(p).name, hidden: true });
  add(document.body, a);
  a.click();
  a.remove();
}

/** A picture in a sheet, with its download. */
export function viewPicture(m, p) {
  const { name } = splitPath(p);
  return openSheet({ title: name, subtitle: p, wide: true }, (close) => [
    h('div.dfiles-viewer', h('img', { src: rawUrl(m, p, false), alt: name, onerror: (e) => e.target.replaceWith(h('p.dapp-note', 'This picture could not be shown.')) })),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Close'),
      h('button.btn.primary', { type: 'button', onclick: () => download(m, p) }, icon('download', { size: 16 }), h('span', 'Download'))),
  ]);
}

/**
 * Pick a folder of computer `m`, starting at `start`: "Copy to" and "Move to". Resolves its full path or null.
 */
export function pickFolder(m, start, { title, ok }) {
  return openSheet({ title, subtitle: 'Open the folder to put them in, then choose it.' }, (close) => {
    let cur = null;
    const where = h('p.dfiles-pickpath.mono');
    const rows = h('div.dfiles-picklist', { role: 'list' });
    const upBtn = h('button.btn.secondary.small', { type: 'button', onclick: () => cur && cur.parent && go(cur.parent) }, icon('folderUp', { size: 14 }), h('span', 'Up'));
    const okBtn = h('button.btn.primary', { type: 'button', onclick: () => cur && close(cur.path) }, ok);
    async function go(p) {
      fill(rows, h('p.dapp-note', 'Reading…'));
      try {
        cur = await api(at(m, `/api/files/list?${new URLSearchParams({ path: p })}`));
      } catch (e) {
        fill(rows, errorLine(e));
        return;
      }
      where.textContent = cur.path;
      upBtn.disabled = !cur.parent;
      const dirs = cur.entries.filter((e) => e.kind === 'dir');
      fill(rows, dirs.length ? dirs.map((d) => h('button.dfiles-pick', { type: 'button', role: 'listitem', onclick: () => go(joinPath(cur.path, d.name)) }, icon('folder', { size: 16 }), h('span', d.name), icon('chevronRight', { size: 14 })))
        : h('p.dapp-note', 'No folders in here.'));
    }
    go(start);
    return [h('div.dapp-bar', upBtn, where), rows, h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), okBtn)];
  });
}

/**
 * Upload `file` into folder `dir` of computer `m` (raw bytes, as the hub's rule for uploads wants), with its progress
 * in `status`. A name that is taken asks whether to replace the file. Resolves the answer, or null when skipped.
 */
export async function uploadFile(m, dir, file, status) {
  const send = (replace) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); // not fetch: XHR reports the progress of an upload
    xhr.open('POST', url(at(m, `/api/files/upload?${new URLSearchParams({ dir, name: file.name, ...(replace ? { replace: '1' } : {}) })}`)));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) status.textContent = `Uploading ${file.name}: ${Math.round((e.loaded / e.total) * 100)} % of ${bytes(e.total)}`;
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200) resolve(body);
      else reject(Object.assign(new Error(body.error || `The upload failed (${xhr.status})`), { status: xhr.status, code: body.code }));
    };
    xhr.onerror = () => reject(new Error('The upload stopped: the connection was lost'));
    xhr.send(file);
  });
  try {
    return await send(false);
  } catch (e) {
    if (e.status !== 409 || e.code !== 'exists') throw e;
    const yes = await confirmSheet({ title: `Replace ${file.name}?`, text: `A file named ${file.name} is in this folder already. Replacing it puts the uploaded one in its place.`, ok: 'Replace', danger: true });
    return yes ? send(true) : null;
  } finally {
    status.textContent = '';
  }
}

/** The trash's view in `box`: what is in it, "Put back" each, "Empty". `done()` goes back to the folder. */
export function trashView(box, m, { done, changed }) {
  const call = (p, body) => api(at(m, p), body);
  const note = h('div');
  const status = h('span.dapp-status', { role: 'status' });
  const t = table('Trash', [
    { key: 'name', label: 'Name', w: 'minmax(140px, 1.2fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'from', label: 'Where it was', w: 'minmax(160px, 1.6fr)', narrow: false },
    { key: 'at', label: 'Deleted', w: '130px', num: true, narrow: false },
    { key: 'act', label: '', sort: false, w: '120px', narrow: 'auto' },
  ], { sort: { key: 'at', desc: true }, onSort: () => draw() });
  let items = [];
  const emptyBtn = h('button.btn.secondary.small', { type: 'button', onclick: () => empty() }, icon('trash', { size: 14 }), h('span', 'Empty the trash'));
  function draw() {
    t.draw(sortBy(items, t.sort.key, t.sort.desc).map((i) => ({
      key: i.id,
      cells: [
        h('span.dfiles-name.dapp-strong', { title: i.name }, icon(i.kind === 'dir' ? 'folder' : 'text', { size: 15 }), h('span.dfiles-label', i.name)),
        h('span.dapp-dim.mono', { title: i.from }, splitPath(i.from).dir),
        h('span.dapp-dim', when(i.at)),
        h('button.btn.secondary.small.dapp-act', { type: 'button', title: `Put ${i.name} back`, onclick: () => putBack(i) }, icon('undo', { size: 14 }), h('span.dapp-word', 'Put back')),
      ],
    })));
    status.textContent = items.length ? `${items.length} in the trash` : 'The trash is empty';
    emptyBtn.disabled = !items.length;
  }
  async function load() {
    try {
      items = (await call('/api/files/trash')).items;
      fill(note);
    } catch (e) {
      fill(note, errorLine(e));
    }
    draw();
  }
  async function putBack(i) {
    try {
      const r = await call('/api/files/trash/restore', { id: i.id });
      toast(`${i.name} is back in ${splitPath(r.path).dir}`);
      changed();
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 8000 });
    }
    load();
  }
  async function empty() {
    const yes = await confirmSheet({ title: 'Empty the trash?', text: `${items.length} ${items.length === 1 ? 'thing goes' : 'things go'} for good: they cannot be put back.`, ok: 'Empty the trash', danger: true });
    if (!yes) return;
    try {
      await call('/api/files/trash/empty', { confirm: true });
      toast('The trash is empty');
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 8000 });
    }
    load();
  }
  fill(box,
    h('div.dapp-bar', h('button.btn.secondary.small', { type: 'button', onclick: done }, icon('back', { size: 14 }), h('span', 'Back to the files')), emptyBtn, h('span.desk-grow'), status),
    h('p.hint.dapp-hint', 'What Files deleted on this computer. It stays here until it is put back or the trash is emptied.'),
    note, t.el);
  load();
  return () => t.stop();
}
