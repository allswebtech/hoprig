// Where a feature adds itself to the page: a page of its own in the navigation, a page in Settings, and small
// pieces of the session screens. A feature is one file that calls these at load, plus one import line in app.js.

const pages = [];
const settingsPages = [];

// Hashes the router keeps for itself; a page id may not take one.
const RESERVED = ['s', 'm', 'new', 'more', 'pc'];

/**
 * A page: `#/<id>` and `#/<id>/<sub>` (and `#/m/<computer>/<id>…` for another computer).
 *   group     'main' (Home · Workspace · Providers · Computers), 'more' (the second group) or null (reached from
 *             another page only; `navAs` names the navigation item it lights up)
 *   order     its place in the group
 *   render(ctx)  draws the page with ctx.frame (shell.js) and returns its cleanup function. ctx: { frame,
 *             connectionBanner, sub } where `sub` is the part after "#/<id>/" ('' for none).
 *   perComputer  the page belongs to one computer: with several, the computer switcher shows on it, and the
 *             navigation keeps the open computer when it leads there
 *   visible() (optional) false hides it from the navigation (routing still knows it); badge() a number shown
 *             next to it (0 = none). When either answer changes, the feature calls navChanged().
 */
export function registerPage({ id, title, icon, group = null, order = 100, navAs = null, perComputer = false, render, visible = () => true, badge = () => 0 }) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id) || RESERVED.includes(id) || pages.some((p) => p.id === id)) throw new Error(`bad page id "${id}"`);
  if (![null, 'main', 'more'].includes(group)) throw new Error(`bad group "${group}"`);
  pages.push({ id, title, icon, group, order, navAs, perComputer, render, visible, badge });
}

/** Ask the page to draw the navigation again (a page's visible() or badge() answer changed). */
export function navChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nav-changed'));
}

/**
 * A page in Settings: `#/settings/<id>`, one row in the Settings list.
 *   summary(ctx)   the one line under its title: the current state ("On · phone and desktop"); may return a Promise
 *   render(ctx)    the page's content (an array of nodes; panel() and fold() from shell.js are the usual parts)
 *   onlyHere       shown on this dashboard's own settings only, not on another computer's
 *   tag            a small word next to the title, e.g. "experimental"
 *   when(ctx)      optional: show this page only when it returns true (e.g. a feature not offered yet); absent = always
 * ctx: { settings (GET /api/settings), state (GET /api/state), here, isAlive }
 */
export function registerSettingsPage({ id, title, icon, desc, order = 100, onlyHere = false, tag = null, when = null, summary = () => '', render }) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id) || settingsPages.some((p) => p.id === id)) throw new Error(`bad settings page id "${id}"`);
  settingsPages.push({ id, title, icon, desc, order, onlyHere, tag, when, summary, render });
}

const safe = (fn, dflt) => {
  try {
    return fn();
  } catch {
    return dflt;
  }
};
/** The pages of a navigation group to show now (visible() true), in order, with their badge numbers. */
export const navPages = (group) =>
  pages.filter((p) => p.group === group && safe(p.visible, true) !== false).sort((a, b) => a.order - b.order).map((p) => ({ ...p, count: Number(safe(p.badge, 0)) || 0 }));
/** Every registered page, shown or not. */
export const allPages = () => [...pages];
export const pageById = (id) => pages.find((p) => p.id === id) || null;
// The order of the Settings list, kept in one place: what a person looks for first on top, the pages that apply only
// sometimes (Runs as root, Hands-off) next to what they belong with. A page not named here keeps its own `order`.
export const SETTINGS_ORDER = Object.freeze({
  'new-sessions': 10, root: 12, notifications: 20, appearance: 30, security: 40, 'public-link': 45, handsoff: 47, workspace: 50,
  automations: 55, tia: 60, updates: 70, addons: 80,
});
export const registeredSettingsPages = () => settingsPages.map((p) => (Object.hasOwn(SETTINGS_ORDER, p.id) ? { ...p, order: SETTINGS_ORDER[p.id] } : p)).sort((a, b) => a.order - b.order);

// Small pieces a feature adds to the session screens.
const sessionActions = [];
const cardBadges = [];

/**
 * One more row in a session's "more" sheet, looking like the others: { id, label, sub, icon, describe, run }.
 * `describe(session)` (optional, may be async) returns { label?, sub? } with the current state (e.g. "2 queued"), or
 * null to leave the row out (a computer without the feature); the sheet waits for it a moment, then uses label and
 * sub. `run(session)` is called when the row is pressed. `session` is { name, machine }.
 */
export function registerSessionAction({ id, label, sub = '', icon = 'more', describe = null, run }) {
  sessionActions.push({ id, label, sub, icon, describe, run });
}

/** A small badge on a session card on Home: `badge(session)` returns a node or null (synchronous). */
export function registerCardBadge(badge) {
  cardBadges.push(badge);
}

export const registeredSessionActions = () => [...sessionActions];

// Small round buttons in every page head, left of the light/dark button.
const headTools = [];
/**
 * `make()` returns a 34px button (`.icon-btn`) or null; it is called each time a page head is drawn. The feature
 * keeps the node it returned to update it later (a count, hidden when the feature is off).
 */
export function registerHeadTool(make) {
  headTools.push(make);
}
export const registeredHeadTools = () => [...headTools];
export const registeredCardBadges = () => [...cardBadges];
