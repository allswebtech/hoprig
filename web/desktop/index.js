// The desktop (#/desktop, and #/m/<computer>/desktop for another computer): one page beside the dashboard with the
// apps of a computer as windows on a wide screen, in the style "Taskbar" or "Dock" (Settings → Appearance; kept on
// this device). It is opened by the "Desktop mode" button at the top right of every page head (wide screens) and by
// "Open desktop" on a computer's page; inside it the same corner leads back to the dashboard. It has no entry in the
// navigation. Below 1024 × 600 there are no windows: the same apps are a grid that opens them as pages, a native
// app at #/desktop/<app>.
//
//   apps.js    the catalog          wm.js     the windows        bar.js     the bars, start menu and launcher
//   layout.js  the window maths     menu.js   right-click menu   native.js  what the native apps share
//   moves.js   moving and resizing windows with the pointer
//   tasks.js, services.js, logs.js  the native apps              desktop.css its look
import { icon } from '../icons.js';
import { BARE, WINDOW, api, at, fill, h, link, machine, openSheet, prefs, toast } from '../lib.js';
import { registerHeadTool, registerPage } from '../registry.js';
import { panel, savedMark } from '../shell.js';
import { pageNotify, store } from '../store.js';
import { named } from '../trail.js';
import { APPS, appById, appHash, onComputer, sessionHash } from './apps.js';
import { drawBars } from './bar.js';
import { withMenu } from './menu.js';
import { nativeBody } from './native.js';
import { windowManager } from './wm.js';

/** The screens that get windows; smaller ones get the grid of apps. */
export const WIDE = '(min-width: 1024px) and (min-height: 600px)';
export const STYLES = ['taskbar', 'dock'];
export const deskStyle = () => (prefs.get('desktop.style', 'taskbar') === 'dock' ? 'dock' : 'taskbar');

/** A new shell on computer `m` in its home folder: its session name. */
const newShell = (m) => api(at(m, '/api/shells'), {}).then((r) => r.name);

/**
 * The icons on the desktop: the pinned apps. One press opens one, as everywhere else in the dashboard (a double
 * click, from the habit of other desktops, still opens only one: its second press is let go).
 */
function desktopIcons(getDesk) {
  return h('div.desk-icons', { role: 'list', 'aria-label': 'Apps on the desktop' },
    APPS.filter((a) => a.pinned).map((a) => {
      const open = () => getDesk().launch(a.id);
      const b = h('button.desk-icon', { type: 'button', role: 'listitem', title: `Open ${a.title}`, dataset: { app: a.id },
        onclick: (e) => {
          if (e.detail <= 1) open();
        },
      }, h('span.desk-icon-img', icon(a.icon, { size: 26 })), h('span.desk-icon-name', a.title));
      withMenu(b, () => [
        { label: 'Open', icon: 'plus', run: open },
        a.kind !== 'terminal' ? { label: 'Open as a page', icon: 'external', run: () => (location.hash = appHash(a, getDesk().machineName)) } : null,
      ].filter(Boolean), a.title);
      return b;
    }));
}

/**
 * Before the window of a shell the desktop started closes: end the shell too, or keep it running (it is then in
 * Sessions). On other desktops closing a terminal ends it, so this is asked rather than assumed either way.
 * Resolves 'end' (ended), 'close' (kept running) or null (the window stays).
 */
async function askCloseShell(v, m) {
  const name = (/\/s\/([A-Za-z0-9_-]{1,40})$/.exec(v.hash) || [])[1];
  if (!name) return 'close';
  const how = await openSheet({ title: `Close ${v.title || name}?`, subtitle: 'The shell this window started' }, (close) => [
    h('p.sheet-text', 'Closing only the window keeps the shell running on the computer, with whatever runs in it; it stays in Sessions. Ending it stops all of that.'),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close(null) }, 'Cancel'),
      h('button.btn.secondary', { type: 'button', onclick: () => close('close') }, 'Keep it running'),
      h('button.btn.danger', { type: 'button', onclick: () => close('end') }, 'End the shell')),
  ]);
  if (how !== 'end') return how || null;
  try {
    await api(at(m, `/api/sessions/${encodeURIComponent(name)}/kill`), {});
    return 'end';
  } catch (e) {
    toast(`The shell was not ended: ${e.message}`, { kind: 'error', ms: 7000 });
    return null;
  }
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
  named('Desktop'); // a page opened from here (Desktop settings) links back to "Desktop", not to its own parent

  const desk = {
    machineName,
    wm: null,
    async launch(id, hash = null) {
      const a = appById(id);
      if (!a) return;
      // Past the window limit nothing starts: a shell with no window would keep running unseen.
      if (!desk.wm.canOpen()) return;
      if (a.kind === 'terminal') {
        try {
          const name = await newShell(machineName);
          desk.wm.open('terminal', sessionHash(name, machineName), { title: name, own: true });
        } catch (e) {
          toast(`No terminal: ${e.message}`, { kind: 'error' });
        }
        return;
      }
      desk.wm.open(id, hash ? onComputer(hash, machineName) : appHash(a, machineName), { title: a.title });
    },
    openSession(s) {
      desk.wm.open(s.kind === 'shell' ? 'terminal' : 'sessions', sessionHash(s.name, machineName), { title: s.display || s.name });
    },
    // Back to the dashboard: its Home, or this computer's own page for another computer.
    leave: () => (location.hash = machineName ? link('#/computer', machineName) : '#/'),
    setStyle(next) {
      if (!STYLES.includes(next)) return;
      prefs.set('desktop.style', next);
      restyle();
    },
  };
  let bars = null;
  desk.wm = windowManager({ root, area, machineName, onChange: () => bars && bars.paint(), askClose: (v) => askCloseShell(v, machineName) });
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
    { label: 'Arrange the windows', icon: 'square', run: () => desk.wm.arrange() },
    { label: 'Minimise all', icon: 'minus', run: () => desk.wm.minimiseAll() },
    { label: style === 'dock' ? 'Use the Taskbar style' : 'Use the Dock style', icon: 'swap', run: () => desk.setStyle(style === 'dock' ? 'taskbar' : 'dock') },
    { label: 'Desktop settings', icon: 'settings', run: () => (location.hash = '#/settings/appearance') },
    null,
    { label: 'Back to the dashboard', icon: 'back', run: () => desk.leave() },
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
    if (a.kind !== 'terminal') return h('a.desk-tile', { href: appHash(a, m), dataset: { app: a.id } }, inner);
    return h('button.desk-tile', { type: 'button', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        location.hash = sessionHash(await newShell(m), m);
      } catch (err) {
        toast(`No terminal: ${err.message}`, { kind: 'error' });
        b.disabled = false;
      }
    }, dataset: { app: a.id } }, inner);
  };
  frame({
    title: 'Desktop',
    page: 'desktop',
    intro: 'The apps of this computer. On a screen at least 1024 × 600 they open as windows.',
    back: '#/',
    backLabel: 'Dashboard',
    body: [h('div.desk-grid', APPS.map(tile))],
  });
  return () => {};
}

// ---------- the page ----------

/** A native app as a page of its own (#/desktop/<app>): on a small screen, and "Open as a page" from a window. */
function appPage(a, frame) {
  const body = nativeBody(a, { machine: machine.current });
  body.el.classList.add('dapp-page');
  frame({ title: a.title, page: 'desktop', back: link('#/desktop'), backLabel: 'Desktop', wide: true, body: [body.el] });
  return () => body.stop();
}

function viewDesktop({ frame, sub }) {
  // A link to the desktop inside one of its windows: the desktop is already around it; the window goes back to the
  // page its app starts at.
  if (BARE) {
    location.replace((WINDOW && WINDOW.home) || link('#/'));
    return () => {};
  }
  const a = sub ? appById(sub) : null;
  if (a && a.kind === 'native') return appPage(a, frame);
  if (sub) {
    location.replace(link('#/desktop'));
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

// Not in the navigation: the desktop is beside the dashboard, reached from the button below and a computer's page.
registerPage({ id: 'desktop', title: 'Desktop', icon: 'monitor', perComputer: true, render: viewDesktop });

// "Desktop mode" at the top right of every page head, on a wide screen only (desktop.css hides it below the line):
// the desktop of the computer whose page is open.
registerHeadTool(() => h('a.icon-btn.desk-headbtn', { href: link('#/desktop'), title: 'Desktop mode', 'aria-label': 'Desktop mode' }, icon('monitor', { size: 16 })));

// ---------- Settings → Appearance ----------

/** The desktop's style, kept on this device like the colours. */
export function desktopSettings() {
  const seg = (key, options, current, mark) => {
    const el = h('div.segmented', { role: 'radiogroup' });
    const paint = (cur) => fill(el, options.map(([v, label]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: (e) => {
      e.preventDefault();
      prefs.set(key, v);
      paint(v);
      mark.show();
    } }, h('span', label))));
    paint(current);
    return el;
  };
  const group = (label, key, options, current, hint) => {
    const mark = savedMark();
    return h('div.fieldrow', h('span.field-label', label, mark), seg(key, options, current, mark), h('span.hint', hint));
  };
  return panel({ id: 'desktop', icon: 'monitor', title: 'Desktop', desc: 'The apps of a computer as windows, on a screen at least 1024 × 600: Desktop mode at the top right of a page. Saved on this device only.' },
    group('Desktop style', 'desktop.style', [['taskbar', 'Taskbar'], ['dock', 'Dock']], deskStyle(), 'Where the apps and open windows are: a bar at the bottom, or a dock with a bar at the top.'));
}
