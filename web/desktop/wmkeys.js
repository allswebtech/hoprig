// The desktop's keys for its windows (wm.js): the modifier set chosen in Settings (keymap.js) with an arrow, M, W or
// ` (the key above Tab). They work with the keyboard on the desktop, in a native app, and in a window's page (lib.js
// sends them here). The cycle key goes through the windows in the order last used, as Alt+Tab does: held, each press
// goes one further; when the keys are let go (or a moment passes) only the window chosen comes to the front, and a
// minimised one passed over stays minimised.
import { prefs } from '../lib.js';
import { DESK_KEYS, deskKeyOf, inTextField, keySet, modifierUp } from './keymap.js';
import { cycleOrder, keySnap } from './layout.js';

/** How long after the last press of the cycle key the cycle ends by itself (a key up that never arrived). */
export const CYCLE_MS = 1200;
export const chosenKeys = () => keySet(prefs.get('desktop.keys', 'alt-shift'));

/**
 * `w`: what the keys may ask of the window manager: { wins, byId, front() → id, raise(id), minimise(id, opts),
 * close(id), setSnap(id, snap), relayer() (layers changed: draw and keep) }. Returns { act(name, id), release(), stop() }.
 */
export function windowKeys(w) {
  let cycle = null; // { order: ids front first, i, mins: ids minimised at the start, timer }

  function release() {
    if (!cycle) return;
    const c = cycle;
    cycle = null;
    clearTimeout(c.timer);
    const chosen = c.order[c.i];
    for (const id of c.order) {
      const v = w.byId(id);
      if (v && id !== chosen && c.mins.has(id)) v.min = true;
    }
    // The chosen window on top, the others in the order they had before the cycle.
    const rank = [chosen, ...c.order.filter((id) => id !== chosen)];
    w.wins.forEach((v) => (v.z = rank.includes(v.id) ? rank.length - rank.indexOf(v.id) : 0));
    [...w.wins].sort((a, b) => a.z - b.z).forEach((v, i) => (v.z = i + 1)); // a copy: the bar keeps the order opened
    w.relayer();
  }

  function step() {
    if (!cycle) {
      const order = cycleOrder(w.wins.filter((v) => !v.min)).concat(cycleOrder(w.wins.filter((v) => v.min)));
      if (order.length < 2 && !(order.length === 1 && w.byId(order[0]).min)) return order.length === 1;
      cycle = { order, i: 0, mins: new Set(w.wins.filter((v) => v.min).map((v) => v.id)) };
      if (w.byId(order[0]).min) cycle.i = -1; // all minimised: the first press brings back the last used
    }
    clearTimeout(cycle.timer);
    cycle.i = (cycle.i + 1) % cycle.order.length;
    w.raise(cycle.order[cycle.i]);
    cycle.timer = setTimeout(release, CYCLE_MS);
    return true;
  }

  /** Do act `name` ('left', 'cycle', 'min'…) on window `id` (the one in front): true when something was done. */
  function act(name, id = w.front()) {
    if (name === 'cycle') return step();
    const v = id ? w.byId(id) : null;
    if (!v) return false;
    if (name === 'close') w.close(id);
    else if (name === 'min') w.minimise(id, { byKey: true });
    else {
      const k = DESK_KEYS.find((x) => x.act === name);
      const next = k ? keySnap(v.snap, k.code) : null;
      if (!next) return false;
      if (next.min) w.minimise(id, { byKey: true });
      else w.setSnap(id, next.snap);
    }
    return true;
  }

  // Before the page under the keyboard (a native app, a text box) sees the key: the arrows stay in a text box.
  const onKey = (e) => {
    const name = deskKeyOf(e, chosenKeys(), { inText: inTextField(document.activeElement) });
    if (!name || !act(name)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onUp = (e) => {
    if (cycle && modifierUp(e, chosenKeys())) release();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onUp, true);
  return {
    act,
    release,
    stop() {
      if (cycle) clearTimeout(cycle.timer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onUp, true);
    },
  };
}
