// The Providers list as data: which group a provider is in, the words of the summary line, the two limit bars of a row
// and the one button of a row. No page elements here, so the rules can be tested alone (web/accounts.js draws them).
import { ago, limitWindow, profileState, until } from './lib.js';

export const GROUPS = [
  { key: 'signin', title: 'Needs a sign-in' },
  { key: 'work', title: 'Can work now' },
  { key: 'limit', title: 'At a limit', note: 'soonest back first' },
  { key: 'cannot', title: 'Cannot be used' },
];

/** The group of one provider: signin, work, limit or cannot. */
export function groupOf(a) {
  const k = profileState(a).key;
  return k === 'signin' ? 'signin' : k === 'limit' ? 'limit' : k === 'unusable' ? 'cannot' : 'work';
}

/** The non-empty groups in their order, each with its providers: work in Auto mode's order, limit soonest back first. */
export function groupRows(accounts) {
  const by = { signin: [], work: [], limit: [], cannot: [] };
  for (const a of accounts) by[groupOf(a)].push(a);
  by.limit.sort((x, y) => (x.limited.until || Infinity) - (y.limited.until || Infinity));
  return GROUPS.map((g) => ({ ...g, rows: by[g.key] })).filter((g) => g.rows.length);
}

/** "3 can work · 3 at a limit · 1 to sign in": a group with none is left out; '' for no providers. */
export function summaryLine(groups) {
  const n = (k) => (groups.find((g) => g.key === k) || { rows: [] }).rows.length;
  return [n('work') ? `${n('work')} can work` : '', n('limit') ? `${n('limit')} at a limit` : '', n('signin') ? `${n('signin')} to sign in` : ''].filter(Boolean).join(' · ');
}

/** The time of the newest figure of any provider, or null. */
export const newestFigure = (accounts) => accounts.reduce((m, a) => (a.usage && Number.isFinite(a.usage.at) && a.usage.at > (m || 0) ? a.usage.at : m), null);

/** "Limits read 12 min ago" (this computer, after a Refresh or from the newest figure), or the plain fallback. */
export function readLine(here, readAt, accounts) {
  const at = readAt || newestFigure(accounts);
  if (!at) return here ? 'Refresh asks each subscription one small question and uses a very small part of its limit' : '';
  return `${here ? 'Limits read' : 'Limits as of'} ${ago(at)}`;
}

/** The time of a Refresh that gave figures; null when no account did (every run timed out, for example). */
export function figuresAt(r) {
  return r && Array.isArray(r.results) && r.results.some((x) => x && x.read === 'figures') ? r.at || Date.now() : null;
}

/** The result of the account `name` in the answer of a read, or null (a shared answer may be for another account). */
export function resultOf(r, name) {
  return (r && Array.isArray(r.results) && r.results.find((x) => x && x.name === name)) || null;
}

/** The two bars of a row: [{ key, label, pct, back }] for the windows that are known; `back` from 80%. */
export function barsOf(a) {
  const u = a.usage;
  if (!u) return [];
  const bar = (key, label, w) => (w && Number.isFinite(w.pct)
    ? { key, label, pct: Math.round(w.pct), back: w.pct >= 80 && w.resetsAt ? `back ${until(w.resetsAt)}` : '' }
    : null);
  return [bar('fiveHour', '5-hour', u.fiveHour), bar('week', 'Week', u.week)].filter(Boolean);
}

/** The one button of a row, by its state: { kind, label } or null. `here`: this computer's own page. */
export function rowButton(a, here, storedLogin) {
  if (!here) return null;
  const k = profileState(a).key;
  if (k === 'signin') {
    if (a.hub) return { kind: 'signin', label: 'Sign in here' };
    return { kind: 'signin', label: a.signinRefused || (a.limited && a.limited.reason === 'auth') ? 'Sign in again' : 'Sign in' };
  }
  if (k === 'limit' && storedLogin) return { kind: 'another', label: 'Sign in with another account' };
  return null;
}

/** Which window a limit is, for the words: kept here so the page and the tests read one source. */
export { limitWindow };

/**
 * Is this provider asked by Refresh (providers/readlimits.mjs)? A Claude sign-in of this computer that is signed in (a refused
 * one is asked again) and not billed by use. Signed-out and billed ones are not asked, so they are not counted or shown as reading.
 */
export const askedByRefresh = (a) => (a.kind === 'login' || a.kind === 'subscription') && !a.hub && !a.signedOut && !a.paid && (a.signedIn !== false || Boolean(a.signinRefused));
