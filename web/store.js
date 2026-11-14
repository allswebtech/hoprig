// One poller for the whole page: the sessions of every computer (this one and the ones added in Settings →
// Computers) every few seconds, slower while the tab is hidden. Views subscribe to it instead of polling on their
// own. `store.data` is the state of the computer whose screen is open (the shape of /api/state), `store.all` the
// list of every computer with its state. Every session and account carries `machine` (null: this computer) and
// `machineLabel`, so a view can act on it wherever it lives.
// It also raises the in-page notifications: a count in the tab title, an optional sound and vibration, and
// browser notifications where the browser allows them.
import { APP_NAME } from './brand.js';
import { api, link, machine, prefs, stateOf } from './lib.js';

const listeners = new Set();
let all = null;
let error = null;
let timer = null;
let inflight = null;
let lastKeys = null; // session name → state key, for spotting changes
let unread = 0;

// What an unreachable computer looks like to a view that expects /api/state.
const EMPTY = { sessions: [], profiles: [], autoSwitch: { enabled: false, order: [] }, quickActions: [], recommended: null, backend: null };

/** Tag what came from computer `m`, so actions on it go there. */
function tag(m) {
  const where = { machine: m.machine ?? null, machineLabel: m.label || m.machine || 'This computer' };
  const out = { ...EMPTY, ...m, ...where };
  out.sessions = (m.sessions || []).map((s) => ({ ...s, ...where }));
  out.profiles = (m.profiles || []).map((p) => ({ ...p, ...where }));
  return out;
}

export const store = {
  /** The state of the computer whose screen is open, or null before the first answer. */
  get data() {
    if (!all) return null;
    const cur = machine.current;
    return all.find((m) => m.machine === cur) || (cur ? { ...EMPTY, machine: cur, machineLabel: cur, status: 'offline', error: 'This computer is not in the list.' } : null);
  },
  /** Every computer: [{ machine, machineLabel, status, error, sessions, profiles, ... }], this one first. */
  get all() {
    return all || [];
  },
  /** More than one computer: the page shows which one each thing belongs to. */
  get multi() {
    return !!all && all.length > 1;
  },
  get error() {
    return error;
  },
  /** fn(data, error) is called now (if there is data) and after every poll. Returns an unsubscribe function. */
  subscribe(fn) {
    listeners.add(fn);
    if (all || error) fn(store.data, error);
    if (!timer && !inflight) refresh();
    return () => listeners.delete(fn);
  },
  refresh,
  /** The page is showing this session of the open computer (or Home with null): its changes do not count as unread. */
  viewing: null,
};

async function refresh() {
  clearTimeout(timer);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = (await api('~/api/machines/sessions')).machines.map(tag);
      error = null;
      notice(next.flatMap((m) => m.sessions));
      all = next;
      const own = next.find((m) => m.machine === null);
      if (own && typeof own.home === 'string') window.__home = own.home; // for tildePath (lib.js)
    } catch (e) {
      error = e;
    }
    inflight = null;
    for (const fn of listeners) fn(store.data, error);
    timer = setTimeout(refresh, document.visibilityState === 'visible' ? 3000 : 15000);
  })();
  return inflight;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    unread = 0;
    setTitle();
    refresh();
  }
});

// ---------- notifications in the page ----------

const EVENT_TEXT = {
  waiting: 'is waiting for you',
  attention: 'needs your OK',
  limit: 'reached a usage limit',
  ended: 'finished',
};

export const pageNotify = {
  get sound() {
    return prefs.get('notify.sound', false);
  },
  get vibrate() {
    return prefs.get('notify.vibrate', true);
  },
  /** 'granted' | 'denied' | 'default' | 'unsupported' | 'insecure' */
  get browser() {
    if (!('Notification' in window)) return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    return Notification.permission;
  },
  async askBrowser() {
    if (this.browser !== 'default') return this.browser;
    return Notification.requestPermission();
  },
  setTitleBase(text) {
    titleBase = text;
    setTitle();
  },
};

let titleBase = APP_NAME;
function setTitle() {
  document.title = unread ? `(${unread}) ${titleBase}` : titleBase;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
    o.onended = () => ctx.close();
  } catch {
    /* no audio */
  }
}

const keyOf = (s) => `${s.machine || ''}/${s.name}`;

function notice(sessions) {
  const keys = new Map(sessions.map((s) => [keyOf(s), stateOf(s).key]));
  if (lastKeys) {
    const events = [];
    for (const s of sessions) {
      const k = keys.get(keyOf(s));
      const before = lastKeys.get(keyOf(s));
      if (before === undefined || before === k) continue;
      if (EVENT_TEXT[k]) events.push([s, k]);
      else if (k === 'shell' && before !== 'shell') events.push([s, 'ended']);
    }
    const seen = document.visibilityState === 'visible';
    for (const [s, k] of events) {
      const here = seen && ((store.viewing === s.name && (s.machine || null) === machine.current) || store.viewing === null);
      if (!seen) unread++;
      if (here) continue; // already in front of the user
      if (pageNotify.sound) beep();
      if (pageNotify.vibrate && navigator.vibrate) navigator.vibrate([60, 40, 60]);
      if (pageNotify.browser === 'granted' && !seen) {
        try {
          const where = s.machine ? ` on ${s.machineLabel}` : '';
          const n = new Notification(`${s.name}${where} ${EVENT_TEXT[k]}`, { body: s.lastMessage || '', tag: `${keyOf(s)}:${k}`, icon: 'icon-192.png' });
          n.onclick = () => {
            window.focus();
            location.hash = link(`#/s/${encodeURIComponent(s.name)}`, s.machine);
            n.close();
          };
        } catch {
          /* some mobile browsers only allow notifications from a service worker */
        }
      }
    }
    setTitle();
  }
  lastKeys = keys;
}

/**
 * Whether computer `m` (an entry of store.all) can run a Claude session now, and if not why, in plain words:
 * online, not a hub (`setup --hub`: it only links the others), Claude Code there (`claude`: its version from
 * /api/machines; undefined when not asked yet counts as there) and at least one provider.
 */
export function runsSessions(m, claude) {
  if (!m) return { ok: false, why: 'Not in the list' };
  if (m.status && m.status !== 'online') return { ok: false, why: 'Not reachable now' };
  if (m.hub) return { ok: false, why: 'The hub: it links your computers and runs no sessions' };
  if (claude === null) return { ok: false, why: 'Claude Code is not installed there' };
  if (!(m.profiles || []).some((p) => !p.virtual)) return { ok: false, why: 'No provider there yet' };
  return { ok: true, why: '' };
}

/**
 * On a hub, a page that belongs to a coding computer (its projects, providers, skills…) opens on the first computer
 * that runs sessions: the computer to use instead of this one, or undefined (not a hub, none can, or not known yet).
 */
export function hubStandIn() {
  const own = store.all.find((m) => m.machine === null);
  if (!own || !own.hub) return undefined;
  const other = store.all.find((m) => m.machine !== null && runsSessions(m).ok);
  return other ? other.machine : undefined;
}
