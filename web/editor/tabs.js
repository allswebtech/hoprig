// The editor area: the tabs and what the open tab shows. A file tab is a Monaco model in one shared editor (its view
// state kept per tab), or a plain text box (Settings → Editor, or where Monaco cannot load). A changes tab is the diff
// editor over git's two sides of a file. A save sends the version the file was read at; when the file changed on disk
// since, nothing is overwritten: the owner picks between the version on disk and their own (or compares them).
import { btn, confirmSheet, fill, h, openSheet, toast } from '../lib.js';
import { icon } from '../icons.js';
import { editorPrefs, languageName, languageOf, loadMonaco } from './monaco.js';

const base = (p) => p.split('/').pop();
const keyOf = (t) => (t.kind === 'file' ? `file:${t.path}` : t.kind === 'diff' ? `diff:${t.staged ? 's' : 'w'}:${t.path}` : `compare:${t.path}`);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * wb: { get, post, plain, onActive(tab), onSaved(), onCursor(pos), onDirty() }. Returns the area and what the rest of
 * the page does with tabs.
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
  const empty = h('div.ed-empty', icon('code', { size: 34 }), h('p', 'Open a file from the Explorer, or press Ctrl+P to find one by name.'));
  const body = h('div.ed-body', bar, host, diffHost, text, note, empty);
  const el = h('section.ed-area', strip, body);

  const isPlain = () => wb.plain || !monaco;

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
    if (editor) editor.updateOptions({ ...o, tabSize: p.tabSize });
    if (diff) diff.updateOptions(o);
    for (const t of tabs) if (t.model) t.model.updateOptions({ tabSize: p.tabSize });
    text.style.fontSize = `${p.fontSize}px`;
    text.style.tabSize = String(p.tabSize);
    text.wrap = p.wordWrap ? 'soft' : 'off';
  }

  // ---------- a tab's text, the same for Monaco and the plain box ----------
  const value = (t) => (t.model ? t.model.getValue() : t.text);
  const isDirty = (t) => t.kind === 'file' && !t.binary && !t.note && (t.model ? t.model.getAlternativeVersionId() !== t.savedAlt : t.text !== t.savedText);
  const markSaved = (t) => {
    if (t.model) t.savedAlt = t.model.getAlternativeVersionId();
    else t.savedText = t.text;
  };
  const setValue = (t, v) => {
    if (t.model) t.model.setValue(v);
    else {
      t.text = v;
      if (t === active) text.value = v;
    }
  };

  // ---------- the strip ----------
  function paintStrip() {
    fill(strip, tabs.map((t) => {
      const dirty = isDirty(t);
      const label = t.kind === 'file' ? base(t.path) : `${base(t.path)} ${t.kind === 'compare' ? '(on disk ↔ yours)' : t.staged ? '(staged)' : '(changes)'}`;
      return h(`div.ed-tab${t === active ? '.on' : ''}${t.preview ? '.preview' : ''}${dirty ? '.dirty' : ''}`, {
        role: 'tab', 'aria-selected': String(t === active), title: t.path, tabindex: '0',
        onclick: () => show(t),
        ondblclick: () => pin(t),
        onauxclick: (e) => e.button === 1 && close(t),
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), show(t)),
      },
      icon(t.kind === 'file' ? 'text' : 'git', { size: 14 }),
      h('span.ed-tab-name', label),
      h('button.ed-tab-x', { type: 'button', title: dirty ? 'Unsaved changes. Close' : 'Close', 'aria-label': `Close ${label}`, onclick: (e) => {
        e.stopPropagation();
        close(t);
      } }, dirty ? h('span.ed-dot', { 'aria-hidden': 'true' }) : null, icon('x', { size: 14 })));
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
      if (t.view) ed.restoreViewState(t.view);
      if (focus) ed.focus();
    } else if (t.kind === 'file') {
      text.classList.remove('hidden');
      text.value = t.text;
      if (focus && matchMedia('(pointer: fine)').matches) text.focus();
    } else {
      bar.classList.remove('hidden');
      fill(bar, t.bar());
      diffHost.classList.remove('hidden');
      const d = diffEditor();
      d.setModel({ original: t.original, modified: t.modified });
      d.updateOptions({ readOnly: t.kind !== 'compare' });
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
    } else {
      t.text = r.text;
      t.savedText = r.text;
    }
  }

  /** The changes of a file as git sees them: staged (the last commit ↔ staged) or not (staged ↔ the disk). */
  async function openDiff(path, { staged = false } = {}) {
    const key = `diff:${staged ? 's' : 'w'}:${path}`;
    let t = find(key);
    if (t) {
      await refreshDiff(t);
      return show(t);
    }
    try {
      await needMonaco();
    } catch (e) {
      return toast(`The changes cannot be shown: ${e.message}`, { kind: 'error' });
    }
    t = { kind: 'diff', key, path, staged, preview: true, original: null, modified: null, note: null };
    t.bar = () => [
      h('span.ed-diffbar-text', staged ? 'Staged: the last commit ↔ what is staged' : 'Not staged: what is staged (or the last commit) ↔ the file on disk'),
      btn('small ghost', { icon: 'text', label: 'Open file', onclick: () => open(path) }),
    ];
    await refreshDiff(t);
    place(t, { preview: true });
    show(t);
  }

  async function refreshDiff(t) {
    let r;
    try {
      r = await wb.get('git/diff', { path: t.path, ...(t.staged ? { staged: '1' } : {}) });
    } catch (e) {
      t.note = [h('p', e.message)];
      return;
    }
    if (r.binary || r.tooLarge) {
      t.note = [h('p', r.binary ? 'A binary file: its changes are not shown as text.' : 'This file is too large to compare here.')];
      return;
    }
    t.note = null;
    const lang = languageOf(monaco, t.path);
    if (t.original) {
      t.original.setValue(r.original);
      t.modified.setValue(r.modified);
    } else {
      t.original = monaco.editor.createModel(r.original, lang);
      t.modified = monaco.editor.createModel(r.modified, lang);
    }
  }

  /** Every changes tab again (after a stage, an unstage, a save): they show what git has now. */
  async function refreshDiffs() {
    for (const t of tabs.filter((x) => x.kind === 'diff')) await refreshDiff(t);
    if (active && active.kind === 'diff') show(active, { focus: false });
  }

  // ---------- saving ----------
  async function save(t = active, { force = null } = {}) {
    if (!t || t.kind === 'diff') return false;
    if (t.kind === 'compare') {
      // Saving from the compare view: yours over the version on disk it shows.
      const c = t;
      t = c.file;
      if (c.ownModified) t.text = c.modified.getValue();
      force = force || c.disk;
    }
    if (!isDirty(t) && !force) return true;
    if (t === active) leave(t);
    try {
      const r = await wb.post('file', { path: t.path, text: value(t), version: force || t.version });
      t.version = r.version;
      markSaved(t);
      paintStrip();
      wb.onSaved(t);
      return true;
    } catch (e) {
      if (e.status === 409 && e.code === 'changed') return changedOnDisk(t, e.data.version);
      toast(e.status === 413 ? 'The file is too large to save here (more than 5 MB).' : `Not saved: ${e.message}`, { kind: 'error' });
      return false;
    }
  }

  // The file changed on disk after it was opened: say so, and let the owner pick. Nothing is overwritten unasked.
  async function changedOnDisk(t, diskVersion) {
    const pick = await openSheet({ title: `${base(t.path)} changed on disk`, subtitle: t.path }, (close) => [
      h('p.sheet-text', 'Something else changed this file after you opened it (a session, git, another window). Saving now would replace that change.'),
      h('div.choice-list',
        choice('git', 'Compare', 'The version on disk next to yours, before you choose', () => close('compare')),
        choice('refresh', 'Load the version on disk', 'Your unsaved changes in this tab are dropped', () => close('load')),
        choice('pencil', 'Overwrite with yours', 'The change on disk is replaced by your text', () => close('overwrite'), true)),
    ]);
    if (pick === 'overwrite') return save(t, { force: diskVersion });
    if (pick === 'load') return reload(t);
    if (pick === 'compare') return compare(t);
    return false;
  }

  const choice = (ic, label, sub, onclick, danger = false) => h(`button.choice${danger ? '.danger' : ''}`, { type: 'button', onclick },
    h('span.choice-icon', icon(ic)), h('span.choice-main', h('span.choice-label', label), h('span.choice-sub', sub)), h('span.choice-end', icon('chevronRight')));

  /** Read the file from disk again into its tab (what is unsaved in it goes). */
  async function reload(t) {
    let r;
    try {
      r = await wb.get('file', { path: t.path });
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return false;
    }
    if (r.binary) return false;
    t.version = r.version;
    setValue(t, r.text);
    markSaved(t);
    paintStrip();
    if (t === active) show(t);
    return true;
  }

  // On disk ↔ yours, in the diff editor; your side stays editable, and the bar holds the two choices.
  async function compare(t) {
    let r;
    try {
      await needMonaco();
      r = await wb.get('file', { path: t.path });
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return false;
    }
    const key = `compare:${t.path}`;
    const old = find(key);
    if (old) close(old, { ask: false });
    const lang = languageOf(monaco, t.path);
    // Yours: the tab's own model (edits here are edits of the file tab), or a model over the plain box's text.
    const mine = t.model || monaco.editor.createModel(value(t), lang);
    const c = { kind: 'compare', key, path: t.path, file: t, preview: false, disk: r.version, original: monaco.editor.createModel(r.text, lang), modified: mine, ownModified: !t.model, note: null };
    c.bar = () => [
      h('span.ed-diffbar-text', 'Left: on disk now. Right: yours (unsaved).'),
      btn('small secondary', { icon: 'refresh', label: 'Load the version on disk', onclick: async () => {
        close(c, { ask: false });
        await reload(t);
        show(t);
      } }),
      btn('small primary', { icon: 'check', label: 'Overwrite with yours', onclick: async () => {
        if (c.ownModified) t.text = c.modified.getValue();
        close(c, { ask: false });
        if (await save(t, { force: c.disk })) show(t);
      } }),
    ];
    place(c, { preview: false });
    show(c);
    return false;
  }

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

  return {
    el,
    open,
    openDiff,
    save,
    close: () => active && close(active),
    refreshDiffs,
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
    eol: (t) => (t && t.model ? (t.model.getEOL() === '\r\n' ? 'CRLF' : 'LF') : t && t.text && t.text.includes('\r\n') ? 'CRLF' : 'LF'),
    dirty: () => tabs.filter(isDirty),
    paths: () => tabs.filter((t) => t.kind === 'file').map((t) => t.path),
    layout: () => {
      if (editor) editor.layout();
      if (diff) diff.layout();
    },
    dispose() {
      for (const t of tabs) dispose(t);
      tabs.length = 0;
      if (editor) editor.dispose();
      if (diff) diff.dispose();
    },
    dirOf,
  };
}
