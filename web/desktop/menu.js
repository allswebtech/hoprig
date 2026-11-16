// The desktop's right-click menu, and the long press that opens the same menu on a touch screen. One menu at a
// time; it closes on Escape, on a press outside it, when a choice is made and when the window loses focus. The
// arrow keys move between its items.
import { icon } from '../icons.js';
import { add, h } from '../lib.js';

let open = null;
let openedAt = 0;

/** Close the menu; `back`: the keyboard returns to what had it when the menu opened (Escape, not a choice). */
export function closeMenu(back = false) {
  if (!open) return;
  const m = open;
  open = null;
  m.cleanup();
  m.el.remove();
  if (back && m.opener && m.opener.isConnected && m.opener !== document.body) m.opener.focus({ preventScroll: true });
}

/**
 * Open a menu at (x, y) on the page: `items` [{ label, icon, run, disabled, danger }] or null for a divider.
 * `label` names the menu for screen readers.
 */
export function openMenu(x, y, items, label = 'Menu') {
  const opener = document.activeElement;
  closeMenu();
  openedAt = Date.now();
  const buttons = [];
  const el = h('div.desk-menu', { role: 'menu', 'aria-label': label },
    items.map((it) => {
      if (!it) return h('div.desk-menu-sep', { role: 'separator' });
      const b = h(`button.desk-menu-item${it.danger ? '.desk-menu-danger' : ''}`, {
        type: 'button', role: 'menuitem', disabled: !!it.disabled, tabindex: '-1',
        onclick: () => {
          closeMenu();
          it.run();
        },
      }, it.icon ? icon(it.icon, { size: 16 }) : h('span.desk-menu-gap'), h('span', it.label));
      if (!it.disabled) buttons.push(b);
      return b;
    }));
  add(document.body, el);
  // Inside the window: moved left or up when it would leave it.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  const onDown = (e) => {
    if (!el.contains(e.target)) closeMenu();
  };
  const onBlur = () => closeMenu();
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = buttons.length;
      if (n) buttons[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + (i < 0 && e.key === 'ArrowUp' ? 1 : 0)) % n].focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  open = {
    el,
    opener,
    cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    },
  };
  if (buttons[0]) buttons[0].focus({ preventScroll: true });
  return el;
}

/**
 * The menu of `el`: on a right click, on the context-menu key, and on a long press (500 ms without moving) with a
 * finger or a pen. `items(e)` gives the items when it opens (null: no menu there).
 */
export function withMenu(el, items, label) {
  const show = (x, y, e) => {
    const list = items(e);
    if (list && list.length) openMenu(x, y, list, label);
  };
  el.addEventListener('contextmenu', (e) => {
    // A long press already opened it (some browsers also send contextmenu for one).
    if (Date.now() - openedAt < 700 && open) {
      e.preventDefault();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest('input, textarea')) return; // the browser's own menu for text
    e.preventDefault();
    const r = e.clientX || e.clientY ? null : (target || el).getBoundingClientRect();
    show(r ? r.left + 8 : e.clientX, r ? r.bottom - 8 : e.clientY, e);
  });
  let timer = null;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      show(start.x, start.y, e);
    }, 500);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
}
