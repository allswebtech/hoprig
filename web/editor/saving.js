// Saving a file tab, and what happens when the file changed on disk after it was read. A save sends the version the
// file was read at; when the file changed since, nothing is overwritten: the owner picks between the version on disk
// and their own, or compares them first. Saves of one tab run one after another, and only the text that was sent is
// marked saved: keys typed while a save is on its way stay unsaved.
import { btn, h, openSheet, toast } from '../lib.js';
import { icon } from '../icons.js';
import { languageOf } from './monaco.js';

const base = (p) => p.split('/').pop();

export const choice = (ic, label, sub, onclick, danger = false) => h(`button.choice${danger ? '.danger' : ''}`, { type: 'button', onclick },
  h('span.choice-icon', icon(ic)), h('span.choice-main', h('span.choice-label', label), h('span.choice-sub', sub)), h('span.choice-end', icon('chevronRight')));

/**
 * x: what the tabs share with this module: { wb, tabs, active (getter), isDirty, snapshot, markSaved, toDisk, replaceText,
 * leave, show, place, find, close, paintStrip, needMonaco, monaco (getter) }.
 */
export function createSaving(x) {
  const { wb } = x;

  /** Save the tab (or the file of a compare view). Resolves true when what it showed is on disk. */
  function save(t, opts = {}) {
    if (!t) return Promise.resolve(false);
    const file = t.kind === 'compare' ? t.file : t;
    const run = (file.queue || Promise.resolve()).then(() => saveNow(t, opts));
    file.queue = run.catch(() => {});
    return run;
  }

  async function saveNow(t, { force = null, again = false } = {}) {
    if (t.kind === 'diff') return false;
    if (t.kind === 'compare') {
      // Saving from the compare view: yours over the version on disk it shows.
      const c = t;
      t = c.file;
      if (c.ownModified) t.text = c.modified.getValue().replace(/\r\n/g, '\n');
      force = force || c.disk;
    }
    if (!x.isDirty(t) && !force && !t.gone) return true;
    if (t === x.active) x.leave(t);
    const snap = x.snapshot(t);
    t.saving = true;
    try {
      const r = await wb.post('file', { path: t.path, text: x.toDisk(t, snap.text), version: t.gone ? null : force || t.version });
      t.version = r.version;
      t.gone = false;
      x.markSaved(t, snap);
      x.paintStrip();
      wb.onSaved(t);
      return true;
    } catch (e) {
      if (e.status === 409 && e.code === 'changed') return changedOnDisk(t, e.data.version);
      if (e.status === 409 && e.code === 'exists' && t.gone) {
        // Deleted, and made again by something else meanwhile: as any other change on disk.
        t.gone = false;
        const now = await wb.get('file', { path: t.path }).catch(() => null);
        if (now && !now.binary) return changedOnDisk(t, now.version);
      }
      if (e.status === 404 && !again && !t.gone) {
        // The file was deleted on disk: saving makes it again with the tab's text (as VS Code does).
        t.gone = true;
        return saveNow(t, { again: true });
      }
      toast(e.status === 413 ? 'The file is too large to save here (more than 5 MB).' : `Not saved: ${e.message}`, { kind: 'error' });
      x.paintStrip();
      return false;
    } finally {
      t.saving = false;
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
    if (pick === 'overwrite') return saveNow(t, { force: diskVersion });
    if (pick === 'load') return reload(t);
    if (pick === 'compare') return compare(t);
    return false;
  }

  /**
   * Read the file from disk again into its tab (what is unsaved in it goes). `quiet`: a check in the background (the
   * file changed on disk and the tab has no unsaved changes): nothing is said, and a tab typed into meanwhile stays.
   */
  async function reload(t, { quiet = false } = {}) {
    let r;
    try {
      r = await wb.get('file', { path: t.path });
    } catch (e) {
      if (!quiet) toast(e, { kind: 'error' });
      return false;
    }
    if (r.binary) return false;
    if (quiet && (x.isDirty(t) || t.saving)) return false;
    t.version = r.version;
    t.eol = r.eol;
    t.gone = false;
    x.replaceText(t, r.text);
    x.markSaved(t);
    x.paintStrip();
    if (t === x.active && !quiet) x.show(t);
    return true;
  }

  // On disk ↔ yours, in the diff editor; your side stays editable, and the bar holds the two choices.
  async function compare(t) {
    let r;
    let monaco;
    try {
      monaco = await x.needMonaco();
      r = await wb.get('file', { path: t.path });
    } catch (e) {
      toast(e, { kind: 'error' });
      return false;
    }
    const key = `compare:${t.path}`;
    const old = x.find(key);
    if (old) x.close(old, { ask: false });
    const lang = languageOf(monaco, t.path);
    // Yours: the tab's own model (edits here are edits of the file tab), or a model over the plain box's text.
    const mine = t.model || monaco.editor.createModel(x.snapshot(t).text, lang);
    const c = { kind: 'compare', key, path: t.path, file: t, preview: false, disk: r.version, original: monaco.editor.createModel(r.text, lang), modified: mine, ownModified: !t.model, note: null };
    c.bar = () => [
      h('span.ed-diffbar-text', 'Left: on disk now. Right: yours (unsaved).'),
      btn('small secondary', { icon: 'refresh', label: 'Load the version on disk', onclick: async () => {
        x.close(c, { ask: false });
        await reload(t);
        x.show(t);
      } }),
      btn('small primary', { icon: 'check', label: 'Overwrite with yours', onclick: async () => {
        if (c.ownModified) t.text = c.modified.getValue().replace(/\r\n/g, '\n');
        x.close(c, { ask: false });
        if (await save(t, { force: c.disk })) x.show(t);
      } }),
    ];
    x.place(c, { preview: false });
    x.show(c);
    return false;
  }

  /**
   * Look at the open files on disk again (the page came back into view, every few seconds, after a discard): a tab
   * without unsaved changes is read again when its file changed, and closed when the file is gone; a tab with
   * unsaved changes whose file is gone is marked deleted.
   */
  let checking = false;
  async function check() {
    const list = x.tabs.filter((t) => t.kind === 'file' && !t.note && !t.saving);
    if (checking || !list.length) return;
    checking = true;
    try {
      const r = await wb.get('versions', { paths: list.map((t) => t.path).join('\n') });
      for (const t of list) {
        if (!x.tabs.includes(t) || t.saving || !(t.path in r.versions)) continue;
        const v = r.versions[t.path];
        if (v === null) {
          if (!x.isDirty(t)) x.close(t, { ask: false });
          else if (!t.gone) {
            t.gone = true;
            x.paintStrip();
          }
        } else if (t.gone) {
          // Made again by something else: a save goes over that version, through the usual question.
          t.gone = false;
          t.version = v;
          x.paintStrip();
        } else if (v !== t.version && !x.isDirty(t)) await reload(t, { quiet: true });
      }
    } catch {
      /* the next look will do */
    } finally {
      checking = false;
    }
  }

  return { save, reload, check };
}
