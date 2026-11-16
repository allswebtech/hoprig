// Tab stays inside an open sheet (lib.js's dialog): from its last control round to its first, Shift+Tab the other
// way. A modal dialog alone lets the focus step out to the page's body once a round.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab goes from `active` among a sheet's controls `items` (in order): from the last round to the first, with
 * `back` (Shift+Tab) from the first (or from the sheet itself) round to the last; null: the browser's own step.
 */
export function wrapTab(items, active, back) {
  if (!items.length) return null;
  const i = items.indexOf(active);
  if (back) return i <= 0 ? items[items.length - 1] : null;
  return i === items.length - 1 ? items[0] : null;
}

/** Keep Tab inside `dialog` (its controls that can be seen and reached by Tab). */
export function keepTabIn(dialog) {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const to = wrapTab([...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.tabIndex >= 0 && x.getClientRects().length), document.activeElement, e.shiftKey);
    if (to) {
      e.preventDefault();
      to.focus();
    }
  });
}
