// What the tab strip does with its list, without a page: which tabs a "Close ..." command closes (pinned tabs stay, as
// VS Code's pinned editors do), the order after a pin or a drag (pinned tabs first), and the next tab in turn.

/**
 * The tabs `kind` closes, from `list`, around tab `ref`: 'all', 'others' (all but ref), 'right' (after ref), 'saved'
 * (without unsaved changes). Pinned tabs are never among them.
 */
export function toClose(list, ref, kind, isDirty = () => false) {
  const i = list.indexOf(ref);
  return list.filter((t, j) => !t.pinned && (
    kind === 'all' || (kind === 'others' && t !== ref) || (kind === 'right' && i >= 0 && j > i) || (kind === 'saved' && !isDirty(t))));
}

/**
 * Whether a close `how` closes tab `t`: a pinned tab stays on a middle click ('middle') and on the Close Editor key
 * ('key'), as VS Code's workbench.editor.preventPinnedEditorClose ('keyboardAndMouse' by default) keeps it; its own
 * button and the menu's Close still close it.
 */
export const closesBy = (t, how) => !(t && t.pinned && (how === 'middle' || how === 'key'));

/**
 * A tab's word wrap: what Alt+Z set for that file while it is open (VS Code's toggleWordWrap keeps it on the model,
 * leaving the editor.wordWrap setting alone), else the Word Wrap setting. → 'on' | 'off'
 */
export const wrapOf = (t, setting) => (t && t.wrap ? t.wrap : setting ? 'on' : 'off');

/** Whether Alt+Z wraps tab `t`: a file, and a Changes or compare tab (VS Code's toggleWordWrap works in a diff too). */
export const wraps = (t) => !!t && !t.note && ['file', 'diff', 'compare'].includes(t.kind);

/**
 * Whether the tab itself takes a keydown (Enter or Space shows it): only when the tab has the keyboard, not one of
 * its own buttons (Close, Unpin), which keep their Enter and Space.
 */
export const tabTakes = (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget;

/**
 * Start the drag of a tab or a tree row: its path under the page's own type, never as text/plain, so a drop on the
 * code editor (or any text box) types nothing (VS Code's own drags open or move, they never insert text).
 */
export const DRAG_TYPE = 'application/x-hoprig-path';
export function dragPath(dt, path) {
  dt.effectAllowed = 'move';
  dt.setData(DRAG_TYPE, path);
}

/**
 * Whether the keyboard was lost: it is on nothing (the page's body), on an element that left the page (a closed
 * tab), or inside `gone` (a side bar being hidden). Then the page gives it to the editor, as VS Code does.
 */
export const focusLost = (a, body, gone = null) => !a || a === body || a.isConnected === false || Boolean(gone && gone.contains(a));

/** Pinned tabs first, each group in the order it had. Changes `list` in place. */
export function regroup(list) {
  const pinned = list.filter((t) => t.pinned);
  const rest = list.filter((t) => !t.pinned);
  list.splice(0, list.length, ...pinned, ...rest);
  return list;
}

/** Move tab `t` to stand before `before` (null: at the end), then pinned first again. Changes `list` in place. */
export function moveBefore(list, t, before) {
  const from = list.indexOf(t);
  if (from < 0 || t === before) return list;
  list.splice(from, 1);
  const to = before ? list.indexOf(before) : -1;
  list.splice(to < 0 ? list.length : to, 0, t);
  return regroup(list);
}

/** The tab `d` steps from `ref` (1 the next, -1 the one before), round the end; null with fewer than two tabs. */
export function stepFrom(list, ref, d) {
  if (list.length < 2) return null;
  const i = Math.max(0, list.indexOf(ref));
  return list[(i + d + list.length) % list.length];
}

