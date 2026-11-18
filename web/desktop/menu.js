// The desktop's right-click menu, and the long press that opens the same menu on a touch screen; also a menu that
// drops down from a button (the chat's session menu). One menu at a time, with at most one submenu open beside it;
// it closes on Escape, on a press outside it, when a choice is made, when the window loses focus and on a second press
// of the button it drops from. The arrow keys move between its items; after a choice or Escape the keyboard is back on
// what had it (the button), unless the choice took it elsewhere (a sheet, another page).
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
  m.child?.el.remove();
  m.from?.setAttribute('aria-expanded', 'false');
  if (back && m.opener && m.opener.isConnected && m.opener !== document.body) m.opener.focus({ preventScroll: true });
}

/** Inside the window: moved left or up when it would leave it. */
function place(el, x, y) {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

/** Close the menu `el` (what openMenu returned) if it is still the open one; another's stays. */
export function closeMenuOf(el) {
  if (open && el && open.el === el) closeMenu();
}

/**
 * Open a menu at (x, y) on the page: `items` [{ label, icon, run, disabled, danger, checked, items }] or null for a
 * divider. `checked` (true or false): one of a set of choices, marked when chosen. `items`: a submenu that opens beside
 * its entry (a click, Enter, the right arrow or the pointer over it; the left arrow or Escape goes back). `label` names
 * the menu for screen readers. `from`: the button it drops from (aria-expanded while open; a second press of it closes
 * the menu, as a drop-down button does). → the menu, or null when the press closed it
 */
export function openMenu(x, y, items, label = 'Menu', { from = null } = {}) {
  if (from && open && open.from === from) {
    closeMenu(true);
    return null;
  }
  const opener = from || document.activeElement; // a browser that does not focus a pressed button (Safari): the button
  closeMenu();
  openedAt = Date.now();
  let child = null; // the submenu that is open: { el, buttons, from (its entry) }
  const closeChild = (focusBack = false) => {
    if (!child) return;
    const c = child;
    child = null;
    open.child = null;
    c.from.setAttribute('aria-expanded', 'false');
    c.el.remove();
    if (focusBack) c.from.focus({ preventScroll: true });
  };
  const openChild = (from, list, name) => {
    if (child && child.from === from) return;
    closeChild();
    const sub = build(list, name, false);
    add(document.body, sub.el);
    const r = from.getBoundingClientRect();
    const w = sub.el.getBoundingClientRect().width;
    // Beside its entry, at the left of the menu where the right side has no room.
    place(sub.el, r.right + w + 4 > innerWidth ? r.left - w - 2 : r.right + 2, r.top - 6);
    from.setAttribute('aria-expanded', 'true');
    child = { ...sub, from };
    open.child = child;
    sub.buttons[0]?.focus({ preventScroll: true });
  };
  function build(list, name, top) {
    const buttons = [];
    const el = h('div.desk-menu', { role: 'menu', 'aria-label': name },
      list.map((it) => {
        if (!it) return h('div.desk-menu-sep', { role: 'separator' });
        const subOf = Array.isArray(it.items) && it.items.length ? it.items : null;
        const radio = typeof it.checked === 'boolean';
        const b = h(`button.desk-menu-item${it.danger ? '.desk-menu-danger' : ''}`, {
          type: 'button', role: radio ? 'menuitemradio' : 'menuitem', disabled: !!it.disabled, tabindex: '-1',
          ...(radio ? { 'aria-checked': String(it.checked) } : {}),
          ...(subOf ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
          onclick: () => {
            if (subOf) return openChild(b, subOf, it.label);
            closeMenu(true); // the keyboard back on the button, unless the choice takes it elsewhere
            it.run();
          },
          onpointerenter: (e) => {
            if (e.pointerType !== 'mouse' || !top) return;
            if (subOf) openChild(b, subOf, it.label);
            else closeChild();
          },
        }, radio ? (it.checked ? icon('check', { size: 16 }) : h('span.desk-menu-gap')) : it.icon ? icon(it.icon, { size: 16 }) : h('span.desk-menu-gap'),
        h('span', it.label), subOf ? h('span.desk-menu-more', icon('chevronRight', { size: 14 })) : null);
        b.sub = subOf ? { list: subOf, name: it.label } : null;
        if (!it.disabled) buttons.push(b);
        return b;
      }));
    return { el, buttons };
  }
  const { el, buttons } = build(items, label, true);
  add(document.body, el);
  place(el, x, y);
  const onDown = (e) => {
    if (from && from.contains(e.target)) return; // its button: its click closes the menu (openMenu above)
    if (!el.contains(e.target) && !(child && child.el.contains(e.target))) closeMenu();
  };
  const onBlur = () => closeMenu();
  const onKey = (e) => {
    const inChild = !!(child && child.el.contains(document.activeElement));
    const list = inChild ? child.buttons : buttons;
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && inChild)) {
      e.preventDefault();
      if (inChild) closeChild(true);
      else closeMenu(true);
    } else if (e.key === 'ArrowRight' && !inChild && i >= 0 && list[i].sub) {
      e.preventDefault();
      openChild(list[i], list[i].sub.list, list[i].sub.name);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list.length;
      if (n) list[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + (i < 0 && e.key === 'ArrowUp' ? 1 : 0)) % n].focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  from?.setAttribute('aria-expanded', 'true');
  open = {
    el,
    opener,
    from,
    child: null,
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
