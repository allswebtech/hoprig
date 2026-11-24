// The diff pane, as the Claude Code desktop app's diff view: opened from the title bar's Changes button or the session
// rail's Changes card, it lists the files changed in the session's folder (git, against the last commit) and shows
// one file's diff, unified or side by side. A + beside a line's number opens a comment box: Enter adds the comment
// (queued here, nothing is sent), Shift+Enter is a new line, Esc closes the box; Cmd+Enter (macOS) or Ctrl+Enter
// sends every queued comment as ONE message, which the owner sends (the Send button says how many). Claude reads them
// and changes the code; the pane reads the folder again after each turn. Every line is set as text.
import { icon } from '../icons.js';
import { api, fill, h, toast } from '../lib.js';
import { failText } from './words.js';

const mac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const sendKeys = () => (mac() ? 'Cmd+Enter' : 'Ctrl+Enter');

/**
 * Rows of hunks for the two views. unified: [{ kind: 'gap'|'ctx'|'add'|'del', old, new, text }]; split: [{ kind:
 * 'gap' } | { left: { n, text, kind } | null, right: { n, text, kind } | null }] where a run of removed lines meets
 * the run of added lines after it, line by line, as side-by-side diffs show them.
 */
export function diffRows(hunks, split = false) {
  const out = [];
  for (const [k, x] of (hunks || []).entries()) {
    if (k || x.oldStart > 1) out.push({ kind: 'gap', line: x.newStart });
    let o = x.oldStart;
    let n = x.newStart;
    const flat = x.lines.map((l) => {
      const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
      const r = { kind, old: kind === 'add' ? null : o, new: kind === 'del' ? null : n, text: l.slice(1) };
      if (kind !== 'add') o++;
      if (kind !== 'del') n++;
      return r;
    });
    if (!split) {
      out.push(...flat);
      continue;
    }
    for (let i = 0; i < flat.length;) {
      if (flat[i].kind === 'ctx') {
        out.push({ left: { n: flat[i].old, text: flat[i].text, kind: 'ctx' }, right: { n: flat[i].new, text: flat[i].text, kind: 'ctx' } });
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < flat.length && flat[i].kind === 'del') dels.push(flat[i++]);
      while (i < flat.length && flat[i].kind === 'add') adds.push(flat[i++]);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        out.push({ left: dels[j] ? { n: dels[j].old, text: dels[j].text, kind: 'del' } : null, right: adds[j] ? { n: adds[j].new, text: adds[j].text, kind: 'add' } : null });
      }
    }
  }
  return out;
}

const short = (t, n = 80) => {
  const s = String(t || '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * The one message the queued comments make: each names its file and line (a removed line says so), quotes the line,
 * then the comment. comments: [{ path, side ('new' | 'old'), line, text (the line's), body }]
 */
export function commentsMessage(comments) {
  const parts = comments.map((c) => `${c.path}, ${c.side === 'old' ? 'removed line' : 'line'} ${c.line}${c.text.trim() ? `: \`${short(c.text).replace(/`/g, "'")}\`` : ''}\n${c.body.trim()}`);
  return `Comments on the changes in the diff:\n\n${parts.join('\n\n')}`;
}

/**
 * o: { A (the chat's API path), send(text) → Promise (sends one message: the page's), editor() (the folder's
 * changes in the editor), onToggle(open) } → { el, open(path?), close(), isOpen(), refresh(), comments() }
 */
export function createDiffPane(o) {
  let open = false;
  let split = false;
  let files = [];
  let chosen = null; // the file shown
  let diff = null;
  let editing = null; // { key, box } of the comment box that is open
  let opener = null; // what had the focus when the pane opened: it gets it back when the pane closes
  const queued = []; // the comments not sent yet: { key, path, side, line, text, body }
  const count = h('span.dp-count');
  const viewBtns = [['Unified', false], ['Side by side', true]].map(([label, s]) => h('button.dp-seg', { type: 'button', 'aria-pressed': String(s === split), onclick: () => {
    split = s;
    for (const b of viewBtns) b.setAttribute('aria-pressed', String(b === viewBtns[s ? 1 : 0]));
    paintDiff();
  } }, label));
  const list = h('ul.dp-files', { 'aria-label': 'Changed files' });
  const body = h('div.dp-body', { role: 'region', 'aria-label': 'Diff', tabindex: '-1' });
  const sendBtn = h('button.btn.primary.small.dp-send', { type: 'button', onclick: () => sendAll() });
  const foot = h('div.dp-foot.hidden', h('span.dp-foot-text'), sendBtn);
  // A key the pane takes is the pane's only: the page's own Esc would stop Claude's turn too (keys.js).
  const el = h('section.chat-diffpane.hidden', { 'aria-label': 'Diff pane', onkeydown: (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (editing && editing.box.querySelector('textarea').value.trim()) addComment(editing);
      sendAll();
    } else if (e.key === 'Escape') {
      // Every Esc in the pane: with a comment box open (the focus on its Cancel, in the diff…) it closes the box.
      e.preventDefault();
      e.stopPropagation();
      if (editing) closeBox(true);
      else close();
    }
  } },
  h('div.dp-head',
    h('h2.dp-title', 'Changes'), count,
    h('div.dp-segs', { role: 'group', 'aria-label': 'View' }, viewBtns),
    h('button.btn.icon.ghost.dp-editor', { type: 'button', title: 'Open in the editor', 'aria-label': 'Open the changes in the editor', onclick: () => o.editor() }, icon('code', { size: 16 })),
    h('button.btn.icon.ghost.dp-close', { type: 'button', title: 'Close', 'aria-label': 'Close the diff pane', onclick: () => close() }, icon('x', { size: 17 }))),
  list, body, foot);

  async function refresh() {
    if (!open || editing) return; // a comment box open: the next turn's end reads the folder again
    let c;
    try {
      c = await api(`${o.A}/changes`);
    } catch (e) {
      return fill(body, h('p.dp-empty', failText(e)));
    }
    if (!c || !c.git) {
      files = [];
      fill(count);
      fill(list);
      return fill(body, h('p.dp-empty', 'This folder is not a git repository, so there is no diff to show.'));
    }
    files = c.list || [];
    fill(count, files.length ? [h('span.dp-add', `+${c.added}`), ' ', h('span.dp-del', `−${c.removed}`)] : null);
    if (!files.some((f) => f.path === chosen)) chosen = files.length ? files[0].path : null;
    paintFiles(c.files > files.length ? c.files - files.length : 0);
    if (!chosen) {
      diff = null;
      return fill(body, h('p.dp-empty', 'No changes since the last commit.'));
    }
    await load(chosen);
  }
  function paintFiles(more) {
    fill(list, files.map((f) => h('li', h(`button.dp-file${f.path === chosen ? '.on' : ''}`, { type: 'button', 'aria-current': f.path === chosen ? 'true' : null, title: f.path, onclick: () => load(f.path) },
      // rtl puts the ellipsis at the start (the end of a path is what tells files apart); the name inside is isolated
      // left to right, so a leading dot or a closing bracket stays where it is (".env.example", not "env.example.").
      h('span.dp-file-name', h('bdi', { dir: 'ltr' }, f.path)), f.new ? h('span.dp-file-new', 'new') : null,
      h('span.dp-file-n', h('span.dp-add', `+${f.added}`), ' ', h('span.dp-del', `−${f.removed}`)),
      queued.some((q) => q.path === f.path) ? h('span.dp-file-c', { title: 'Your comments' }, icon('comment', { size: 12 }), String(queued.filter((q) => q.path === f.path).length)) : null))),
    more ? h('li.dp-more', `${more} more: open the editor for every file`) : null);
  }
  async function load(p) {
    chosen = p;
    paintFiles(0);
    try {
      diff = await api(`${o.A}/diff?path=${encodeURIComponent(p)}`);
    } catch (e) {
      diff = null;
      return fill(body, h('p.dp-empty', failText(e)));
    }
    paintDiff();
  }

  // ---------- the diff, with its comment boxes ----------
  const keyOf = (side, n) => `${chosen}\n${side}\n${n}`;
  function plus(side, n, text) {
    return h('button.dp-plus', { type: 'button', 'data-key': keyOf(side, n), title: 'Comment on this line', 'aria-label': `Comment on ${side === 'old' ? 'removed ' : ''}line ${n}`, onclick: (e) => openBox(e.currentTarget.closest('.dp-row'), side, n, text) }, icon('plus', { size: 12 }));
  }
  // One side of a side-by-side row; `comment`: its number has the + (a removed line at the left, every line at the right).
  function cell(side, c, comment) {
    if (!c) return [h('span.dp-n.dp-blank'), h('span.dp-t.dp-blank')];
    return [num(c.n, comment ? plus(side, c.n, c.text) : null), text(c.kind, c.text)];
  }
  // A line's number is hidden from a screen reader, never its + (a button it must name and reach).
  const num = (n, button = null) => h('span.dp-n', n == null ? null : h('span', { 'aria-hidden': 'true' }, String(n)), button);
  // Added or removed is said in words (hidden text): an aria-label on a plain span is read by few screen readers.
  const text = (kind, t) => h(`span.dp-t.dp-${kind}`, h('span.dp-m', { 'aria-hidden': 'true' }, kind === 'add' ? '+' : kind === 'del' ? '−' : ' '),
    kind === 'add' ? h('span.chat-sr', 'Added: ') : kind === 'del' ? h('span.chat-sr', 'Removed: ') : null, t || ' ');
  function noteRows(side, n) {
    return queued.filter((q) => q.key === keyOf(side, n)).map((q) => h('div.dp-note', h('div.dp-note-body', icon('comment', { size: 13 }), h('span', q.body)),
      h('button.btn.small.ghost.dp-note-x', { type: 'button', 'data-key': q.key, 'aria-label': `Remove the comment: ${short(q.body, 40)}`, onclick: () => {
        queued.splice(queued.indexOf(q), 1);
        paintDiff();
        paintFiles(0);
        // The focus stays on the line: its next comment, else its +.
        const next = [...body.querySelectorAll('.dp-note-x')].find((b) => b.getAttribute('data-key') === q.key);
        if (next) next.focus();
        else focusLine(q.key);
      } }, 'Remove')));
  }
  /** The focus goes back to a line's + (after its comment box closed): the diff body where the line is gone. */
  function focusLine(key) {
    const b = [...body.querySelectorAll('.dp-plus')].find((x) => x.getAttribute('data-key') === key);
    (b || body).focus();
  }
  function paintDiff() {
    editing = null;
    paintFoot();
    if (!diff) return;
    if (diff.binary) return fill(body, h('p.dp-empty', `${diff.path} is not a text file: no lines to show.`));
    if (!diff.hunks.length) return fill(body, h('p.dp-empty', `${diff.path} is empty.`));
    const rows = diffRows(diff.hunks, split).map((r) => {
      if (r.kind === 'gap') return h('div.dp-gap', `Line ${r.line}`);
      if (split) {
        return [h(`div.dp-row.dp-split${r.left ? ` dp-l-${r.left.kind}` : ''}${r.right ? ` dp-r-${r.right.kind}` : ''}`, ...cell('old', r.left, !!r.left && r.left.kind === 'del'), ...cell('new', r.right, !!r.right)),
          ...(r.left && r.left.kind === 'del' ? noteRows('old', r.left.n) : []), ...(r.right ? noteRows('new', r.right.n) : [])];
      }
      const side = r.kind === 'del' ? 'old' : 'new';
      const n = side === 'old' ? r.old : r.new;
      return [h(`div.dp-row.dp-${r.kind}`, num(r.old), num(r.new, plus(side, n, r.text)), text(r.kind, r.text)),
      ...noteRows(side, n)];
    });
    fill(body, h(`div.dp-diff${split ? '.dp-diff-split' : ''}`, rows), diff.cut ? h('p.dp-empty', 'The diff goes on: open the editor for the rest.') : null);
  }
  function openBox(row, side, n, text) {
    if (editing) editing.box.remove();
    const ta = h('textarea.field.dp-box-input', { rows: 2, placeholder: 'Comment for Claude. Enter adds it, Shift+Enter is a new line', 'aria-label': `Comment on line ${n}` });
    const box = h('div.dp-box', ta, h('div.dp-box-actions',
      h('button.btn.small.secondary', { type: 'button', onclick: () => closeBox(true) }, 'Cancel'),
      h('button.btn.small.primary', { type: 'button', onclick: () => addComment(editing) }, 'Add comment')));
    editing = { key: keyOf(side, n), path: chosen, side, line: n, text, box };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.isComposing) {
        e.preventDefault();
        addComment(editing);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeBox(true);
      }
    });
    // Under the line and its comments already made.
    let at = row;
    while (at.nextElementSibling && at.nextElementSibling.classList.contains('dp-note')) at = at.nextElementSibling;
    at.after(box);
    ta.focus();
  }
  function closeBox(refocus = false) {
    if (!editing) return;
    const key = editing.key;
    editing.box.remove();
    editing = null;
    if (refocus) focusLine(key);
  }
  function addComment(ed) {
    if (!ed) return;
    const t = ed.box.querySelector('textarea').value.trim();
    if (!t) return;
    queued.push({ key: ed.key, path: ed.path, side: ed.side, line: ed.line, text: ed.text, body: t.slice(0, 4000) });
    paintDiff();
    paintFiles(0);
    focusLine(ed.key); // the diff was drawn again: the focus would be lost (and with it the pane's Esc)
  }
  function paintFoot() {
    foot.classList.toggle('hidden', !queued.length);
    fill(foot.firstChild, `${queued.length} comment${queued.length === 1 ? '' : 's'} not sent yet · ${sendKeys()} sends ${queued.length === 1 ? 'it' : 'them'}`);
    fill(sendBtn, icon('send', { size: 14 }), h('span', queued.length === 1 ? 'Send comment' : `Send ${queued.length} comments`));
  }
  async function sendAll() {
    if (!queued.length) return;
    const text = commentsMessage(queued);
    try {
      const r = await o.send(text);
      queued.length = 0;
      paintDiff();
      paintFiles(0);
      toast(r && r.queued ? 'Comments queued: Claude reads them when this turn ends' : 'Comments sent to Claude');
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }

  function close() {
    if (!open) return;
    open = false;
    const had = el.contains(document.activeElement) || document.activeElement === document.body;
    el.classList.add('hidden');
    o.onToggle?.(false);
    if (had && opener && opener.isConnected) opener.focus();
    opener = null;
  }
  return {
    el,
    async open(p = null) {
      if (p) chosen = p;
      if (!open) {
        const a = document.activeElement;
        opener = a && a !== document.body && !el.contains(a) ? a : null;
        open = true;
        el.classList.remove('hidden');
        o.onToggle?.(true);
      }
      await refresh();
      body.focus({ preventScroll: true });
    },
    close,
    isOpen: () => open,
    refresh,
    comments: () => queued.slice(),
  };
}
