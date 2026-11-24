// Keeping the visitor in place when the story's steps change height (the moving form starting or ending). How far a
// step has run is ring.mjs's pinProgress.

/**
 * Runs `change` (one that makes the story's steps taller or shorter: the motion starting or ending) and scrolls by
 * what it moved, so the visitor stays where they were: at the same share of the step under the window's middle; with
 * the middle between two steps (or above the first), at the same distance above the next step's top; past the last
 * step, at the same place after the story. Without this the page grew by 4516 px at 1440 px when the motion began
 * and the window showed another step, and jumped back when a slow window went to the still story. Above the story
 * nothing moves (its first step's top stays where it is).
 */
export function keepPlace(story, change, { vh = innerHeight, scrollBy = (y) => window.scrollBy(0, y) } = {}) {
  const mid = vh / 2;
  const steps = [...story.querySelectorAll('.step')];
  const at = steps.find((el) => { const r = el.getBoundingClientRect(); return r.top <= mid && r.bottom > mid; });
  if (at) {
    const before = at.getBoundingClientRect();
    const share = (mid - before.top) / before.height;
    change();
    const r = at.getBoundingClientRect();
    scrollBy(Math.round(r.top + share * r.height - mid));
    return;
  }
  // Seen at 1440 px: the middle in the 88 px gap above step 2, and the window showed step 1 again after the change.
  const next = steps.find((el) => el.getBoundingClientRect().top > mid);
  const edge = () => (next ? next.getBoundingClientRect().top : story.getBoundingClientRect().bottom);
  const before = edge();
  change();
  scrollBy(Math.round(edge() - before));
}

/**
 * Where a keyboard focus on a step's screens takes the page: the start of the step's pin, where its first screen is
 * held (ring 0). Seen 20 Nov 2026: Tab brought step 2's screens into view with its ring at 0.625, in the middle of a
 * change, where neither screen could be read. Returns the scroll place, or null when the step is not pinned (its
 * stage as tall as the step).
 */
export function pinStart(step, { bar, scrollY: y = window.scrollY } = {}) {
  const r = step.getBoundingClientRect();
  const stage = step.querySelector('.step-stage');
  if (!stage || r.height <= stage.offsetHeight) return null;
  return Math.round(r.top + y - bar);
}

/**
 * The focus handler for the steps' screens (each floor has tabIndex 0): a keyboard focus takes the page to the start of
 * the step's pin (pinStart), where its first screen is held. A mouse click or a tap focuses the floor too, and leaves
 * the page where it is: seen 21 Nov 2026 at 1440x900 and 390x844, one click on step 3's screens while it held its last
 * one threw the page 2060 px back to its first. `steps` are { floor, li }; `on()` says whether the motion runs.
 */
export function focusHandler({ steps, on, bar, scrollY = () => window.scrollY, scrollTo = (top) => window.scrollTo({ top, behavior: 'instant' }) }) {
  return (e) => {
    const floor = e.currentTarget;
    if (!floor.matches(':focus-visible')) return;
    const s = steps.find((x) => x.floor === floor);
    const y = s && on() ? pinStart(s.li, { bar, scrollY: scrollY() }) : null;
    if (y !== null && Math.abs(y - scrollY()) > 1) scrollTo(y);
  };
}

/**
 * Scrolls a still strip of screens (a phone's floor, which scrolls sideways) so that the screen `name` stands in its
 * middle: when the moving form ends (a slow window, reduced motion asked for), the still strip opens on the screen the
 * visitor was looking at. Seen 22 Nov 2026 at 390x844: a fall back in the middle of step 2, on Workspace, opened the
 * strip on its first screen, Home. A floor that does not scroll sideways (from 700 px) is left as it is.
 */
export function showPane(floor, name) {
  if (!floor || !name || floor.scrollWidth <= floor.clientWidth) return;
  const pane = [...floor.querySelectorAll('[data-pane]')].find((p) => p.dataset.pane === name);
  if (!pane) return;
  const f = floor.getBoundingClientRect();
  const r = pane.getBoundingClientRect();
  const left = floor.scrollLeft + r.left - f.left - (f.width - r.width) / 2;
  floor.scrollLeft = Math.max(0, Math.min(floor.scrollWidth - floor.clientWidth, Math.round(left)));
}
