// The window manager of the desktop: windows that move, resize from every edge and corner, snap to halves,
// quarters and the whole area, minimise, maximise, close and come to the front; one implementation for both
// styles (desktop.css draws the difference). Moving and resizing with the pointer is in moves.js, the keys in
// wmkeys.js, the title bar's menu in winmenu.js, two tabs on one desktop in wmsync.js.
//
// A window shows a page of the dashboard in a frame (apps.js frameSrc), or a native app (native.js). While a window
// is dragged or resized, and over every frame that is not in front, a shield lies over it: a frame would otherwise
// swallow the pointer, and the first press on a window behind brings it to the front instead of pressing in it.
// The layout of each computer's desktop is kept in this browser (layout.js) and comes back on a reload. A window's own
// rect is kept as the owner put it; on a smaller area it is shown fitted (layout.js shownRect) and comes back when the
// area is large again.
import { icon } from '../icons.js';
import { add, fill, h, prefs, samePlace, toast } from '../lib.js';
import { APP_IDS, appById, appHash, frameSrc } from './apps.js';
import { frameKeys, giveKeys, mayClose, unsavedOf } from './frames.js';
import { MAX_WINDOWS, cleanLayout, frontOf, gridRects, keepLayout, keptState, layoutKey, placeNew, restack, shownRect, snapRect } from './layout.js';
import { pointerMoves } from './moves.js';
import { withMenu } from './menu.js';
import { nativeBody } from './native.js';
import { windowMenu } from './winmenu.js';
import { chosenKeys, windowKeys } from './wmkeys.js';
import { adoptLayout, tabSync } from './wmsync.js';

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const newId = () => `w${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The windows of one desktop. `area` is the element they live in (the part the bars leave free), `root` the
 * desktop, `machineName` the computer (null: this one), `onChange()` is called after every change (the bars draw
 * again), `askClose(window)` → 'close' | 'end' | null (stay) before a window of a shell the desktop started closes
 * ('end': the shell was ended too), `onMinimised(id)` after a minimise by the keyboard (its bar button takes it).
 * Returns the manager; `stop()` ends its listeners.
 */
export function windowManager({ root, area, machineName, onChange = () => {}, askClose = async () => 'close', launch = () => {}, onMinimised = () => {} }) {
  const key = layoutKey(machineName);
  // { id, app, hash, home (where its app starts), own (a shell the desktop started), title, rect, snap, min, z, el,
  //   placedIn (the area it was moved in, not kept), frame, titleEl }
  const wins = [];
  let focusId = null;

  const size = () => ({ w: area.clientWidth, h: area.clientHeight });
  const byId = (id) => wins.find((v) => v.id === id) || null;
  /** What a window is called in its title bar and the bar: the app's name, and what it shows when that differs. */
  const labelOf = (v) => {
    const app = appById(v.app);
    return v.title && v.title !== app.title ? `${app.title} · ${v.title}` : app.title;
  };
  const front = () => frontOf(wins);
  /** Where window `v` is shown now: its snap place, else its own rect fitted to the area as it is now. */
  const shown = (v, s = size()) => (!s.w || !s.h ? v.rect : v.snap ? snapRect(v.snap, s) : shownRect(v.rect, s, v.placedIn));

  let saveTimer = null;
  let tabs = null; // wmsync.js, made once the kept layout is drawn
  // An act is kept at once, also in a tab that goes behind right after it. Another tab's change that waits is taken
  // first (a page that moved on in a window, this tab closed), so neither tab's change is lost.
  const keep = () => {
    clearTimeout(saveTimer);
    if (tabs) (tabs.take(), wins.forEach((v) => (v.kept = keptState(v))), prefs.set(key, keepLayout(wins, focusId)));
  };
  const changed = () => (keep(), onChange());
  // What a window's page says of itself (title, address): kept a moment later, by a tab in view only. While another
  // tab's change waits, only a window in use keeps it now (keep takes that change first); one nobody uses waits for the
  // tab's next use or its pagehide, so a tab someone only looks at never changes under them.
  const used = (v) => !tabs || !tabs.waiting() || v.el.contains(document.activeElement);
  const synced = (v) => (clearTimeout(saveTimer), (saveTimer = setTimeout(() => !document.hidden && used(v) && keep(), 250)), onChange());

  /** Put a window where its model says: its snap place or its own rect, its layer, shown or not. */
  function place(v) {
    const r = shown(v);
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
    restack(wins, id, true);
    focusId = id;
    placeAll();
    changed();
  }
  function focusFront() {
    focusId = (front() || {}).id || null;
    placeAll();
  }
  /** Minimise a window: it goes to the bottom of the order (the cycle key reaches it last), the next one comes forward. */
  function minimise(id, { byKey = false } = {}) {
    const v = byId(id);
    if (!v) return;
    v.min = true;
    restack(wins, id, false);
    if (focusId === id) focusFront();
    else placeAll();
    changed();
    if (byKey) onMinimised(id);
  }
  function setSnap(id, snap) {
    const v = byId(id);
    if (!v) return;
    v.snap = snap;
    v.min = false;
    focus(id);
  }
  const toggleMax = (id) => byId(id) && setSnap(id, byId(id).snap === 'max' ? null : 'max');
  /** Close a window; one of a shell the desktop started asks first whether the shell ends too. */
  async function close(id) {
    const w = byId(id);
    if (!w) return;
    if (w.own && w.app === 'terminal' && (await askClose(w)) === null) return;
    if (!(await mayClose(w, labelOf(w)))) return;
    if (drop(w)) changed();
  }
  /** Take a window off the desktop (closed here, or in another tab); false when it was gone already. */
  function drop(v) {
    const i = wins.indexOf(v);
    if (i < 0) return false;
    wins.splice(i, 1);
    clearInterval(v.watch);
    if (v.native) v.native.stop();
    v.el.remove();
    if (focusId === v.id) focusFront();
    return true;
  }
  /** From the bar: the window in front is minimised (`byKey`: by Enter or Space), any other comes to the front. */
  function toggleFromBar(id, { byKey = false } = {}) {
    const v = byId(id);
    if (v && focusId === id && !v.min) minimise(id, { byKey });
    else if (v) raise(id);
  }
  /** Bring a window to the front and give it the keyboard, as a window opened or raised on purpose does. */
  function raise(id) {
    focus(id);
    giveKeys(byId(id), () => focusId === id);
  }
  const moves = pointerMoves({ root, area, size, place, changed, shown });

  // ---------- one window ----------

  function build(v) {
    const app = appById(v.app);
    const ctl = (name, label, run) => h('button.dwin-btn', { type: 'button', title: label, 'aria-label': label, dataset: { act: name }, onclick: (e) => {
      e.stopPropagation();
      run(e.detail === 0); // 0: Enter or Space, not a pointer
    } }, icon(name, { size: 14 }));
    v.titleEl = h('span.dwin-title', labelOf(v));
    v.maxBtn = ctl('square', 'Maximise', () => toggleMax(v.id));
    const bar = h('header.dwin-bar', { ondblclick: (e) => {
      if (!e.target.closest('.dwin-btn')) toggleMax(v.id);
    } },
    h('span.dwin-icon', icon(app.icon, { size: 15 })), v.titleEl,
    h('div.dwin-ctl', ctl('minus', 'Minimise', (byKey) => minimise(v.id, { byKey })), v.maxBtn, ctl('x', 'Close', () => close(v.id))));
    // A native app keeps where it is (Files: its folder) in the window's address and title, and opens other apps.
    v.native = app.kind === 'native' ? nativeBody(app, { machine: machineName, hash: () => v.hash, open: launch, place: (q, title) => {
      v.hash = `${appHash(app, machineName)}${q ? `?${q}` : ''}`;
      if (title) {
        v.title = title;
        v.titleEl.textContent = labelOf(v);
      }
      changed();
    } }) : null;
    v.frame = v.native ? null : h('iframe.dwin-frame', { src: frameSrc(v.hash, location.pathname, frameOpts(v)), title: v.title || app.title });
    const shield = h('div.dwin-shield', { 'aria-hidden': 'true' });
    v.el = h('section.dwin', { 'aria-label': labelOf(v), dataset: { id: v.id, app: v.app, kind: app.kind } },
      bar, h('div.dwin-body', v.native ? v.native.el : v.frame, shield),
      DIRS.map((d) => h('div.dwin-grip', { dataset: { dir: d }, 'aria-hidden': 'true' })));
    // Any press on the window brings it to the front (the shield takes the first one on a window behind).
    v.el.addEventListener('pointerdown', () => {
      if (focusId !== v.id) focus(v.id);
    }, true);
    v.el.addEventListener('focusin', () => {
      if (focusId !== v.id) focus(v.id);
    });
    moves.drag(v, bar);
    for (const g of v.el.querySelectorAll('.dwin-grip')) moves.resize(v, g);
    // Also on a button (the bar's only keyboard stops): the context-menu key opens it there; a finger's long press does not.
    withMenu(bar, (e) => (e.target.closest && e.target.closest('.dwin-btn') && (e.type !== 'contextmenu' || e.pointerType === 'touch' || e.pointerType === 'pen') ? null : windowMenu(v, ops, chosenKeys())), 'Window');
    // The page in the window names itself and may move on (a session opened from Sessions): kept for the bar, the
    // title and the next reload. Same origin, so it is read directly; a page still loading is read next time.
    if (v.frame) v.watch = setInterval(() => sync(v), 1000);
    if (v.frame) v.frame.addEventListener('load', () => {
      sync(v);
      // Opened on purpose while it loaded (not restored on a reload): the keyboard goes in now.
      if (v.wantsKeys && focusId === v.id && document.activeElement === v.frame) frameKeys(v);
      try {
        v.frame.contentWindow.addEventListener('hashchange', () => setTimeout(() => sync(v), 50));
      } catch {
        /* not this site's page (it never is): nothing to read */
      }
    });
    add(area, v.el);
  }

  /** What a window's page is told about its app (lib.js WINDOW): where it starts, its name, its computer. */
  function frameOpts(v) {
    const app = appById(v.app);
    return { home: v.home, label: app.kind === 'page' ? app.title : null, only: v.app === 'sessions' ? machineName || '~' : null };
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
      // A page app on the page it starts at is called by the app's name (Sessions, as on its icon); once it moved on
      // (a session opened in it), by that page's.
      const app = appById(v.app);
      if (app.kind === 'page' && samePlace(hash, v.home)) title = app.title;
    } catch {
      return;
    }
    if (title === v.title && hash === v.hash) return;
    v.title = title || v.title;
    v.hash = /^#\/[^\s<>"']{0,500}$/.test(hash) ? hash : v.hash;
    v.titleEl.textContent = labelOf(v);
    v.el.setAttribute('aria-label', v.titleEl.textContent);
    v.frame.title = v.titleEl.textContent;
    synced(v);
  }

  /** A window that shows a page goes to `hash` on that page (the editor opens a file of its folder in place). */
  function navigate(id, hash) {
    const v = byId(id);
    if (!v || !v.frame) return false;
    try {
      v.frame.contentWindow.location.hash = hash;
    } catch {
      return false;
    }
    focus(id);
    return true;
  }
  function reload(id) {
    const v = byId(id);
    if (v && v.native) v.native.reload();
    else if (v) v.frame.src = frameSrc(v.hash, location.pathname, frameOpts(v));
  }

  // ---------- keys ----------

  // The keys (wmkeys.js) and what the title bar's menu (winmenu.js) may do.
  const keys = windowKeys({ wins, byId, front: () => focusId, raise, minimise, close, setSnap, relayer: () => {
    focusFront();
    changed();
  } });
  const ops = { setSnap, toggleMax, minimise, reload, close, cycle: () => keys.act('cycle') };
  // A window's page tells the desktop about its keys, a sign-out and a close (lib.js tellDesktop): only a window of
  // this desktop, from this same site, is listened to.
  const onMessage = (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return;
    const v = wins.find((w) => w.frame && w.frame.contentWindow === e.source);
    if (!v) return;
    tabs.take(); // a key or a press in a window's page never reaches this document's own listeners (wmsync.js)
    if (e.data.type === 'hoprig:key' && typeof e.data.act === 'string') keys.act(e.data.act, v.id);
    else if (e.data.type === 'hoprig:keyup') keys.release();
    else if (e.data.type === 'hoprig:leave') v.el.querySelector('.dwin-btn').focus(); // F6 in its page (lib.js)
    else if (e.data.type === 'hoprig:escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // moves.js
    else if (e.data.type === 'hoprig:logged-out') location.href = '/login';
    else if (e.data.type === 'hoprig:close') close(v.id); // its session ended on the window's start page
    else if (e.data.type === 'hoprig:open' && APP_IDS.has(e.data.app) && /^#\/[^\s<>"']{0,2000}$/.test(e.data.hash || '')) launch(e.data.app, e.data.hash); // Show in Files
    else if (e.data.type === 'hoprig:goto' && /^#\/[^\s<>"']{0,2000}$/.test(e.data.hash || '')) {
      // A chat's "Open the terminal": the window that shows that session comes forward, else this one goes there.
      const there = wins.find((w) => w !== v && !w.native && samePlace(w.hash, e.data.hash));
      if (there) raise(there.id);
      else navigate(v.id, e.data.hash);
    }
  };
  // The keyboard went into a window's page (Tab, or a press the shield did not take): that window comes forward.
  const onBlur = () => setTimeout(() => {
    const el = document.activeElement;
    const v = el && el.tagName === 'IFRAME' ? wins.find((w) => w.frame === el) : null;
    if (v) tabs.take(); // the keyboard went into a window: this tab is used, so it takes another tab's change first
    if (v && focusId !== v.id) focus(v.id);
  }, 0);
  // A smaller area (a smaller browser window, a layout from a larger screen, the other style's bars) shows every window
  // inside it, its title bar's buttons included; its own rect stays, so a larger area shows it as it was again.
  const onResize = () => {
    const s = size();
    if (s.w && s.h) placeAll();
  };
  window.addEventListener('pagehide', keep); // a reload or a closed tab keeps the layout as last shown, also mid-move
  window.addEventListener('message', onMessage);
  window.addEventListener('blur', onBlur);
  // The area changes size with the browser window and when the bars are drawn or change style.
  const sizer = new ResizeObserver(onResize);
  sizer.observe(area);

  // ---------- open and restore ----------

  /** True when one more window can open; else says so (once, not once per press) and false. */
  let saidFull = 0;
  function canOpen() {
    if (wins.length < MAX_WINDOWS) return true;
    if (Date.now() - saidFull > 4000) {
      saidFull = Date.now();
      toast(`At most ${MAX_WINDOWS} windows at once: close one first.`, { kind: 'error' });
    }
    return false;
  }

  /**
   * Open a window of `appId` showing `hash`. `home`: where its app starts (a page app's own address by default; a
   * Terminal's is its session); `own`: a shell the desktop started for it. Returns its id, or null past the limit.
   */
  function open(appId, hash, { title = '', rect = null, snap = null, home = null, own = false } = {}) {
    if (!APP_IDS.has(appId) || !canOpen()) return null;
    const app = appById(appId);
    const start = home || (app.kind === 'page' ? appHash(app, machineName) : app.kind === 'terminal' ? hash : null);
    const icons = area.querySelector('.desk-icons');
    const left = icons ? icons.offsetLeft + icons.offsetWidth + 8 : 0;
    const v = { id: newId(), app: appId, hash, home: start, own: own === true, title, rect: rect || placeNew(wins, size(), {}, { left }), snap, min: false, z: wins.length + 1 };
    wins.push(v);
    build(v);
    raise(v.id);
    return v.id;
  }

  /** A window of a kept layout (cleanLayout), drawn. */
  function restore(k) {
    const app = appById(k.app);
    // A page app starts where its app starts, whatever an older layout kept (it once kept "#/m/<pc>/" for Sessions).
    const home = app.kind === 'page' ? appHash(app, machineName) : k.home || (app.kind === 'terminal' ? k.hash : null);
    const v = { ...k, home, kept: keptState(k) };
    wins.push(v);
    build(v);
  }
  const focusOf = (kept) => (kept.focus && byId(kept.focus) && !byId(kept.focus).min ? kept.focus : (front() || {}).id || null);
  // The layout this computer's desktop had in this browser.
  const kept = cleanLayout(prefs.get(key, null), APP_IDS);
  for (const k of kept.windows) restore(k);
  focusId = focusOf(kept);
  placeAll();

  // Another tab changed this desktop: its layout, the one changed last, is taken (wmsync.js says when and how). A
  // window that holds unsaved changes here stays; a tab behind lets go of the keyboard in a window that went behind.
  tabs = tabSync(key, (raw) => {
    const typing = wins.find((v) => v.el.contains(document.activeElement)) || null;
    focusId = adoptLayout(wins, cleanLayout(raw, APP_IDS), { inView: !document.hidden, typing, front: byId(focusId), byId, drop, restore, canAdd: () => wins.length < MAX_WINDOWS });
    if (typing && focusId !== typing.id && typing.el.contains(document.activeElement)) document.activeElement.blur();
    placeAll();
    onChange();
  });

  return {
    open,
    canOpen,
    focus,
    raise,
    minimise,
    close,
    toggleFromBar,
    toggleMax,
    setSnap,
    reload,
    navigate,
    /** Files with unsaved changes in all the windows. */
    unsaved: () => wins.reduce((n, v) => n + unsavedOf(v), 0),
    /** The windows in the order they were opened, for the bars: { id, app, title, min, focused }. */
    list: () => wins.map((v) => ({ id: v.id, app: v.app, title: v.title || appById(v.app).title, label: labelOf(v), min: v.min, snap: v.snap, focused: v.id === focusId && !v.min, hash: v.hash, home: v.home, own: v.own })),
    /** The next window, as the cycle key goes. */
    cycle: () => keys.act('cycle'),
    focused: () => (focusId ? byId(focusId) : null),
    /**
     * The window that stands for an app with one window (apps.js `single`), or null. For a page app it is one still on
     * its app's start page (Sessions: the list); a window that moved on to something else (a conversation, opened
     * from the list or from the start menu) is that thing now and is never reused or sent back.
     */
    only(appId) {
      const app = appById(appId);
      const v = wins.find((w) => w.app === appId && (app.kind !== 'page' || samePlace(w.hash, w.home)));
      return v ? v.id : null;
    },
    /** The area changed size (the window, or the other style's bars): every window fits it again. */
    relayout: onResize,
    /** Every window side by side in a grid, none minimised. */
    arrange() {
      const shown = wins.filter((v) => !v.min);
      if (!shown.length) return;
      gridRects(shown.length, size()).forEach((r, i) => Object.assign(shown[i], { snap: null, rect: r, placedIn: null }));
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
      keep();
      for (const v of wins) {
        clearInterval(v.watch);
        if (v.native) v.native.stop();
      }
      keys.stop();
      tabs.stop();
      window.removeEventListener('pagehide', keep);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('blur', onBlur);
      sizer.disconnect();
    },
  };
}
