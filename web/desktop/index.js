// The desktop (#/desktop, and #/m/<computer>/desktop for another computer): the apps of a computer as windows on a
// wide screen, in the style "Taskbar" or "Dock" (Settings → Appearance; kept on this device). Below 1024 × 600
// there are no windows: the same apps are a grid that opens them as normal pages.
//
//   apps.js    the catalog          wm.js     the windows        bar.js     the bars, start menu and launcher
//   layout.js  the window maths     menu.js   right-click menu   desktop.css its look
// The windows show the dashboard's own pages in bare mode (lib.js BARE), each for the computer of the desktop.
import { icon } from '../icons.js';
import { BARE, api, at, fill, h, link, machine, prefs, tellDesktop, toast } from '../lib.js';
import { navChanged, registerPage } from '../registry.js';
import { panel, savedMark } from '../shell.js';
import { pageNotify, store } from '../store.js';
import { APPS, appById, appHash, onComputer, sessionHash } from './apps.js';
import { drawBars } from './bar.js';
import { withMenu } from './menu.js';
import { windowManager } from './wm.js';

/** The screens that get windows; smaller ones get the grid of apps. */
export const WIDE = '(min-width: 1024px) and (min-height: 600px)';
const wide = () => typeof matchMedia === 'function' && matchMedia(WIDE).matches;
export const STYLES = ['taskbar', 'dock'];
export const deskStyle = () => (prefs.get('desktop.style', 'taskbar') === 'dock' ? 'dock' : 'taskbar');
export const startView = () => (prefs.get('desktop.start', 'home') === 'desktop' ? 'desktop' : 'home');

/** A new shell on computer `m` in its home folder: its session name. */
const newShell = (m) => api(at(m, '/api/shells'), {}).then((r) => r.name);

/** The icons on the desktop: the pinned apps. A double click opens one (a tap, or Enter, on its own). */
function desktopIcons(getDesk) {
  let pointer = 'mouse';
  return h('div.desk-icons', { role: 'list', 'aria-label': 'Apps on the desktop' },
    APPS.filter((a) => a.pinned).map((a) => {
      const open = () => getDesk().launch(a.id);
      const b = h('button.desk-icon', { type: 'button', role: 'listitem', dataset: { app: a.id },
        onpointerdown: (e) => (pointer = e.pointerType),
        onclick: (e) => {
          if (e.detail === 0 || pointer !== 'mouse') open();
        },
        ondblclick: open,
      }, h('span.desk-icon-img', icon(a.icon, { size: 26 })), h('span.desk-icon-name', a.title));
      withMenu(b, () => [
        { label: 'Open', icon: 'plus', run: open },
        a.kind === 'page' ? { label: 'Open as a page', icon: 'external', run: () => (location.hash = appHash(a, getDesk().machineName)) } : null,
      ].filter(Boolean), a.title);
      return b;
    }));
}

// ---------- the desktop on a wide screen ----------

function mountDesktop() {
  const app = document.getElementById('app');
  const machineName = machine.current;
  let style = deskStyle();
  const top = h('div.desk-top');
  const bottom = h('div.desk-bottom');
  const area = h('div.desk-area', desktopIcons(() => desk));
  const root = h('div.desk', { dataset: { deskStyle: style } }, top, area, bottom);
  fill(app, root);
  document.body.classList.remove('has-nav', 'has-fab');
  document.body.classList.add('desk-mode');
  document.body.dataset.deskStyle = style;
  // Like Home: everything is in view, so a change is not "unread"; the tab says where it is.
  store.viewing = null;
  pageNotify.setTitleBase('Desktop');

  const desk = {
    machineName,
    wm: null,
    async launch(id, hash = null) {
      const a = appById(id);
      if (!a) return;
      if (a.kind === 'terminal') {
        try {
          const name = await newShell(machineName);
          desk.wm.open('terminal', sessionHash(name, machineName), { title: name });
        } catch (e) {
          toast(`No terminal: ${e.message}`, { kind: 'error' });
        }
        return;
      }
      desk.wm.open(id, hash ? onComputer(hash, a.local ? null : machineName) : appHash(a, machineName), { title: a.title });
    },
    openSession(s) {
      desk.wm.open(s.kind === 'shell' ? 'terminal' : 'sessions', sessionHash(s.name, machineName), { title: s.display || s.name });
    },
    leave: () => (location.hash = link('#/', null)),
    setStyle(next) {
      if (!STYLES.includes(next)) return;
      prefs.set('desktop.style', next);
      restyle();
    },
  };
  let bars = null;
  desk.wm = windowManager({ root, area, machineName, onChange: () => bars && bars.paint() });
  bars = drawBars({ root, top, bottom, style, desk });

  function restyle() {
    const next = deskStyle();
    if (next === style) return;
    style = next;
    root.dataset.deskStyle = style;
    document.body.dataset.deskStyle = style;
    bars.stop();
    bars = drawBars({ root, top, bottom, style, desk });
    requestAnimationFrame(() => desk.wm.relayout());
  }

  // The desktop's own menu, on the free space between the windows.
  withMenu(area, (e) => (e.target.closest && e.target.closest('.dwin, .desk-icon') ? null : [
    { label: 'New terminal', icon: 'terminal', run: () => desk.launch('terminal') },
    { label: 'Sessions', icon: 'sessions', run: () => desk.launch('sessions') },
    null,
    { label: 'Arrange the windows', icon: 'grid', run: () => desk.wm.arrange() },
    { label: 'Minimise all', icon: 'minus', run: () => desk.wm.minimiseAll() },
    { label: style === 'dock' ? 'Use the Taskbar style' : 'Use the Dock style', icon: 'swap', run: () => desk.setStyle(style === 'dock' ? 'taskbar' : 'dock') },
    { label: 'Desktop settings', icon: 'settings', run: () => desk.launch('settings', '#/settings/appearance') },
    null,
    { label: 'Leave the desktop', icon: 'logout', run: () => desk.leave() },
  ]), 'Desktop');

  // A choice made in a window (Settings there) or in another tab applies here at once.
  const onStorage = (e) => {
    if (e.key === 'pref:desktop.style') restyle();
    if (e.key === 'pref:page.theme') bars.paint();
  };
  window.addEventListener('storage', onStorage);
  // Ctrl+K: the start menu or the launcher, the way a palette opens elsewhere.
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      root.querySelector('.desk-start, .desk-launch')?.click();
    }
  };
  document.addEventListener('keydown', onKey);

  return () => {
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('keydown', onKey);
    bars.stop();
    desk.wm.stop();
    document.body.classList.remove('desk-mode');
    delete document.body.dataset.deskStyle;
  };
}

// ---------- the grid of apps on a small screen ----------

function appsGrid(frame) {
  const m = machine.current;
  const tile = (a) => {
    const inner = [h('span.desk-tile-icon', icon(a.icon, { size: 24 })), h('span.desk-tile-name', a.title)];
    if (a.kind === 'page') return h('a.desk-tile', { href: appHash(a, m) }, inner);
    return h('button.desk-tile', { type: 'button', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        location.hash = sessionHash(await newShell(m), m);
      } catch (err) {
        toast(`No terminal: ${err.message}`, { kind: 'error' });
        b.disabled = false;
      }
    } }, inner);
  };
  frame({
    title: 'Desktop',
    page: 'desktop',
    intro: 'The apps of this computer. On a screen at least 1024 × 600 they open as windows.',
    body: [h('div.desk-grid', APPS.map(tile))],
  });
  return () => {};
}

// ---------- the page ----------

function viewDesktop({ frame }) {
  // A link to the desktop inside one of its windows: the desktop is already there; the window goes back home.
  if (BARE) {
    tellDesktop({ type: 'hoprig:desktop' });
    location.replace(link('#/'));
    return () => {};
  }
  const mq = matchMedia(WIDE);
  // Crossing the line draws the page again: windows on one side, the grid on the other.
  const again = () => window.dispatchEvent(new Event('hashchange'));
  mq.addEventListener('change', again);
  const stop = mq.matches ? mountDesktop() : appsGrid(frame);
  return () => {
    mq.removeEventListener('change', again);
    stop();
  };
}

registerPage({ id: 'desktop', title: 'Desktop', icon: 'monitor', group: 'main', order: 40, perComputer: true, render: viewDesktop, visible: wide });

if (typeof window !== 'undefined' && typeof matchMedia === 'function' && !BARE) {
  // The navigation shows "Desktop" only on a wide screen.
  matchMedia(WIDE).addEventListener('change', navChanged);
  // Start view: a fresh open of the dashboard (no address of a page in it) goes to the desktop when chosen. Before
  // the router's first draw, without a second one.
  if (!location.hash && startView() === 'desktop' && wide()) history.replaceState(null, '', '#/desktop');
}

// ---------- Settings → Appearance ----------

/** The desktop's two choices, kept on this device like the colours: its style and what the dashboard opens with. */
export function desktopSettings() {
  const seg = (key, options, current, mark) => {
    const el = h('div.segmented', { role: 'radiogroup' });
    const paint = (cur) => fill(el, options.map(([v, label, ic]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: (e) => {
      e.preventDefault();
      prefs.set(key, v);
      paint(v);
      mark.show();
    } }, icon(ic, { size: 16 }), h('span', label))));
    paint(current);
    return el;
  };
  const group = (label, key, options, current, hint) => {
    const mark = savedMark();
    return h('div.fieldrow', h('span.field-label', label, mark), seg(key, options, current, mark), h('span.hint', hint));
  };
  return panel({ id: 'desktop', icon: 'monitor', title: 'Desktop', desc: 'Windows for the apps of a computer, on a screen at least 1024 × 600. Saved on this device only.' },
    group('Desktop style', 'desktop.style', [['taskbar', 'Taskbar', 'down'], ['dock', 'Dock', 'up']], deskStyle(), 'Where the apps and open windows are: a bar at the bottom, or a dock with a bar at the top.'),
    group('Start view', 'desktop.start', [['home', 'Home', 'home'], ['desktop', 'Desktop', 'monitor']], startView(), 'What the dashboard opens with on a wide screen.'));
}
