// Explorer: the opened folder as a tree, read one level at a time as folders open. A press opens a file (in the
// preview tab), a double press keeps it open; each row's menu (its "…" button, a right click, or the context-menu key)
// renames, deletes and makes new files and folders. git's state colours the names: changed, new, staged, in conflict.
// The keys are a tree's: one Tab stop for the whole tree, the arrows, Home and End move inside it.
import { btn, chooseSheet, confirmSheet, copyText, fill, h, openApp, promptSheet, toast } from '../lib.js';
import { filesHash } from '../desktop/apps.js';
import { icon } from '../icons.js';
import { holdWhilePressed } from './press.js';
import { markClass } from './scm.js';
import { dragPath } from './tabops.js';

const NAME_RE = /^[^/\\\0]+$/;
const checkName = (v) => {
  const n = v.trim();
  if (!n) return 'Type a name.';
  if (!NAME_RE.test(n) || n === '.' || n === '..') return 'A name cannot hold "/" or "\\".';
  if (n.startsWith('-')) return 'A name cannot start with "-".';
  return '';
};
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** May `from` go into folder `dir`: not where it is, not into itself or a folder inside it. */
/** What F2 selects of a name, as VS Code's Explorer: a file's name up to its last dot (typing keeps the extension). */
export const renameSelection = (name, isDir) => {
  const dot = name.lastIndexOf('.');
  return [0, dot > 0 && !isDir ? dot : name.length];
};

export const mayDrop = (from, dir) => parentOf(from) !== dir && dir !== from && !dir.startsWith(`${from}/`);

/** wb: { get, post, tabs, root, label, gitMarks() → Map(path → letter), onChanged(), onRootError(error) }. */
export function createExplorer(wb) {
  const open = new Set(['']); // folders shown open
  const kids = new Map(); // folder → its entries, once read
  const failed = new Map(); // folder → why it could not be read
  const truncated = new Set();
  let selected = null; // the row pressed last (a file or a folder): where "New file" goes
  let cur = null; // the row that holds the tree's one Tab stop
  let order = []; // the rows as drawn: [{ p, isDir, parent }]
  let dragging = null; // the path being dragged in the tree
  let cut = null; // the path cut (Ctrl+X) to be moved by the next paste
  const list = h('div.ed-tree', { role: 'tree', 'aria-label': 'Files', onkeydown: (e) => keys(e),
    // The tree's empty end: the opened folder itself.
    ondragover: (e) => {
      if (dragging !== null && mayDrop(dragging, '')) e.preventDefault();
    },
    ondrop: (e) => {
      e.preventDefault();
      const from = dragging;
      dragging = null;
      if (from !== null && mayDrop(from, '')) moveInto(from, '');
    } });
  const head = h('div.ed-panelhead',
    h('h2.ed-paneltitle', wb.label),
    h('div.ed-paneltools',
      btn('icon ghost small', { icon: 'plus', title: 'New file', onclick: () => make('file') }),
      btn('icon ghost small', { icon: 'folder', title: 'New folder', onclick: () => make('dir') }),
      btn('icon ghost small', { icon: 'refresh', title: 'Read the folder again', onclick: () => refresh() }),
      btn('icon ghost small', { icon: 'up', title: 'Collapse Folders in Explorer', onclick: () => {
        open.clear();
        open.add('');
        paint();
      } })));
  const el = h('div.ed-panel.ed-explorer', head, list);

  async function read(dir) {
    try {
      const r = await wb.get('tree', { dir });
      kids.set(dir, r.entries);
      failed.delete(dir);
      if (r.truncated) truncated.add(dir);
      else truncated.delete(dir);
    } catch (e) {
      // Never shown as an empty folder: the opened folder itself is the whole page's error, a folder in it says why.
      // A look again that fails for a moment (another computer not answering) keeps what is shown.
      if (dir === '') {
        if (!kids.has('') || e.status === 403 || e.status === 404) wb.onRootError(e);
      } else {
        kids.delete(dir);
        failed.set(dir, e.message);
      }
      throw e;
    }
  }

  // A folder's mark: what is changed under it, as a small dot.
  function marks() {
    const m = wb.gitMarks();
    const under = new Set();
    for (const p of m.keys()) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) under.add(parts.slice(0, i).join('/'));
    }
    return { m, under };
  }

  function rows(dir, depth, mk, out) {
    for (const e of kids.get(dir) || []) {
      const p = join(dir, e.name);
      const isDir = e.kind === 'dir';
      const isOpen = isDir && open.has(p);
      const letter = mk.m.get(p);
      const cls = letter ? `.git-${markClass(letter)}` : isDir && mk.under.has(p) ? '.git-in' : '';
      const active = wb.tabs.active && wb.tabs.active.path === p && wb.tabs.active.kind === 'file';
      order.push({ p, isDir, parent: dir });
      out.push(h(`div.ed-row${cls}${active ? '.on' : ''}${selected === p ? '.sel' : ''}`, {
        role: 'treeitem', tabindex: '-1', title: p, 'aria-expanded': isDir ? String(isOpen) : null, 'aria-level': String(depth + 1),
        dataset: { path: p },
        style: { paddingLeft: `${8 + depth * 14}px` },
        onfocus: () => (cur = p),
        onclick: () => press(p, isDir, false),
        ondblclick: () => !isDir && wb.tabs.open(p, { preview: false }),
        oncontextmenu: (ev) => {
          ev.preventDefault();
          menu(p, isDir);
        },
        // Drag a file or folder onto a folder (or the tree's empty end: the opened folder) to move it there.
        draggable: 'true',
        ondragstart: (ev) => {
          dragging = p;
          dragPath(ev.dataTransfer, p);
        },
        ondragover: (ev) => {
          if (dragging === null || !mayDrop(dragging, isDir ? p : parentOf(p))) return;
          ev.preventDefault();
          ev.stopPropagation();
          ev.currentTarget.classList.add('drop');
        },
        ondragleave: (ev) => ev.currentTarget.classList.remove('drop'),
        ondrop: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const from = dragging;
          dragging = null;
          if (from !== null) moveInto(from, isDir ? p : parentOf(p));
        },
        ondragend: () => (dragging = null),
      },
      isDir ? icon(isOpen ? 'chevronDown' : 'chevronRight', { size: 14 }) : h('span.ed-row-gap'),
      icon(isDir ? 'folder' : 'text', { size: 15 }),
      h('span.ed-row-name', e.name, e.link ? h('span.ed-row-link', ' ↗') : null),
      letter ? h('span.ed-row-mark', letter) : null,
      h('button.ed-row-more', { type: 'button', tabindex: '-1', title: 'More (Shift+F10)', 'aria-label': `More for ${e.name}`, onclick: (ev) => {
        ev.stopPropagation();
        menu(p, isDir);
      } }, icon('more', { size: 15 }))));
      if (isOpen) {
        if (failed.has(p)) out.push(h('p.ed-panelnote.ed-row-note', { style: { paddingLeft: `${22 + depth * 14}px` } }, failed.get(p)));
        else if (!kids.has(p)) out.push(h('div.ed-row.ed-row-wait', { style: { paddingLeft: `${22 + depth * 14}px` } }, 'Loading…'));
        else rows(p, depth + 1, mk, out);
      }
    }
    if (truncated.has(dir)) out.push(h('p.ed-panelnote', { style: { paddingLeft: `${22 + depth * 14}px` } }, 'Only the first 2,000 entries are shown.'));
    return out;
  }

  const paint = holdWhilePressed(list, () => {
    if (!kids.has('')) return;
    const had = list.contains(document.activeElement);
    order = [];
    const out = rows('', 0, marks(), []);
    fill(list, out.length ? out : h('p.ed-panelnote', 'This folder is empty.'));
    // The tree's one Tab stop: the row moved to last, else the open file's, else the first.
    if (!order.some((r) => r.p === cur)) cur = (order.find((r) => wb.tabs.active && r.p === wb.tabs.active.path) || order[0] || {}).p || null;
    const row = rowOf(cur);
    if (row) {
      row.tabIndex = 0;
      if (had) row.focus({ preventScroll: true });
    }
  });

  const rowOf = (p) => (p === null ? null : [...list.querySelectorAll('.ed-row[data-path]')].find((r) => r.dataset.path === p) || null);
  function moveTo(p) {
    if (!p) return;
    const old = rowOf(cur);
    if (old) old.tabIndex = -1;
    cur = p;
    const row = rowOf(p);
    if (row) {
      row.tabIndex = 0;
      row.focus();
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  // The keys of a tree (as in VS Code's Explorer and the ARIA tree pattern).
  function keys(e) {
    const i = order.findIndex((r) => r.p === cur);
    const r = order[i];
    if (!r || !e.target.closest || !e.target.closest('.ed-row')) return;
    const take = (fn) => {
      e.preventDefault();
      fn();
    };
    if (e.key === 'ArrowDown') take(() => moveTo((order[i + 1] || r).p));
    else if (e.key === 'ArrowUp') take(() => moveTo((order[i - 1] || r).p));
    else if (e.key === 'Home') take(() => moveTo(order[0].p));
    else if (e.key === 'End') take(() => moveTo(order[order.length - 1].p));
    else if (e.key === 'ArrowRight' && r.isDir) take(() => (open.has(r.p) ? order[i + 1] && order[i + 1].parent === r.p && moveTo(order[i + 1].p) : press(r.p, true, false)));
    else if (e.key === 'ArrowLeft') take(() => (r.isDir && open.has(r.p) ? press(r.p, true, false) : r.parent && moveTo(r.parent)));
    else if (e.key === 'Enter') take(() => press(r.p, r.isDir, true));
    else if (e.key === ' ') take(() => press(r.p, r.isDir, false));
    else if (e.key === 'F2') take(() => renameIt(r.p));
    else if (e.key === 'Delete') take(() => removeIt(r.p, r.isDir));
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) take(() => menu(r.p, r.isDir));
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyX') take(() => cutIt(r.p));
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV' && cut !== null) take(() => moveInto(cut, r.isDir ? r.p : r.parent));
  }

  async function press(p, isDir, keep) {
    selected = p;
    if (!isDir) {
      paint();
      return wb.tabs.open(p, { preview: !keep });
    }
    if (open.has(p)) open.delete(p);
    else {
      open.add(p);
      if (!kids.has(p)) {
        paint();
        await read(p).catch((e) => toast(e, { kind: 'error' }));
      }
    }
    paint();
  }

  // Where a new file goes: into the folder pressed last, or next to the file pressed last.
  const targetDir = () => {
    if (selected === null) return '';
    return kidsKind(selected) === 'dir' ? selected : selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';
  };
  const kidsKind = (p) => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const e = (kids.get(dir) || []).find((x) => x.name === p.split('/').pop());
    return e ? e.kind : null;
  };

  async function make(kind, dir = targetDir()) {
    const name = await promptSheet({ title: kind === 'dir' ? 'New folder' : 'New file', text: dir ? `In ${dir}` : `In ${wb.label}`, ok: 'Create', placeholder: kind === 'dir' ? 'folder-name' : 'file-name.txt', check: checkName });
    if (name === null) return;
    const p = join(dir, name.trim());
    try {
      await wb.post('create', { path: p, kind });
    } catch (e) {
      return toast(e.code === 'exists' ? `${name.trim()} is already there.` : e.message, { kind: 'error' });
    }
    if (dir) open.add(dir);
    await refreshDir(dir);
    selected = p;
    if (kind === 'file') await wb.tabs.open(p, { preview: false });
    else {
      open.add(p);
      kids.set(p, []);
    }
    paint();
    wb.onChanged();
  }

  async function renameIt(p) {
    const old = p.split('/').pop();
    const dir = p.slice(0, Math.max(0, p.length - old.length - 1));
    const name = await promptSheet({ title: `Rename ${old}`, value: old, select: renameSelection(old, kidsKind(p) === 'dir'), ok: 'Rename', check: (v) => checkName(v) || (v.trim() === old ? 'Type a new name.' : '') });
    if (name === null) return;
    const to = join(dir, name.trim());
    try {
      await wb.post('rename', { from: p, to });
    } catch (e) {
      return toast(e.code === 'exists' ? `${name.trim()} is already there.` : e.message, { kind: 'error' });
    }
    // What was open under the old name keeps its place under the new one.
    for (const x of [...open]) if (x === p || x.startsWith(`${p}/`)) {
      open.delete(x);
      open.add(to + x.slice(p.length));
    }
    for (const x of [...kids.keys()]) if (x === p || x.startsWith(`${p}/`)) kids.delete(x);
    wb.tabs.renamed(p, to);
    selected = to;
    await refreshDir(dir);
    wb.onChanged();
  }

  async function removeIt(p, isDir) {
    const name = p.split('/').pop();
    const ok = await confirmSheet({
      title: `Delete ${name}?`,
      text: isDir ? `The folder ${p} and everything in it is deleted from the disk. Unsaved changes in its open files are lost too.` : `${p} is deleted from the disk. If it has unsaved changes in a tab, they are lost too.`,
      ok: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await wb.post('delete', { path: p, confirm: true });
    } catch (e) {
      return toast(e, { kind: 'error' });
    }
    wb.tabs.removed(p);
    for (const x of [...kids.keys()]) if (x === p || x.startsWith(`${p}/`)) kids.delete(x);
    open.delete(p);
    selected = null;
    // The keys stay in the tree: on the row after the deleted one, else the one before it.
    const i = order.findIndex((r) => r.p === p);
    const next = order.slice(i + 1).find((r) => r.p !== p && !r.p.startsWith(`${p}/`)) || order[i - 1];
    cur = next ? next.p : null;
    await refreshDir(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    moveTo(cur);
    toast(`Deleted ${name}`);
    wb.onChanged();
  }

  function cutIt(p) {
    cut = p;
    toast(`Cut ${p.split('/').pop()}: Paste (Ctrl+V) on a folder moves it there.`, { kind: 'info' });
  }

  /** Move `from` into folder `dir` (a rename to the same name there): its tabs follow, never over something there. */
  async function moveInto(from, dir) {
    if (!mayDrop(from, dir)) return toast(dir === from || dir.startsWith(`${from}/`) ? 'A folder cannot be moved into itself.' : 'It is in that folder already.', { kind: 'info' });
    const name = from.split('/').pop();
    const to = join(dir, name);
    try {
      await wb.post('rename', { from, to });
    } catch (e) {
      return toast(e.code === 'exists' ? `${name} is already in ${dir || wb.label}.` : e.message, { kind: 'error' });
    }
    if (cut === from) cut = null;
    for (const x of [...open]) if (x === from || x.startsWith(`${from}/`)) {
      open.delete(x);
      open.add(to + x.slice(from.length));
    }
    for (const x of [...kids.keys()]) if (x === from || x.startsWith(`${from}/`)) kids.delete(x);
    wb.tabs.renamed(from, to);
    if (dir) open.add(dir);
    selected = to;
    cur = to;
    await Promise.all([refreshDir(parentOf(from)), refreshDir(dir)]);
    toast(`Moved ${name} to ${dir || wb.label}`);
    wb.onChanged();
  }

  async function menu(p, isDir) {
    selected = p;
    paint();
    const what = await chooseSheet({
      title: p.split('/').pop(),
      subtitle: p,
      items: [
        isDir ? null : { value: 'open', label: 'Open', icon: 'text' },
        isDir ? { value: 'file', label: 'New file here', icon: 'plus' } : null,
        isDir ? { value: 'dir', label: 'New folder here', icon: 'folder' } : null,
        { value: 'rename', label: 'Rename...', sub: 'F2', icon: 'pencil' },
        { value: 'cut', label: 'Cut', sub: 'Ctrl+X, then Paste (Ctrl+V) on a folder moves it; dragging it there does the same', icon: 'swap' },
        cut !== null && isDir && mayDrop(cut, p) ? { value: 'paste', label: `Paste ${cut.split('/').pop()}`, sub: 'Ctrl+V: moves it into this folder', icon: 'clipboard' } : null,
        { value: 'fullpath', label: 'Copy Path', sub: 'Ctrl+K P for the open file', icon: 'copy' },
        { value: 'copy', label: 'Copy Relative Path', sub: 'Relative to the opened folder', icon: 'copy' },
        { value: 'files', label: 'Show in Files', sub: 'The desktop\'s file manager', icon: 'folder' },
        { value: 'delete', label: 'Delete', sub: isDir ? 'The folder and everything in it' : 'From the disk', icon: 'trash', danger: true },
      ].filter(Boolean),
    });
    if (what === 'open') wb.tabs.open(p, { preview: false });
    else if (what === 'file' || what === 'dir') make(what, p);
    else if (what === 'rename') renameIt(p);
    else if (what === 'delete') removeIt(p, isDir);
    else if (what === 'copy') toast((await copyText(p)) ? 'Path copied' : 'Could not copy', { kind: 'info' });
    else if (what === 'fullpath' && wb.copyPath) wb.copyPath(true, p);
    else if (what === 'cut') cutIt(p);
    else if (what === 'paste' && cut !== null) moveInto(cut, p);
    else if (what === 'files') openApp('files', filesHash(`${wb.root}/${isDir ? p : p.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''), null, isDir ? null : p.split('/').pop()));
  }

  async function refreshDir(dir) {
    await read(dir).catch(() => {});
    paint();
  }

  /** Read every open folder again (a session or git may have changed files). */
  async function refresh() {
    const dirs = [...open].filter((d) => d === '' || kids.has(d));
    await Promise.all(dirs.map((d) => read(d).catch(() => {})));
    for (const d of [...kids.keys()]) if (!open.has(d)) kids.delete(d);
    paint();
  }

  /** Show `p` in the tree: open the folders on the way to it. */
  async function reveal(p, { focus = false } = {}) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      open.add(d);
      if (!kids.has(d)) await read(d).catch(() => {});
    }
    paint();
    if (focus) {
      selected = p;
      moveTo(p);
    } else {
      const row = rowOf(p);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  return {
    el,
    /** The first read of the opened folder: true when it could be read (else the page shows why). */
    start: () => read('').then(() => {
      paint();
      return true;
    }, () => false),
    paint, refresh, reveal, make,
    /** The keyboard on the tree's one Tab stop. */
    focus() {
      const row = rowOf(cur) || list.querySelector('.ed-row[data-path]');
      if (!row) return;
      row.tabIndex = 0;
      row.focus();
    },
  };
}
