// Moving and resizing the desktop's windows with the pointer (wm.js): Pointer Events with the pointer captured, so a
// mouse, a pen and a finger take one path; a drag to an edge or a corner shows where the window would snap.
import { add, h } from '../lib.js';
import { clampRect, resizeRect, snapRect, snapZone } from './layout.js';

/**
 * The moves of the windows in `area` of desktop `root`. `size()` → the area's size; `place(v)` draws a window as its
 * model says; `changed()` after a move or a resize ended. Returns { drag(v, bar), resize(v, grip) }.
 */
export function pointerMoves({ root, area, size, place, changed }) {
  const preview = h('div.desk-preview.hidden', { 'aria-hidden': 'true' });
  add(area, preview);

  /** Pointer moves on `handle` with the pointer captured; `move(dx, dy, e)` per frame, `end(e)` once. */
  function track(handle, startFn, move, end) {
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
      const onUp = (ev) => {
        cancelAnimationFrame(raf);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        root.classList.remove('desk-busy');
        move(ev.clientX - x0, ev.clientY - y0, ev);
        end(ev);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  function drag(v, bar) {
    let start = null;
    let moved = false;
    let zone = null;
    track(bar, () => {
      start = v.snap ? snapRect(v.snap, size()) : { ...v.rect };
      moved = false;
      zone = null;
    }, (dx, dy, e) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      const a = area.getBoundingClientRect();
      if (!moved && v.snap) {
        // Taken out of a snap place: back to its own size, under the pointer where it was held.
        const px = e.clientX - a.left;
        const keep = (px - start.x) / start.w;
        start = { x: Math.round(px - keep * v.rect.w - dx), y: start.y, w: v.rect.w, h: v.rect.h };
        v.snap = null;
      }
      moved = true;
      v.rect = clampRect({ ...start, x: start.x + dx, y: start.y + dy }, size());
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
    });
  }

  function resize(v, grip) {
    let start = null;
    let moved = false;
    track(grip, () => {
      start = v.snap ? snapRect(v.snap, size()) : { ...v.rect };
      moved = false;
    }, (dx, dy) => {
      // A press without a move leaves a snapped window as it was, with the size it goes back to.
      if (!moved && !dx && !dy) return;
      moved = true;
      v.snap = null;
      v.rect = resizeRect(start, grip.dataset.dir, dx, dy, size());
      place(v);
    }, () => moved && changed());
  }

  function showPreview(zone) {
    const r = zone ? snapRect(zone, size()) : null;
    preview.classList.toggle('hidden', !r);
    if (r) Object.assign(preview.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  return { drag, resize };
}
