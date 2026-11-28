// The editor page (#/code?dir=<folder>&file=<path>&line=<n>&view=explorer|search|changes), laid out as in VS Code:
// an activity bar (Explorer, Search, Source Control), the side panel, the tabs with the editor, and a status bar
// (branch, line and column, tab size, line ends, language). On a phone one pane at a time, switched from a bar at the
// bottom. The address follows what is open, so a reload or a shared link lands in the same place.
import { BARE, api, btn, chooseSheet, copyText, fill, h, link, machine, openSheet, prefs, promptSheet, tildePath, toast } from '../lib.js';
import { icon } from '../icons.js';
import { pageNotify, store } from '../store.js';
import { named, wayBack } from '../trail.js';
import { createExplorer } from './explorer.js';
import { PREFS_EVENT, editorPrefs, followTheme, setEditorPref } from './monaco.js';
import { changeCount, createScm, inside, marksOf } from './scm.js';
import { BROWSER_LINE, COMMANDS, createKeyReader, strokeOf } from './commands.js';
import { createTerminal } from './terminal.js';
import { createQuickOpen, createSearch } from './search.js';
import { folderName, forget, refused, remember } from './places.js';
import { createTabs } from './tabs.js';
import { focusLost } from './tabops.js';

const VIEWS = [
  { id: 'explorer', label: 'Explorer', short: 'Files', icon: 'folder', keys: 'Ctrl+Shift+E' },
  { id: 'search', label: 'Search', short: 'Search', icon: 'search', keys: 'Ctrl+Shift+F' },
  { id: 'changes', label: 'Source Control', short: 'Changes', icon: 'git', keys: 'Ctrl+Shift+G' },
];
// A phone: one pane at a time. (Read lazily where a test loads the module without a browser.)
const phoneQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 699px)') : { matches: false, addEventListener() {}, removeEventListener() {} };

/**
 * The status bar's indentation, as VS Code words it: "Tab Size: 4" for a file indented with tabs (Monaco found
 * them, insertSpaces false: the Tab key types a tab), "Spaces: 2" otherwise.
 */
export const indentText = ({ insertSpaces = true, tabSize = 2 } = {}) => (insertSpaces ? `Spaces: ${tabSize}` : `Tab Size: ${tabSize}`);

/**
 * The number on a view's icon, or 0: Source Control counts its changes, the Explorer the files with unsaved changes
 * ("the Explorer view shows a badge indicating the number of unsaved files", VS Code's Basic Editing page).
 */
export const badgeOf = (id, { changes = 0, dirty = 0 } = {}) => (id === 'changes' ? changes : id === 'explorer' ? dirty : 0);

/**
 * The status bar's place, in VS Code's words (editorStatus.ts): "Ln 2, Col 10", "Ln 1, Col 7 (6 selected)", and with
 * several cursors "2 selections (6 characters selected)" or "2 selections", without a line and column.
 */
export function cursorText({ line = 1, col = 1, selected = 0, cursors = 1 } = {}) {
  if (cursors > 1) return `${cursors} selections${selected ? ` (${selected} characters selected)` : ''}`;
  return `Ln ${line}, Col ${col}${selected ? ` (${selected} selected)` : ''}`;
}

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
  const cursor = { line: 1, col: 1, selected: 0, cursors: 1 };

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
      if (!alive) return; // an answer that came after the page went: its tabs are gone
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
  const terminal = createTerminal({ root, machine: here, onHide: () => tabs.focus(), run: (id) => run(id) });
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
  const main = h('div.ed-main', activity, side, resize, h('div.ed-center', tabs.el, terminal.el));
  const wrap = h('div.ed-wrap', bar, main, statusEl, phonebar, quick.el);
  wrap.style.setProperty('--ed-side', `${prefs.get('editor.side', 300)}px`);
  fill(app, wrap);

  let activityKey = '';
  function paintActivity() {
    const counts = { changes: changeCount(status), dirty: tabs.dirty().length };
    // As the Explorer: drawn again only when something on it changed.
    const key = `${view}|${pane}|${counts.changes}|${counts.dirty}|${wrap.classList.contains('ed-noside')}`;
    if (key === activityKey) return;
    activityKey = key;
    const badge = (v) => {
      const n = badgeOf(v.id, counts);
      return n ? h('span.ed-badge', { title: v.id === 'explorer' ? `${n} unsaved` : null }, n > 99 ? '99+' : String(n)) : null;
    };
    fill(activity, VIEWS.map((v) => h(`button.ed-act${v.id === view ? '.on' : ''}`, { type: 'button', title: `${v.label} (${v.keys})`, 'aria-label': v.label, 'aria-pressed': String(v.id === view), onclick: () => showView(v.id, { toggle: true }) },
      icon(v.icon, { size: 22 }), badge(v))));
    fill(phonebar, [...VIEWS.map((v) => h(`button.ed-pb${pane === 'side' && v.id === view ? '.on' : ''}`, { type: 'button', onclick: () => {
      showView(v.id);
      setPane('side');
    } }, icon(v.icon, { size: 20 }), h('span', v.short), badge(v))),
    h(`button.ed-pb${pane === 'editor' ? '.on' : ''}`, { type: 'button', onclick: () => setPane('editor') }, icon('text', { size: 20 }), h('span', 'Editor'))]);
  }

  /**
   * Show or hide the side bar. When it hides with the keyboard in it, the keyboard goes to the editor (VS Code does
   * the same), not to the page's body where no key reaches anything.
   */
  function toggleSide() {
    const hiding = !wrap.classList.contains('ed-noside');
    wrap.classList.toggle('ed-noside');
    paintActivity();
    if (hiding && focusLost(document.activeElement, document.body, side)) keyboardHome();
  }

  /** The keyboard somewhere useful: the open tab's editor, else the side bar's view, else the activity bar. */
  function keyboardHome() {
    tabs.focus();
    const hidden = wrap.classList.contains('ed-noside') ? side : null;
    if (!focusLost(document.activeElement, document.body, hidden)) return;
    if (!hidden && view === 'explorer') explorer.focus();
    else if (!hidden && side.querySelector('input')) side.querySelector('input').focus();
    if (focusLost(document.activeElement, document.body, hidden)) {
      const b = activity.querySelector('.ed-act.on') || activity.querySelector('.ed-act');
      if (b) b.focus();
    }
  }

  function showView(id, { toggle = false } = {}) {
    // A second press on the open view closes the side panel (VS Code does the same).
    if (toggle && id === view && !phoneQuery.matches) return toggleSide();
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
        h('button.ed-st', { type: 'button', title: 'Go to Line/Column (Ctrl+G)', onclick: () => goToLine() }, cursorText(t.model ? cursor : { line: cursor.line, col: cursor.col })),
        h('button.ed-st.ed-st-wide', { type: 'button', title: 'Select Indentation: Tab Size', onclick: () => pickTabSize() }, indentText(t.model ? t.model.getOptions() : { tabSize: p.tabSize })),
        h('span.ed-st.ed-st-wide', { title: 'Encoding: the editor reads and saves UTF-8 (another encoding opens as a binary file)' }, 'UTF-8'),
        h('span.ed-st.ed-st-wide', { title: 'End of Line: kept as the file has it' }, tabs.eol(t)),
        h('span.ed-st', { title: 'Language Mode: from the file\'s name' }, tabs.language(t)),
      ] : null);
  }

  async function pickTabSize() {
    const now = editorPrefs().tabSize;
    const v = await chooseSheet({ title: 'Tab Size', subtitle: 'Spaces for the Tab key and for an indent, in this browser', items: [2, 4, 8].map((n) => ({ value: n, label: `Spaces: ${n}`, current: n === now })) });
    if (v) setEditorPref('tab', v);
  }

  function paintDirty() {
    const n = tabs.dirty().length;
    saveBtn.disabled = !(tabs.active && tabs.dirty().includes(tabs.active.kind === 'compare' ? tabs.active.file : tabs.active));
    wrap.classList.toggle('ed-has-dirty', n > 0);
    paintActivity(); // the Explorer's badge
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
        { value: 'terminal', label: 'Terminal', sub: 'Ctrl+`', icon: 'terminal' },
        { value: 'shortcuts', label: 'Keyboard shortcuts', sub: 'Ctrl+K Ctrl+S', icon: 'info' },
        { value: 'settings', label: 'Editor settings', sub: 'Font Size, Tab Size, Word Wrap', icon: 'settings' },
      ],
    });
    if (what === 'quick') quick.open();
    else if (what === 'find') findInFiles();
    else if (what === 'line') goToLine();
    else if (what === 'settings') location.hash = link('#/settings/appearance?show=code-editor', null);
    else if (what === 'terminal' || what === 'shortcuts') run(what);
    else if (what === 'plain') {
      setEditorPref('plain', !plain);
      const kept = await tabs.remode();
      if (kept) toast(`${kept} file${kept === 1 ? '' : 's'} with unsaved changes stay as they are until saved and opened again.`);
    }
  }

  // ---------- the commands of commands.js ----------
  const active = () => (tabs.active && tabs.active.kind !== 'file' && tabs.active.file ? tabs.active.file : tabs.active);
  const copyPath = async (full, rel = active() && active().path) => {
    if (!rel) return;
    const p = full ? inside(root, rel) : rel;
    toast((await copyText(p)) ? `Copied ${p}` : 'The browser did not allow the copy: select the path in the tab\'s title and copy it.', { kind: 'info' });
  };
  function shortcuts() {
    const keys = (c) => c.keys.map((k) => ((c.notTyping || []).includes(k) ? `${k} (outside the code and text boxes)` : k));
    const row = (c) => h('div.ed-keyrow', h('span.ed-keyrow-label', c.label), h('span.ed-keyrow-keys', [...keys(c), ...(c.browser ? [`${c.browser} (an installed app)`] : [])].join(' · ')));
    openSheet({ title: 'Keyboard shortcuts', tall: true }, () => [
      h('p.sheet-text', BROWSER_LINE),
      h('p.sheet-text.muted', 'The code editor\'s own keys (find and replace, multi-cursor, move, copy and delete a line, comment, format, fold) are VS Code\'s: the command palette (Ctrl+Shift+P or F1) lists them with their keys.'),
      h('div.ed-keys', COMMANDS.map(row)),
    ]);
  }
  const CMDS = {
    save: () => tabs.save(),
    saveAll: () => tabs.saveAll(),
    newFile: () => explorer.make('file'),
    quickOpen: () => quick.open(),
    palette: () => {
      if (tabs.editor && tabs.active.kind === 'file') {
        tabs.editor.focus();
        tabs.editor.trigger('keyboard', 'editor.action.quickCommand', null);
      } else quick.open('>');
    },
    goToLine,
    findInFiles,
    replaceInFiles: () => {
      findInFiles();
      search.showReplace();
    },
    searchDetails: () => {
      showView('search');
      setPane('side');
      search.toggleDetails();
    },
    focusEditor: () => {
      setPane('editor');
      tabs.focus();
    },
    explorer: () => {
      showView('explorer');
      setPane('side');
    },
    scm: () => {
      showView('changes');
      setPane('side');
    },
    sidebar: () => {
      if (phoneQuery.matches) return setPane(pane === 'side' ? 'editor' : 'side');
      toggleSide();
      requestAnimationFrame(() => tabs.layout());
    },
    panel: () => terminal.toggle(),
    terminal: () => terminal.toggle(),
    closeEditor: () => tabs.close(),
    closeAll: () => tabs.closeMany('all'),
    closeSaved: () => tabs.closeMany('saved'),
    reopen: () => tabs.reopen(),
    nextEditor: () => tabs.step(1),
    prevEditor: () => tabs.step(-1),
    keepOpen: () => tabs.keep(),
    pin: () => tabs.togglePin(),
    copyPath: () => copyPath(true),
    copyRelativePath: () => copyPath(false),
    reveal: () => active() && wb.revealPath(active().path),
    wordWrap: () => tabs.toggleWrap(),
    settings: () => (location.hash = link('#/settings/appearance?show=code-editor', null)),
    shortcuts,
  };
  function run(id) {
    if (CMDS[id]) CMDS[id]();
  }
  wb.run = run;
  wb.keyboardHome = keyboardHome;
  wb.copyPath = copyPath;
  wb.revealPath = (p) => {
    showView('explorer');
    setPane('side');
    explorer.reveal(p, { focus: true });
  };
  // Shown in Monaco's own command palette with their keys (tabs.js adds them to the code editor).
  wb.commands = COMMANDS.filter((c) => c.palette !== false).map((c) => ({ ...c, run: () => run(c.id) }));
  quick.commands(wb.commands);

  // The keys: one listener before everything else on the page. Inside the code editor its own chords (Ctrl+K ...)
  // stay its own: this table's chords are added to it (tabs.js), so they work there too.
  const reader = createKeyReader();
  const onKey = (e) => {
    if (failed || document.querySelector('dialog.sheet[open]')) return reader.reset();
    const inEditor = !!(e.target && e.target.closest && e.target.closest('.monaco-editor'));
    const inText = !inEditor && !!(e.target && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)));
    // Typing in a field of the page (search, commit message): only the keys with Ctrl.
    if (!(e.ctrlKey || e.metaKey) && !e.altKey && !reader.pending && e.key !== 'F1') return;
    const stroke = strokeOf(e);
    if (e.metaKey && stroke === 'Ctrl+G') return; // a Mac's Cmd+G is find next, as in VS Code there
    if ((stroke === 'Ctrl+Shift+I' || (reader.pending === 'Ctrl+K' && stroke === 'Ctrl+F')) && inEditor && tabs.active && !tabs.canFormat()) {
      reader.reset();
      e.preventDefault();
      e.stopPropagation();
      return toast('No formatter for this language in the browser editor (it formats JSON, CSS, HTML, JavaScript and TypeScript).', { kind: 'info' });
    }
    const r = reader.read(stroke, { inEditor, inText });
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    if (r.id) run(r.id);
    else if (r.miss) toast(`${r.miss} is not a command here (Ctrl+K Ctrl+S lists them).`, { kind: 'info' });
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
