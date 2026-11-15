// Shared helpers: DOM building (text only, never innerHTML with data), the one place that builds API and
// WebSocket URLs, per-device preferences, wording, sheets (dialogs) and toasts.
import { APP_NAME, REPO_URL } from './brand.js';
import { icon } from './icons.js';

// ---------- DOM ----------

/** Children that render nothing: null, undefined, false, true and empty strings never become text. */
const isNothing = (c) => c === null || c === undefined || c === false || c === true || c === '';
const toNodes = (kids) => kids.flat(Infinity).filter((c) => !isNothing(c)).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));

/** h('div.card', {onclick}, child, 'text', ...) builds an element. */
export function h(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs !== undefined && (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v; // a textarea's text is a property, not an attribute
    else if (k === 'style') Object.assign(el.style, v); // CSSOM: allowed by the CSP, unlike style attributes
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...toNodes(children));
  return el;
}

/** Replace the children of `el`. Use this (not replaceChildren) so a null child never shows up as "null". */
export function fill(el, ...children) {
  el.replaceChildren(...toNodes(children));
  return el;
}

/** Append children to `el`, skipping nothing-children. */
export function add(el, ...children) {
  el.append(...toNodes(children));
  return el;
}

/** A button with an icon and an optional text. */
export function btn(cls, { icon: name, label, title, onclick, type = 'button', disabled, ...rest } = {}) {
  return h(`button.btn${cls ? '.' + cls : ''}`, { type, title: title || (label ? null : name), 'aria-label': label ? null : title || name, onclick, disabled, ...rest },
    name ? icon(name, { size: 18 }) : null, label ? h('span', label) : null);
}

// ---------- server URLs: every request goes through these two ----------

// The page shows several computers as one place. A screen of another computer has "#/m/<name>/..." in the
// address; while it is open, every API call goes to /m/<name>/api/... on this dashboard, which relays it there.
// A path starting with "~/" always means this dashboard itself (the list of computers, the sessions of all).

let MACHINE = typeof location !== 'undefined' ? ((location.pathname.match(/^\/m\/([a-z0-9][a-z0-9_-]{0,31})(?=\/)/) || [])[1] || null) : null;
/** The computer whose screen is open: null for this one. Set by the router. */
export const machine = {
  get current() {
    return MACHINE;
  },
  set(name) {
    MACHINE = name || null;
  },
};
/** API path `p` of computer `m` (null: this computer), whatever screen is open. */
export const at = (m, p) => (m ? `/m/${m}${p}` : `~${p}`);
/** API path of the computer a session (or account) belongs to; items from the shared poller carry `machine`. */
export const atOf = (item, p) => (item && 'machine' in item ? at(item.machine, p) : p);
export const url = (p) => (p.startsWith('~/') ? p.slice(1) : p.startsWith('/m/') || p === '/login' || !MACHINE ? p : `/m/${MACHINE}${p}`);
export const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${url(p)}`;
/** An in-page link to a screen of computer `m` (default: the open one): "#/s/x" -> "#/m/pc2/s/x". */
export const link = (hash, m = MACHINE) => (m ? `#/m/${m}${hash.slice(1)}` : hash);

export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.code = data.code || null; // e.g. offline, not-authorised, not-installed (from another computer)
    this.data = data;
  }
}

/** JSON API call. A 401 means the login has expired: go to the login page. */
export async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  let r;
  try {
    r = await fetch(url(path), {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the computer. Check the connection.', 0);
  }
  if (r.status === 401 && !path.startsWith('/api/settings/password')) {
    location.href = url('/login');
    throw new ApiError('Logged out', 401);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error ? data.error.charAt(0).toUpperCase() + data.error.slice(1) : `Request failed (${r.status})`, r.status, data);
  return data;
}

// ---------- computers ----------

/** A small "which computer" tag, shown on sessions, accounts and settings once there is more than one. */
export const machinePill = (label, { state = 'online' } = {}) =>
  h(`span.mpill${state !== 'online' ? '.off' : ''}`, icon('cpu', { size: 13 }), label);

/** What a computer's state means, in plain words. */
export const MACHINE_STATE = {
  online: 'Online',
  offline: 'Offline',
  unauthorised: 'Not allowed any more',
  'too-old': `Needs a ${APP_NAME} update`,
  connecting: 'Connecting…',
};

/** A QR code (rows of '1'/'0' from the server) as an SVG drawn with DOM calls. */
export function qrSvg(rows, size = 220) {
  const NS = 'http://www.w3.org/2000/svg';
  const n = rows.length;
  const q = 4; // quiet zone
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + q * 2} ${n + q * 2}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(NS, 'path');
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x + q} ${y + q}h1v1h-1z`;
  });
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

/** Copy text; true when it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- per-device preferences ----------

export const prefs = {
  get(k, dflt) {
    try {
      const v = localStorage.getItem(`pref:${k}`);
      return v === null ? dflt : JSON.parse(v);
    } catch {
      return dflt;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`pref:${k}`, JSON.stringify(v));
    } catch {
      /* private mode: the setting lasts until the page closes */
    }
  },
};

/** Page colours: follow the system, or the choice made in Settings (per device). */
export function applyPageTheme() {
  const t = prefs.get('page.theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- wording ----------

export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "in 2 h 10 min" / "at 17:00" for a time in the future. */
export function until(ms) {
  if (!ms) return '';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 60) return 'any moment';
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 12 * 3600) return `in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

/** What a session is doing, in plain words, and how urgent it is (lower = needs you sooner). */
export function stateOf(s) {
  if (s.limit || s.runLimit) return { key: 'limit', text: 'Limit reached', rank: 1 };
  if (s.kind === 'shell') return { key: 'shell', text: 'Terminal', rank: 6 };
  switch (s.status) {
    case 'attention': return { key: 'attention', text: 'Needs your OK', rank: 0 };
    case 'waiting': return { key: 'waiting', text: 'Waiting for your next message', rank: 2 };
    case 'starting': return { key: 'starting', text: 'Starting', rank: 3 };
    case 'working': return { key: 'working', text: 'Working', rank: 4 };
    case 'ended': return { key: 'ended', text: 'Finished', rank: 5 };
    default: return { key: 'shell', text: s.status || 'Unknown', rank: 6 };
  }
}

/** What Home groups as "Needs you": a question waiting for an OK, or a limit. Every count of it uses this. */
export const needsYou = (s) => ['attention', 'limit'].includes(stateOf(s).key);

export const needsYouFirst = (a, b) =>
  stateOf(a).rank - stateOf(b).rank || (b.statusAt || b.activity || 0) - (a.statusAt || a.activity || 0);

export function statusPill(s, { time = true } = {}) {
  const st = stateOf(s);
  const at = s.statusAt || s.activity;
  return h(`span.pill.st-${st.key}`, h('span.dot'), st.text, time && at ? h('span.pill-time', { dataset: { at } }, ` · ${ago(at)}`) : null);
}

export const KIND = { login: 'Subscription', subscription: 'Subscription', api: 'API', auto: 'Auto mode', unknown: 'Provider' };

/** How a session's account reads: "Auto · now on Work" for Auto sessions, else the account's name. */
export const profileText = (s) =>
  !s.profile ? '' : s.profile.name === 'auto' ? (s.autoOn ? `Auto · now on ${s.autoOn.label}` : 'Auto') : s.profile.label;
export const profileIcon = (p) => (p && p.name === 'auto' ? 'zap' : 'user');

export function profileState(p) {
  if (p.virtual) return { key: 'free', text: 'Uses your providers in order; never stops at a limit' };
  // A sign-in provider whose sign-in is gone (or never finished): it cannot be used until someone signs in again.
  if (p.signedIn === false) return { key: 'signin', text: 'Not signed in' };
  if (p.limited) {
    const when = p.limited.until ? `${p.limited.exact === false ? 'about ' : ''}${until(p.limited.until)}` : '';
    return { key: 'limit', text: when ? `Limit reached · free ${when}` : 'Limit reached' };
  }
  if (p.inUse) return { key: 'inuse', text: `In use · ${p.inUse} session${p.inUse > 1 ? 's' : ''}` };
  return { key: 'free', text: 'Available' };
}

export const insecure = () => location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// ---------- sheets (bottom sheets on phones, centered dialogs on wide screens) ----------

let sheetEl = null;
function sheetElement() {
  if (!sheetEl) {
    sheetEl = h('dialog.sheet', { 'aria-modal': 'true' });
    // Tap outside the panel closes it.
    sheetEl.addEventListener('click', (e) => {
      if (e.target === sheetEl) sheetEl.close();
    });
    document.body.append(sheetEl);
  }
  return sheetEl;
}

/**
 * Open a sheet. `build(close)` returns its content. Resolves with the value passed to close(), or null.
 */
export function openSheet({ title, subtitle, wide = false }, build) {
  const d = sheetElement();
  if (d.open) d.close();
  return new Promise((resolve) => {
    let result = null;
    const close = (value = null) => {
      result = value;
      d.close();
    };
    d.classList.toggle('wide', wide);
    fill(d,
      h('div.sheet-grip', { 'aria-hidden': 'true' }),
      h('header.sheet-head',
        h('div', h('h2.sheet-title', title), subtitle ? h('p.sheet-sub', subtitle) : null),
        btn('icon ghost', { icon: 'x', title: 'Close', onclick: () => close(null) })),
      h('div.sheet-body', build(close)),
    );
    d.addEventListener('close', () => resolve(result), { once: true });
    d.showModal();
    const focus = d.querySelector('[autofocus]');
    if (focus) focus.focus();
  });
}

export function confirmSheet({ title, text, ok = 'OK', danger = false }) {
  return openSheet({ title }, (close) => [
    text ? h('p.sheet-text', text) : null,
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
      h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: () => close(true) }, ok)),
  ]).then((v) => v === true);
}

/** A form with one field. `check(value)` returns an error message or ''. */
export function promptSheet({ title, text, value = '', ok = 'OK', placeholder = '', type = 'text', check = () => '', multiline = false }) {
  return openSheet({ title }, (close) => {
    const input = multiline
      ? h('textarea.field', { value, placeholder, autofocus: true, rows: 5 })
      : h('input.field', { type, value, placeholder, autofocus: true, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const err = h('p.form-error', { role: 'alert' });
    return h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const msg = check(input.value);
        if (msg) err.textContent = msg;
        else close(input.value);
      },
    },
    text ? h('p.sheet-text', text) : null,
    input, err,
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, ok)));
  });
}

/** A list of choices: [{ value, label, sub, icon, badge, disabled, current }]. */
export function chooseSheet({ title, subtitle, items }) {
  return openSheet({ title, subtitle }, (close) =>
    h('div.choice-list', items.map((it) =>
      h(`button.choice${it.current ? '.current' : ''}${it.danger ? '.danger' : ''}`, { type: 'button', disabled: it.disabled, onclick: () => close(it.value) },
        it.icon ? h('span.choice-icon', icon(it.icon)) : null,
        h('span.choice-main', h('span.choice-label', it.label, it.badge ? h('span.badge', it.badge) : null), it.sub ? h('span.choice-sub', it.sub) : null),
        it.current ? h('span.choice-end', icon('check')) : h('span.choice-end', icon('chevronRight'))),
    )));
}

// ---------- toasts ----------

let toastBox = null;
export function toast(text, { kind = 'info', ms = 3500 } = {}) {
  if (!toastBox) {
    toastBox = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h(`div.toast.${kind}`, icon(kind === 'error' ? 'alert' : 'check', { size: 18 }), h('span', text));
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- switching profiles (used by Home and the session view) ----------

/** Confirm, then continue session `s` under profile `p`. Resolves true when it was moved. */
export async function switchProfile(s, p) {
  const ok = await confirmSheet({
    title: `Continue on ${p.label}?`,
    text:
      `Claude in "${s.name}" stops and the same conversation continues on ${p.label}. ` +
      'The conversation is saved as it goes, so at most the reply being written right now is lost.',
    ok: 'Switch',
  });
  if (!ok) return false;
  try {
    await api(atOf(s, `/api/sessions/${encodeURIComponent(s.name)}/switch`), { profile: p.name });
    toast(`Continuing on ${p.label}`);
    return true;
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return false;
  }
}

/** The switch sheet: every profile with its state; the current one marked. */
export async function chooseProfileFor(s, profiles) {
  if (!s.canSwitch) {
    toast('Claude has not reported its session yet. Try again in a moment.', { kind: 'error' });
    return false;
  }
  const pick = await chooseSheet({
    title: 'Run this session on…',
    subtitle: 'The conversation continues where it is.',
    items: profiles.map((p) => ({
      value: p.name,
      label: p.label,
      sub: p.virtual ? profileState(p).text : `${KIND[p.kind] || p.kind} · ${profileState(p).text}`,
      icon: profileIcon(p),
      current: s.profile && p.name === s.profile.name,
      disabled: s.profile && p.name === s.profile.name,
    })),
  });
  const p = profiles.find((x) => x.name === pick);
  return p ? switchProfile(s, p) : false;
}

/** The red "limit reached" box with one button per other profile. */
export function limitBox(s, profiles, after) {
  if (!s.limit && !s.runLimit) return null;
  const text = (s.limit && s.limit.text) || (s.runLimit && s.runLimit.error) || '';
  // Not one that is not signed in: the session would stop there at once.
  const others = profiles.filter((p) => (!s.profile || p.name !== s.profile.name) && p.signedIn !== false);
  return h('div.limitbox', { role: 'alert' },
    h('div.limit-head', icon('alert'), h('strong', 'Limit reached'), s.limit && s.limit.resets && !text.includes(s.limit.resets) ? h('span', ` · resets ${s.limit.resets}`) : null),
    text ? h('p.limit-text', text) : null,
    s.autoMove ? h('p.limit-text', `Moving to ${s.autoMove} automatically…`) : null,
    s.canSwitch && others.length
      ? h('div.limit-actions', others.map((p) =>
        // One main button: Auto when it is there, else the first account that is free; the others plain.
        h(`button.btn.small.${p === (others.find((x) => x.virtual) || others.find((x) => !x.limited)) ? 'primary' : 'secondary'}`, {
          type: 'button',
          onclick: async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (await switchProfile(s, p)) after?.();
          },
        }, icon('swap', { size: 16 }), h('span', `Continue on ${p.label}`))))
      : null,
  );
}

// ---------- a question waiting for your OK (the session page's banner, Home's card, Workspace's row) ----------

/**
 * The answers to Claude Code's permission question: Allow (Enter takes its first answer, "Yes"), the "Yes, and don't
 * ask again …" answer when the question on screen has one (s.always, read by the server from the screen; picked by
 * its number), and Do not allow (Esc). `after` runs once an answer was sent. Null unless the session needs an OK.
 */
export function permissionActions(s, after) {
  if (stateOf(s).key !== 'attention' || s.kind === 'chat') return null;
  const answer = (body, said) => async (e) => {
    e.preventDefault();
    e.stopPropagation(); // on a card: answer, do not open the session
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await api(atOf(s, `/api/sessions/${encodeURIComponent(s.name)}/key`), body);
      toast(said);
      after?.();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    } finally {
      b.disabled = false;
    }
  };
  const a = s.always && /^[1-9]$/.test(s.always.key) ? s.always : null;
  // Claude's own words without "Yes, (and)": "Allow all edits during this session", "Allow, and don't ask again for …".
  const always = a ? (/^allow\b/i.test(a.label) ? a.label : `Allow, and ${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}`) : '';
  return h('div.ok-actions',
    h('button.btn.small.primary', { type: 'button', onclick: answer({ key: 'Enter' }, 'Allowed') }, icon('check', { size: 16 }), h('span', 'Allow')),
    a ? h('button.btn.small.secondary', { type: 'button', title: a.text, onclick: answer({ key: a.key, expect: a.text }, 'Allowed, and Claude will not ask again') },
      icon('checkAll', { size: 16 }), h('span', always)) : null,
    h('button.btn.small.secondary', { type: 'button', onclick: answer({ key: 'Escape' }, 'Not allowed') }, icon('x', { size: 16 }), h('span', 'Do not allow')));
}

// ---------- Auto mode: several subscriptions in the order ----------

const SUBSCRIPTION_KINDS = new Set(['subscription', 'login']);

/** True when the Auto order holds more than one subscription (an API account changes nothing). */
export const manySubscriptions = (accounts) => accounts.filter((a) => a && SUBSCRIPTION_KINDS.has(a.kind)).length > 1;

/** The calm note under the Auto order when it holds more than one subscription; null otherwise. */
export function subscriptionsNote(accounts, readme = REPO_URL) {
  if (!manySubscriptions(accounts)) return null;
  return h('p.banner.muted.subs-note', icon('info', { size: 18 }), h('span',
    'Going from one subscription to another restarts Claude as the next one. Whether continuing past a limit on a second subscription of yours is acceptable is yours to judge against Anthropic\'s terms — the surest order is one subscription, then an API provider. ',
    h('a', { href: `${readme}#is-this-allowed`, target: '_blank', rel: 'noopener' }, 'Is this allowed?')));
}

/** A path under the home folder of the computer as "~/…", the way the rest of the page writes it. */
export function tildePath(p, home = (typeof window !== 'undefined' && window.__home) || '') {
  const s = String(p || '');
  return home && (s === home || s.startsWith(`${home}/`)) ? `~${s.slice(home.length)}` : s;
}
