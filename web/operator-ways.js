// The places an Operator text names ("Settings → Tia", "the Operator page"), as links. The server sends them beside the
// words in one field, `ways`: a list of codes of the page's one table of places (errorways.js, the table the error
// buttons use), on an item's card note, a rule, the act catalog, a line of Done by Tia and the sentence of what Tia
// does. Each code the table knows becomes a link to its place on the computer the page shows; a code it does not know
// draws nothing. A link only opens the place: nothing there is pressed or turned on.
import { h, wayHref } from './lib.js';
import { wayOf } from './errorways.js';

/**
 * The ways of `ways` that the table knows: [{ label, href }], each place once, in the order given. A place that is the
 * page shown now (`here`, its hash) is left out: "Open Operator" on the Operator page would only load it again.
 */
export function placesOf(ways, here = typeof location !== 'undefined' ? location.hash : '') {
  const page = String(here || '').split('?')[0];
  if (!Array.isArray(ways)) return [];
  const seen = new Set();
  const out = [];
  for (const code of ways) {
    if (typeof code !== 'string') continue;
    const w = wayOf({ code });
    if (!w) continue;
    const href = wayHref({ code }, w);
    if (seen.has(href) || (page && href.split('?')[0] === page)) continue;
    seen.add(href);
    out.push({ label: w.label, href, ...(w.button ? { button: w.button } : {}) });
  }
  return out;
}

/** The links for `ways`, in a small row; null when the table knows none of them. `about`: what they belong to, for a screen reader. */
export function placeLinks(ways, about = '') {
  const places = placesOf(ways);
  if (!places.length) return null;
  return h('span.op-ways', places.map((p) => h('a.btn.small.secondary.op-way', { href: p.href, 'aria-label': about ? `${p.button || `Open ${p.label}`}: ${about}` : null }, p.button || `Open ${p.label}`)));
}
