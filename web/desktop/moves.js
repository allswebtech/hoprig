// Moving and resizing the desktop's windows with the pointer (wm.js): Pointer Events with the pointer captured, so a
// mouse, a pen and a finger take one path; a drag to an edge or a corner shows where the window would snap. Escape
// during a move or a resize puts the window back where it was, as on other desktops.
import { add, h } from '../lib.js';
import { clampRect, resizeRect, snapRect, snapZone, unsnapRect } from './layout.js';

/**
 * The moves of the windows in `area` of desktop `root`. `size()` → the area's size; `shown(v)` → where a window is
 * shown now; `place(v)` draws a window as its model says; `changed()` after a move or a resize ended. Returns
 * { drag(v, bar), resize(v, grip) }.
 */
export function pointerMoves({ root, area, size, place, changed, shown }) {
  const preview = h('div.desk-preview.hidden', { 'aria-hidden': 'true' });
  add(area, preview);

  /**
   * Pointer moves on `handle` with the pointer captured: `startFn(e)` once (false: not this press), `move(dx, dy, e)`
   * per frame, `end(e)` once, or `cancel()` once instead when Escape is pressed (the pointer is then let go).
   */
  function track(handle, startFn, move, end, cancel) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('.dwin-btn'))) return;
      if (startFn(e) === false) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const y0 = e.clientY;
      let raf = 0;
      let last = e;
      root.classList.add('desk-busy');
      const onMove = (ev) => {
        last = ev;
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          move(last.clientX - x0, last.clientY - y0, last);
        });
      };
      const finish = () => {
        cancelAnimationFrame(raf);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        document.removeEventListener('keydown', onEsc, true);
        root.classList.remove('desk-busy');
      };
      const onUp = (ev) => {
        finish();
        move(ev.clientX - x0, ev.clientY - y0, ev);
        end(ev);
      };
      const onEsc = (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        finish();
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        cancel();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      document.addEventListener('keydown', onEsc, true);
    });
  }

  /** What a window was when a press began, to put it back on Escape. */
  const before = (v) => ({ rect: { ...v.rect }, snap: v.snap, placedIn: v.placedIn || null });
  const putBack = (v, b) => {
    Object.assign(v, b);
    showPreview(null);
    place(v);
  };

  function drag(v, bar) {
    let start = null;
    let was = null;
    let moved = false;
    let zone = null;
    track(bar, () => {
      was = before(v);
      start = shown(v);
      moved = false;
      zone = null;
    }, (dx, dy, e) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      const a = area.getBoundingClientRect();
      if (!moved && v.snap) {
        // Taken out of a snap place: back to its own size, under the pointer at the same share of the title bar.
        const px = e.clientX - a.left - dx;
        start = unsnapRect(start, v.rect, px);
        v.snap = null;
      }
      moved = true;
      v.rect = clampRect({ ...start, x: start.x + dx, y: start.y + dy }, size());
      v.placedIn = size(); // put here on purpose: shown as put while the area is this large
      zone = snapZone(e.clientX - a.left, e.clientY - a.top, size(), { edge: e.pointerType === 'mouse' ? 8 : 20 });
      showPreview(zone);
      place(v);
    }, () => {
      showPreview(null);
      if (!moved) return;
      if (zone) {
        v.rect = clampRect(start, size()); // where it goes back to from the snap place
        v.snap = zone;
      }
      place(v);
      changed();
    }, () => putBack(v, was));
  }

  function resize(v, grip) {
    let start = null;
    let was = null;
    let moved = false;
    track(grip, () => {
      was = before(v);
      start = shown(v);
      moved = false;
    }, (dx, dy) => {
      // A press without a move leaves a snapped window as it was, with the size it goes back to.
      if (!moved && !dx && !dy) return;
      moved = true;
      v.snap = null;
      v.rect = resizeRect(start, grip.dataset.dir, dx, dy, size());
      v.placedIn = size();
      place(v);
    }, () => moved && changed(), () => putBack(v, was));
  }

  function showPreview(zone) {
    const r = zone ? snapRect(zone, size()) : null;
    preview.classList.toggle('hidden', !r);
    if (r) Object.assign(preview.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  return { drag, resize };
}
