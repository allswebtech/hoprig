// Files: the folders of a computer (GET /api/files/list and the rest of src/desktop/files.mjs), with name, size,
// date and kind, a path bar, sort, hidden files on request. A text file opens in the Editor app at that file, a
// picture in a small viewer, anything else as a download (always a download, never a page of the dashboard). New
// folder and file, rename, "Copy to" and "Move to" with a folder picker, delete into Hoprig's own trash (put back,
// empty), upload (a button, or files dropped on the window), pack into a .tar.gz and unpack, find by name.
// It reaches as far as the dashboard's one setting allows (Settings → Security: the allowed folders or everything).
// mount(root, { machine, query, open, place }): `query` the address's (path, select), `open(app, hash)` opens
// another app (the Editor), `place(query, title)` keeps where it is (the window's layout, the page's address).
import { icon } from '../icons.js';
import { api, at, bytes, copyText, fill, h, link, openSheet, prefs, promptSheet, toast } from '../lib.js';
import { ARCHIVE, download, joinPath, kindWord, openKind, splitPath, trashView, viewPicture } from './files-parts.js';
import { fileOps } from './files-ops.js';
import { openMenu, withMenu } from './menu.js';
import { errorLine, errorText, poll, sortBy, table, when } from './native.js';

export function mount(root, { machine, query = new URLSearchParams(), open = () => {}, place = () => {} }) {
  const call = (p, body) => api(at(machine, p), body);
  let cur = null; // the folder's answer
  let hidden = prefs.get('files.hidden', false) === true;
  let mode = 'folder'; // 'folder' | 'find' | 'trash'
  let found = null; // the answer of a find
  let sel = new Set(); // names (folder) or full paths (find) chosen
  let anchor = null; // where a Shift press reaches from
  let stopTrash = null;
  let pending = query.get('select'); // a name to choose once the folder is read
  const back = [];
  const note = h('div');
  const status = h('span.dapp-status', { role: 'status' });
  const busy = h('span.dapp-status', { role: 'status', 'aria-live': 'polite' });
  const crumbs = h('nav.dfiles-crumbs', { 'aria-label': 'Path' });
  const reach = h('p.hint.dapp-hint.dfiles-reach');
  const t = table('Files', [
    { key: 'name', label: 'Name', w: 'minmax(160px, 2fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'size', label: 'Size', w: '84px', num: true, narrow: 'auto' },
    { key: 'mtime', label: 'Modified', w: '130px', num: true, narrow: false },
    { key: 'kindWord', label: 'Kind', w: '110px', narrow: false },
    { key: 'act', label: '', sort: false, w: '40px', narrow: '40px' },
  ], { sort: { key: 'name', desc: false }, onSort: () => draw() });
  t.el.classList.add('dfiles-table');
  const view = h('div.dapp-view');
  const findField = h('input.field.dapp-filter', { type: 'search', placeholder: 'Find by name in this folder', 'aria-label': 'Find by name in this folder', autocomplete: 'off', spellcheck: 'false',
    onkeydown: (e) => {
      if (e.key === 'Enter') find(e.target.value);
      if (e.key === 'Escape' && mode === 'find') toFolder();
    } });
  const tool = (ic, label, run, extra = {}) => h('button.btn.secondary.small.dfiles-tool', { type: 'button', title: label, 'aria-label': label, onclick: run, ...extra }, icon(ic, { size: 14 }), h('span.dapp-word', label));
  const iconBtn = (ic, label, run) => h('button.dapp-btn', { type: 'button', title: label, 'aria-label': label, onclick: run }, icon(ic, { size: 15 }));
  const backBtn = iconBtn('back', 'Back', () => back.length && go(back.pop(), { push: false }));
  const upBtn = iconBtn('folderUp', 'Up one folder', () => cur && cur.parent && go(cur.parent));
  const hiddenBtn = tool('search', 'Hidden files', () => {
    hidden = !hidden;
    prefs.set('files.hidden', hidden);
    hiddenBtn.setAttribute('aria-pressed', String(hidden));
    load();
  }, { 'aria-pressed': String(hidden) });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    uploadAll(files);
  } });
  const selBar = h('div.dapp-bar.dfiles-selbar.hidden');

  // ---------- reading ----------

  async function load() {
    if (!cur && !query.get('path')) return go(null, { push: false });
    return go(cur ? cur.path : query.get('path'), { push: false, keep: true });
  }
  async function go(p, { push = true, keep = false } = {}) {
    let r;
    try {
      r = await call(`/api/files/list?${new URLSearchParams({ ...(p ? { path: p } : {}), ...(hidden ? { hidden: '1' } : {}) })}`);
    } catch (e) {
      // The folder went away (or the reach changed): one level up, else the top.
      if (!cur && p) return go(null, { push: false });
      fill(note, errorLine(e));
      return;
    }
    if (push && cur && cur.path !== r.path) back.push(cur.path);
    const moved = !cur || cur.path !== r.path;
    cur = r;
    if (moved && !keep) sel = new Set();
    if (moved) anchor = null;
    sel = new Set([...sel].filter((n) => r.entries.some((e) => e.name === n)));
    if (pending && r.entries.some((e) => e.name === pending)) sel = new Set([pending]);
    pending = null;
    fill(note);
    if (mode === 'find' && moved) mode = 'folder';
    paintCrumbs();
    if (moved) place(new URLSearchParams({ path: r.path }).toString(), splitPath(r.path).name || r.path);
    draw();
  }

  function paintCrumbs() {
    const top = cur.top;
    const rest = cur.path.slice(top.length).split(/[\\/]/).filter(Boolean);
    const topName = top === '/' ? 'Computer' : splitPath(top).name || top;
    const parts = [[topName, top]];
    let p = top;
    for (const s of rest) parts.push([s, (p = joinPath(p, s))]);
    fill(crumbs, parts.map(([name, to], i) => [
      i ? h('span.dfiles-sep', { 'aria-hidden': 'true' }, icon('chevronRight', { size: 12 })) : null,
      i === parts.length - 1 ? h('span.dfiles-crumb', { 'aria-current': 'location', title: to }, name)
        : h('button.dfiles-crumb', { type: 'button', title: to, onclick: () => go(to) }, name),
    ]), iconBtn('pencil', 'Type a path', () => typePath()));
    backBtn.disabled = !back.length;
    upBtn.disabled = !cur.parent;
    const tops = cur.reach.tops;
    fill(reach, cur.reach.kind === 'everything' ? 'Files reaches everything your user can open on this computer.'
      : `Files reaches ${tops.length === 1 ? 'one folder' : `${tops.length} folders`}: ${tops.join(', ')}.`, ' ',
    h('a', { href: link('#/settings/security', machine) }, 'Change in Settings'));
  }

  async function typePath() {
    const p = await promptSheet({ title: 'Go to a folder', text: 'Its full path on this computer.', value: cur ? cur.path : '', ok: 'Go', label: 'Folder path', check: (v) => (v.trim() ? '' : 'Type a path.') });
    if (p) go(p.trim());
  }

  // ---------- drawing ----------

  const isFind = () => mode === 'find';
  /** The rows shown: a folder's entries, or what a find found ({ name, path, kind } with the folder as `where`). */
  function rows() {
    if (isFind()) return found.matches.map((m) => ({ ...splitPath(m.path), path: m.path, kind: m.kind, size: null, mtime: null, key: m.path }));
    return cur.entries.map((e) => ({ ...e, path: joinPath(cur.path, e.name), key: e.name }));
  }
  function draw() {
    if (!cur || mode === 'trash') return;
    const list = sortBy(rows().map((e) => ({ ...e, kindWord: kindWord(e) })), t.sort.key, t.sort.desc);
    // Folders first whatever the order, as in every file manager.
    list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1));
    t.draw(list.map((e) => ({
      key: e.key,
      cls: sel.has(e.key) ? 'dapp-picked' : null,
      cells: [
        h('button.dfiles-name', { type: 'button', title: e.path, dataset: { key: e.key } },
          icon(e.kind === 'dir' ? 'folder' : ARCHIVE.test(e.name) ? 'download' : 'text', { size: 15 }),
          h('span.dfiles-label', e.name), e.link ? h('span.badge.soft', 'link') : null,
          isFind() ? h('span.dfiles-where.mono', splitPath(e.path).dir) : null),
        h('span.dapp-dim', e.kind === 'dir' ? '–' : bytes(e.size)),
        h('span.dapp-dim', e.mtime ? when(e.mtime) : ''),
        h('span.dapp-dim', e.kindWord),
        h('button.dapp-btn.dfiles-more', { type: 'button', title: `More for ${e.name}`, 'aria-label': `More for ${e.name}`, dataset: { key: e.key } }, icon('more', { size: 15 })),
      ],
    })));
    const n = cur.entries.length;
    status.textContent = isFind() ? `${found.matches.length}${found.truncated ? '+' : ''} found${found.timedOut ? ' (the search stopped at its time limit)' : ''}`
      : `${n}${cur.truncated ? '+' : ''} ${n === 1 ? 'item' : 'items'}${sel.size ? ` · ${sel.size} chosen` : ''}`;
    paintSelBar();
  }

  function paintSelBar() {
    selBar.classList.toggle('hidden', !sel.size);
    if (!sel.size) return fill(selBar);
    const one = sel.size === 1 ? chosen()[0] : null;
    fill(selBar,
      h('span.dapp-status', `${sel.size} chosen`),
      one ? tool(one.kind === 'dir' ? 'folder' : 'external', 'Open', () => openEntry(one)) : null,
      one && one.kind === 'file' ? tool('download', 'Download', () => download(machine, one.path)) : null,
      one ? tool('pencil', 'Rename', () => renameIt(one)) : null,
      tool('copy', 'Copy to…', () => transfer(true)),
      tool('swap', 'Move to…', () => transfer(false)),
      isFind() ? null : tool('plus', 'Pack', () => packIt()),
      tool('trash', 'Delete', () => trashIt()),
      h('span.desk-grow'),
      iconBtn('x', 'Choose none', () => {
        sel = new Set();
        draw();
      }));
  }

  // ---------- choosing and opening ----------

  const entryOf = (key) => rows().find((e) => e.key === key) || null;
  const chosen = () => rows().filter((e) => sel.has(e.key));

  function choose(key, e = {}) {
    if (e.shiftKey && anchor) {
      const order = [...t.el.querySelectorAll('.dapp-tbody [data-key]')].map((r) => r.dataset.key).filter((k, i, a) => a.indexOf(k) === i);
      const [a, b] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) sel = new Set(order.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) {
      if (sel.has(key)) sel.delete(key);
      else sel.add(key);
      anchor = key;
    } else {
      sel = new Set([key]);
      anchor = key;
    }
    draw();
  }

  async function openEntry(e) {
    if (e.kind === 'dir') return go(e.path);
    const how = openKind(e);
    if (how === 'picture') return viewPicture(machine, e.path);
    if (how === 'archive') {
      const ok = await promptOpen(e, 'Unpack it into a new folder next to it, or download it.', [['unpack', 'Unpack'], ['download', 'Download']]);
      if (ok === 'unpack') unpackIt(e);
      if (ok === 'download') download(machine, e.path);
      return;
    }
    if (how === 'download') {
      const ok = await promptOpen(e, 'This kind of file is not shown here. It can be downloaded.', [['download', 'Download']]);
      if (ok === 'download') download(machine, e.path);
      return;
    }
    inEditor(e);
  }
  const promptOpen = (e, text, actions) => openSheet({ title: e.name, subtitle: `${kindWord(e)}${e.size !== null && e.size !== undefined ? ` · ${bytes(e.size)}` : ''}` }, (close) => [
    h('p.sheet-text', text),
    h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
      actions.map(([v, label], i) => h(`button.btn.${i === actions.length - 1 ? 'primary' : 'secondary'}`, { type: 'button', onclick: () => close(v) }, label))),
  ]);

  /** The editor on the repository the file is in (else its folder), at that file. */
  function inEditor(e) {
    const { dir } = splitPath(e.path);
    const top = !isFind() && cur.project && (e.path.startsWith(`${cur.project}/`) || e.path.startsWith(`${cur.project}\\`)) ? cur.project : dir;
    const rel = e.path.slice(top.length).replace(/^[\\/]+/, '').split('\\').join('/');
    open('editor', `#/code?${new URLSearchParams({ dir: top, file: rel })}`, { title: e.name });
  }

  const ops = fileOps({ machine, busy, cur: () => cur, chosen, isFind, clear: () => (sel = new Set()), load, after: async (msg, select) => {
    if (msg) toast(msg);
    if (select) pending = select;
    await load();
  } });
  const { make, renameIt, transfer, trashIt, packIt, unpackIt, uploadAll } = ops;

  async function find(text) {
    if (!text.trim()) return toFolder();
    busy.textContent = 'Looking…';
    try {
      found = await call(`/api/files/find?${new URLSearchParams({ path: cur.path, q: text.trim(), ...(hidden ? { hidden: '1' } : {}) })}`);
      mode = 'find';
      sel = new Set();
      draw();
    } catch (e) {
      toast(errorText(e), { kind: 'error', ms: 7000 });
    } finally {
      busy.textContent = '';
    }
  }
  function toFolder() {
    mode = 'folder';
    found = null;
    findField.value = '';
    sel = new Set();
    show();
  }
  function toTrash() {
    mode = 'trash';
    sel = new Set();
    show();
  }

  // ---------- the menu of a row, presses and keys ----------

  function rowMenu(key) {
    if (!sel.has(key)) choose(key);
    const many = sel.size > 1;
    const e = entryOf(key);
    if (!e) return null;
    return [
      many ? null : { label: e.kind === 'dir' ? 'Open' : openKind(e) === 'editor' ? 'Open in Editor' : 'Open', icon: e.kind === 'dir' ? 'folder' : 'external', run: () => openEntry(e) },
      !many && e.kind === 'file' ? { label: 'Download', icon: 'download', run: () => download(machine, e.path) } : null,
      !many && ARCHIVE.test(e.name) ? { label: 'Unpack here', icon: 'folder', run: () => unpackIt(e) } : null,
      !many ? { label: 'Rename', icon: 'pencil', run: () => renameIt(e) } : null,
      { label: 'Copy to…', icon: 'copy', run: () => transfer(true) },
      { label: 'Move to…', icon: 'swap', run: () => transfer(false) },
      isFind() ? null : { label: 'Pack into an archive', icon: 'plus', run: () => packIt() },
      !many ? { label: 'Copy the path', icon: 'clipboard', run: async () => toast((await copyText(e.path)) ? 'Path copied' : 'Could not copy') } : null,
      null,
      { label: 'Move to the trash', icon: 'trash', danger: true, run: () => trashIt() },
    ].filter((x, i, a) => x !== null || (i > 0 && a[i - 1] !== null));
  }

  t.el.addEventListener('click', (e) => {
    const more = e.target.closest('.dfiles-more');
    const row = e.target.closest('.dapp-tbody [data-key]');
    if (!row) return;
    const key = row.dataset.key;
    if (more) {
      const r = more.getBoundingClientRect();
      const items = rowMenu(key);
      if (items) openMenu(r.left, r.bottom, items, 'File');
      return;
    }
    // One press chooses, two open; on a touch screen one tap opens, as there is no hovering to see first.
    if (e.pointerType === 'touch' && !e.shiftKey) {
      const it = entryOf(key);
      if (it) openEntry(it);
      return;
    }
    choose(key, e);
  });
  t.el.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.dapp-tbody [data-key]');
    const it = row && !e.target.closest('.dfiles-more') ? entryOf(row.dataset.key) : null;
    if (it) openEntry(it);
  });
  withMenu(t.el, (e) => {
    const row = e.target.closest && e.target.closest('.dapp-tbody [data-key]');
    return row ? rowMenu(row.dataset.key) : mode === 'folder' ? [{ label: 'New folder', icon: 'folder', run: () => make('dir') }, { label: 'New file', icon: 'plus', run: () => make('file') }, { label: 'Upload files', icon: 'up', run: () => fileInput.click() }] : null;
  }, 'Files');
  root.addEventListener('keydown', (e) => {
    if (mode === 'trash' || e.target.closest('input, textarea, .sheet')) return;
    const names = [...t.el.querySelectorAll('.dfiles-name')];
    const i = names.indexOf(document.activeElement);
    const key = i >= 0 ? names[i].dataset.key : null;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && names.length) {
      e.preventDefault();
      const next = names[Math.max(0, Math.min(names.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
      next.focus();
      choose(next.dataset.key, e.shiftKey ? e : {});
    } else if (e.key === 'Enter' && key) {
      e.preventDefault();
      const it = entryOf(key);
      if (it) openEntry(it);
    } else if (e.key === ' ' && key) {
      e.preventDefault();
      choose(key, { ctrlKey: true });
    } else if (e.key === 'Delete' && sel.size) trashIt();
    else if (e.key === 'F2' && sel.size === 1) renameIt(chosen()[0]);
    else if (e.key === 'Backspace' && cur && cur.parent && mode === 'folder') go(cur.parent);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && mode !== 'trash') {
      e.preventDefault();
      sel = new Set(rows().map((r) => r.key));
      draw();
    }
  });

  // Files dropped from the computer the browser runs on: uploaded into the folder shown.
  root.addEventListener('dragover', (e) => {
    if (mode !== 'folder' || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    root.classList.add('dfiles-drop');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('dfiles-drop');
  });
  root.addEventListener('drop', (e) => {
    root.classList.remove('dfiles-drop');
    if (mode !== 'folder' || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    uploadAll([...e.dataTransfer.files]);
  });

  // ---------- the window ----------

  const folderBars = [
    h('div.dapp-bar.dfiles-path', backBtn, upBtn, crumbs),
    h('div.dapp-bar',
      tool('folder', 'New folder', () => make('dir')), tool('plus', 'New file', () => make('file')), tool('up', 'Upload', () => fileInput.click()),
      findField, hiddenBtn, tool('trash', 'Trash', () => toTrash()), h('span.desk-grow'), busy, status),
  ];
  function show() {
    if (stopTrash) stopTrash();
    stopTrash = null;
    if (mode === 'trash') {
      fill(view);
      stopTrash = trashView(view, machine, { done: () => toFolder(), changed: () => {} });
      return;
    }
    // The actions of what is chosen sit under the list: shown above it, they would move the rows under the pointer
    // between the two presses of a double press.
    fill(view, folderBars, note, t.el, selBar, reach, fileInput);
    draw();
  }
  fill(root, view);
  root.classList.add('dapp-files');
  show();
  const live = poll(root, () => (mode === 'folder' ? load() : null), 15000);
  return () => {
    live.stop();
    t.stop();
    if (stopTrash) stopTrash();
  };
}
