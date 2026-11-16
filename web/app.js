// The page's router. Pages draw themselves in the frame of shell.js; Home is home.js, New session newsession.js,
// a session session.js; every other page is registered by its feature (registry.js) and imported below.
// Routes: #/  #/new  #/s/<session>  #/more  #/<page>  #/<page>/<sub>
//         #/m/<computer>/...   the same pages for another computer (Home is always every computer at once)
// Addresses from before the pages were split keep working: ALIASES sends them to where the thing lives now.
import { applyPageTheme, h, link, machine } from './lib.js';
import { allPages, navPages } from './registry.js';
import { connectionBanner, endFrame, frame, listRow } from './shell.js';
import { openSession } from './session.js';
import { arrive } from './trail.js';
import { viewHome } from './home.js';
import { viewNew } from './newsession.js';
import { hubStandIn, store } from './store.js';
// Features: one import each; they register their pages and Settings pages (registry.js).
import './projects.js';
import './accounts.js';
import './computers.js';
import './pc.js';
import './automation.js';
import './sessiondefaults.js';
import './skillhub.js';
import './brain.js';
import './workspace.js';
import './tia.js';
import './chat.js';
import './addons.js';
import './vscode.js';
import './settings.js';
import './updates.js';

const app = document.getElementById('app');
let stopView = () => {};

/**
 * Every page address a person (or Tia's open_screen) can open, in one list: "#/<page>" or "#/<page>/<part>". A test
 * checks each one leads to a page.
 */
export const PAGE_ADDRESSES = [
  '#/', '#/new', '#/more',
  '#/workspace', '#/new-project', '#/get-project',
  '#/providers',
  '#/computers', '#/computers/add', '#/computer', '#/computer/setup', '#/computer/advanced',
  '#/automations', '#/automations/queue', '#/automations/rules', '#/automations/activity',
  '#/skills', '#/skills/installed', '#/skills/suggested', '#/skills/find',
  '#/brain',
  '#/tia', '#/tia/jobs', '#/tia/activity',
  '#/settings', '#/settings/new-sessions', '#/settings/workspace', '#/settings/notifications', '#/settings/appearance', '#/settings/security', '#/settings/tia', '#/settings/vscode', '#/settings/addons', '#/settings/about',
];

/** Old addresses (and the screens Tia links to) → where that lives now. */
export const ALIASES = {
  '/pc': '/computer',
  '/pc/setup': '/computer/setup',
  '/pc/projects': '/workspace',
  '/settings/auto': '/providers',
  '/settings/accounts': '/providers',
  '/settings/fixed': '/providers',
  '/settings/computers': '/computers',
  '/settings/join': '/computers',
  '/settings/tokens': '/computers',
  '/settings/pair': '/computers',
  '/settings/skills': '/skills',
  '/settings/automations': '/automations',
  '/settings/schedules': '/automations',
  '/settings/activity': '/automations',
  '/settings/signin': '/settings/security',
  '/settings/password': '/settings/security',
  '/settings/network': '/settings/security',
  '/settings/notify': '/settings/notifications',
  '/settings/look': '/settings/appearance',
  '/settings/quick': '/settings/appearance',
  '/settings/terminals': '/settings/appearance',
  '/settings/claude': '/settings/about',
  '/settings/folders': '/settings/new-sessions',
  '/settings/uploads': '/settings/new-sessions',
  // open_screen (src/assistant/tools.mjs SCREENS)
  '/add-account': '/providers',
  '/password': '/settings/security',
  '/pair-computer': '/computers',
  '/notifications': '/settings/notifications',
  '/tia-settings': '/settings/tia',
};

/** Pages that were renamed: the old address and everything under it lands on the new one. */
const RENAMED = [[/^\/projects(\/(.+))?$/, (m) => (m[2] ? `/workspace/project/${m[2]}` : '/workspace')], [/^\/accounts(\/.*)?$/, (m) => `/providers${m[1] || ''}`]];
export const renamed = (path) => {
  for (const [re, to] of RENAMED) {
    const m = re.exec(path);
    if (m) return to(m);
  }
  return null;
};

/** More (#/more): the second group of pages, as a list — the phone's fifth navigation item. */
function viewMore() {
  store.viewing = null;
  frame({
    title: 'More',
    page: 'more',
    intro: 'Everything else: automations, skills, the assistant and the settings.',
    body: [h('div.rows', navPages('more').map((p) => listRow({ href: p.perComputer ? link(`#/${p.id}`) : `#/${p.id}`, icon: p.icon, title: p.title, end: p.count ? h('span.badge', String(p.count)) : null })))],
  });
}

// The pages that belong to a computer that codes. On a hub (`setup --hub`: it only links the others) they open on
// the first computer that runs sessions, not on the hub's empty one.
export const CODING_PAGES = ['workspace', 'providers', 'brain', 'skills', 'automations', 'new-project', 'get-project'];
let hubWait = () => {};
function onHub(hash) {
  const to = hubStandIn();
  if (to) {
    location.replace(link(hash, to));
    return true;
  }
  // The computers are not known yet on the first load: look once more when they are.
  if (!store.all.length) {
    hubWait = store.subscribe(() => {
      if (!store.all.length) return;
      hubWait();
      hubWait = () => {};
      if (location.hash === hash && machine.current === null) onHub(hash);
    });
  }
  return false;
}

// The address just left, unless the router only sent it on (an old address): a way back must never lead to one.
function leftFrom(e) {
  if (!e || !e.oldURL) return null;
  let old;
  try {
    old = new URL(e.oldURL).hash || '#/';
  } catch {
    return null;
  }
  const p = old.replace(/^#\/m\/[a-z0-9][a-z0-9_-]{0,31}/, '#').slice(1) || '/';
  return ALIASES[p] || renamed(p) ? null : old;
}

function route(e) {
  hubWait();
  hubWait = () => {};
  stopView();
  stopView = () => {};
  endFrame();
  document.body.classList.remove('term-mode');
  let hash = location.hash || '#/';
  // "#/m/<computer>/<page>": that page for another computer. Home is every computer at once.
  const mm = /^#\/m\/([a-z0-9][a-z0-9_-]{0,31})(\/.*)?$/.exec(hash);
  machine.set(mm ? mm[1] : null);
  if (mm) hash = `#${mm[2] || '/'}`;
  const path = hash.slice(1);
  const to = ALIASES[path] || renamed(path);
  if (to) return location.replace(mm ? `#/m/${mm[1]}${to}` : `#${to}`);
  const s = /^\/s\/(.+)$/.exec(path);
  const p = /^\/([a-z][a-z0-9-]*)(?:\/(.*))?$/.exec(path);
  const page = p && allPages().find((x) => x.id === p[1]);
  if (page && !mm && CODING_PAGES.includes(page.id) && onHub(hash)) return;
  if (!s && !page && !['/new', '/new/here', '/more'].includes(path) && (mm || path !== '/')) return location.replace('#/');
  arrive(location.hash || '#/', leftFrom(e));
  let stop;
  if (s) {
    document.body.classList.remove('has-nav');
    stop = openSession(app, decodeURIComponent(s[1]));
  } else if (path === '/new' || path === '/new/here') stop = viewNew();
  else if (path === '/more') stop = viewMore();
  else if (page) stop = page.render({ frame, connectionBanner, sub: p[2] || '' });
  else stop = viewHome();
  stopView = typeof stop === 'function' ? stop : () => {};
  window.scrollTo(0, 0);
}

applyPageTheme();
window.addEventListener('hashchange', route);
route();

// The demo (`<name> demo`): a small "Demo" marker next to every page's title (style.css, body.is-demo).
store.subscribe((d) => document.body.classList.toggle('is-demo', !!(d && d.demo)));
