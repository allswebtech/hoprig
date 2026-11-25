// Shared helpers: DOM building (text only, never innerHTML with data), the one place that builds API and
// WebSocket URLs, per-device preferences, wording, sheets (dialogs) and toasts.
import { APP_NAME, REPO_URL } from './brand.js';
import { deskKeyOf, inTextField, keySet, modifierUp } from './desktop/keymap.js';
import { icon } from './icons.js';
import { keepTabIn } from './tabwrap.js';
import { chrome } from './sessionchrome.js';
import { wayOf } from './errorways.js';

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

/**
 * Replace the children of `el`. Use this (not replaceChildren) so a null child never shows up as "null".
 * A control marked `data-keep-focus` (an answer's button) that has the focus inside `el` gets it back on its new copy
 * with the same mark: the polling draws a card again whenever anything on it changes (a terminal attached, another
 * session's line), and a keyboard user who had reached Allow would otherwise be dropped to the page body.
 */
export function fill(el, ...children) {
  const kept = keptFocus(el);
  el.replaceChildren(...toNodes(children));
  if (kept) giveFocusBack(el, kept);
  return el;
}

function keptFocus(el) {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || typeof a.getAttribute !== 'function' || typeof el.contains !== 'function') return null;
  const k = a.getAttribute('data-keep-focus');
  return k && el.contains(a) ? k : null;
}

function giveFocusBack(el, k) {
  if (typeof el.querySelectorAll !== 'function') return;
  const next = [...el.querySelectorAll('[data-keep-focus]')].find((x) => x.getAttribute('data-keep-focus') === k);
  if (next && !next.disabled) next.focus({ preventScroll: true });
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
/** The WebSocket address of path `p` on computer `m` (null: this one), whatever screen is open (native desktop apps). */
export const wsAt = (m, p) => wsUrl(at(m, p));
export const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${url(p)}`;
// ---------- bare mode: a page inside a window of the desktop ----------

// "/?bare=1#/…" is a page drawn as an app in a window of the desktop (web/desktop/): the frame has no navigation,
// no head tools and no floating buttons, the trail is not saved, the session poll is the desktop's, and Tia is the
// desktop's. The desktop is this same page one level up (framing is allowed for this origin only).
export const BARE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('bare') === '1' && typeof window !== 'undefined' && window.parent !== window;
const bareQuery = BARE ? new URLSearchParams(location.search) : null;
const asHash = (v) => (typeof v === 'string' && /^#\/[^\s<>"']{0,500}$/.test(v) ? v : null);
/**
 * What a window says about itself in its address (web/desktop/apps.js frameSrc), null outside a window: `home` the
 * page its app starts at (the way back leads there; on it there is none, so a Terminal window never turns into
 * another page), `label` the app's name for that way back, `only` the computer whose sessions it shows ('~': this
 * one; the Sessions app of a computer's desktop).
 */
export const WINDOW = BARE
  ? {
    home: asHash(bareQuery.get('home')),
    label: (bareQuery.get('label') || '').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 40) || null,
    only: /^(~|[a-z0-9][a-z0-9_-]{0,31})$/.test(bareQuery.get('only') || '') ? bareQuery.get('only') : null,
  }
  : null;
/** Two in-page addresses that show the same place ("#/m/pc/" and "#/m/pc", "" and "#/"). */
export const samePlace = (a, b) => (a || '#/').replace(/\/+$/, '') === (b || '#/').replace(/\/+$/, '');
/** The desktop around a bare page, or null: only ever this same site's own page (a frame of another one is not). */
export function desktopParent() {
  if (!BARE) return null;
  try {
    return window.parent.location.origin === location.origin ? window.parent : null;
  } catch {
    return null;
  }
}
/** Tell the desktop something ({ type: 'hoprig:…' }); a page outside the desktop has nobody to tell. */
export function tellDesktop(msg) {
  const p = desktopParent();
  if (p) p.postMessage(msg, location.origin);
  return !!p;
}
/**
 * Ask the desktop to close the window this page is in: a session that ended on the window's own start page has no
 * page left to go back to (trail.js windowWay). False outside a window.
 */
export const closeWindow = () => tellDesktop({ type: 'hoprig:close' });
/** Open app `app` of the desktop at `hash` (on this page's computer, written without it): a window of the desktop
 * around this page, or the page itself outside the desktop. */
export function openApp(app, hash) {
  if (!tellDesktop({ type: 'hoprig:open', app, hash })) location.hash = link(hash);
}
/**
 * Go to page `hash` (written without the computer) in place. Inside the desktop, a window that shows that page
 * already comes forward instead (one window per session); else this window turns into it, as a page does.
 */
export function goTo(hash) {
  if (!tellDesktop({ type: 'hoprig:goto', hash: link(hash) })) location.hash = link(hash);
}
if (BARE) {
  // The desktop gives a window the keyboard (web/desktop/frames.js giveKeys): the page's own place for typing takes
  // it, as a press into it would (the terminal, the editor, a chat's message box). A page still being drawn is
  // waited for a moment.
  const takeKeys = () => {
    let n = 0;
    const take = () => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const el = document.querySelector('.xterm-helper-textarea, .monaco-editor textarea, textarea.chat-input, [autofocus]');
      if (el) el.focus();
      else if (++n < 30 && document.hasFocus()) setTimeout(take, 100);
    };
    take();
  };
  window.addEventListener('focus', takeKeys);
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.origin === location.origin && e.data && e.data.type === 'hoprig:keys') takeKeys();
  });
  // The desktop's window keys work while the keyboard is inside a window too (web/desktop/wmkeys.js): taken before the
  // page sees them (a terminal would send them to its program), except the arrows in the code editor and a text box,
  // which keep them. The let-go of the keys ends a cycle through the windows.
  const keys = () => keySet(prefs.get('desktop.keys', 'alt-shift'));
  window.addEventListener('keydown', (e) => {
    // Escape while this window is being moved or resized on the desktop: the move is let go there (moves.js).
    if (e.key === 'Escape' && desktopParent()?.document.querySelector('.desk-busy')) {
      e.preventDefault();
      tellDesktop({ type: 'hoprig:escape' });
      return;
    }
    // F6, as between the panes of a desktop's app: the keyboard leaves the page for its window's title bar. Kept with
    // the keys off too, so a terminal or the editor (which keep Tab) is never a trap.
    if (e.key === 'F6' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && tellDesktop({ type: 'hoprig:leave' })) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const act = deskKeyOf(e, keys(), { inText: inTextField(document.activeElement) });
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    tellDesktop({ type: 'hoprig:key', act });
  }, true);
  window.addEventListener('keyup', (e) => {
    if (modifierUp(e, keys())) tellDesktop({ type: 'hoprig:keyup' });
  }, true);
}

/** An in-page link to a screen of computer `m` (default: the open one): "#/s/x" -> "#/m/laptop/s/x". */
export const link = (hash, m = MACHINE) => (m ? `#/m/${m}${hash.slice(1)}` : hash);

export class ApiError extends Error {
  // machine: the computer that answered (null: this one), so a way to a place opens it on that computer.
  constructor(message, status, data = {}, machine = null) {
    super(message);
    this.status = status;
    this.code = data.code || null; // e.g. offline, computer-not-allowed, not-installed (from another computer)
    this.data = data;
    this.machine = machine;
  }
}

/** The words of an error, of a result { error }, or a text as it is. */
export const errorWords = (e) => (isErrorLike(e) ? String(e.message || e.error || '') : e);
const isErrorLike = (e) => Boolean(e) && typeof e === 'object' && !Array.isArray(e) && !(typeof Node !== 'undefined' && e instanceof Node);

/** Where the way of an error's code leads (errorways.js), on the computer that answered; null without one. */
export function wayHref(err, w = wayOf(err)) {
  if (!w) return null;
  return w.perComputer ? link(w.href, err && err.machine !== undefined ? err.machine : MACHINE) : w.href;
}

/** The button to the place an error's code names, or null. It only opens the place: he changes it himself. */
export function wayLink(err) {
  const w = wayOf(err);
  return w ? h('a.btn.secondary.err-way', { href: wayHref(err, w) }, w.button || `Open ${w.label}`) : null;
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
    // Inside a window of the desktop the whole desktop goes to the login, not this one window.
    if (!tellDesktop({ type: 'hoprig:logged-out' })) location.href = url('/login');
    throw new ApiError('Logged out', 401);
  }
  const data = await r.json().catch(() => ({}));
  const from = (/^\/m\/([a-z0-9][a-z0-9_-]{0,31})\//.exec(url(path)) || [])[1] || null;
  if (!r.ok) throw new ApiError(data.error ? data.error.charAt(0).toUpperCase() + data.error.slice(1) : `Request failed (${r.status})`, r.status, data, from);
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
  hostkey: 'Its host key changed',
};

// Why a computer that is not online cannot take work, by its state (src/machines/hub.mjs): only "offline" did not
// answer; the others answered and say what to do there (the New session sheet, the Operator's Computers part).
export const NOT_ONLINE = {
  offline: 'Did not answer when asked',
  unauthorised: 'It no longer lets this dashboard in. Add it again here: Computers → Add a computer',
  'too-old': 'Its Hoprig is too old for this dashboard: update it there',
  hostkey: 'Its host key changed: check it under Computers',
  connecting: 'Still connecting',
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
// A choice made in another tab, or in the desktop around this window, applies here at once.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'pref:page.theme') applyPageTheme();
  });
}

// ---------- wording ----------

export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  return `${span(s * 1000)} ago`;
}

/** A length of time in the one unit rule of the page: "5 min", "7 h", "1 day", "2 days" (ago() and Home's End sheet). */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * "in 2 h 10 min" / "Mon 17:00" for a time in the future. Always the 24-hour clock, as schedules write their rule
 * ("Weekdays at 18:00"), so one list never mixes "18:00" with "06:00 PM".
 */
export function until(ms) {
  if (!ms) return '';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 60) return 'any moment';
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  const min = Math.round(s / 60); // whole minutes first: 1 h 59.7 min is "2 h 0 min", never "1 h 60 min"
  if (s < 12 * 3600) return `in ${Math.floor(min / 60)} h ${min % 60} min`;
  const d = new Date(ms);
  const day = d.toLocaleDateString([], { weekday: 'short' });
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

// What waits for the owner, by what is asked (the card's ask.type): a question the coding tool puts to him and a plan
// to approve are no permission, so they do not read "OK".
const ASK_TEXT = { question: 'Needs your answer', plan: 'Needs your approval', mcp: 'Needs your answer' };

/** What a session is doing, in plain words, and how urgent it is (lower = needs you sooner). */
export function stateOf(s) {
  if (s.limit || s.runLimit) return { key: 'limit', text: 'Limit reached', rank: 1 };
  // The coding tool ended at its start (src/startfail.mjs): its terminal is back at the shell, but this is no terminal.
  if (s.startFailed) return { key: 'failed', text: 'Did not start', rank: 0 };
  if (s.kind === 'shell') return { key: 'shell', text: 'Terminal', rank: 6 };
  // Answered a moment ago: the card stays where it was for a second, saying so (heldWord, below).
  // `done`: its pill takes the colour of what was answered (style.css .st-done), not the one of a question waiting.
  const word = heldWord(s);
  if (word) return { key: 'attention', text: word, rank: 0, ...(word === 'Allowed' ? { done: true } : {}) };
  switch (s.status) {
    // A notice is Claude Code's own question before it starts (src/askcard.mjs): nothing to allow, so not "OK".
    case 'attention': return { key: 'attention', text: (s.ask && ASK_TEXT[s.ask.type]) || (s.askCard && s.askCard.kind === 'notice' ? (s.askCard.notice && s.askCard.notice.type === 'trust' ? 'Trust this folder?' : 'Asks you first') : 'Needs your OK'), rank: 0 };
    case 'waiting': return { key: 'waiting', text: 'Waiting for your next message', rank: 2 };
    case 'starting': return { key: 'starting', text: 'Starting', rank: 3 };
    // `background`: the reply ended, but subagents or a workflow go on and Claude continues when they finish.
    case 'working': return { key: 'working', text: s.background ? 'Working in the background' : 'Working', rank: 4 };
    case 'ended': return { key: 'ended', text: 'Finished', rank: 5 };
    default: return { key: 'shell', text: s.status || 'Unknown', rank: 6 };
  }
}

/** What Home groups as "Needs you": a question waiting for an OK, or a limit. Every count of it uses this. */
export const needsYou = (s) => ['attention', 'limit', 'failed'].includes(stateOf(s).key);

/**
 * A session waiting for the owner, while a command it started still runs in the background (the run record's
 * bgCommands, hook.mjs): one plain line for the card. The state stays "Waiting for your next message" — the owner
 * must still message it — and this line only says a command may carry on by itself. null when there is none.
 */
export const BG_COMMAND_LINE = 'A command it started still runs in the background. It may go on by itself when that ends.';
export const bgCommandNote = (s) => (s && Number(s.bgCommands) > 0 && stateOf(s).key === 'waiting' ? BG_COMMAND_LINE : null);

// A card held a second after his answer keeps the time it had, so it stays in its place (hold, below).
const sortTime = (s) => heldTime(s) ?? (s.statusAt || s.activity || 0);
export const needsYouFirst = (a, b) => stateOf(a).rank - stateOf(b).rank || sortTime(b) - sortTime(a);

/** The state chip: "● Working · 2 min ago". `text: false` (its group's heading says the state): "● 2 min ago". */
export function statusPill(s, { time = true, text = true } = {}) {
  const st = stateOf(s);
  const at = s.statusAt || s.activity;
  const when = time && at ? ago(at) : '';
  const cls = `span.pill.st-${st.key}${st.done ? '.st-done' : ''}`;
  if (!text && when) return h(cls, { title: st.text }, h('span.dot'), h('span.pill-time', { dataset: { at, bare: '1' } }, when));
  return h(cls, h('span.dot'), st.text, when ? h('span.pill-time', { dataset: { at } }, ` · ${when}`) : null);
}

export const KIND = { login: 'Subscription', subscription: 'Subscription', api: 'API', openai: 'OpenAI API', chatgpt: 'Codex sign-in', auto: 'Auto mode', unknown: 'Provider' };
/**
 * What a provider is, in words. The server's data decides, not a list in the page: a sign-in of a coding tool that
 * computer's Hoprig does not offer comes with `unusable` (src/profiles.mjs publicProfile) and is named without the
 * tool; the same kind from a computer that offers it (or an older one, which does not say) keeps its own name.
 */
export const kindLabel = (p) => (p.unusable && p.kind === 'chatgpt' ? 'Sign-in of another coding tool' : KIND[p.kind] || p.kind);

/** The coding tools by id, as the page names them. */
export const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
/** "Claude Code · OpenCode": the coding tools a provider serves (src/profiles.mjs servesTools), or '' when unknown. */
export const toolsText = (p) => (Array.isArray(p.tools) ? p.tools.map((t) => TOOL_NAMES[t] || t).join(' · ') : '');
/**
 * Providers a Claude Code session or chat may use: the ones that serve it. A computer too old to say (no `tools`)
 * has only Claude Code providers; Auto mode is Claude Code's.
 */
export const servesClaude = (p) => Boolean(p) && (p.virtual || !Array.isArray(p.tools) || p.tools.includes('claude'));

/**
 * What a session card is (the same rules as src/automation/cards.mjs): a coding session in a terminal has kind
 * "claude" whatever its coding tool, and `tool` names the tool (absent on older computers: Claude Code).
 */
export const isCodingCard = (s) => Boolean(s) && ['claude', 'codex', 'opencode'].includes(s.kind);
export const cardTool = (s) => (s && typeof s.tool === 'string' ? s.tool : s && (s.kind === 'claude' || s.kind === 'chat') ? 'claude' : s && isCodingCard(s) ? s.kind : null);
export const isClaudeCard = (s) => isCodingCard(s) && cardTool(s) === 'claude';
/** A provider that may take a session of coding tool `tool` (Auto mode only for Claude Code). */
export const servesTool = (p, tool) => (tool === 'claude' ? servesClaude(p) : Boolean(p) && !p.virtual && Array.isArray(p.tools) && p.tools.includes(tool));

/** The small chip with the coding tool's name, on a session or chat that is not Claude Code's. */
export function toolChip(s) {
  const t = cardTool(s);
  return (isCodingCard(s) || (s && s.kind === 'chat')) && t && t !== 'claude' ? h('span.badge.toolchip', TOOL_NAMES[t] || t) : null;
}
/** The same chip for a coding tool by its id (a conversation in a list, a chat's head); none for Claude Code. */
export const toolBadge = (t) => (t && t !== 'claude' ? h('span.badge.toolchip', TOOL_NAMES[t] || t) : null);
/** A session whose status is read from its screen's activity only (Working or Waiting; never "Needs your OK"). */
export const liveBasic = (s) => (s && s.liveStatus === 'basic'
  ? h('span.badge.soft', { title: 'Hoprig sees only whether the screen changes: Working or Waiting. A question or a limit shows in the terminal.' }, 'Live status: basic')
  : null);

/** How a session's account reads: "Auto · now on Work" for Auto sessions, else the account's name. */
export const profileText = (s) =>
  !s.profile ? '' : s.profile.name === 'auto' ? (s.autoOn ? `Auto · now on ${s.autoOn.label}` : 'Auto') : s.profile.label;
export const profileIcon = (p) => (p && p.name === 'auto' ? 'zap' : 'user');

/**
 * How soon a provider starts its answers, as the router measured it (src/routerstate.mjs speedVerdict), or null while
 * that is not known.
 */
export function speedWords(speed) {
  if (!speed) return null;
  if (speed.verdict === 'refusing') return 'Refusing now (too many requests)';
  const n = Math.max(1, Math.round(Number(speed.seconds) || 0));
  const secs = `${n} second${n === 1 ? '' : 's'}`;
  if (speed.verdict === 'slow') return `Slow now: about ${secs} to start an answer`;
  return speed.verdict === 'fast' ? `Answers in about ${secs}` : null;
}

export function profileState(p) {
  if (p.virtual) return { key: 'free', text: 'Uses your providers in order; never stops at a limit' };
  // A sign-in provider whose sign-in is gone (or never finished): it cannot be used until someone signs in again.
  if (p.signedIn === false) return { key: 'signin', text: 'Not signed in' };
  // A provider that serves no coding tool this computer's Hoprig offers (src/profiles.mjs): kept, never used.
  if (p.unusable) return { key: 'unusable', text: 'Not used by this version of Hoprig' };
  // Its PRERUN starts a gateway that was removed (src/server/accounts.mjs): its sessions end at the start.
  if (p.gatewayGone) return { key: 'unusable', text: `Its gateway ${p.gatewayGone.id} ${p.gatewayGone.notLoaded ? 'was not loaded' : 'was removed'}` };
  // A Codex sign-in when Codex is not installed (or does not say whether it is signed in).
  if (p.kind === 'chatgpt' && p.signedIn == null) return { key: 'signin', text: 'Codex is not installed' };
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
let sheetNow = null; // the open sheet: { resolve, result }
let sheetSkip = 0; // close events still to come from sheets that made way for the next one
function sheetElement() {
  if (!sheetEl) {
    sheetEl = h('dialog.sheet', { 'aria-modal': 'true' });
    // Tap outside the panel closes it, and Escape does, but not a sheet that must be closed by its own button (`keep`).
    const kept = () => !!(sheetNow && sheetNow.keep);
    sheetEl.addEventListener('click', (e) => {
      if (e.target === sheetEl && !kept()) sheetEl.close();
    });
    sheetEl.addEventListener('cancel', (e) => {
      if (kept()) e.preventDefault();
    });
    sheetEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && kept()) e.preventDefault(); // a browser that no longer lets a second cancel be stopped
    });
    keepTabIn(sheetEl); // Tab stays in the sheet
    // The browser reports a close a moment later. A sheet that made way for another one was answered already: its
    // report must not end the one that is open now.
    sheetEl.addEventListener('close', () => {
      placeToasts();
      if (sheetSkip > 0) return void sheetSkip--;
      const s = sheetNow;
      // A kept sheet the browser closed by itself (a phone's back gesture: Chrome lets a page stop that only once per
      // tap, or not at all) opens again: only its own buttons end it, and what it shows is not lost without a word.
      if (s && s.keep && !s.closing) {
        sheetEl.showModal();
        const again = sheetEl.querySelector('[autofocus]');
        if (again) again.focus();
        return;
      }
      sheetNow = null;
      if (s) s.resolve(s.result);
      // The focus goes back to what opened the sheet (else it lands on the page's body, far from where he was).
      if (s && s.opener && s.opener.isConnected && typeof s.opener.focus === 'function') s.opener.focus();
    });
    document.body.append(sheetEl);
  }
  return sheetEl;
}

/**
 * Open a sheet. `build(close)` returns its content. Resolves with the value passed to close(), or null. A sheet
 * opened while another is open takes its place: the earlier one resolves (null) at once. `wide`: room for two
 * columns on a desktop; `tall`: a form with several rows of choices (the whole height on a phone); `keep`: closed
 * only by its own buttons (no X, no Escape, no tap outside), for what is lost when it closes unread. When it closes,
 * the focus goes back to what had it when the first of a row of sheets opened.
 */
export function openSheet({ title, subtitle, wide = false, tall = false, keep = false }, build) {
  const d = sheetElement();
  // The sheet that is open, or was closed a moment ago and not reported yet, is answered now; its report is skipped.
  const before = sheetNow;
  const opener = before ? before.opener : document.activeElement;
  if (before) {
    sheetNow = null;
    sheetSkip++;
    if (d.open) d.close();
    before.resolve(before.result);
  } else if (d.open) d.close();
  return new Promise((resolve) => {
    const mine = { resolve, result: null, opener, keep };
    const close = (value = null) => {
      if (sheetNow !== mine) return; // it made way already
      mine.result = value;
      mine.closing = true;
      d.close();
    };
    d.classList.toggle('wide', wide);
    d.classList.toggle('sheet-tall', tall);
    if (toastBox && toastBox.parentNode === d) document.body.append(toastBox); // not taken away with the old content
    fill(d,
      h('div.sheet-grip', { 'aria-hidden': 'true' }),
      h('header.sheet-head',
        h('div', h('h2.sheet-title', title), subtitle ? h('p.sheet-sub', subtitle) : null),
        keep ? null : btn('icon ghost', { icon: 'x', title: 'Close', onclick: () => close(null) })),
      h('div.sheet-body', build(close)),
    );
    sheetNow = mine;
    d.showModal();
    placeToasts();
    const focus = d.querySelector('[autofocus]');
    if (focus) focus.focus();
  });
}

/** Close the sheet that is open, if one is (it resolves as its Close button would). */
export function closeSheet() {
  if (sheetEl && sheetEl.open) sheetEl.close();
}

export function confirmSheet({ title, text, ok = 'OK', danger = false }) {
  return openSheet({ title }, (close) => [
    text ? h('p.sheet-text', text) : null,
    h('div.sheet-actions',
      // Cancel has the focus: Enter still says no, and the action is one Tab away (not behind the X).
      h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close(false) }, 'Cancel'),
      h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: () => close(true) }, ok)),
  ]).then((v) => v === true);
}

/** A form with one field. `check(value)` returns an error message or ''. `danger`: the button that does it is red;
 * `label`: what the field is, for a screen reader (the title by default); `select`: [start, end] of the value chosen
 * when the sheet opens (a rename: the name without its extension). */
export function promptSheet({ title, text, value = '', ok = 'OK', placeholder = '', type = 'text', check = () => '', multiline = false, danger = false, label = null, select = null }) {
  return openSheet({ title }, (close) => {
    const named = { 'aria-label': label || title };
    const input = multiline
      ? h('textarea.field', { value, placeholder, autofocus: true, rows: 5, ...named })
      : h('input.field', { type, value, placeholder, autofocus: true, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...named });
    if (select) queueMicrotask(() => input.setSelectionRange(...select)); // after openSheet focuses it
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
      h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'submit' }, ok)));
  });
}

/** A list of choices: [{ value, label, sub, icon, badge, disabled, current }]. */
/** `more`: { label, items } of rare choices, folded under the list (open when the current one is among them). */
export function chooseSheet({ title, subtitle, items, more = null }) {
  return openSheet({ title, subtitle }, (close) => {
    const row = (it) => h(`button.choice${it.current ? '.current' : ''}${it.danger ? '.danger' : ''}`, { type: 'button', disabled: it.disabled, onclick: () => close(it.value) },
      it.icon ? h('span.choice-icon', icon(it.icon)) : null,
      h('span.choice-main', h('span.choice-label', it.label, it.badge ? h('span.badge', it.badge) : null), it.sub ? h('span.choice-sub', it.sub) : null),
      it.current ? h('span.choice-end', icon('check')) : h('span.choice-end', icon('chevronRight')));
    const list = h('div.choice-list', items.map(row));
    if (!more || !more.items.length) return list;
    return [list, h('details.adv.choice-more', { open: more.items.some((it) => it.current) },
      h('summary', more.label), h('div.choice-list', more.items.map(row)))];
  });
}

// ---------- toasts ----------

let toastBox = null;
// An open sheet is a modal dialog: the browser makes everything outside it inert and draws it above the rest, so a
// toast on the body could not be pressed (Undo, Open). While a sheet is open the toasts are in it (still fixed to the
// screen's corner), and back on the body when it closes. A sheet still sliding in is a transformed box, which a fixed
// toast in it would be drawn inside of: they go in when it stands.
function placeToasts() {
  if (!toastBox) return;
  const sheet = sheetEl && sheetEl.open ? sheetEl : null;
  const moving = sheet && sheet.getAnimations ? sheet.getAnimations().find((a) => a.playState === 'running') : null;
  if (moving) return void moving.finished.then(placeToasts, placeToasts);
  const into = sheet || document.body;
  if (toastBox.parentNode !== into) into.append(toastBox);
}
// `text` may be the error itself (or `from` names it): its code's place (errorways.js) becomes the toast's button.
export function toast(text, { kind = 'info', ms = 3500, action = null, from = null } = {}) {
  if (!toastBox) toastBox = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
  placeToasts();
  const err = from || (isErrorLike(text) ? text : null);
  text = errorWords(text);
  const way = !action && err ? wayOf(err) : null;
  if (way) {
    const to = wayHref(err, way);
    action = { label: way.button || `Open ${way.label}`, run: () => (location.hash = to) };
    ms = Math.max(ms, 8000);
  }
  // `action` { label, run, title }: one button on the toast (Undo); pressing it runs it and the toast goes.
  const t = h(`div.toast.${kind}`, icon(kind === 'error' ? 'alert' : 'check', { size: 18 }), h('span', text),
    action ? h('button.btn.ghost.small.toast-action', { type: 'button', ...(action.title ? { title: action.title, 'aria-label': action.title } : {}), onclick: () => {
      t.remove();
      action.run();
    } }, action.label) : null);
  // A tap on the toast itself (not its button) closes it.
  t.addEventListener('click', (e) => {
    if (!(e.target && e.target.closest && e.target.closest('.toast-action'))) t.remove();
  });
  toastBox.append(t);
  let timer = setTimeout(() => t.remove(), ms);
  if (action) {
    // A toast with a button stays while the pointer or the keyboard is on it, and a moment after.
    const hold = () => clearTimeout(timer);
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => t.remove(), 3000);
    };
    t.addEventListener('pointerenter', hold);
    t.addEventListener('focusin', hold);
    t.addEventListener('pointerleave', later);
    t.addEventListener('focusout', later);
  }
  return t;
}

// ---------- switching profiles (used by Home and the session view) ----------

/** Confirm, then continue session `s` under profile `p`. Resolves true when it was moved. */
export async function switchProfile(s, p) {
  const ok = await confirmSheet({
    title: `Continue on ${p.label}?`,
    text:
      `${TOOL_NAMES[cardTool(s)] || 'Claude'} in "${s.name}" stops and the same conversation continues on ${p.label}. ` +
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
    toast('The session has not reported its conversation yet. Try again in a moment.', { kind: 'error' });
    return false;
  }
  const tool = cardTool(s) || 'claude';
  const pick = await chooseSheet({
    title: 'Run this session on…',
    // Only the providers that serve its coding tool: a conversation stays in the tool it was started in.
    subtitle: tool === 'claude' ? 'The conversation continues where it is.' : `The conversation stays in ${TOOL_NAMES[tool] || tool} and continues where it is.`,
    items: profiles.filter((p) => servesTool(p, tool)).map((p) => ({
      value: p.name,
      label: p.label,
      sub: p.virtual ? profileState(p).text : `${kindLabel(p)} · ${profileState(p).text}`,
      icon: profileIcon(p),
      current: s.profile && p.name === s.profile.name,
      disabled: s.profile && p.name === s.profile.name,
    })),
  });
  const p = profiles.find((x) => x.name === pick);
  return p ? switchProfile(s, p) : false;
}

// Paid per use: the server says so (`paid`, src/profiles.mjs isPayPerUse). A computer too old to say it: an API
// provider counts as paid, the safe side.
export const isPaid = (p) => p.paid === true || (p.paid === undefined && p.kind === 'api');

/**
 * The order Auto mode starts with when the owner turns it on: subscriptions, then gateways; pay-per-use keys only
 * with "also use pay-per-use providers" on, and then last. Returns the names.
 */
export function startOrder(accounts, payPerUse = false) {
  const rank = (a) => (SUBSCRIPTION_KINDS.has(a.kind) ? 0 : isPaid(a) ? 2 : 1);
  return accounts.filter((a) => servesClaude(a) && (payPerUse || !isPaid(a))).map((a, i) => [rank(a), i, a.name]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
}

/**
 * Where sessions can go on, best first: the one chooser of the limit card's main button (limitBox) and of Home's
 * near-limit line (home.js accountsLine), so one screen never names two ways on. Providers that are signed in, real
 * (not Auto mode), not at a limit and serve Claude Code, in the order Auto mode uses (`autoPlace`); outside that
 * order, subscriptions before gateways, as Auto's own order starts. Not one almost used up (`nearLimit`): it would
 * stop the session again soon. `skip` leaves more out (the session's own one).
 */
export function waysOn(profiles, skip = () => false) {
  const place = (p) => (Number.isInteger(p.autoPlace) ? p.autoPlace : 1000 + (SUBSCRIPTION_KINDS.has(p.kind) ? 0 : 1));
  return profiles.filter((p) => !skip(p) && p.signedIn !== false && !p.virtual && !p.limited && !nearLimit(p) && servesClaude(p)).sort((a, b) => place(a) - place(b));
}
/** From this share of a limit a provider is "almost used up": Home's line warns, and it is no way on. */
export const NEAR = 90;
/** The limit a provider is nearest, when it is at NEAR or more: ['5-hour' | 'weekly', { pct }], else undefined. */
export function nearLimit(p) {
  const u = (p && p.usage) || {};
  return [['5-hour', u.fiveHour], ['weekly', u.week]].filter(([, x]) => x && Number.isFinite(x.pct) && x.pct >= NEAR).sort((x, y) => y[1].pct - x[1].pct)[0];
}
/** The words every paid way carries, whatever its label says ("API (pay as you go)" too). */
export const costWords = (p) => (isPaid(p) ? ' · costs money per use' : '');

/**
 * More actions for the "limit reached" box, added by the part that owns them (claudeaccount.js: sign in with another
 * Claude account). Each is fn(session, profiles, after) → buttons or null; a button of class "primary" leads.
 */
export const limitActions = [];

// The sessions whose "Other ways" he opened: the card is drawn anew with each look, and stays open.
const limitOpen = new Set();
/**
 * The red "limit reached" box with one button per other profile. The main button is the first free provider in
 * the order Auto mode uses (`autoPlace`), never a paid one, and stands alone; the others are under "Other ways".
 * Auto mode's button says where it would go next.
 */
export function limitBox(s, profiles, after) {
  if (!s.limit && !s.runLimit) return null;
  const text = (s.limit && s.limit.text) || (s.runLimit && s.runLimit.error) || '';
  // Not one that is not signed in: the session would stop there at once.
  const others = profiles.filter((p) => (!s.profile || p.name !== s.profile.name) && p.signedIn !== false && servesClaude(p));
  const free = waysOn(others);
  const main = free.find((p) => !isPaid(p)) || null;
  // Auto runs as the first free subscription of its order, else the router uses the first free provider of it.
  const inAuto = free.filter((p) => Number.isInteger(p.autoPlace));
  const autoNext = inAuto.find((p) => SUBSCRIPTION_KINDS.has(p.kind)) || inAuto[0] || null;
  // Every paid way says so in the same words. Auto mode in plain words: what it does each time, and where it goes next.
  const cost = costWords;
  const words = (p) => (p.virtual
    ? (autoNext ? `Go on with the next provider that has room each time (next: ${autoNext.label}${cost(autoNext)})` : 'Go on with the next provider that has room each time')
    : `Continue on ${p.label}${cost(p)}`);
  // The main one first, then Auto, then the rest; paid ones last.
  const rank = (p) => (p === main ? 0 : p.virtual ? 1 : isPaid(p) ? 3 : 2);
  const shown = others.map((p, i) => [rank(p), i, p]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
  const extra = toNodes(limitActions.map((fn) => fn(s, profiles, after)));
  const leads = extra.filter((b) => /(^|\s)primary(\s|$)/.test(b.className || ''));
  const moves = s.canSwitch
    ? shown.map((p) =>
      h(`button.btn.small.${p === main && !leads.length ? 'primary' : 'secondary'}`, {
        type: 'button',
        onclick: async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (await switchProfile(s, p)) after?.();
        },
      }, icon('swap', { size: 16 }), h('span', words(p))))
    : [];
  // One way in front (what leads, else the first free account), the others under "Other ways", so he is not asked to
  // tell three buttons apart. With nothing in front, nothing is folded away.
  const front = [...leads, ...(main && s.canSwitch ? [moves[shown.indexOf(main)]] : [])];
  const rest = [...moves, ...extra.filter((b) => !leads.includes(b))].filter((b) => !front.includes(b));
  const fold = front.length && rest.length
    ? h('details.limit-more', {
      open: limitOpen.has(askKey(s)),
      ontoggle: (e) => (e.currentTarget.open ? limitOpen.add(askKey(s)) : limitOpen.delete(askKey(s))),
    },
    // On a card: open the fold, not the session behind it.
    h('summary.limit-more-summary', { onclick: (e) => e.stopPropagation() }, 'Other ways', icon('chevronDown', { size: 16 })),
    h('div.limit-actions', rest))
    : null;
  return h('div.limitbox', { role: 'alert', ...chrome() },
    h('div.limit-head', icon('alert'), h('strong', 'Limit reached'), s.limit && s.limit.resets && !text.includes(s.limit.resets) ? h('span', ` · resets ${s.limit.resets}`) : null),
    text ? h('p.limit-text', text) : null,
    s.autoMove ? h('p.limit-text', `Moving to ${s.autoMove} automatically…`) : null,
    fold ? [h('div.limit-actions', front), fold] : moves.length || extra.length ? h('div.limit-actions', leads, moves, extra.filter((b) => !leads.includes(b))) : null,
  );
}

// ---------- a question waiting for your OK (the session page's banner, Home's card, Workspace's row) ----------

// The question the owner answered a moment ago, per session. The page learns what the coding tool did with the
// answer only with its next look at the sessions; until then the card still says "needs your OK", and a second press
// would answer whatever came next. So the answers are not offered again until the card says something else: the tool
// went on, or asked again (another `askAt`). The server types an answer only into a permission question, so the
// question is answered; should the card say nothing new for ten seconds all the same, the answers return.
const ANSWERED_MS = 10_000;
const answered = new Map(); // `${computer}|${session}` → { ask, until }
const askKey = (s) => `${s.machine ?? ''}|${s.name}`;
const askOf = (s) => s.askAt || s.statusAt || 0;
// After his answer the card stays one second in its place as "Allowed" (or "Not allowed"), whatever the next look says,
// so the card under it does not slide up under his finger; then the page looks again and it moves.
const HOLD_MS = 1000;
const holding = new Map(); // `${computer}|${session}` → { word, until, at }
function heldWord(s, now = Date.now()) {
  const x = s && s.name ? holding.get(askKey(s)) : null;
  if (x && now < x.until) return x.word;
  if (x) holding.delete(askKey(s));
  return null;
}
function heldTime(s) {
  return heldWord(s) ? holding.get(askKey(s)).at : null;
}
function hold(s, word, after) {
  holding.set(askKey(s), { word, until: Date.now() + HOLD_MS, at: s.statusAt || s.activity || 0 });
  setTimeout(() => after?.(), HOLD_MS + 50);
}
const whoOf = (s) => s.display || s.name;
// The held card's line: what he pressed, as plain text (a green check for Allowed), never drawn like a button.
const doneLine = (word, attrs = {}) => h(`p.ok-how.ok-done${word === 'Allowed' ? '.ok-allowed' : ''}`, { role: 'status', ...attrs }, icon(word === 'Allowed' ? 'check' : 'x', { size: 16 }), h('span', word));

/** The owner answered this session's question a moment ago and its card has not changed since. */
export function answeredNow(s, now = Date.now()) {
  if (heldWord(s, now)) return true;
  const a = answered.get(askKey(s));
  if (a && a.ask === askOf(s) && now < a.until) return true;
  answered.delete(askKey(s));
  return false;
}

/**
 * The answers to Claude Code's permission question: Allow (Enter takes its first answer, "Yes"), the "Yes, and don't
 * ask again …" answer when the question on screen has one (s.always, read by the server from the screen; picked by
 * its number), and Do not allow (Esc). `after` runs once an answer was sent, and again a moment later (the coding
 * tool has gone on by then). Null unless the session needs an OK.
 * A question Claude puts to the owner and a plan to approve (s.ask.type, from the hook) are no permission: there is
 * nothing to allow, and Enter would pick an answer nobody read. They are answered in the terminal, so a card leads
 * there; the session page says so itself (`here`).
 * A chat (s.ask, from src/chat/feature.mjs) gets the same: Allow, Allow in this chat, Do not allow; a question or a
 * plan to approve is answered in the chat itself, so its card leads there.
 */
// After an answer the buttons are replaced, so the focused one is gone. Like handsOffBar, a short window moves focus
// to the "answer was sent" line on the next render, so a keyboard or screen-reader user is told there, not dropped to
// the page body.
let answerFocusUntil = 0;

/**
 * A permission note as the chat's card says it (web/chat/words.js): the hook writes "Claude needs your permission to
 * use Bash: <command>" (src/hook.mjs), the card reads "Claude wants to run: <command>". The command stays exact; any
 * other note is shown as it is.
 */
export function askNote(note) {
  const m = /^(\S+) needs your permission(?: to use (\S+?)(?::\s*([\s\S]*))?)?$/.exec(String(note || ''));
  if (!m) return String(note || '');
  const [, who, tool, what] = m;
  if (!tool) return `${who} wants your OK`;
  if (tool === 'Bash') return what ? `${who} wants to run: ${what}` : `${who} wants to run a command`;
  return `${who} wants to use ${tool}${what ? `: ${what}` : ''}`;
}

export function permissionActions(s, after, { here = false } = {}) {
  if (stateOf(s).key !== 'attention') return null;
  if (s.kind === 'chat') return chatAnswers(s, after);
  // The answer keys are Claude Code's: in Codex and OpenCode the owner answers in the terminal.
  if (!isClaudeCard(s)) return null;
  // A live region, so a screen reader is told; focusable, so the keyboard lands here and not on the page body. Each
  // render within the window after an answer reclaims focus to this line if it fell to the body (the polling re-renders
  // replace the old line), but never steals it from somewhere the owner moved it. `word`: the held card's "Allowed".
  const sent = ({ focus = false, word = null } = {}) => {
    const line = word ? doneLine(word, { tabindex: '-1' }) : h('p.ok-how', { role: 'status', tabindex: '-1' }, 'Your answer was sent.');
    if (focus && answerFocusUntil > Date.now()) {
      setTimeout(() => {
        try {
          if (line.isConnected !== false && (document.activeElement === document.body || !document.activeElement)) line.focus();
        } catch { /* not focusable in this host */ }
      }, 0);
    }
    return line;
  };
  const held = heldWord(s);
  if (held) return h('div.ok-actions', sent({ focus: true, word: held }));
  const type = s.ask && s.ask.type;
  if (type === 'question' || type === 'plan') {
    if (here) return h('p.ok-how', type === 'plan' ? 'Read the plan in the terminal below and choose there.' : 'Answer in the terminal below: the arrow keys choose, Enter takes the answer.');
    return h('div.ok-actions', h('a.btn.small.primary', { href: link(`#/s/${encodeURIComponent(s.name)}`, s.machine ?? machine.current), onclick: (e) => e.stopPropagation() },
      icon('terminal', { size: 16 }), h('span', type === 'plan' ? 'Read the plan' : 'Answer')));
  }
  if (answeredNow(s)) return sent({ focus: true });
  // The server types an answer only into the dialog that shows this card's command or file, and only while one asker
  // waits (server.mjs): with more, or with nothing to find on the screen, the owner answers in the terminal.
  const what = s.ask && typeof s.ask.what === 'string' ? s.ask.what : '';
  if (!what || (s.ask && s.ask.waiting > 1)) {
    const why = s.ask && s.ask.waiting > 1 ? 'More than one question waits: answer them in the terminal' : 'Answer in the terminal';
    if (here) return h('p.ok-how', `${why} below.`);
    // A notice (Claude Code's own question before it starts, its words are the card's note): the page cannot answer
    // it, so the card says where it is answered and how to get there.
    const said = s.askCard && s.askCard.kind === 'notice' ? 'Claude Code asks this in its own window: press Answer to open it.' : `${why}.`;
    return h('div.ok-actions', h('p.ok-how', said), h('a.btn.small.primary', { href: link(`#/s/${encodeURIComponent(s.name)}`, s.machine ?? machine.current), onclick: (e) => e.stopPropagation() },
      icon('terminal', { size: 16 }), h('span', 'Answer')));
  }
  const box = h('div.ok-actions');
  const buttons = [];
  const answer = (body, said, word = 'Allowed') => async (e) => {
    e.preventDefault();
    e.stopPropagation(); // on a card: answer, do not open the session
    for (const b of buttons) b.disabled = true;
    try {
      // `owner`: the owner's own answer; `question`: typed only while a permission question is on the screen, `about`:
      // one that shows this command or file (server.mjs).
      await api(atOf(s, `/api/sessions/${encodeURIComponent(s.name)}/key`), { ...body, owner: true, question: true, about: what });
      answered.set(askKey(s), { ask: askOf(s), until: Date.now() + ANSWERED_MS });
      answerFocusUntil = Date.now() + 5000; // each render within the window reclaims focus if it fell to the body
      hold(s, word, after);
      fill(box, sent({ word }));
      // On the session page the message box is the stable landing spot (it survives the re-renders); on a card there
      // is none, so the live-region line takes focus and reclaims it across the re-renders.
      try {
        const msg = here && typeof document !== 'undefined' ? document.querySelector('textarea.msg') : null;
        if (msg) msg.focus();
        else box.querySelector?.('.ok-how')?.focus?.();
      } catch { /* not focusable in this host: the live region still tells a screen reader */ }
      toast(said);
      // Now, soon (the tool has gone on, or asked again) and once the wait is over (it did neither: the answers return).
      after?.();
      // (The look at the end of the hold is hold's own.)
      for (const ms of [1800, 4000, ANSWERED_MS + 100]) setTimeout(() => after?.(), ms);
    } catch (err) {
      for (const b of buttons) b.disabled = false;
      toast(err.message, { kind: 'error' });
      after?.(); // the question on the screen is not the one this card showed: look again
    }
  };
  const a = s.always && /^[1-9]$/.test(s.always.key) ? s.always : null;
  // Claude's own words without "Yes, (and)": "Always allow access to … from this project", "Allow reading from …",
  // "Allow, and don't ask again for …".
  // "Don't ask again for npm install commands" reads as the chat says it: "this kind of command" (its exact words stay
  // in the button's tooltip).
  const always = a ? (/^(?:always\s+)?allow\b/i.test(a.label) ? a.label : /^don'?t ask again for\b.*\bcommands?$/i.test(a.label) ? "Allow, and don't ask again for this kind of command" : `Allow, and ${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}`) : '';
  // What "this kind" is, under the buttons: a rule that lasts says what it covers where a phone shows it too (a phone
  // shows no tooltip). "npm install" from "Don't ask again for npm install commands".
  const kind = a && always === "Allow, and don't ask again for this kind of command" ? (/^don'?t ask again for\s+(.*?)\s*\bcommands?$/i.exec(a.label) || [])[1] || '' : '';
  // What Allow and Do not allow act on, for a screen reader at the button: a held act's title and part, else the
  // command or file the card shows.
  const about = s.held && typeof s.held.what === 'string' && s.held.what ? `${s.held.title || 'an act that is yours'}: ${s.held.what}` : what;
  // The same mark on the same answer of the same question, drawn again (fill keeps the focus on it); a new question
  // gets new marks, so the focus never lands on an answer to something the owner has not read.
  const keep = (answerName) => `${askKey(s)}|${askOf(s)}|${answerName}`;
  buttons.push(
    // Allow is the number of "Yes": it takes that answer wherever the arrow is (Enter would take the one it is on).
    h('button.btn.small.primary', { type: 'button', 'data-keep-focus': keep('allow'), 'aria-label': about ? `Allow — ${about}` : null, onclick: answer({ key: '1' }, `Allowed. ${whoOf(s)} goes on.`) }, icon('check', { size: 16 }), h('span', 'Allow')),
    ...(a ? [h('button.btn.small.secondary', { type: 'button', 'data-keep-focus': keep('always'), title: a.text, onclick: answer({ key: a.key, expect: a.text }, `Allowed. ${whoOf(s)} goes on, and Claude will not ask again for this.`) },
      icon('checkAll', { size: 16 }), h('span', always))] : []),
    h('button.btn.small.secondary', { type: 'button', 'data-keep-focus': keep('no'), 'aria-label': about ? `Do not allow — ${about}` : null, onclick: answer({ key: 'Escape' }, `Not allowed. ${whoOf(s)} was told no.`, 'Not allowed') }, icon('x', { size: 16 }), h('span', 'Do not allow')));
  return fill(box, buttons, kind ? h('p.ok-scope', `This kind of command: ${kind}`) : null);
}

function chatAnswers(s, after) {
  const held = heldWord(s);
  if (held) return h('div.ok-actions', doneLine(held));
  const ask = s.ask;
  if (!ask || !s.chatId) return null;
  if (ask.type !== 'permission') {
    return h('div.ok-actions', h('a.btn.small.primary', { href: link(`#/chat/${s.chatId}`, s.machine ?? machine.current) }, icon('text', { size: 16 }),
      h('span', ask.type === 'plan' ? 'Read the plan' : 'Answer')));
  }
  const answer = (body, said, word = 'Allowed') => async (e) => {
    e.preventDefault();
    e.stopPropagation(); // on a card: answer, do not open the chat
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await api(atOf(s, `/api/chats/${s.chatId}/answer`), { request: ask.request, ...body });
      hold(s, word, after);
      toast(said);
      after?.();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    } finally {
      b.disabled = false;
    }
  };
  return h('div.ok-actions',
    h('button.btn.small.primary', { type: 'button', onclick: answer({ allow: true }, `Allowed. ${whoOf(s)} goes on.`) }, icon('check', { size: 16 }), h('span', 'Allow')),
    // The chat card's words (web/chat/asks.js), so one OK reads the same on Home and in the chat.
    ask.canAlways ? h('button.btn.small.secondary', { type: 'button', title: ask.always === 'edits' ? 'Claude changes files without asking for the rest of this session' : ask.alwaysText || 'The same kind of request is allowed for the rest of this session', onclick: answer({ allow: true, always: true }, `Allowed for this session. ${whoOf(s)} goes on.`) },
      icon('checkAll', { size: 16 }), h('span', ask.always === 'edits' ? 'Allow all edits in this session' : 'Allow in this session')) : null,
    h('button.btn.small.secondary', { type: 'button', onclick: answer({ allow: false }, `Not allowed. ${whoOf(s)} was told no.`, 'Not allowed') }, icon('x', { size: 16 }), h('span', 'Do not allow')));
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
