// Two tabs of this browser on one computer's desktop (wm.js). The kept layout is the one changed last. A tab that is
// not shown takes another tab's change at once (nobody sees it move); a tab that is shown takes it when it is used
// again (it gets the focus, or a press), so a window never jumps under someone who is looking at it, and no tab
// writes its old layout over the other's windows. What a tab changed itself since it last kept or took a window (its
// place, minimised or not, its page) stays when it takes another tab's layout, and the window in use stays in front.
import { followHash, liveHash, unsavedOf } from './frames.js';
import { frontOf, keptState, mergeWindow, restack } from './layout.js';

/**
 * `key`: the storage key of the layout (lib.js prefs adds "pref:"); `adopt(raw)`: take a layout another tab kept.
 * Returns { take() → takes a change of another tab that waits, if any; waiting(); stop() }.
 */
export function tabSync(key, adopt) {
  let behind = null;
  const take = () => {
    if (!behind) return;
    const raw = behind;
    behind = null;
    adopt(raw);
  };
  const onStorage = (e) => {
    if (e.key !== `pref:${key}` || e.newValue === null) return;
    let raw;
    try {
      raw = JSON.parse(e.newValue);
    } catch {
      return;
    }
    behind = raw;
    if (document.hidden) take();
  };
  const onShow = () => {
    if (!document.hidden) take();
  };
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onShow);
  window.addEventListener('focus', onShow);
  // A press or a key in this tab: its layout is brought up to date first (the window's capture runs before the desktop's).
  document.addEventListener('pointerdown', take, true);
  window.addEventListener('keydown', take, true);
  return {
    take,
    /** Whether another tab's change waits to be taken. */
    waiting: () => !!behind,
    stop() {
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
      document.removeEventListener('pointerdown', take, true);
      window.removeEventListener('keydown', take, true);
    },
  };
}

/** What this tab changed of window `v` since it last kept or took it: { place, min, hash } (layout.js mergeWindow). */
const ownOf = (v) => mergeWindow({ ...v, hash: liveHash(v) }, v.kept, v).own;

/**
 * Take layout `next` (cleanLayout) that another tab kept into this tab's windows `wins`; returns the id of the window
 * in front. In each window what this tab changed itself stays, the rest follows. In a tab in view (`inView`) the
 * window in use stays where it is and in front, also one the other tab closed or minimised: `typing`, the window
 * that holds this tab's keyboard, else the front window `front` when this tab changed it. `byId(id)`, `drop(v)`,
 * `restore(k)` and `canAdd()` are the window manager's.
 */
export function adoptLayout(wins, next, { inView, typing, front, byId, drop, restore, canAdd }) {
  const used = !inView ? null : typing || (front && Object.values(ownOf(front)).some(Boolean) ? front : null);
  const ids = new Set(next.windows.map((k) => k.id));
  for (const v of [...wins]) if (!ids.has(v.id) && v !== used && !unsavedOf(v)) drop(v);
  for (const k of next.windows) {
    const v = byId(k.id);
    if (!v) {
      if (canAdd()) restore(k);
      continue;
    }
    const m = mergeWindow({ ...v, hash: liveHash(v) }, v.kept, k);
    Object.assign(v, { rect: m.rect, snap: m.snap, min: m.min, z: k.z });
    if (!m.own.place) v.placedIn = null;
    if (!m.own.hash) followHash(v, k.hash);
    v.kept = keptState(k);
  }
  [...wins].sort((a, b) => a.z - b.z).forEach((v, i) => (v.z = i + 1));
  if (used && wins.includes(used)) {
    used.min = false;
    restack(wins, used.id, true);
    return used.id;
  }
  const f = next.focus ? byId(next.focus) : null;
  return f && !f.min ? f.id : (frontOf(wins) || {}).id || null;
}
