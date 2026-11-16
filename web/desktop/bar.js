// The bars of the desktop, in its two styles:
//   Taskbar  a bar at the bottom: the start button (the product's mark) with the start menu, a button per open
//            window, and the tray: the computer, the sessions that need you, light or dark, the clock; a slim strip
//            at the top with the way back to the dashboard at its right
//   Dock     a bar at the top: the launcher button, the front window's name with its menu, and the same tray with
//            the way back at its end; a dock at the bottom with the pinned apps and the open ones (a dot under an
//            app that has a window)
// In both styles the way back is at the top right, where "Desktop mode" is in a dashboard page's head.
// The start menu and the launcher are one list: a search field, the apps, and the sessions of this computer that
// can be opened in a window. Everything here is drawn again when the windows or the sessions change.
import { icon } from '../icons.js';
import { MACHINE_STATE, add, applyPageTheme, fill, h, needsYou, needsYouFirst, prefs, stateOf } from '../lib.js';
import { store } from '../store.js';
import { APPS, appById, onComputer, searchApps } from './apps.js';
import { closeMenu, openMenu, withMenu } from './menu.js';

const dark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
const clockText = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Draw the bars into `top` and `bottom` of desktop `root` for `style` ('taskbar' | 'dock'). `desk` is what the
 * bars can ask of the desktop: { wm, machineName, launch(appId, hash?), openSession(session), leave(), setStyle(s) }.
 * Returns { paint(), stop() }.
 */
export function drawBars({ root, top, bottom, style, desk }) {
  const { wm } = desk;
  let popup = null; // the start menu or the launcher while open
  const clock = h('time.desk-clock');
  const tick = () => {
    const d = new Date();
    clock.textContent = clockText(d);
    clock.title = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  const clockTimer = setInterval(tick, 15_000);

  // ---------- the tray: computer, sessions needing you, light/dark, clock ----------

  const own = () => store.all.find((m) => (m.machine || null) === desk.machineName) || null;
  const computerName = () => {
    const m = own();
    return m ? m.machineLabel : desk.machineName || 'This computer';
  };
  function computerPill() {
    const label = computerName();
    const b = h('button.desk-tray-btn.desk-pc', { type: 'button', title: `Computer: ${label}`, 'aria-haspopup': 'menu' }, icon('cpu', { size: 15 }), h('span', label));
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      openMenu(r.left, style === 'dock' ? r.bottom + 6 : r.top - 8 - Math.min(store.all.length, 8) * 38, store.all.map((x) => ({
        label: `${x.machineLabel}${x.status === 'online' ? '' : ` · ${MACHINE_STATE[x.status] || x.status}`}`,
        icon: (x.machine || null) === desk.machineName ? 'check' : 'cpu',
        run: () => (location.hash = onComputer('#/desktop', x.machine)),
      })), 'Computers');
    });
    return b;
  }
  // The desktop is one computer's: it counts that computer's sessions, the ones its Sessions window lists.
  const waitingCount = () => ((own() || {}).sessions || []).filter(needsYou).length;
  function waiting() {
    const n = waitingCount();
    return n ? h('button.desk-tray-btn.desk-waiting', { type: 'button', title: `${n} session${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you`, onclick: () => desk.showSessions() }, icon('bell', { size: 15 }), h('span', String(n))) : null;
  }
  function themeBtn() {
    const label = dark() ? 'Light colours' : 'Dark colours';
    return h('button.desk-tray-btn', { type: 'button', title: label, 'aria-label': label, onclick: () => {
      prefs.set('page.theme', dark() ? 'light' : 'dark');
      applyPageTheme();
      paint();
    } }, icon(dark() ? 'sun' : 'moon', { size: 15 }));
  }
  // The way back sits where "Desktop mode" sits on a dashboard page: the top right, in both styles.
  const back = () => h('button.desk-tray-btn.desk-back', { type: 'button', title: 'Back to the dashboard', onclick: () => desk.leave() }, icon('back', { size: 15 }), h('span', 'Dashboard'));
  const tray = () => h('div.desk-tray', computerPill(), waiting(), themeBtn(), clock, style === 'dock' ? back() : null);

  // ---------- the start menu / the launcher ----------

  function closePopup() {
    if (!popup) return null;
    const from = popup.from;
    popup.cleanup();
    popup.el.remove();
    popup = null;
    paint();
    return from;
  }
  function openPopup(anchor) {
    if (popup) return closePopup();
    closeMenu();
    const grid = h('div.desk-apps', { role: 'list' });
    const sessions = h('div.desk-sessions');
    const input = h('input.field.desk-search', { type: 'search', placeholder: 'Search apps and sessions', 'aria-label': 'Search apps and sessions', autocomplete: 'off', spellcheck: 'false' });
    // What Enter opens: the first app found, else the first session found. It is marked while something is typed.
    let next = null;
    const draw = () => {
      const typed = input.value.trim().toLowerCase();
      const found = searchApps(input.value);
      const m = own();
      const list = m ? [...(m.sessions || [])].filter((s) => s.kind !== 'chat' && (!typed || `${s.display || ''} ${s.name}`.toLowerCase().includes(typed))).sort(needsYouFirst).slice(0, 6) : [];
      next = found.length ? { app: found[0] } : list.length ? { session: list[0] } : null;
      const enterMark = (on) => (on && typed ? h('kbd.desk-enter', { title: 'Enter opens this' }, 'Enter') : null);
      fill(grid, found.map((a, i) => h('button.desk-app', { type: 'button', role: 'listitem', dataset: { next: i === 0 && typed ? '1' : '' }, onclick: () => {
        closePopup();
        desk.launch(a.id);
      } }, h('span.desk-app-icon', icon(a.icon, { size: 22 })), h('span.desk-app-name', a.title), enterMark(i === 0))));
      if (!found.length) fill(grid, h('p.hint', 'No app has that name.'));
      fill(sessions, list.length ? [h('h3.desk-pop-head', 'Open a session in a window'),
        list.map((s, i) => h('button.desk-session', { type: 'button', dataset: { next: !found.length && i === 0 && typed ? '1' : '' }, onclick: () => {
          closePopup();
          desk.openSession(s);
        } }, icon(s.kind === 'shell' ? 'terminal' : 'sessions', { size: 16 }), h('span.desk-session-name', s.display || s.name), h('span.desk-session-state', stateOf(s).text), enterMark(!found.length && i === 0)))]
        : typed && m && (m.sessions || []).length ? h('p.hint', 'No session has that name.') : null);
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !next) return;
      const it = next;
      closePopup();
      if (it.app) desk.launch(it.app.id);
      else desk.openSession(it.session);
    });
    draw();
    const el = h(`div.desk-pop.desk-pop-${style}`, { role: 'dialog', 'aria-label': style === 'dock' ? 'Launcher' : 'Start' },
      input, grid, sessions,
      h('div.desk-pop-foot',
        h('button.btn.ghost.small', { type: 'button', onclick: () => {
          closePopup();
          location.hash = '#/settings/appearance?show=desktop';
        } }, icon('settings', { size: 16 }), h('span', 'Desktop settings')),
        h('button.btn.ghost.small', { type: 'button', onclick: () => {
          closePopup();
          desk.leave();
        } }, icon('back', { size: 16 }), h('span', 'Back to the dashboard'))));
    add(root, el);
    const onDown = (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) closePopup();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // The bar was drawn again on close: the keyboard goes back to the new button that opened the menu.
        const from = closePopup();
        const again = from && root.querySelector(from);
        if (again) again.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    const from = ['.desk-start', '.desk-launch', '.desk-dock-all'].find((sel) => anchor.matches(sel)) || null;
    popup = { el, from, cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    } };
    paint();
    input.focus();
  }

  // ---------- the window buttons ----------

  const windowMenu = (w) => [
    { label: w.min ? 'Restore' : 'Bring to front', icon: 'up', run: () => wm.raise(w.id) },
    { label: 'Minimise', icon: 'minus', disabled: w.min, run: () => wm.minimise(w.id) },
    { label: 'Maximise', icon: 'square', run: () => wm.setSnap(w.id, 'max') },
    null,
    { label: 'Close', icon: 'x', danger: true, run: () => wm.close(w.id) },
  ];
  function winButton(w) {
    const app = appById(w.app);
    const b = h('button.desk-task', { type: 'button', title: w.label, 'aria-pressed': String(w.focused), dataset: { id: w.id, min: w.min ? '1' : '' }, onclick: () => wm.toggleFromBar(w.id) },
      icon(app.icon, { size: 16 }), h('span.desk-task-name', w.label));
    withMenu(b, () => windowMenu(w), 'Window');
    return b;
  }

  /** A dock item: an app (pinned, or open), with a dot while it has a window. */
  function dockItem(app, open) {
    const label = app.title;
    const b = h('button.desk-dock-item', { type: 'button', title: label, 'aria-label': label, dataset: { app: app.id, open: open.length ? '1' : '' }, onclick: () => {
      // The app's window in front goes down; one behind comes up; none: a new one.
      const front = open.find((w) => w.focused) || open[open.length - 1];
      if (front) wm.toggleFromBar(front.id);
      else desk.launch(app.id);
    } }, icon(app.icon, { size: 22 }), h('span.desk-dock-dot', { 'aria-hidden': 'true' }));
    withMenu(b, () => [
      app.single && wm.only(app.id) ? null : { label: open.length && !app.single ? `New ${app.title} window` : `Open ${app.title}`, icon: 'plus', run: () => desk.launch(app.id) },
      ...open.map((w) => ({ label: w.title, icon: app.icon, run: () => wm.raise(w.id) })),
      ...(open.length ? [null, { label: open.length > 1 ? 'Close all its windows' : 'Close', icon: 'x', danger: true, run: async () => {
        for (const w of open) await wm.close(w.id); // one at a time: a shell's window asks first
      } }] : []),
    ].filter(Boolean), app.title);
    return b;
  }

  const mark = (label, cls, word = null) => h(`button.${cls}`, { type: 'button', title: label, 'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': String(!!popup), onclick: (e) => openPopup(e.currentTarget) },
    h('img', { src: 'icon.svg', alt: '', width: 22, height: 22 }), word ? h('span.desk-start-word', word) : null);

  // Drawn again only when something it shows changed, so the keyboard's place in the bar survives the next poll.
  let shown = '';
  function paint(force = true) {
    const wins = wm.list();
    const now = JSON.stringify([wins, !!popup, dark(), store.all.map((m) => [m.machine, m.machineLabel, m.status]), waitingCount()]);
    if (!force && now === shown) return;
    shown = now;
    if (style === 'taskbar') {
      // A slim strip at the top holds only the way back, where the "Desktop mode" button was on the page.
      fill(top, h('div.desk-strip', h('span.desk-strip-name', h('img', { src: 'icon.svg', alt: '', width: 16, height: 16 }), h('span', `Desktop · ${computerName()}`)), h('span.desk-grow'), back()));
      fill(bottom, h('nav.desk-taskbar', { 'aria-label': 'Taskbar' },
        mark('Start', 'desk-start', 'Start'),
        h('div.desk-tasks', wins.map(winButton)),
        tray()));
      return;
    }
    // Dock: the front window's name and its menu in the top bar.
    const f = wins.find((w) => w.focused);
    const appMenu = f ? h('button.desk-appmenu', { type: 'button', 'aria-haspopup': 'menu', title: `${f.title}: window menu`, onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom + 6, [
        { label: 'Minimise', icon: 'minus', run: () => wm.minimise(f.id) },
        { label: 'Maximise or restore', icon: 'square', run: () => wm.toggleMax(f.id) },
        { label: 'Snap to the left half', icon: 'back', run: () => wm.setSnap(f.id, 'l') },
        { label: 'Snap to the right half', icon: 'chevronRight', run: () => wm.setSnap(f.id, 'r') },
        { label: 'Reload', icon: 'refresh', run: () => wm.reload(f.id) },
        { label: 'Open as a page', icon: 'external', run: () => (location.hash = f.hash) },
        null,
        { label: 'Close', icon: 'x', danger: true, run: () => wm.close(f.id) },
      ], f.title);
    } }, h('strong', appById(f.app).title), f.title !== appById(f.app).title ? h('span.desk-appmenu-sub', f.title) : null, icon('chevronDown', { size: 14 })) : h('span.desk-appmenu-none', 'Desktop');
    fill(top, h('div.desk-topbar', mark('Launcher', 'desk-launch'), appMenu, h('span.desk-grow'), tray()));
    const pinned = APPS.filter((a) => a.pinned);
    const extra = APPS.filter((a) => !a.pinned && wins.some((w) => w.app === a.id));
    fill(bottom, h('nav.desk-dock', { 'aria-label': 'Dock' },
      h('button.desk-dock-item.desk-dock-all', { type: 'button', title: 'All apps', 'aria-label': 'All apps', onclick: (e) => openPopup(e.currentTarget) }, icon('grid', { size: 22 })),
      h('span.desk-dock-sep', { 'aria-hidden': 'true' }),
      [...pinned, ...extra].map((a) => dockItem(a, wins.filter((w) => w.app === a.id)))));
  }

  const unsubscribe = store.subscribe(() => {
    if (!popup) paint(false);
  });
  paint();
  return {
    paint,
    stop() {
      clearInterval(clockTimer);
      unsubscribe();
      closePopup();
      closeMenu();
    },
  };
}
