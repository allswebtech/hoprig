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

/**
 * Whether Tab can reach `x`: in the Tab order, shown, and not inside a closed <details> other than as its summary
 * (Chrome keeps boxes for a closed details' content, so a select under a closed "Options" looked reachable, was taken
 * for the last control, and Tab from the summary fell out of the sheet).
 */
export function reachable(x) {
  if (!(x.tabIndex >= 0) || !x.getClientRects().length) return false;
  const shut = typeof x.closest === 'function' ? x.closest('details:not([open])') : null;
  if (!shut) return true;
  const outer = shut.parentElement && typeof shut.parentElement.closest === 'function' ? shut.parentElement.closest('details:not([open])') : null;
  return x.tagName === 'SUMMARY' && x.parentElement === shut && !outer;
}

/**
 * Keep Tab inside `dialog` (its controls that can be seen and reached by Tab); `when()`: only while it says so (a
 * panel that is a sheet on a phone and floats beside the page on a desktop).
 */
export function keepTabIn(dialog, { when = () => true } = {}) {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented || !when()) return;
    const to = wrapTab([...dialog.querySelectorAll(FOCUSABLE)].filter(reachable), document.activeElement, e.shiftKey);
    if (to) {
      e.preventDefault();
      to.focus();
    }
  });
}
