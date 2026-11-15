// The way back: the page you came from. A page that another page sent you to (Setup → the session its Fix opened,
// a session → Providers) links back to that page, not only to its own parent, so nobody has to find it again through
// the menu. One trail per browser tab (sessionStorage), at most eight places. Coming back to a place on the trail
// (its link, or the browser's Back) takes off what came after it; a press in the navigation starts a new trail.

const KEY = 'trail';
const MAX = 8;
// Pages that only start something: the session they open goes back to where you were before them.
const STARTERS = new Set(['new', 'new-project', 'get-project']);

let trail = { stack: [], here: null };
let fresh = false;

// Only addresses of this page are ever links (never "javascript:"), whatever the storage holds.
const isHash = (v) => typeof v === 'string' && v.startsWith('#/') && v.length < 600;
const clean = (p) => (p && isHash(p.hash) && typeof p.page === 'string'
  ? { hash: p.hash, page: p.page, entry: isHash(p.entry) ? p.entry : p.hash, label: typeof p.label === 'string' ? p.label.slice(0, 60) : null }
  : null);

function load() {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (v && Array.isArray(v.stack)) trail = { stack: v.stack.map(clean).filter(Boolean).slice(-MAX), here: clean(v.here) };
  } catch {
    /* no storage (a private window, a test): the trail lives in memory */
  }
}

function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(trail));
  } catch {
    /* as above */
  }
}

/** The page an address shows: "session" for #/s/<name>, "home" for #/, else its first part (after any #/m/<computer>). */
export function placeOf(hash) {
  let path = String(hash || '').replace(/^#/, '') || '/';
  const m = /^\/m\/[a-z0-9][a-z0-9_-]{0,31}(\/.*)?$/.exec(path);
  if (m) path = m[1] || '/';
  if (path.startsWith('/s/')) return 'session';
  const p = /^\/([a-z][a-z0-9-]*)/.exec(path);
  return p ? p[1] : 'home';
}

// The same place: the same page, and for a session the same session.
const samePlace = (p, page, hash) => p.page === page && (page !== 'session' || p.hash === hash);

/**
 * The router draws `hash` (after its redirects); `from` is the address just left (a page's tabs change it in place,
 * without telling the router).
 */
export function arrive(hash, from = null) {
  const page = placeOf(hash);
  let here = trail.here;
  if (here && from && placeOf(from) === here.page) here.hash = from;
  if (fresh) {
    fresh = false;
    trail.stack = [];
    here = null; // the new trail starts at this page
  } else if (here && here.page !== page) {
    const back = trail.stack.findLastIndex((p) => samePlace(p, page, hash));
    if (back >= 0) trail.stack = trail.stack.slice(0, back); // back at a place on the way: what came after it goes
    else if (here.label && !(STARTERS.has(here.page) && page === 'session')) trail.stack = [...trail.stack, here].slice(-MAX);
  }
  // Another part of the same page (a tab, an item of its list, another session) keeps where the page was entered.
  trail.here = here && here.page === page ? { ...here, hash } : { hash, page, entry: hash, label: null };
  save();
}

/** What the place being shown is called in a link back to it ("Setup · laptop", a session's name). */
export function named(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!trail.here || !text) return;
  trail.here.label = text.slice(0, 60);
  save();
}

/** The page that sent you to the one being shown, { hash, label }, or null. */
export function cameFrom() {
  const top = trail.stack.at(-1);
  return top && top.label ? { hash: top.hash, label: top.label } : null;
}

/** You moved on inside the page being shown, and its own way back (`parent`) is a part of it: that one fits now. */
export function movedOn(parent) {
  const here = trail.here;
  return Boolean(parent && here && placeOf(parent) === here.page && here.hash !== here.entry);
}

/**
 * The link back for the page being shown, { hash, label }, or null for its own (`parent`). The page that sent you
 * here wins, except where you have moved on inside a page whose parent is part of it (Workspace → a project goes
 * back to Workspace).
 */
export function wayBack(parent = null) {
  return movedOn(parent) ? null : cameFrom();
}

/**
 * A press in the navigation: the page it opens starts a new trail. Not a press that opens a new tab or window, nor
 * one on the page already shown (no page opens, so nothing would end the new trail but the next link).
 */
export function startOver(e) {
  if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button)) return;
  const to = e && e.currentTarget && typeof e.currentTarget.getAttribute === 'function' ? e.currentTarget.getAttribute('href') : null;
  if (to && typeof location !== 'undefined' && to === (location.hash || '#/')) return;
  fresh = true;
}

/** Tests: start with an empty trail. */
export function resetTrail() {
  trail = { stack: [], here: null };
  fresh = false;
}

if (typeof window !== 'undefined') load();
