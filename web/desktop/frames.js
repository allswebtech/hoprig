// What the window manager (wm.js) asks of the page or app inside a window: to take the keyboard, and whether the
// Editor in it holds unsaved changes (web/editor/index.js says how many, and saves them on request). A window's
// frame is a page of this same site, so it is read directly; one still loading answers next time.
import { h, openSheet, samePlace } from '../lib.js';

/**
 * The keyboard goes into window `v`: its page (the terminal, the editor) or the first field of a native app, so
 * what is typed next lands there. A page still loading gets it once it has loaded (wm.js, on the frame's load).
 * `inFront()`: whether `v` is still the window in front; one that went behind meanwhile takes nothing.
 */
export function giveKeys(v, inFront = () => true) {
  if (!v) return;
  if (v.native) {
    // Its module loads and draws a moment later: its first field takes the keyboard then, unless another window came
    // to the front or the keyboard went elsewhere meanwhile.
    const from = document.activeElement;
    let n = 0;
    const take = () => {
      if (!v.el.isConnected || !inFront() || (document.activeElement !== from && !v.el.contains(document.activeElement))) return;
      const el = v.native.el.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
      if (el) el.focus({ preventScroll: true });
      else if (++n < 30) setTimeout(take, 100);
    };
    take();
    return;
  }
  v.wantsKeys = true;
  frameKeys(v);
}

/** The frame of window `v` takes the keyboard, and its page puts it where typing goes (lib.js, 'hoprig:keys'). */
export function frameKeys(v) {
  v.frame.focus({ preventScroll: true });
  try {
    v.frame.contentWindow.focus();
    v.frame.contentWindow.postMessage({ type: 'hoprig:keys' }, location.origin);
  } catch {
    /* not loaded yet: wm.js does it on the frame's load */
  }
}

/** The address window `v` shows now: its page's own (read at once, before its next sync in wm.js), else its model's. */
export function liveHash(v) {
  try {
    const w = v.frame && v.frame.contentWindow;
    if (w && w.location.href !== 'about:blank') return w.location.hash || '#/';
  } catch {
    /* not loaded yet */
  }
  return v.hash;
}

/**
 * Window `v` goes to address `hash`, the one another tab moved it to (wmsync.js decides when): its page follows (its
 * title is read from it a moment later), a native app starts again there. One with unsaved changes stays where it is.
 */
export function followHash(v, hash) {
  if (samePlace(liveHash(v), hash) || unsavedOf(v)) return;
  v.hash = hash;
  if (v.native) return v.native.reload();
  try {
    v.frame.contentWindow.location.hash = hash;
  } catch {
    /* not loaded yet: it shows the address it was opened at */
  }
}

/** Files with unsaved changes in a window's page. */
export function unsavedOf(v) {
  try {
    const f = v.frame && v.frame.contentWindow.__hoprigUnsaved;
    return typeof f === 'function' ? Number(f()) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Save every file of a window's editor: true when all were saved. */
async function saveAllOf(v) {
  try {
    const f = v.frame && v.frame.contentWindow.__hoprigSaveAll;
    return typeof f === 'function' ? Boolean(await f()) : false;
  } catch {
    return false;
  }
}

/**
 * May window `v` (called `label`) close? With unsaved changes in it, asked first: Save and close, Close without
 * saving, or Cancel. A save that does not go through (the file changed on disk, an error) keeps the window.
 */
export async function mayClose(v, label) {
  const n = unsavedOf(v);
  if (!n) return true;
  const how = await openSheet({ title: `Close ${label}?` }, (done) => [
    h('p.sheet-text', `${n} ${n === 1 ? 'file has' : 'files have'} unsaved changes in this window.`),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => done(null) }, 'Cancel'),
      h('button.btn.danger', { type: 'button', onclick: () => done('drop') }, 'Close without saving'),
      h('button.btn.primary', { type: 'button', autofocus: true, onclick: () => done('save') }, 'Save and close')),
  ]);
  if (!how) return false;
  return how === 'drop' || saveAllOf(v);
}
