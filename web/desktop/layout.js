// The window maths of the desktop, with no DOM: where a window may be, the snap places (halves, quarters, the
// whole area), a resize from an edge or a corner, where a new window opens, the window keys, and the layout as it
// is kept in the browser (checked when it is read back, since anything can be in storage). wm.js draws with it.
//
// A rect is { x, y, w, h } in pixels of the desktop's work area (the part the bars leave free), whose size is
// { w, h }. A window's `snap` is null (where it was put), 'max', or one of the halves and quarters below.

export const MIN_W = 320;
export const MIN_H = 200;
/** How much of a title bar always stays on the screen, so a window can always be taken back. */
export const GRAB = 48;
export const TITLE_H = 36;
/** The most windows open at once; past it a toast says so (each window is a page of its own). */
export const MAX_WINDOWS = 12;
export const SNAPS = ['max', 'l', 'r', 'tl', 'tr', 'bl', 'br'];

const int = (n) => Math.round(Number(n) || 0);

/** A rect kept inside the area: at least the minimum size, at most the area, the title bar reachable. */
export function clampRect(r, area) {
  const w = Math.min(Math.max(int(r.w), MIN_W), Math.max(area.w, MIN_W));
  const h = Math.min(Math.max(int(r.h), MIN_H), Math.max(area.h, MIN_H));
  const x = Math.min(Math.max(int(r.x), GRAB - w), area.w - GRAB);
  const y = Math.min(Math.max(int(r.y), 0), Math.max(area.h - TITLE_H, 0));
  return { x, y, w, h };
}

/** The rect of a snap place in the area. */
export function snapRect(snap, area) {
  const hw = Math.round(area.w / 2);
  const hh = Math.round(area.h / 2);
  switch (snap) {
    case 'max': return { x: 0, y: 0, w: area.w, h: area.h };
    case 'l': return { x: 0, y: 0, w: hw, h: area.h };
    case 'r': return { x: hw, y: 0, w: area.w - hw, h: area.h };
    case 'tl': return { x: 0, y: 0, w: hw, h: hh };
    case 'tr': return { x: hw, y: 0, w: area.w - hw, h: hh };
    case 'bl': return { x: 0, y: hh, w: hw, h: area.h - hh };
    case 'br': return { x: hw, y: hh, w: area.w - hw, h: area.h - hh };
    default: return null;
  }
}

/**
 * Where a window dragged with the pointer at (px, py) in the area would snap: the top edge maximises, a side
 * edge takes that half, a corner (near a side and near the top or bottom) a quarter; null anywhere else.
 */
export function snapZone(px, py, area, { edge = 8, corner = 64 } = {}) {
  const left = px <= edge;
  const right = px >= area.w - edge;
  if (left || right) {
    const side = left ? 'l' : 'r';
    if (py <= corner) return `t${side}`;
    if (py >= area.h - corner) return `b${side}`;
    return side;
  }
  if (py <= edge) return 'max';
  return null;
}

/** The rect after dragging edge or corner `dir` ('n', 'se', 'w'…) by (dx, dy) from `start`. */
export function resizeRect(start, dir, dx, dy, area) {
  let { x, y, w, h } = start;
  if (dir.includes('e')) w = Math.min(Math.max(start.w + dx, MIN_W), area.w - x);
  if (dir.includes('s')) h = Math.min(Math.max(start.h + dy, MIN_H), area.h - y);
  if (dir.includes('w')) {
    const nx = Math.min(Math.max(start.x + dx, 0), start.x + start.w - MIN_W);
    w = start.w + (start.x - nx);
    x = nx;
  }
  if (dir.includes('n')) {
    const ny = Math.min(Math.max(start.y + dy, 0), start.y + start.h - MIN_H);
    h = start.h + (start.y - ny);
    y = ny;
  }
  return { x: int(x), y: int(y), w: int(w), h: int(h) };
}

/**
 * Where a new window opens: a size that suits the area, a little down and right of the last one opened so no two
 * sit exactly on top of each other, back to the top left when it would leave the area.
 */
export function placeNew(windows, area, size = {}) {
  const w = Math.min(size.w || Math.round(area.w * 0.62), area.w);
  const h = Math.min(size.h || Math.round(area.h * 0.72), area.h);
  const step = 28;
  let x = Math.round((area.w - w) / 4);
  let y = Math.round((area.h - h) / 6);
  const taken = new Set(windows.filter((v) => !v.min).map((v) => `${v.rect.x},${v.rect.y}`));
  for (let i = 0; i < 12 && taken.has(`${x},${y}`); i++) {
    x += step;
    y += step;
    if (x + w > area.w || y + h > area.h) {
      x = step * (i % 3);
      y = step * (i % 3);
    }
  }
  return clampRect({ x, y, w, h }, area);
}

/**
 * The window keys (Alt+Shift with an arrow): what a window becomes. Left and right take a half; up from a half
 * takes its top quarter, else maximises; down from a half takes its bottom quarter, from a quarter or the whole
 * area goes back to where it was, and from there minimises.
 */
export function keySnap(snap, key) {
  const side = snap && /^[tb]?[lr]$/.test(snap) ? snap.slice(-1) : null;
  switch (key) {
    case 'ArrowLeft': return { snap: 'l' };
    case 'ArrowRight': return { snap: 'r' };
    case 'ArrowUp': return { snap: side && snap.length === 1 ? `t${side}` : 'max' };
    case 'ArrowDown':
      if (side && snap.length === 1) return { snap: `b${side}` };
      if (snap) return { snap: null };
      return { min: true };
    default: return null;
  }
}

// ---------- the layout kept in the browser ----------

const HASH = /^#\/[^\s<>"']{0,500}$/;
const ID = /^w[0-9a-z]{1,12}$/;

/**
 * The layout read back from storage, kept only where it is sound: known apps, addresses of this page only (never
 * "javascript:"), numbers for the rects, a known snap. `apps` is the set of app ids the catalog has.
 */
export function cleanLayout(raw, apps) {
  const out = { windows: [], focus: null };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.windows)) return out;
  const seen = new Set();
  for (const v of raw.windows.slice(0, MAX_WINDOWS)) {
    if (!v || typeof v !== 'object' || !apps.has(v.app) || !ID.test(v.id) || seen.has(v.id)) continue;
    if (typeof v.hash !== 'string' || !HASH.test(v.hash)) continue;
    const r = v.rect || {};
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
    seen.add(v.id);
    out.windows.push({
      id: v.id,
      app: v.app,
      hash: v.hash,
      title: typeof v.title === 'string' ? v.title.slice(0, 80) : '',
      rect: { x: int(r.x), y: int(r.y), w: int(r.w), h: int(r.h) },
      snap: SNAPS.includes(v.snap) ? v.snap : null,
      min: v.min === true,
      z: Number.isFinite(v.z) ? int(v.z) : 0,
    });
  }
  out.windows.sort((a, b) => a.z - b.z).forEach((v, i) => (v.z = i + 1));
  out.focus = typeof raw.focus === 'string' && seen.has(raw.focus) ? raw.focus : null;
  return out;
}

/** What is kept of a layout: the windows without anything drawn. */
export const keepLayout = (windows, focus) => ({
  windows: windows.map(({ id, app, hash, title, rect, snap, min, z }) => ({ id, app, hash, title, rect, snap, min, z })),
  focus,
});

/** The storage key of a computer's layout: one desktop per computer ("~" is this one). */
export const layoutKey = (machineName) => `desktop.${machineName || '~'}`;

/** `n` windows side by side in a grid that fills an area of `size`: their rects. */
export function gridRects(n, size) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = Math.floor(size.w / cols);
  const hh = Math.floor(size.h / rows);
  return Array.from({ length: n }, (_, i) => clampRect({ x: (i % cols) * w, y: Math.floor(i / cols) * hh, w, h: hh }, size));
}
