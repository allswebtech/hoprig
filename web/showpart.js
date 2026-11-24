// A page opened at one of its parts ("#/settings/new-sessions?show=bypass"): a sentence that says "turn this on in
// Settings" leads to the switch itself, not to the top of a long page. The part is brought into the middle of the
// window and the focus goes to its first control, so a keyboard or a screen reader lands there too. Nothing is
// pressed: he changes the switch himself.

/** The part a page's query names (`show`), or null: only a plain id, so no address can name anything else. */
export function partOf(query) {
  const v = query && typeof query.get === 'function' ? query.get('show') : null;
  return typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : null;
}

/**
 * Open every closed fold (<details>) around `el`, the outermost too: a part inside a closed "Advanced" is not drawn,
 * so it can neither be scrolled to nor focused. Opening a fold only shows what is inside it; nothing is turned on.
 */
export function openFoldsAround(el) {
  const up = (x) => (x && typeof x.closest === 'function' ? x.closest('details') : null);
  for (let d = up(el); d; d = up(d.parentElement)) if (!d.open) d.open = true;
}

/**
 * Show the element `#id` once it is drawn (a panel may be filled after its own request): looked for every `every` ms,
 * up to `tries` times, while `alive()` holds. `find` is the lookup (document.getElementById in the page). → a promise
 * of the element, or null when it never came.
 */
export async function showPart(id, { find = (x) => document.getElementById(x), alive = () => true, tries = 30, every = 150 } = {}) {
  for (let i = 0; i < tries && alive(); i++) {
    const el = find(id);
    if (el) {
      openFoldsAround(el);
      const control = typeof el.querySelector === 'function' ? el.querySelector('input, select, textarea, button, [role="switch"]') : null;
      try {
        (control || el).focus({ preventScroll: true });
      } catch {
        /* not focusable here */
      }
      el.scrollIntoView({ block: 'center' });
      return el;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}
