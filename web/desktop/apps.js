// The apps of the desktop: the computer's own things. Sessions and the Editor are pages of the dashboard that are
// also apps (coding is what the computer is for), shown in a window as a frame of this same page in bare mode (lib.js
// BARE); Terminal opens a new shell, or a session that runs already, in a window; Files, Task manager, Services and
// Logs are native apps: a module in this folder with mount(root, { machine, query, open, place }) that calls that
// computer's API (native.js says what the rest is). The other pages of the
// dashboard are not apps: they stay in the dashboard, one press away. Each app is opened for the computer the desktop
// belongs to. No DOM here: the tests read the catalog as it is.

/**
 * kind 'page'      a page of the dashboard: `hash` is its address on this computer
 * kind 'terminal'  a new shell on the computer (POST /api/shells), shown as its session page
 * kind 'native'    `module` (in this folder) exports mount(root, { machine }) → stop(); as a page: #/desktop/<id>
 * pinned           on the desktop as an icon, and in the dock
 * single           one window is enough (each shows the same): opening it again brings that window to the front
 * keep             words for the start menu's search besides the title
 */
export const APPS = [
  { id: 'sessions', title: 'Sessions', icon: 'sessions', kind: 'page', hash: '#/', pinned: true, single: true, keep: 'home chats conversations coding' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal', kind: 'terminal', pinned: true, keep: 'shell console command' },
  { id: 'files', title: 'Files', icon: 'folder', kind: 'native', module: 'files.js', pinned: true, keep: 'folders documents upload download trash archive zip' },
  { id: 'editor', title: 'Editor', icon: 'code', kind: 'page', hash: '#/code', pinned: true, keep: 'code source text edit' },
  { id: 'tasks', title: 'Task manager', icon: 'cpu', kind: 'native', module: 'tasks.js', pinned: true, single: true, keep: 'processes programs performance memory disks network ports kill' },
  { id: 'services', title: 'Services', icon: 'stack', kind: 'native', module: 'services.js', pinned: true, single: true, keep: 'systemd daemons units start stop restart' },
  { id: 'logs', title: 'Logs', icon: 'text', kind: 'native', module: 'logs.js', pinned: true, single: true, keep: 'journal journalctl syslog events' },
];

export const APP_IDS = new Set(APPS.map((a) => a.id));
export const appById = (id) => APPS.find((a) => a.id === id) || null;

/**
 * An in-page address of computer `m` (null: this one): "#/x" → "#/m/<m>/x", as lib.js link(). Home ("#/") is every
 * computer's at once and stays "#/": the router sends "#/m/<m>/" there, and a window's start page is the address it
 * lands on (the Sessions app of another computer keeps to it by `only`, frameSrc).
 */
export const onComputer = (hash, m) => (m && hash !== '#/' ? `#/m/${m}${hash.slice(1)}` : hash);

/** The address an app opens at as a page of computer `m`: a page app's own, a native app's under the desktop. */
export const appHash = (app, m) => onComputer(app.kind === 'native' ? `#/desktop/${app.id}` : app.hash, m);

/** The query of an address ("#/desktop/files?path=…"): what a native app is told where to start. */
export const queryOf = (hash) => new URLSearchParams(String(hash || '').includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');

/** The folder `path` in Files on computer `m`, with `select` chosen: "Show in Files" from the Editor. */
export const filesHash = (path, m, select = null) => onComputer(`#/desktop/files?${new URLSearchParams({ path, ...(select ? { select } : {}) })}`, m);

/** The address of a session's page on computer `m`: what a Terminal window shows. */
export const sessionHash = (name, m) => onComputer(`#/s/${encodeURIComponent(name)}`, m);

/**
 * The frame address of a window showing `hash`: this same page in bare mode. `home`: the address its app starts at
 * (the page's way back leads there), `label`: the app's name, `only`: the computer whose sessions it shows (lib.js
 * WINDOW reads them).
 */
export function frameSrc(hash, page = '/', { home = null, label = null, only = null } = {}) {
  const q = new URLSearchParams({ bare: '1' });
  if (home) q.set('home', home);
  if (label) q.set('label', label);
  if (only) q.set('only', only);
  return `${page}?${q}${hash}`;
}

/** The apps that match what was typed in the start menu or the launcher, best first. */
export function searchApps(q, apps = APPS) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return apps;
  const score = (a) => (a.title.toLowerCase().startsWith(s) ? 0 : a.title.toLowerCase().includes(s) ? 1 : (a.keep || '').includes(s) ? 2 : 9);
  return apps.map((a) => [score(a), a]).filter(([n]) => n < 9).sort((x, y) => x[0] - y[0]).map(([, a]) => a);
}
