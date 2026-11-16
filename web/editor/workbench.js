// The editor page (#/code?dir=<folder>&file=<path>&line=<n>&view=explorer|search|changes), laid out as in VS Code:
// an activity bar (Explorer, Search, Source Control), the side panel, the tabs with the editor, and a status bar
// (branch, line and column, tab size, line ends, language). On a phone one pane at a time, switched from a bar at the
// bottom. The address follows what is open, so a reload or a shared link lands in the same place.
import { BARE, api, btn, chooseSheet, fill, h, link, machine, prefs, promptSheet, tildePath, toast } from '../lib.js';
import { icon } from '../icons.js';
import { pageNotify, store } from '../store.js';
import { named, wayBack } from '../trail.js';
import { createExplorer } from './explorer.js';
import { PREFS_EVENT, editorPrefs, followTheme, setEditorPref } from './monaco.js';
import { createScm, marksOf } from './scm.js';
import { createQuickOpen, createSearch } from './search.js';
import { folderName, forget, refused, remember } from './places.js';
import { createTabs } from './tabs.js';

const VIEWS = [
  { id: 'explorer', label: 'Explorer', short: 'Files', icon: 'folder', keys: 'Ctrl+Shift+E' },
  { id: 'search', label: 'Search', short: 'Search', icon: 'search', keys: 'Ctrl+Shift+F' },
  { id: 'changes', label: 'Source Control', short: 'Changes', icon: 'git', keys: 'Ctrl+Shift+G' },
];
// A phone: one pane at a time. (Read lazily where a test loads the module without a browser.)
const phoneQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 699px)') : { matches: false, addEventListener() {}, removeEventListener() {} };

/** The address of the editor on `dir` (of the computer whose screen is open). */
export function codeHash(dir, { file = '', line = 0, view = '' } = {}, m = machine.current) {
  const q = new URLSearchParams({ dir });
  if (file) q.set('file', file);
  if (line > 0) q.set('line', String(line));
  if (view) q.set('view', view);
  return link(`#/code?${q}`, m);
}

/**
 * Draw the editor for ctx.query's folder. `onCurrent(handle)` gets what the leave guard needs:
 * { root, machine, dirty(), openFrom(query) } (null when the page goes).
 */
export function viewCode({ query }, onCurrent) {
  const root = query.get('dir');
  const app = document.getElementById('app');
  document.body.classList.remove('has-nav');
  document.body.classList.add('code-mode');
  const label = folderName(root);
  named(label);
  pageNotify.setTitleBase(label); // the tab's (and a desktop window's) name: the folder
  // In a window of the desktop with nowhere to go back to, no way back: the window has its own close.
  const way = wayBack() || (BARE ? null : { hash: link('#/workspace'), label: 'Workspace' });
  const here = machine.current;

  let view = VIEWS.some((v) => v.id === query.get('view')) ? query.get('view') : 'explorer';
  let pane = query.get('file') ? 'editor' : 'side'; // on a phone
  let alive = true;
  let failed = false; // the folder cannot be opened: one message for the whole page
  let status = null;
  let marksKey = '';
  const cursor = { line: 1, col: 1 };

  const wb = {
    root, label,
    get: (p, params) => api(`/api/code/${p}?${new URLSearchParams({ root, ...params })}`),
    post: (p, body) => api(`/api/code/${p}`, { root, ...body }),
    get plain() {
      return editorPrefs().plain;
    },
    gitMarks: () => marksOf(status),
    hasStaged: (p) => Boolean(status && status.repo && status.staged.some((x) => x.path === p)),
    onRootError: (e) => rootError(e),
    onActive: (t, user) => {
      if (!alive) return;
      explorer.paint();
      paintStatus();
      address();
      if (t && user && phoneQuery.matches) setPane('editor');
    },
    onCursor: (p) => {
      Object.assign(cursor, p);
      paintStatus();
    },
    onDirty: () => paintDirty(),
    onSaved: () => {
      soon();
      quick.stale();
    },
    onStatus: (st) => {
      status = st;
      // Drawn again only when git's marks changed: a redraw under a finger or a pointer would swallow its press.
      const key = JSON.stringify([...marksOf(st)]);
      if (key !== marksKey) {
        marksKey = key;
        explorer.paint();
      }
      paintStatus();
      paintActivity();
    },
    onDiscarded: async () => {
      await explorer.refresh();
      await tabs.check(); // a discarded change goes from its open tab too, a deleted new file's tab closes
      tabs.refreshDiffs();
    },
    onChanged: () => {
      quick.stale();
      soon();
    },
  };

  const tabs = createTabs(wb);
  wb.tabs = tabs;
  const explorer = createExplorer(wb);
  const search = createSearch(wb);
  const scm = createScm(wb);
  const quick = createQuickOpen(wb);
  const panels = { explorer: explorer.el, search: search.el, changes: scm.el };

  // ---------- layout ----------
  // Under the title: the folder, and the computer it is on when that is not this one (its name may come later).
  const subEl = h('div.ed-sub', { title: root });
  const paintSub = () => {
    const where = here ? (store.all.find((m) => m.machine === here) || {}).machineLabel || here : null;
    fill(subEl, where ? `${where} · ` : '', here ? root : tildePath(root));
  };
  paintSub();
  const stopStore = store.subscribe(paintSub);
  const saveBtn = btn('small secondary ed-savebtn', { icon: 'check', label: 'Save', title: 'Save (Ctrl+S)', disabled: true, onclick: async () => {
    // The button hides itself once nothing is unsaved: the keys go back to the editor, not to the page.
    tabs.focus();
    await tabs.save();
    tabs.focus();
  } });
  const bar = h('header.ed-bar',
    way ? h('a.btn.ghost.ed-back', { href: way.hash, 'aria-label': `Back to ${way.label}`, title: `Back to ${way.label}` }, icon('back'), h('span.ed-back-label', way.label)) : null,
    h('div.ed-head', h('h1.ed-title', label), subEl),
    h('div.ed-bar-end',
      saveBtn,
      btn('icon ghost', { icon: 'search', title: 'Go to file (Ctrl+P)', onclick: () => quick.open() }),
      btn('icon ghost', { icon: 'more', title: 'More', onclick: () => menu() })));
  const activity = h('nav.ed-activity', { 'aria-label': 'Views' });
  const side = h('div.ed-side');
  const resize = h('div.ed-resize', { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to change the width' });
  const phonebar = h('nav.ed-phonebar', { 'aria-label': 'Panes' });
  const statusEl = h('footer.ed-status');
  const main = h('div.ed-main', activity, side, resize, tabs.el);
  const wrap = h('div.ed-wrap', bar, main, statusEl, phonebar, quick.el);
  wrap.style.setProperty('--ed-side', `${prefs.get('editor.side', 300)}px`);
  fill(app, wrap);

  let activityKey = '';
  function paintActivity() {
    // One per file, as Workspace's "N changes" counts: a file staged and changed again is one change, not two.
    const n = marksOf(status).size;
    // As the Explorer: drawn again only when something on it changed.
    const key = `${view}|${pane}|${n}|${wrap.classList.contains('ed-noside')}`;
    if (key === activityKey) return;
    activityKey = key;
    const badge = (v) => (v.id === 'changes' && n ? h('span.ed-badge', n > 99 ? '99+' : String(n)) : null);
    fill(activity, VIEWS.map((v) => h(`button.ed-act${v.id === view ? '.on' : ''}`, { type: 'button', title: `${v.label} (${v.keys})`, 'aria-label': v.label, 'aria-pressed': String(v.id === view), onclick: () => showView(v.id, { toggle: true }) },
      icon(v.icon, { size: 22 }), badge(v))));
    fill(phonebar, [...VIEWS.map((v) => h(`button.ed-pb${pane === 'side' && v.id === view ? '.on' : ''}`, { type: 'button', onclick: () => {
      showView(v.id);
      setPane('side');
    } }, icon(v.icon, { size: 20 }), h('span', v.short), badge(v))),
    h(`button.ed-pb${pane === 'editor' ? '.on' : ''}`, { type: 'button', onclick: () => setPane('editor') }, icon('text', { size: 20 }), h('span', 'Editor'))]);
  }

  function showView(id, { toggle = false } = {}) {
    // A second press on the open view closes the side panel (VS Code does the same).
    if (toggle && id === view && !phoneQuery.matches) {
      wrap.classList.toggle('ed-noside');
      paintActivity();
      return;
    }
    view = id;
    wrap.classList.remove('ed-noside');
    fill(side, panels[id]);
    if (id === 'changes') scm.refresh();
    paintActivity();
    address();
  }

  function setPane(p) {
    pane = p;
    wrap.classList.toggle('ed-pane-editor', p === 'editor');
    paintActivity();
    paintStatus();
    if (p === 'editor') requestAnimationFrame(() => tabs.layout());
  }

  function paintStatus() {
    const t = tabs.active;
    const st = status;
    const p = editorPrefs();
    fill(statusEl,
      st && st.repo ? h('button.ed-st', { type: 'button', title: 'Source Control', onclick: () => showView('changes') }, icon('git', { size: 13 }),
        h('span', st.detached ? 'Detached' : st.branch || '(no branch)'), st.upstream && (st.ahead || st.behind) ? h('span', `↑${st.ahead} ↓${st.behind}`) : null) : null,
      h('span.ed-st-gap'),
      // On a phone with the side pane up, the file is not on screen: its line and language would say nothing.
      t && t.kind === 'file' && !t.note && !(phoneQuery.matches && pane === 'side') ? [
        h('button.ed-st', { type: 'button', title: 'Go to line (Ctrl+G)', onclick: () => goToLine() }, `Ln ${cursor.line}, Col ${cursor.col}`),
        h('span.ed-st.ed-st-wide', `Spaces: ${p.tabSize}`),
        h('span.ed-st.ed-st-wide', tabs.eol(t)),
        h('span.ed-st', tabs.language(t)),
      ] : null);
  }

  function paintDirty() {
    const n = tabs.dirty().length;
    saveBtn.disabled = !(tabs.active && tabs.dirty().includes(tabs.active.kind === 'compare' ? tabs.active.file : tabs.active));
    wrap.classList.toggle('ed-has-dirty', n > 0);
  }

  // The address says what is open: the folder, the file, the view (not a new place in the trail: replaced).
  function address() {
    const t = tabs.active;
    const want = codeHash(root, { file: t ? t.path : '', view: view === 'explorer' ? '' : view }, here);
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  // ---------- the side panel's width ----------
  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resize.setPointerCapture(e.pointerId);
    const left = side.getBoundingClientRect().left;
    const move = (ev) => {
      const w = Math.max(180, Math.min(640, Math.round(ev.clientX - left)));
      wrap.style.setProperty('--ed-side', `${w}px`);
      prefs.set('editor.side', w);
    };
    const up = () => {
      resize.removeEventListener('pointermove', move);
      resize.removeEventListener('pointerup', up);
      tabs.layout();
    };
    resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', up);
  });

  // ---------- commands and keys ----------
  async function goToLine() {
    const ed = tabs.editor;
    if (ed && tabs.active && tabs.active.kind === 'file') {
      ed.focus();
      ed.trigger('keyboard', 'editor.action.gotoLine', null);
      return;
    }
    if (!tabs.active || tabs.active.kind !== 'file') return;
    const v = await promptSheet({ title: 'Go to line', ok: 'Go', type: 'number', check: (x) => (Number(x) > 0 ? '' : 'Type a line number.') });
    if (v) tabs.reveal(Number(v));
  }

  function findInFiles() {
    const ed = tabs.editor;
    let sel = '';
    if (ed && ed.getModel && ed.getSelection) {
      const s = ed.getSelection();
      if (s && !s.isEmpty() && ed.getModel()) sel = ed.getModel().getValueInRange(s);
    }
    showView('search');
    setPane('side');
    search.focus(sel);
  }

  async function menu() {
    const plain = editorPrefs().plain;
    const what = await chooseSheet({
      title: label,
      subtitle: tildePath(root),
      items: [
        { value: 'quick', label: 'Go to file', sub: 'Ctrl+P', icon: 'search' },
        { value: 'find', label: 'Find in files', sub: 'Ctrl+Shift+F', icon: 'search' },
        { value: 'line', label: 'Go to line', sub: 'Ctrl+G', icon: 'chevronRight' },
        { value: 'plain', label: plain ? 'Use the code editor' : 'Plain text editing', sub: plain ? 'Colours, find and the rest of VS Code\'s editor' : 'A plain text box, for a phone where the code editor cannot be typed into', icon: 'text' },
        { value: 'settings', label: 'Editor settings', sub: 'Text size, tab size, word wrap', icon: 'settings' },
      ],
    });
    if (what === 'quick') quick.open();
    else if (what === 'find') findInFiles();
    else if (what === 'line') goToLine();
    else if (what === 'settings') location.hash = link('#/settings/editor', null);
    else if (what === 'plain') {
      setEditorPref('plain', !plain);
      const kept = await tabs.remode();
      if (kept) toast(`${kept} file${kept === 1 ? '' : 's'} with unsaved changes stay as they are until saved and opened again.`);
    }
  }

  const onKey = (e) => {
    if (failed || !(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector('dialog.sheet[open]')) return;
    const k = e.key.toLowerCase();
    const take = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (k === 's' && !e.shiftKey) take(() => tabs.save());
    else if (k === 'p' && !e.shiftKey) take(() => quick.open());
    else if (k === 'p' && e.shiftKey && tabs.editor && tabs.active.kind === 'file') take(() => {
      tabs.editor.focus();
      tabs.editor.trigger('keyboard', 'editor.action.quickCommand', null);
    });
    else if (k === 'f' && e.shiftKey) take(findInFiles);
    else if (k === 'e' && e.shiftKey) take(() => {
      showView('explorer');
      setPane('side');
    });
    else if (k === 'g' && e.shiftKey) take(() => {
      showView('changes');
      setPane('side');
    });
    else if (k === 'g' && e.ctrlKey && !e.metaKey) take(goToLine);
  };
  window.addEventListener('keydown', onKey, true);

  // A tab or window that closes with unsaved changes: the browser asks.
  const onUnload = (e) => {
    if (!tabs.dirty().length) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onUnload);

  // ---------- git's state, kept fresh ----------
  let soonTimer = null;
  const soon = () => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => alive && !failed && scm.refresh(), 300);
  };
  // A session, git or another window changes files all the time: the lists and the open tabs follow.
  const tick = setInterval(() => {
    if (!alive || failed || document.visibilityState !== 'visible') return;
    scm.refresh();
    tabs.check();
  }, 15_000);
  const onFocus = () => {
    if (!alive || failed) return;
    scm.refresh();
    explorer.refresh();
    tabs.check();
  };
  window.addEventListener('focus', onFocus);

  const stopTheme = followTheme();
  const onPrefs = () => {
    tabs.applyPrefs();
    paintStatus();
  };
  window.addEventListener(PREFS_EVENT, onPrefs);
  const onPhone = () => {
    wrap.classList.toggle('ed-phone', phoneQuery.matches);
    paintActivity();
    tabs.layout();
  };
  phoneQuery.addEventListener('change', onPhone);
  onPhone();
  setPane(pane);

  // ---------- what the address asks for ----------
  async function openFrom(q) {
    const file = q.get('file');
    const v = q.get('view');
    if (VIEWS.some((x) => x.id === v)) showView(v);
    if (!file) {
      if (v) setPane('side'); // a link to a view shows it, also on a phone with a file up
      return address();
    }
    const line = Number(q.get('line')) || 0;
    if (v === 'changes') {
      // "Show changes" for a file: its unstaged changes, else its staged ones, else the file.
      await scm.refresh();
      const st = scm.status;
      const has = (list) => st && st.repo && list.some((x) => x.path === file);
      if (st && has([...st.changes, ...st.untracked])) return tabs.openDiff(file);
      if (st && has(st.staged)) return tabs.openDiff(file, { staged: true });
    }
    await tabs.open(file, { line, preview: false });
    explorer.reveal(file);
  }

  // ---------- a folder that cannot be opened ----------
  // Outside the folders the dashboard may show, private, gone, or the computer cannot be reached: one plain message
  // for the whole page and what to do next, instead of an empty Explorer with its tools.
  function rootError(e) {
    if (!alive || failed) return;
    failed = true;
    forget(root, here);
    wrap.classList.add('ed-failed');
    fill(main, refused(e, root));
    paintStatus();
  }

  showView(view);
  paintStatus();
  // Kept among "Opened lately" only once it opened.
  explorer.start().then((ok) => ok && alive && remember(root, here));
  scm.refresh();
  openFrom(query);

  onCurrent({ root, machine: here, dirty: () => tabs.dirty().length, saveAll: () => tabs.saveAll(), openFrom });

  return () => {
    alive = false;
    onCurrent(null);
    stopStore();
    clearInterval(tick);
    clearTimeout(soonTimer);
    stopTheme();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('beforeunload', onUnload);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener(PREFS_EVENT, onPrefs);
    phoneQuery.removeEventListener('change', onPhone);
    tabs.dispose();
    document.body.classList.remove('code-mode');
  };
}
