// Changes tabs: a file's changes as git sees them, in the diff editor. Not staged: what is staged (or the last commit)
// against the file on disk; staged: the last commit against what is staged. When nothing is left to show (after a
// stage, a commit, a discard), the tab says so instead of showing two equal sides.
import { btn, h, toast } from '../lib.js';
import { languageOf } from './monaco.js';

const base = (p) => p.split('/').pop();

/** x: { wb, tabs, active (getter), find, place, show, open, close, needMonaco }. */
export function createDiffs(x) {
  let monaco = null;

  /** The changes of a file as git sees them: staged (the last commit ↔ staged) or not (staged ↔ the disk). */
  async function openDiff(path, { staged = false } = {}) {
    const key = `diff:${staged ? 's' : 'w'}:${path}`;
    let t = x.find(key);
    if (t) {
      await refreshDiff(t);
      return x.show(t);
    }
    try {
      monaco = await x.needMonaco();
    } catch (e) {
      return toast(`The changes cannot be shown: ${e.message}`, { kind: 'error' });
    }
    t = { kind: 'diff', key, path, staged, preview: true, original: null, modified: null, note: null };
    t.bar = () => [
      h('span.ed-diffbar-text', staged ? 'Staged: the last commit ↔ what is staged' : 'Not staged yet: before ↔ now, on disk'),
      btn('small ghost', { icon: 'text', label: 'Open file', onclick: () => x.open(path) }),
    ];
    await refreshDiff(t);
    x.place(t, { preview: true });
    x.show(t);
  }

  async function refreshDiff(t) {
    let r;
    try {
      r = await x.wb.get('git/diff', { path: t.path, ...(t.staged ? { staged: '1' } : {}) });
    } catch (e) {
      t.note = [h('p', e.message)];
      return;
    }
    if (r.binary || r.tooLarge) {
      t.note = [h('p', r.binary ? 'A binary file: its changes are not shown as text.' : 'This file is too large to compare here.')];
      return;
    }
    monaco = monaco || (await x.needMonaco());
    const lang = languageOf(monaco, t.path);
    if (t.original) {
      t.original.setValue(r.original);
      t.modified.setValue(r.modified);
    } else {
      t.original = monaco.editor.createModel(r.original, lang);
      t.modified = monaco.editor.createModel(r.modified, lang);
    }
    // Nothing left to show (staged, committed, discarded): say so instead of two equal sides.
    t.note = r.original === r.modified && r.originalExists === r.modifiedExists ? noChanges(t) : null;
  }

  function noChanges(t) {
    const name = base(t.path);
    const staged = !t.staged && x.wb.hasStaged(t.path);
    return [
      h('p', t.staged ? `Nothing of ${name} is staged now.` : staged ? `No changes left to stage in ${name}: they are all staged.` : `No changes left in ${name}: it is as in the last commit.`),
      h('div.ed-note-tools',
        staged ? btn('small secondary', { icon: 'git', label: 'Show the staged changes', onclick: () => openDiff(t.path, { staged: true }) }) : null,
        btn('small secondary', { icon: 'text', label: 'Open file', onclick: () => x.open(t.path) }),
        btn('small ghost', { icon: 'x', label: 'Close', onclick: () => x.close(t) })),
    ];
  }

  /** Every changes tab again (after a stage, an unstage, a save): they show what git has now. */
  async function refreshDiffs() {
    for (const t of x.tabs.filter((d) => d.kind === 'diff')) await refreshDiff(t);
    if (x.active && x.active.kind === 'diff') x.show(x.active, { focus: false });
  }

  return { openDiff, refreshDiffs };
}
