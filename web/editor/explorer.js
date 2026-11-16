// Explorer: the opened folder as a tree, read one level at a time as folders open. A press opens a file (in the
// preview tab), a double press keeps it open; each row's menu (its "…" button, or a right click) renames, deletes and
// makes new files and folders. git's state colours the names: changed, new, staged, in conflict.
import { btn, chooseSheet, confirmSheet, copyText, fill, h, promptSheet, toast } from '../lib.js';
import { icon } from '../icons.js';
import { markClass } from './scm.js';

const NAME_RE = /^[^/\\\0]+$/;
const checkName = (v) => {
  const n = v.trim();
  if (!n) return 'Type a name.';
  if (!NAME_RE.test(n) || n === '.' || n === '..') return 'A name cannot hold "/" or "\\".';
  if (n.startsWith('-')) return 'A name cannot start with "-".';
  return '';
};
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** wb: { get, post, tabs, root, label, gitMarks() → Map(path → letter), onChanged() }. */
export function createExplorer(wb) {
  const open = new Set(['']); // folders shown open
  const kids = new Map(); // folder → its entries, once read
  const truncated = new Set();
  let selected = null; // the row pressed last (a file or a folder): where "New file" goes
  const list = h('div.ed-tree', { role: 'tree', 'aria-label': 'Files' });
  const head = h('div.ed-panelhead',
    h('h2.ed-paneltitle', wb.label),
    h('div.ed-paneltools',
      btn('icon ghost small', { icon: 'plus', title: 'New file', onclick: () => make('file') }),
      btn('icon ghost small', { icon: 'folder', title: 'New folder', onclick: () => make('dir') }),
      btn('icon ghost small', { icon: 'refresh', title: 'Read the folder again', onclick: () => refresh() }),
      btn('icon ghost small', { icon: 'up', title: 'Close every folder', onclick: () => {
        open.clear();
        open.add('');
        paint();
      } })));
  const el = h('div.ed-panel.ed-explorer', head, list);

  async function read(dir) {
    try {
      const r = await wb.get('tree', { dir });
      kids.set(dir, r.entries);
      if (r.truncated) truncated.add(dir);
      else truncated.delete(dir);
    } catch (e) {
      kids.set(dir, []);
      if (dir === '') fill(list, h('p.ed-panelnote', e.message));
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
      out.push(h(`div.ed-row${cls}${active ? '.on' : ''}${selected === p ? '.sel' : ''}`, {
        role: 'treeitem', tabindex: '0', title: p, 'aria-expanded': isDir ? String(isOpen) : null,
        style: { paddingLeft: `${8 + depth * 14}px` },
        onclick: () => press(p, isDir, false),
        ondblclick: () => !isDir && wb.tabs.open(p, { preview: false }),
        oncontextmenu: (ev) => {
          ev.preventDefault();
          menu(p, isDir);
        },
        onkeydown: (ev) => {
          if (ev.key === 'Enter') press(p, isDir, true);
          else if (ev.key === 'F2') renameIt(p);
          else if (ev.key === 'Delete') removeIt(p, isDir);
        },
      },
      isDir ? icon(isOpen ? 'chevronDown' : 'chevronRight', { size: 14 }) : h('span.ed-row-gap'),
      icon(isDir ? 'folder' : 'text', { size: 15 }),
      h('span.ed-row-name', e.name, e.link ? h('span.ed-row-link', ' ↗') : null),
      letter ? h('span.ed-row-mark', letter) : null,
      h('button.ed-row-more', { type: 'button', title: 'More', 'aria-label': `More for ${e.name}`, onclick: (ev) => {
        ev.stopPropagation();
        menu(p, isDir);
      } }, icon('more', { size: 15 }))));
      if (isOpen) {
        if (!kids.has(p)) out.push(h('div.ed-row.ed-row-wait', { style: { paddingLeft: `${22 + depth * 14}px` } }, 'Loading…'));
        else rows(p, depth + 1, mk, out);
      }
    }
    if (truncated.has(dir)) out.push(h('p.ed-panelnote', { style: { paddingLeft: `${22 + depth * 14}px` } }, 'Only the first 2,000 entries are shown.'));
    return out;
  }

  function paint() {
    if (!kids.has('')) return;
    const out = rows('', 0, marks(), []);
    fill(list, out.length ? out : h('p.ed-panelnote', 'This folder is empty.'));
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
        await read(p).catch((e) => toast(e.message, { kind: 'error' }));
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
    const name = await promptSheet({ title: `Rename ${old}`, value: old, ok: 'Rename', check: (v) => checkName(v) || (v.trim() === old ? 'Type a new name.' : '') });
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
      return toast(e.message, { kind: 'error' });
    }
    wb.tabs.removed(p);
    for (const x of [...kids.keys()]) if (x === p || x.startsWith(`${p}/`)) kids.delete(x);
    open.delete(p);
    selected = null;
    await refreshDir(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    toast(`Deleted ${name}`);
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
        { value: 'rename', label: 'Rename', sub: 'F2', icon: 'pencil' },
        { value: 'copy', label: 'Copy the path', sub: 'Relative to the opened folder', icon: 'copy' },
        { value: 'delete', label: 'Delete', sub: isDir ? 'The folder and everything in it' : 'From the disk', icon: 'trash', danger: true },
      ].filter(Boolean),
    });
    if (what === 'open') wb.tabs.open(p, { preview: false });
    else if (what === 'file' || what === 'dir') make(what, p);
    else if (what === 'rename') renameIt(p);
    else if (what === 'delete') removeIt(p, isDir);
    else if (what === 'copy') toast((await copyText(p)) ? 'Path copied' : 'Could not copy', { kind: 'info' });
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
  async function reveal(p) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      open.add(d);
      if (!kids.has(d)) await read(d).catch(() => {});
    }
    paint();
  }

  return { el, start: () => read('').then(paint, () => {}), paint, refresh, reveal, make };
}
