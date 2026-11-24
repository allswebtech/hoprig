// The editor area: the tabs and what the open tab shows. A file tab is a Monaco model in one shared editor (its view
// state kept per tab), or a plain text box (the editor's menu, or where Monaco cannot load). A changes tab is the diff
// editor over git's two sides of a file. Saving is in saving.js. A tab without unsaved changes follows its file: when
// a session, git or a discard changes it on disk, it is read again (check()); when the file is gone, the tab closes,
// or is marked deleted when it holds unsaved changes (a save then makes the file again).
import { btn, confirmSheet, fill, h, toast } from '../lib.js';
import { icon } from '../icons.js';
import { editorPrefs, languageName, languageOf, loadMonaco } from './monaco.js';
import { createDiffs } from './diffs.js';
import { createSaving } from './saving.js';
import { withMenu } from '../desktop/menu.js';
import { editorKeys, monacoKey, paletteLabel } from './commands.js';
import { closesBy, dragPath, focusLost, moveBefore, regroup, stepFrom, tabTakes, toClose, wrapOf, wraps } from './tabops.js';

// The languages Monaco formats itself (no program of the project is started to format).
const FORMATS = new Set(['json', 'css', 'scss', 'less', 'html', 'javascript', 'typescript']);

const base = (p) => p.split('/').pop();
const keyOf = (t) => (t.kind === 'file' ? `file:${t.path}` : t.kind === 'diff' ? `diff:${t.staged ? 's' : 'w'}:${t.path}` : `compare:${t.path}`);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * wb: { get, post, plain, hasStaged(path), onActive(tab), onSaved(), onCursor(pos), onDirty() }. Returns the area and
 * what the rest of the page does with tabs.
 */
export function createTabs(wb) {
  const tabs = [];
  let active = null;
  let monaco = null;
  let editor = null; // the one code editor of the file tabs
  let diff = null; // the one diff editor of the changes tabs
  const strip = h('div.ed-tabs', { role: 'tablist', 'aria-label': 'Open files' });
  const host = h('div.ed-host'); // Monaco's code editor
  const diffHost = h('div.ed-host.hidden'); // Monaco's diff editor
  const text = h('textarea.ed-plain.hidden', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'File text' });
  const note = h('div.ed-note.hidden'); // a binary file, a file too large, a failed load
  const bar = h('div.ed-diffbar.hidden'); // over a diff: what it compares and its buttons
  const empty = h('div.ed-empty', icon('code', { size: 34 }), h('p', 'Open a file from the side panel, or press Ctrl+P to find one by name.'));
  const body = h('div.ed-body', bar, host, diffHost, text, note, empty);
  const el = h('section.ed-area', strip, body);

  async function needMonaco() {
    if (monaco) return monaco;
    monaco = await loadMonaco();
    return monaco;
  }

  function codeEditor() {
    if (editor) return editor;
    const p = editorPrefs();
    editor = monaco.editor.create(host, {
      automaticLayout: true, minimap: { enabled: innerWidth >= 1100 }, fontSize: p.fontSize, tabSize: p.tabSize,
      wordWrap: p.wordWrap ? 'on' : 'off', scrollBeyondLastLine: false, renderWhitespace: 'selection', fixedOverflowWidgets: true,
    });
    editor.onDidChangeCursorPosition((e) => wb.onCursor({ line: e.position.lineNumber, col: e.position.column }));
    editor.onDidChangeCursorSelection(() => {
      const m = editor.getModel();
      const sel = m ? editor.getSelections().reduce((n, x) => n + m.getValueLengthInRange(x), 0) : 0;
      wb.onCursor({ selected: sel, cursors: editor.getSelections().length });
    });
    // The page's commands in Monaco's own command palette, with their keys (a chord such as Ctrl+K S works in the
    // editor this way: the editor reads its own chords). The one plain line is in the label where a browser keeps a key.
    for (const c of wb.commands || []) {
      editor.addAction({
        id: `hoprig.${c.id}`, label: paletteLabel(c),
        keybindings: editorKeys(c).map((k) => monacoKey(monaco, k)).filter((x) => x !== null),
        run: () => c.run(),
      });
    }
    return editor;
  }

  function diffEditor() {
    if (diff) return diff;
    const p = editorPrefs();
    diff = monaco.editor.createDiffEditor(diffHost, {
      automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: innerWidth >= 900,
      useInlineViewWhenSpaceIsLimited: true, fontSize: p.fontSize, wordWrap: p.wordWrap ? 'on' : 'off', scrollBeyondLastLine: false,
      renderOverviewRuler: innerWidth >= 900,
    });
    return diff;
  }

  /** The settings of Settings → Editor, again (they changed while the page was open). */
  function applyPrefs() {
    const p = editorPrefs();
    const o = { fontSize: p.fontSize, wordWrap: p.wordWrap ? 'on' : 'off' };
    if (editor) editor.updateOptions({ ...o, tabSize: p.tabSize, wordWrap: wrapOf(active && active.kind === 'file' ? active : null, p.wordWrap) });
    if (diff) diff.updateOptions({ ...o, wordWrap: wrapOf(active && active.kind !== 'file' ? active : null, p.wordWrap) });
    for (const t of tabs) if (t.model) t.model.updateOptions({ tabSize: p.tabSize });
    text.style.fontSize = `${p.fontSize}px`;
    text.style.tabSize = String(p.tabSize);
    text.wrap = wrapOf(active && active.kind === 'file' ? active : null, p.wordWrap) === 'on' ? 'soft' : 'off';
  }

  /** Alt+Z: word wrap on or off for this file (or these changes) while it is open; the Word Wrap setting stays. */
  function toggleWrap(t = active) {
    if (!wraps(t)) return;
    t.wrap = wrapOf(t, editorPrefs().wordWrap) === 'on' ? 'off' : 'on';
    if (t === active) applyPrefs();
  }

  // ---------- a tab's text, the same for Monaco and the plain box ----------
  // The plain box keeps lines ended by "\n" only (a text box turns "\r\n" into "\n" on its own); the file's own line
  // end is put back when it is saved, so a file with Windows line ends keeps them.
  const lf = (v) => v.replace(/\r\n/g, '\n');
  const value = (t) => (t.model ? t.model.getValue() : t.text);
  const isDirty = (t) => t.kind === 'file' && !t.binary && !t.note && (t.gone || (t.model ? t.model.getAlternativeVersionId() !== t.savedAlt : t.text !== t.savedText));
  /** What the tab holds now: the text a save sends, and how to mark exactly that as saved. */
  const snapshot = (t) => ({ text: value(t), alt: t.model ? t.model.getAlternativeVersionId() : null, plain: t.text });
  const markSaved = (t, snap = snapshot(t)) => {
    if (t.model) t.savedAlt = snap.alt;
    else t.savedText = snap.plain;
  };
  const toDisk = (t, v) => (!t.model && t.eol === '\r\n' ? v.replace(/\n/g, '\r\n') : v);
  /** New text from disk into a tab, keeping where its editor was (cursor, scroll) when it is on screen. */
  const replaceText = (t, v) => {
    if (t.model) {
      const shown = editor && editor.getModel() === t.model;
      const view = shown ? editor.saveViewState() : null;
      t.model.setValue(v);
      if (view) editor.restoreViewState(view);
    } else {
      t.text = lf(v);
      if (t === active && !text.classList.contains('hidden')) {
        const at = text.selectionStart;
        text.value = t.text;
        text.setSelectionRange(at, at);
      }
    }
  };

  // ---------- the strip ----------
  function paintStrip() {
    fill(strip, tabs.map((t) => {
      const dirty = isDirty(t);
      const label = t.kind === 'file' ? `${base(t.path)}${t.gone ? ' (deleted)' : ''}` : `${base(t.path)} ${t.kind === 'compare' ? '(on disk ↔ yours)' : t.staged ? '(staged)' : '(changes)'}`;
      const el = h(`div.ed-tab${t === active ? '.on' : ''}${t.preview ? '.preview' : ''}${dirty ? '.dirty' : ''}${t.gone ? '.gone' : ''}${t.pinned ? '.pinned' : ''}`, {
        role: 'tab', 'aria-selected': String(t === active), title: `${t.gone ? `${t.path}: deleted on disk. Saving makes it again.` : t.path}${t.preview ? ' (preview: the next file opened from a list takes its place)' : ''}`, tabindex: '0',
        'aria-label': `${label}${dirty ? ', unsaved changes' : ''}${t.preview ? ', preview' : ''}${t.pinned ? ', pinned' : ''}`,
        draggable: 'true',
        onclick: () => show(t),
        ondblclick: () => pin(t),
        onauxclick: (e) => e.button === 1 && closesBy(t, 'middle') && close(t),
        onmousedown: (e) => e.button === 1 && e.preventDefault(), // a middle press closes, it does not scroll
        onkeydown: (e) => tabTakes(e) && (e.preventDefault(), show(t)),
        ondragstart: (e) => {
          dragged = t;
          dragPath(e.dataTransfer, t.path);
        },
        ondragover: (e) => {
          if (!dragged || dragged === t) return;
          e.preventDefault();
          el.classList.add('drop');
        },
        ondragleave: () => el.classList.remove('drop'),
        ondrop: (e) => {
          e.preventDefault();
          if (dragged && dragged !== t) moveBefore(tabs, dragged, t);
          dragged = null;
          paintStrip();
        },
        ondragend: () => (dragged = null),
      },
      icon(t.kind === 'file' ? 'text' : 'git', { size: 14 }),
      h('span.ed-tab-name', label),
      t.pinned && !dirty
        ? h('button.ed-tab-x', { type: 'button', title: 'Unpin', 'aria-label': `Unpin ${label}`, onclick: (e) => {
          e.stopPropagation();
          togglePin(t);
        } }, icon('pin', { size: 14 }))
        : h('button.ed-tab-x', { type: 'button', title: dirty ? 'Unsaved changes. Close (Ctrl+Shift+Alt+N)' : 'Close (Ctrl+Shift+Alt+N)', 'aria-label': `Close ${label}`, onclick: async (e) => {
          e.stopPropagation();
          await close(t);
          keepKeyboard();
        } }, dirty ? h('span.ed-dot', { 'aria-hidden': 'true' }) : null, icon('x', { size: 14 })));
      withMenu(el, () => tabMenu(t), `${label}: tab`);
      return el;
    }));
    const on = strip.querySelector('.ed-tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    wb.onDirty();
  }

  const pin = (t) => {
    if (!t.preview) return;
    t.preview = false;
    paintStrip();
  };
  let dragged = null;
  function togglePin(t = active) {
    if (!t) return;
    t.pinned = !t.pinned;
    t.preview = false;
    regroup(tabs);
    paintStrip();
  }

  /** After a close: the keyboard, when it was on what went (a tab, its menu), goes to the editor, else the side bar. */
  function keepKeyboard() {
    if (!focusLost(document.activeElement, document.body)) return;
    if (active) focusActive();
    if (focusLost(document.activeElement, document.body) && wb.keyboardHome) wb.keyboardHome();
  }
  const thenKeyboard = (fn) => async () => {
    await fn();
    keepKeyboard();
  };

  // A tab's menu (a right click, the context-menu key, a long press), as VS Code's: what it closes, its path, its place.
  function tabMenu(t) {
    const others = toClose(tabs, t, 'others').length;
    const right = toClose(tabs, t, 'right').length;
    return [
      { label: 'Close', keys: 'Ctrl+Shift+Alt+N', icon: 'x', run: thenKeyboard(() => close(t)) },
      { label: 'Close Others', icon: 'x', disabled: !others, run: thenKeyboard(() => closeMany('others', t)) },
      { label: 'Close to the Right', icon: 'x', disabled: !right, run: thenKeyboard(() => closeMany('right', t)) },
      { label: 'Close Saved', keys: 'Ctrl+K U', icon: 'check', run: thenKeyboard(() => closeMany('saved', t)) },
      { label: 'Close All', keys: 'Ctrl+K W', icon: 'x', run: thenKeyboard(() => closeMany('all', t)) },
      null,
      { label: 'Copy Path', keys: 'Ctrl+K P', icon: 'copy', run: () => wb.copyPath && wb.copyPath(true, t.path) },
      { label: 'Copy Relative Path', keys: 'Ctrl+Shift+Alt+C', icon: 'copy', run: () => wb.copyPath && wb.copyPath(false, t.path) },
      null,
      // No key shown: VS Code's Ctrl+K R opens the system's file manager, which a browser cannot (commands.js).
      { label: 'Reveal in Explorer View', icon: 'folder', run: () => wb.revealPath && wb.revealPath(t.path) },
      t.preview ? { label: 'Keep Open', keys: 'Ctrl+K Enter', icon: 'check', run: () => pin(t) } : null,
      { label: t.pinned ? 'Unpin' : 'Pin', keys: 'Ctrl+K Shift+Enter', icon: 'pin', run: () => togglePin(t) },
    ].filter((x, i, a) => x !== null || (a[i - 1] && a[i + 1]));
  }

  /** Close the tabs `kind` names around `ref` (tabops.js): unsaved ones only after one question for all of them. */
  async function closeMany(kind, ref = active) {
    const list = toClose(tabs, ref, kind, isDirty);
    const unsaved = list.filter(isDirty);
    if (unsaved.length) {
      const names = unsaved.slice(0, 5).map((t) => base(t.path)).join(', ') + (unsaved.length > 5 ? ` and ${unsaved.length - 5} more` : '');
      const ok = await confirmSheet({ title: `Close ${unsaved.length} file${unsaved.length === 1 ? '' : 's'} without saving?`, text: `${names}: the changes in ${unsaved.length === 1 ? 'it are' : 'them are'} lost.`, ok: 'Close without saving', danger: true });
      if (!ok) return false;
    }
    for (const t of list) await close(t, { ask: false });
    return true;
  }

  // Closed file tabs, newest last, for Reopen Closed Editor.
  const closed = [];
  async function reopen() {
    while (closed.length) {
      const c = closed.pop();
      if (find(`file:${c.path}`)) continue;
      const t = await open(c.path, { preview: false });
      if (t && c.view && editor && t.model && editor.getModel() === t.model) editor.restoreViewState(c.view);
      return t;
    }
    return null;
  }

  /** The keyboard into what the open tab shows (nothing for a binary or too large file). */
  function focusActive() {
    if (!active) return;
    if (active.kind === 'file' && active.model && editor) editor.focus();
    else if (active.kind === 'file' && !active.note) text.focus();
    else if (diff && !active.note) diff.getModifiedEditor().focus();
  }

  // ---------- what the open tab shows ----------
  function hideAll() {
    for (const x of [host, diffHost, text, note, bar, empty]) x.classList.add('hidden');
  }

  function show(t, { focus = true } = {}) {
    if (active && active !== t) leave(active);
    active = t;
    hideAll();
    if (!t) {
      empty.classList.remove('hidden');
      paintStrip();
      wb.onActive(null, false);
      return;
    }
    if (t.note) {
      fill(note, t.note);
      note.classList.remove('hidden');
    } else if (t.kind === 'file' && t.model) {
      host.classList.remove('hidden');
      const ed = codeEditor();
      ed.setModel(t.model);
      ed.updateOptions({ wordWrap: wrapOf(t, editorPrefs().wordWrap) });
      if (t.view) ed.restoreViewState(t.view);
      if (focus) ed.focus();
    } else if (t.kind === 'file') {
      text.classList.remove('hidden');
      text.wrap = wrapOf(t, editorPrefs().wordWrap) === 'on' ? 'soft' : 'off';
      text.value = t.text;
      if (focus && matchMedia('(pointer: fine)').matches) text.focus();
    } else {
      bar.classList.remove('hidden');
      fill(bar, t.bar());
      diffHost.classList.remove('hidden');
      const d = diffEditor();
      d.setModel({ original: t.original, modified: t.modified });
      d.updateOptions({ readOnly: t.kind !== 'compare', wordWrap: wrapOf(t, editorPrefs().wordWrap) });
    }
    paintStrip();
    wb.onActive(t, focus);
  }

  // Keep what the tab looked like (scroll, cursor, folds) and the plain box's text, for when it is shown again.
  function leave(t) {
    if (t.kind === 'file' && t.model && editor && editor.getModel() === t.model) t.view = editor.saveViewState();
    if (t.kind === 'file' && !t.model && !t.note) t.text = text.value;
  }

  text.addEventListener('input', () => {
    if (!active || active.kind !== 'file' || active.model) return;
    active.text = text.value;
    if (active.preview) active.preview = false;
    paintStrip();
  });
  const caret = () => {
    const before = text.value.slice(0, text.selectionStart);
    wb.onCursor({ line: before.split('\n').length, col: before.length - before.lastIndexOf('\n') });
  };
  text.addEventListener('keyup', caret);
  text.addEventListener('click', caret);

  // ---------- opening ----------
  const find = (key) => tabs.find((t) => t.key === key);
  function place(t, { preview }) {
    // A preview tab (italic) is taken by the next file opened from the lists, unless it was changed or pinned.
    const old = preview ? tabs.find((x) => x.preview && !isDirty(x)) : null;
    if (old) {
      tabs.splice(tabs.indexOf(old), 1, t);
      detach(old);
      if (active === old) active = null;
      dispose(old);
    } else {
      const at = active ? tabs.indexOf(active) + 1 : tabs.length;
      tabs.splice(at, 0, t);
    }
  }

  /** Open a file (at a line). `preview`: a single press in a list, replaced by the next one. */
  async function open(path, { line = 0, col = 1, preview = false, focus = true } = {}) {
    const key = `file:${path}`;
    let t = find(key);
    if (!t) {
      t = { kind: 'file', key, path, preview, version: null, model: null, text: '', savedText: '', savedAlt: 0, view: null, note: [h('p.muted', 'Opening…')] };
      place(t, { preview });
      show(t, { focus: false });
      await load(t);
      if (!tabs.includes(t)) return null; // closed while it loaded
    } else if (!preview) t.preview = false;
    show(t, { focus });
    if (line > 0) reveal(t, line, col);
    return t;
  }

  function reveal(t, line, col = 1) {
    if (t.model && editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: col });
      editor.focus();
    } else if (!t.model && !t.note) {
      const lines = text.value.split('\n');
      const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
      text.focus();
      text.setSelectionRange(at, at);
    }
  }

  // Read the file into the tab: a model in Monaco, or the plain box's text.
  async function load(t) {
    let r;
    try {
      r = await wb.get('file', { path: t.path });
    } catch (e) {
      t.note = [h('p', e.status === 413 ? 'This file is too large to open here (more than 5 MB).' : e.message)];
      return;
    }
    t.version = r.version;
    t.eol = r.eol;
    t.note = null;
    if (r.binary) {
      t.binary = true;
      t.note = [h('p', 'This is a binary file, so it is not shown as text.'), h('p.muted', `${base(t.path)} · ${Math.max(1, Math.round(r.size / 1024))} KB`)];
      return;
    }
    if (!wb.plain) {
      try {
        await needMonaco();
      } catch (e) {
        toast(`${e.message} The file opens as plain text.`, { kind: 'error' });
      }
    }
    if (monaco && !wb.plain) {
      t.model = monaco.editor.createModel(r.text, languageOf(monaco, t.path));
      t.model.updateOptions({ tabSize: editorPrefs().tabSize });
      t.savedAlt = t.model.getAlternativeVersionId();
      t.model.onDidChangeContent(() => {
        if (t.preview) t.preview = false;
        paintStrip();
      });
      // Tab size or tabs/spaces changed (Settings, the status bar): the status bar says it again.
      t.model.onDidChangeOptions(() => t === active && wb.onCursor({}));
    } else {
      t.text = lf(r.text);
      t.savedText = t.text;
    }
  }

  // ---------- changes tabs (diffs.js) ----------
  const diffs = createDiffs({
    wb, tabs, find, place, show, needMonaco, open: (p) => open(p), close: (t, o) => close(t, o),
    get active() {
      return active;
    },
  });

  // ---------- saving, and files changed on disk ----------
  const saving = createSaving({
    wb, tabs, isDirty, snapshot, markSaved, toDisk, replaceText, leave, show, place, find, paintStrip, needMonaco,
    close: (t, o) => close(t, o),
    get active() {
      return active;
    },
  });

  // ---------- closing ----------
  // An editor never keeps a model that is about to go.
  function detach(t) {
    if (diff && t.kind !== 'file' && diff.getModel() && diff.getModel().modified === t.modified) diff.setModel(null);
    if (editor && t.model && editor.getModel() === t.model) editor.setModel(null);
  }

  function dispose(t) {
    if (t.kind === 'file' && t.model) t.model.dispose();
    if (t.kind === 'diff' && t.original) {
      t.original.dispose();
      t.modified.dispose();
    }
    if (t.kind === 'compare') {
      t.original.dispose();
      if (t.ownModified) t.modified.dispose();
    }
  }

  async function close(t, { ask = true } = {}) {
    if (ask && isDirty(t)) {
      const ok = await confirmSheet({ title: `Close ${base(t.path)} without saving?`, text: 'Your changes in this tab are lost.', ok: 'Close without saving', danger: true });
      if (!ok) return false;
    }
    // A compare view shows the file tab's own model: close it first.
    for (const c of tabs.filter((x) => x.kind === 'compare' && x.file === t)) close(c, { ask: false });
    const i = tabs.indexOf(t);
    if (i < 0) return true;
    if (t.kind === 'file' && !t.note) {
      leave(t);
      closed.push({ path: t.path, view: t.view });
      if (closed.length > 20) closed.shift();
    }
    detach(t);
    tabs.splice(i, 1);
    dispose(t);
    if (active === t) {
      active = null;
      show(tabs[Math.min(i, tabs.length - 1)] || null);
    } else paintStrip();
    return true;
  }

  /** A file or folder was renamed in the Explorer: its tabs follow it. */
  function renamed(from, to) {
    for (const t of tabs) {
      if (t.path !== from && !t.path.startsWith(`${from}/`)) continue;
      t.path = to + t.path.slice(from.length);
      t.key = keyOf(t);
      if (t.model && monaco) monaco.editor.setModelLanguage(t.model, languageOf(monaco, t.path));
    }
    paintStrip();
    if (active) wb.onActive(active, false);
  }

  /**
   * Plain text editing was turned on or off: open files without unsaved changes are read again the new way. Returns
   * how many were left as they are (unsaved changes).
   */
  async function remode() {
    const files = tabs.filter((t) => t.kind === 'file' && !t.note);
    const kept = files.filter(isDirty);
    for (const t of files.filter((x) => !kept.includes(x))) {
      for (const c of tabs.filter((x) => x.kind === 'compare' && x.file === t)) close(c, { ask: false });
      detach(t);
      if (t.model) t.model.dispose();
      Object.assign(t, { model: null, view: null, text: '', savedText: '', note: [h('p.muted', 'Opening…')] });
      await load(t);
    }
    if (active) show(active, { focus: false });
    return kept.length;
  }

  /** A file or folder was deleted in the Explorer: its tabs close (the confirm said unsaved changes go too). */
  function removed(path) {
    for (const t of [...tabs]) if (t.path === path || t.path.startsWith(`${path}/`)) close(t, { ask: false });
  }

  // Settings → Editor as they are now, also for the plain box shown first (before any change of them).
  applyPrefs();

  return {
    el,
    open,
    openDiff: diffs.openDiff,
    save: (t = active) => saving.save(t),
    /** Save every file with unsaved changes; true when none is left. */
    async saveAll() {
      for (const t of tabs.filter(isDirty)) await saving.save(t);
      return !tabs.some(isDirty);
    },
    check: saving.check,
    focus: () => focusActive(),
    /** The Close Editor key: a pinned tab stays (closesBy). */
    close: () => active && closesBy(active, 'key') && close(active),
    closeMany,
    reopen,
    togglePin,
    toggleWrap,
    keep: () => active && pin(active),
    step: (d) => {
      const t = stepFrom(tabs, active, d);
      if (t) show(t);
    },
    /** The open tab of file `path`, or null. */
    fileTab: (path) => find(`file:${path}`) || null,
    isDirty,
    /**
     * New text into a file tab as one edit (its undo takes it back), without saving. False for a tab that shows no
     * text (binary, too large).
     */
    putText(t, v) {
      if (t.note || t.binary) return false;
      if (t.model) {
        t.model.pushStackElement();
        t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: v }], () => null);
        t.model.pushStackElement();
      } else {
        t.text = lf(v);
        if (t === active) text.value = t.text;
        if (t.preview) t.preview = false;
      }
      paintStrip();
      return true;
    },
    textOf: (t) => value(t),
    /** Monaco formats this tab's language itself (format runs nothing else). */
    canFormat: (t = active) => Boolean(t && t.model && FORMATS.has(t.model.getLanguageId())),
    refreshDiffs: diffs.refreshDiffs,
    renamed,
    removed,
    remode,
    applyPrefs,
    reveal: (line) => active && reveal(active, line),
    get active() {
      return active;
    },
    get editor() {
      return active && active.kind === 'file' && active.model ? editor : active && active.kind !== 'file' ? diff : null;
    },
    get monaco() {
      return monaco;
    },
    language: (t) => (t && t.kind === 'file' && !t.note ? (t.model ? languageName(monaco, t.model.getLanguageId()) : 'Plain text') : ''),
    eol: (t) => ((t && t.model ? t.model.getEOL() : t && t.eol) === '\r\n' ? 'CRLF' : 'LF'),
    dirty: () => tabs.filter(isDirty),
    paths: () => tabs.filter((t) => t.kind === 'file').map((t) => t.path),
    layout: () => {
      if (editor) editor.layout();
      if (diff) diff.layout();
    },
    dispose() {
      // The editors first: Monaco refuses a model that goes while an editor still shows it.
      if (editor) editor.dispose();
      if (diff) diff.dispose();
      for (const t of tabs) dispose(t);
      tabs.length = 0;
      active = null; // nothing reads a disposed model through it later
    },
    dirOf,
  };
}
