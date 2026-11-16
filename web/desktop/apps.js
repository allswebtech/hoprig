// The apps of the desktop. A page app is a page of the dashboard shown in a window (a frame of this same page in
// bare mode, lib.js BARE); Terminal opens a new shell, or a session that runs already, in a window. Each one is
// opened for the computer the desktop belongs to. No DOM here: the tests read the catalog as it is.

/**
 * kind 'page'      a page of the dashboard: `hash` is its address on this computer
 * kind 'terminal'  a new shell on the computer (POST /api/shells), shown as its session page
 * local            the page is about every computer at once, so it always opens on this dashboard
 * pinned           on the desktop as an icon, and in the dock
 * keep             words for the start menu's search besides the title
 */
export const APPS = [
  { id: 'sessions', title: 'Sessions', icon: 'sessions', kind: 'page', hash: '#/', pinned: true, keep: 'home chats conversations' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal', kind: 'terminal', pinned: true, keep: 'shell console command' },
  { id: 'workspace', title: 'Workspace', icon: 'folder', kind: 'page', hash: '#/workspace', pinned: true, keep: 'projects repositories folders' },
  { id: 'providers', title: 'Providers', icon: 'user', kind: 'page', hash: '#/providers', pinned: true, keep: 'accounts subscription api sign in' },
  { id: 'computers', title: 'Computers', icon: 'cpu', kind: 'page', hash: '#/computers', local: true, pinned: true, keep: 'machines link pair' },
  { id: 'automations', title: 'Automations', icon: 'clock', kind: 'page', hash: '#/automations', keep: 'queue schedules rules activity' },
  { id: 'skills', title: 'Skills', icon: 'book', kind: 'page', hash: '#/skills', keep: 'install find' },
  { id: 'brain', title: 'AI brain', icon: 'brain', kind: 'page', hash: '#/brain', keep: 'memory rules notes' },
  { id: 'settings', title: 'Settings', icon: 'settings', kind: 'page', hash: '#/settings', pinned: true, keep: 'preferences appearance security' },
];

export const APP_IDS = new Set(APPS.map((a) => a.id));
export const appById = (id) => APPS.find((a) => a.id === id) || null;

/** An in-page address of computer `m` (null: this one): "#/x" → "#/m/<m>/x". The same rule as lib.js link(). */
export const onComputer = (hash, m) => (m ? `#/m/${m}${hash.slice(1)}` : hash);

/** The address a page app opens at on the desktop of computer `m`. */
export const appHash = (app, m) => onComputer(app.hash, app.local ? null : m);

/** The address of a session's page on computer `m`: what a Terminal window shows. */
export const sessionHash = (name, m) => onComputer(`#/s/${encodeURIComponent(name)}`, m);

/** The frame address of a window showing `hash`: this same page in bare mode. */
export const frameSrc = (hash, page = '/') => `${page}?bare=1${hash}`;

/** The apps that match what was typed in the start menu or the launcher, best first. */
export function searchApps(q, apps = APPS) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return apps;
  const score = (a) => (a.title.toLowerCase().startsWith(s) ? 0 : a.title.toLowerCase().includes(s) ? 1 : (a.keep || '').includes(s) ? 2 : 9);
  return apps.map((a) => [score(a), a]).filter(([n]) => n < 9).sort((x, y) => x[0] - y[0]).map(([, a]) => a);
}
