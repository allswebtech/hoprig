// The window manager of the desktop: windows that move, resize from every edge and corner, snap to halves,
// quarters and the whole area, minimise, maximise, close and come to the front; one implementation for both
// styles (desktop.css draws the difference). Pointer Events, so a mouse, a pen and a finger take the same path.
//
// A window shows a page of the dashboard in a frame (apps.js frameSrc), or a native app (native.js). While a window
// is dragged or resized, and over every frame that is not in front, a shield lies over it: a frame would otherwise
// swallow the pointer, and the first press on a window behind brings it to the front instead of pressing in it.
// The layout of each computer's desktop is kept in this browser (layout.js) and comes back on a reload.
import { icon } from '../icons.js';
import { add, fill, h, prefs, toast } from '../lib.js';
import { APP_IDS, appById, frameSrc } from './apps.js';
import { MAX_WINDOWS, clampRect, cleanLayout, gridRects, keepLayout, keySnap, layoutKey, placeNew, resizeRect, snapRect, snapZone } from './layout.js';
import { withMenu } from './menu.js';
import { nativeBody } from './native.js';

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const newId = () => `w${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The windows of one desktop. `area` is the element they live in (the part the bars leave free), `root` the
 * desktop, `machineName` the computer (null: this one), `onChange()` is called after every change (the bars draw
 * again). Returns the manager; `stop()` ends its listeners.
 */
export function windowManager({ root, area, machineName, onChange = () => {} }) {
  const key = layoutKey(machineName);
  const wins = []; // { id, app, hash, title, rect, snap, min, z, el, frame, titleEl }
  let focusId = null;
  let zTop = 0;
  const preview = h('div.desk-preview.hidden', { 'aria-hidden': 'true' });
  add(area, preview);

  const size = () => ({ w: area.clientWidth, h: area.clientHeight });
  const byId = (id) => wins.find((v) => v.id === id) || null;
  const front = () => wins.filter((v) => !v.min).sort((a, b) => b.z - a.z)[0] || null;

  let saveTimer = null;
  function changed() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => prefs.set(key, keepLayout(wins, focusId)), 250);
    onChange();
  }

  /** Put a window where its model says: its snap place or its own rect, its layer, shown or not. */
  function place(v) {
    const r = v.snap ? snapRect(v.snap, size()) : v.rect;
    Object.assign(v.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, zIndex: String(10 + v.z) });
    v.el.dataset.snap = v.snap || '';
    v.el.classList.toggle('hidden', v.min);
    v.el.setAttribute('aria-current', v.id === focusId ? 'true' : 'false');
    fill(v.maxBtn, icon(v.snap === 'max' ? 'restore' : 'square', { size: 14 }));
    v.maxBtn.title = v.snap === 'max' ? 'Restore' : 'Maximise';
    v.maxBtn.setAttribute('aria-label', v.maxBtn.title);
  }
  const placeAll = () => wins.forEach(place);

  function focus(id) {
    const v = byId(id);
    if (!v) return;
    v.min = false;
    // Layers stay 1…n (the window in front is n), so they never climb over the bars' menus or Tia's button.
    wins.filter((w) => w !== v).sort((a, b) => a.z - b.z).concat(v).forEach((w, i) => (w.z = i + 1));
    zTop = wins.length;
    focusId = id;
    placeAll();
    changed();
  }
  function focusFront() {
    const f = front();
    focusId = f ? f.id : null;
    placeAll();
  }
  function minimise(id) {
    const v = byId(id);
    if (!v) return;
    v.min = true;
    if (focusId === id) focusFront();
    else place(v);
    changed();
  }
  function setSnap(id, snap) {
    const v = byId(id);
    if (!v) return;
    v.snap = snap;
    v.min = false;
    focus(id);
  }
  const toggleMax = (id) => {
    const v = byId(id);
    if (v) setSnap(id, v.snap === 'max' ? null : 'max');
  };
  function close(id) {
    const i = wins.findIndex((v) => v.id === id);
    if (i < 0) return;
    const [v] = wins.splice(i, 1);
    clearInterval(v.watch);
    if (v.native) v.native.stop();
    v.el.remove();
    if (focusId === id) focusFront();
    changed();
  }
  /** From the bar: the window in front is minimised, any other comes to the front. */
  function toggleFromBar(id) {
    const v = byId(id);
    if (!v) return;
    if (focusId === id && !v.min) minimise(id);
    else focus(id);
  }

  // ---------- one window ----------

  function build(v) {
    const app = appById(v.app);
    const ctl = (name, label, run) => h('button.dwin-btn', { type: 'button', title: label, 'aria-label': label, dataset: { act: name }, onclick: (e) => {
      e.stopPropagation();
      run();
    } }, icon(name, { size: 14 }));
    v.titleEl = h('span.dwin-title', v.title || app.title);
    v.maxBtn = ctl('square', 'Maximise', () => toggleMax(v.id));
    const bar = h('header.dwin-bar', { ondblclick: (e) => {
      if (!e.target.closest('.dwin-btn')) toggleMax(v.id);
    } },
    h('span.dwin-icon', icon(app.icon, { size: 15 })), v.titleEl,
    h('div.dwin-ctl', ctl('minus', 'Minimise', () => minimise(v.id)), v.maxBtn, ctl('x', 'Close', () => close(v.id))));
    v.native = app.kind === 'native' ? nativeBody(app, { machine: machineName }) : null;
    v.frame = v.native ? null : h('iframe.dwin-frame', { src: frameSrc(v.hash, location.pathname), title: v.title || app.title });
    const shield = h('div.dwin-shield', { 'aria-hidden': 'true' });
    v.el = h('section.dwin', { 'aria-label': v.title || app.title, dataset: { id: v.id, app: v.app, kind: app.kind } },
      bar, h('div.dwin-body', v.native ? v.native.el : v.frame, shield),
      DIRS.map((d) => h('div.dwin-grip', { dataset: { dir: d }, 'aria-hidden': 'true' })));
    // Any press on the window brings it to the front (the shield takes the first one on a window behind).
    v.el.addEventListener('pointerdown', () => {
      if (focusId !== v.id) focus(v.id);
    }, true);
    v.el.addEventListener('focusin', () => {
      if (focusId !== v.id) focus(v.id);
    });
    drag(v, bar);
    for (const g of v.el.querySelectorAll('.dwin-grip')) resize(v, g);
    withMenu(bar, (e) => (e.target.closest && e.target.closest('.dwin-btn') ? null : windowMenu(v)), 'Window');
    // The page in the window names itself and may move on (a session opened from Sessions): kept for the bar, the
    // title and the next reload. Same origin, so it is read directly; a page still loading is read next time.
    if (v.frame) v.watch = setInterval(() => sync(v), 1000);
    if (v.frame) v.frame.addEventListener('load', () => {
      sync(v);
      try {
        v.frame.contentWindow.addEventListener('hashchange', () => setTimeout(() => sync(v), 50));
      } catch {
        /* not this site's page (it never is): nothing to read */
      }
    });
    add(area, v.el);
  }

  function sync(v) {
    let title = '';
    let hash = v.hash;
    try {
      const doc = v.frame.contentDocument;
      const w = v.frame.contentWindow;
      if (!doc || !w || w.location.href === 'about:blank') return;
      hash = w.location.hash || '#/';
      const t = doc.querySelector('main .page-title');
      title = ((t && t.textContent) || doc.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    } catch {
      return;
    }
    if (title === v.title && hash === v.hash) return;
    v.title = title || v.title;
    v.hash = /^#\/[^\s<>"']{0,500}$/.test(hash) ? hash : v.hash;
    v.titleEl.textContent = v.title || appById(v.app).title;
    v.el.setAttribute('aria-label', v.titleEl.textContent);
    v.frame.title = v.titleEl.textContent;
    changed();
  }

  function windowMenu(v) {
    return [
      { label: 'Snap to the left half', icon: 'back', run: () => setSnap(v.id, 'l') },
      { label: 'Snap to the right half', icon: 'chevronRight', run: () => setSnap(v.id, 'r') },
      { label: 'Top left quarter', run: () => setSnap(v.id, 'tl') },
      { label: 'Top right quarter', run: () => setSnap(v.id, 'tr') },
      { label: 'Bottom left quarter', run: () => setSnap(v.id, 'bl') },
      { label: 'Bottom right quarter', run: () => setSnap(v.id, 'br') },
      null,
      { label: v.snap === 'max' ? 'Restore' : 'Maximise', icon: v.snap === 'max' ? 'restore' : 'square', run: () => toggleMax(v.id) },
      { label: 'Minimise', icon: 'minus', run: () => minimise(v.id) },
      { label: 'Reload', icon: 'refresh', run: () => reload(v.id) },
      { label: 'Open as a page', icon: 'external', run: () => (location.hash = v.hash) },
      null,
      { label: 'Close', icon: 'x', danger: true, run: () => close(v.id) },
    ];
  }
  function reload(id) {
    const v = byId(id);
    if (v && v.native) v.native.reload();
    else if (v) v.frame.src = frameSrc(v.hash, location.pathname);
  }

  // ---------- move and resize ----------

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
    track(grip, () => {
      start = v.snap ? snapRect(v.snap, size()) : { ...v.rect };
      v.snap = null;
    }, (dx, dy) => {
      v.rect = resizeRect(start, grip.dataset.dir, dx, dy, size());
      place(v);
    }, () => changed());
  }

  function showPreview(zone) {
    const r = zone ? snapRect(zone, size()) : null;
    preview.classList.toggle('hidden', !r);
    if (r) Object.assign(preview.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  // ---------- keys ----------

  /** Alt+Shift with an arrow snaps the window in front, W closes it, M minimises it. */
  function onKeyCode(code, id = focusId) {
    const v = byId(id);
    if (!v) return false;
    if (code === 'KeyW') close(id);
    else if (code === 'KeyM') minimise(id);
    else {
      const next = keySnap(v.snap, code);
      if (!next) return false;
      if (next.min) minimise(id);
      else setSnap(id, next.snap);
    }
    return true;
  }
  const onKey = (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (onKeyCode(e.code)) e.preventDefault();
  };
  // A window's page tells the desktop about its keys and about a sign-out (lib.js tellDesktop): only a window of
  // this desktop, from this same site, is listened to.
  const onMessage = (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return;
    const v = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
    if (!v) return;
    if (e.data.type === 'hoprig:key' && typeof e.data.code === 'string') onKeyCode(e.data.code, v.id);
    else if (e.data.type === 'hoprig:logged-out') location.href = '/login';
  };
  // The keyboard went into a window's page (Tab, or a press the shield did not take): that window comes forward.
  const onBlur = () => setTimeout(() => {
    const el = document.activeElement;
    const v = el && el.tagName === 'IFRAME' ? wins.find((w) => w.frame === el) : null;
    if (v && focusId !== v.id) focus(v.id);
  }, 0);
  const onResize = () => {
    for (const v of wins) v.rect = clampRect(v.rect, size());
    placeAll();
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('message', onMessage);
  window.addEventListener('blur', onBlur);
  // The area changes size with the browser window and when the bars are drawn or change style.
  const sizer = new ResizeObserver(onResize);
  sizer.observe(area);

  // ---------- open and restore ----------

  /** Open a window of `appId` showing `hash`. Returns its id, or null past the limit. */
  function open(appId, hash, { title = '', rect = null, snap = null } = {}) {
    if (!APP_IDS.has(appId)) return null;
    if (wins.length >= MAX_WINDOWS) {
      toast(`At most ${MAX_WINDOWS} windows at once: close one first.`, { kind: 'error' });
      return null;
    }
    const v = { id: newId(), app: appId, hash, title, rect: rect || placeNew(wins, size()), snap, min: false, z: zTop + 1 };
    wins.push(v);
    build(v);
    focus(v.id);
    return v.id;
  }

  // The layout this computer's desktop had in this browser.
  const kept = cleanLayout(prefs.get(key, null), APP_IDS);
  for (const k of kept.windows) {
    const v = { ...k, rect: clampRect(k.rect, size()) };
    zTop = Math.max(zTop, v.z);
    wins.push(v);
    build(v);
  }
  focusId = kept.focus && byId(kept.focus) && !byId(kept.focus).min ? kept.focus : (front() || {}).id || null;
  placeAll();

  return {
    open,
    focus,
    minimise,
    close,
    toggleFromBar,
    toggleMax,
    setSnap,
    reload,
    /** The windows in the order they were opened, for the bars: { id, app, title, min, focused }. */
    list: () => wins.map((v) => ({ id: v.id, app: v.app, title: v.title || appById(v.app).title, min: v.min, focused: v.id === focusId && !v.min, hash: v.hash })),
    focused: () => (focusId ? byId(focusId) : null),
    /** The area changed size (the window, or the other style's bars): every window fits it again. */
    relayout: onResize,
    /** Every window side by side in a grid, none minimised. */
    arrange() {
      const shown = wins.filter((v) => !v.min);
      if (!shown.length) return;
      gridRects(shown.length, size()).forEach((r, i) => Object.assign(shown[i], { snap: null, rect: r }));
      placeAll();
      changed();
    },
    minimiseAll() {
      for (const v of wins) v.min = true;
      focusId = null;
      placeAll();
      changed();
    },
    stop() {
      clearTimeout(saveTimer);
      prefs.set(key, keepLayout(wins, focusId));
      for (const v of wins) {
        clearInterval(v.watch);
        if (v.native) v.native.stop();
      }
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('blur', onBlur);
      sizer.disconnect();
    },
  };
}
