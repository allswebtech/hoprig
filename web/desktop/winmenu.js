// The menu of a window's title bar (right click, the context-menu key, a long press on a touch screen): each act with
// the desktop's key for it, where it has one (keymap.js; none with the keys off). A quarter has no key of its own: its
// hint is the two presses that reach it (a half, then up or down).
import { keyLabel, keyShortcut, quarterLabel } from './keymap.js';

/** The items of window `v`'s menu. `wm`: { setSnap, toggleMax, minimise, reload, close }; `keys`: the chosen set. */
export function windowMenu(v, wm, keys) {
  const k = (act) => keyLabel(keys, act);
  const a = (act) => keyShortcut(keys, act);
  return [
    { label: 'Snap to the left half', icon: 'back', hint: k('left'), keys: a('left'), run: () => wm.setSnap(v.id, 'l') },
    { label: 'Snap to the right half', icon: 'chevronRight', hint: k('right'), keys: a('right'), run: () => wm.setSnap(v.id, 'r') },
    { label: 'Top left quarter', hint: quarterLabel(keys, 'tl'), run: () => wm.setSnap(v.id, 'tl') },
    { label: 'Top right quarter', hint: quarterLabel(keys, 'tr'), run: () => wm.setSnap(v.id, 'tr') },
    { label: 'Bottom left quarter', hint: quarterLabel(keys, 'bl'), run: () => wm.setSnap(v.id, 'bl') },
    { label: 'Bottom right quarter', hint: quarterLabel(keys, 'br'), run: () => wm.setSnap(v.id, 'br') },
    null,
    { label: v.snap === 'max' ? 'Restore' : 'Maximise', icon: v.snap === 'max' ? 'restore' : 'square', hint: v.snap === 'max' ? keyLabel(keys, 'down') : k('up'), keys: a(v.snap === 'max' ? 'down' : 'up'), run: () => wm.toggleMax(v.id) },
    { label: 'Minimise', icon: 'minus', hint: k('min'), keys: a('min'), run: () => wm.minimise(v.id) },
    { label: 'Next window', icon: 'swap', hint: k('cycle'), keys: a('cycle'), run: () => wm.cycle() },
    { label: 'Reload', icon: 'refresh', run: () => wm.reload(v.id) },
    { label: 'Open as a page', icon: 'external', run: () => (location.hash = v.hash) },
    null,
    { label: 'Close', icon: 'x', danger: true, hint: k('close'), keys: a('close'), run: () => wm.close(v.id) },
  ];
}
