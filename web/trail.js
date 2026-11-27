// The way back: the page you came from. A page that another page sent you to (Setup → the session its Fix opened,
// a session → Providers) links back to that page, not only to its own parent, so nobody has to find it again through
// the menu. One trail per browser tab (sessionStorage), at most eight places. Coming back to a place on the trail
// (its link, the browser's Back, the session switcher) takes off what came after it; a press in the navigation and
// Home start a new trail. A page of another computer is a place of its own.

import { BARE, WINDOW, link, samePlace as sameAddress } from './lib.js';

const KEY = 'trail';
const MAX = 8;
// Pages that only start something: the session or chat they open goes back to where you were before them.
const STARTERS = new Set(['new', 'new-project', 'get-project']);
// Pages where each address is a place of its own (one session, one chat), not a part of one page.
const EACH = new Set(['session', 'chat']);

let trail = { stack: [], here: null };
let fresh = false;
// The next place takes the place of the one shown (handOver): the chat and the terminal of one conversation are one
// place, so a way back never leads from one to the other.
let instead = false;

// Only addresses of this page are ever links (never "javascript:"), whatever the storage holds.
const isHash = (v) => typeof v === 'string' && v.startsWith('#/') && v.length < 600;
const clean = (p) => (p && isHash(p.hash) && typeof p.page === 'string'
  ? { hash: p.hash, page: p.page, entry: isHash(p.entry) ? p.entry : p.hash, label: typeof p.label === 'string' ? p.label.slice(0, 60) : null }
  : null);

// A window of the desktop keeps its trail in memory only: every window shares the tab's sessionStorage, and several
// windows would overwrite each other's trail (and the desktop's own).
function load() {
  if (BARE) return;
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (v && Array.isArray(v.stack)) trail = { stack: v.stack.map(clean).filter(Boolean).slice(-MAX), here: clean(v.here) };
  } catch {
    /* no storage (a private window, a test): the trail lives in memory */
  }
}

function save() {
  if (BARE) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(trail));
  } catch {
    /* as above */
  }
}

/** The page an address shows and the computer it is for (null: this one). */
function parse(hash) {
  let path = String(hash || '').replace(/^#/, '') || '/';
  let computer = null;
  const m = /^\/m\/([a-z0-9][a-z0-9_-]{0,31})(\/.*)?$/.exec(path);
  if (m) {
    computer = m[1];
    path = m[2] || '/';
  }
  if (path.startsWith('/s/')) return { page: 'session', computer };
  const p = /^\/([a-z][a-z0-9-]*)/.exec(path);
  return { page: p ? p[1] : 'home', computer };
}

/** The page an address shows: "session" for #/s/<name>, "home" for #/, else its first part (after any #/m/<computer>). */
export const placeOf = (hash) => parse(hash).page;

// The same page of the same computer (Setup of one computer is not Setup of another).
const samePage = (p, page, hash) => p.page === page && parse(p.hash).computer === parse(hash).computer;
// The same place: the same page, and for a session or a chat the same one.
const samePlace = (p, page, hash) => samePage(p, page, hash) && (!EACH.has(page) || p.hash === hash);

/**
 * The router draws `hash` (after its redirects); `from` is the address just left (a page's tabs change it in place,
 * without telling the router; the router leaves out an old address it only sent on).
 */
export function arrive(hash, from = null) {
  const page = placeOf(hash);
  let here = trail.here;
  if (here && from && !EACH.has(here.page) && samePage(here, placeOf(from), from)) here.hash = from;
  if (instead) {
    // A hand-over: the place shown goes, what came before it stays the way back.
    instead = false;
    here = null;
  }
  if (fresh || page === 'home') {
    // A press in the navigation, or Home (where every trail starts): the new trail starts at this page.
    fresh = false;
    trail.stack = [];
    if (!(here && page === 'home' && here.page === 'home')) here = null;
  } else {
    const back = trail.stack.findLastIndex((p) => samePlace(p, page, hash));
    if (back >= 0) trail.stack = trail.stack.slice(0, back); // back at a place on the way: what came after it goes
    else if (here && here.label && !samePage(here, page, hash) && !(STARTERS.has(here.page) && EACH.has(page))) trail.stack = [...trail.stack, here].slice(-MAX);
  }
  // Another part of the same page (a tab, an item of its list, another session) keeps where the page was entered.
  trail.here = here && samePage(here, page, hash) ? { ...here, hash } : { hash, page, entry: hash, label: null };
  save();
}

/** What the place being shown is called in a link back to it ("Setup · laptop", a session's name). */
export function named(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!trail.here || !text) return;
  trail.here.label = text.slice(0, 60);
  save();
}

/** The place being shown has ended (a session ended, a chat closed or gone): no way back may lead to it. */
export function forgetHere() {
  if (!trail.here) return;
  trail.here.label = null;
  save();
}

/** The page that sent you to the one being shown, { hash, label }, or null. Never the place itself. */
export function cameFrom() {
  const top = trail.stack.at(-1);
  const here = trail.here;
  if (!top || !top.label || (here && samePlace(top, here.page, here.hash))) return null;
  return { hash: top.hash, label: top.label };
}

/** You moved on inside the page being shown, and its own way back (`parent`) is a part of it: that one fits now. */
export function movedOn(parent) {
  const here = trail.here;
  return Boolean(parent && here && samePage(here, placeOf(parent), parent) && here.hash !== here.entry);
}

/**
 * In a window of the desktop (lib.js WINDOW) the way back stays inside the window's app: { hash, label } of the page
 * the app starts at while the window shows another page, null on that page (no way back: a Terminal window never
 * turns into another page), undefined outside a window.
 */
export function windowWay() {
  if (!BARE || !WINDOW || !WINDOW.home) return undefined;
  return sameAddress(location.hash, WINDOW.home) ? null : { hash: WINDOW.home, label: WINDOW.label || 'Back' };
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

/**
 * A conversation moves between the App and a terminal (Open in Terminal, Open in the App): `hash` (of computer `m`)
 * takes the place of the page shown, in the browser's history as on the trail, so Back from either goes where he was
 * before he opened the conversation.
 */
export function handOver(hash, m = undefined) {
  instead = true;
  location.replace(m === undefined ? link(hash) : link(hash, m));
}

/** Tests: start with an empty trail. */
export function resetTrail() {
  trail = { stack: [], here: null };
  fresh = false;
  instead = false;
}

if (typeof window !== 'undefined') load();
