// New session's choices (newsession-popup.js): how the session opens (App or Terminal), which coding tool runs in it
// and on which computer. A coding tool shows its state on the chosen computer; one that is not ready says in plain
// words what is missing and where it is fixed, and cannot be chosen. The computers are small chips, only where two or
// more are linked.
import { h, link, servesTool } from './lib.js';

/** The two ways to work in a session. The App is the chat page (web/chat/), the Terminal the tool's own screen. */
export const OPEN_AS = ['app', 'terminal'];

/** What this browser chose last time (prefs 'new.openAs'); the very first time, the App. */
export const openAsDefault = (saved) => (OPEN_AS.includes(saved) ? saved : 'app');

/**
 * A coding tool's state on computer `m` (null: this one), from GET /api/codetools: { ready: true }, or { ready: false,
 * why, fix, href } where `fix` is the link's words and `href` where it leads. Older computers send no list: the
 * tools a chat can run there (on and installed) count as ready (`providers` left out).
 */
export function toolState(t, m = null) {
  if (t.managed && !t.installed) return { ready: false, why: 'Not installed', fix: 'install it in Settings', href: link('#/settings/new-sessions?show=coding-tools', m) };
  if (t.on === false) return { ready: false, why: 'Turned off', fix: 'turn it on in Settings', href: link('#/settings/new-sessions?show=coding-tools', m) };
  if (Array.isArray(t.providers) && !t.providers.length) return needsProvider(m);
  return { ready: true };
}

/** No provider can run the tool on computer `m`: it is no choice, and the button goes to Providers. */
const needsProvider = (m) => ({ ready: false, why: 'Needs a provider first', fix: 'Add provider', href: link('#/providers', m), button: true });

/**
 * A ready tool's state against the chosen computer's own providers (`profiles`, from its state; null: not known): with
 * none that serves it, a start would fail inside the coding tool, so it needs a provider first and never reads "Ready".
 */
export function providerState(t, profiles, m = null) {
  if (!t.state.ready || !Array.isArray(profiles)) return t.state;
  return profiles.some((p) => !p.virtual && servesTool(p, t.id)) ? t.state : needsProvider(m);
}

/**
 * A ready tool's state for the way it opens: ready only when a start with exactly that tool can be sent that way. An
 * App needs the tool's App engine on the computer (`appTools`: GET /api/chats/tools); a Terminal takes every ready
 * tool (POST /api/sessions names it). `toWay(way)` switches the way, for the button that says so.
 */
export function wayState(t, way, appTools, toWay) {
  if (!t.state.ready) return t.state;
  if (way === 'app' && !appTools.includes(t.id)) return { ready: false, why: 'No App for it on this computer yet', fix: 'open it in the Terminal', act: () => toWay('terminal') };
  return t.state;
}

/**
 * The coding tool a start uses, from `tools` ([{ id, state }] in the product's order), always among the ready ones: the
 * one the owner chose here, else (opened from a project) the one that project used last, else the one this browser
 * chose last time (`saved`), else the computer's first ready one. What the tile shows is what a start sends. Null: none
 * is ready.
 */
export function chooseTool(tools, { picked = null, last = null, saved = null } = {}) {
  const ready = tools.filter((t) => t.state && t.state.ready).map((t) => t.id);
  for (const id of [picked, last, saved]) if (id && ready.includes(id)) return id;
  return ready[0] || null;
}

/** Arrow keys move the choice inside a row of chips, as in any group of radio buttons. */
export function arrows(e) {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in keys)) return;
  const all = [...e.currentTarget.querySelectorAll('button[role=radio]:not(:disabled)')];
  const i = all.indexOf(document.activeElement);
  if (i < 0 || all.length < 2) return;
  e.preventDefault();
  const next = all[(i + keys[e.key] + all.length) % all.length];
  next.click();
  next.focus();
}

/** One chip: a radio button with the name only (the chosen one filled). */
export function chip({ id, name, chosen, onpick, disabled = false }) {
  return h(`button.ns-chip${chosen ? '.ns-is-chosen' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(chosen), 'data-choice': id, disabled, onclick: onpick }, name);
}

/**
 * The computers, where two or more are linked: one row of small chips. o: { computers: [{ id, name, disabled }], chosen
 * (id), choose(id) } → node.
 */
export function computerChips({ computers, chosen, choose }) {
  return h('div.ns-chips', { role: 'radiogroup', 'aria-label': 'Computer', onkeydown: arrows }, computers.map((c) =>
    chip({ id: c.id, name: c.name, chosen: c.id === chosen, disabled: c.disabled && c.id !== chosen, onpick: () => choose(c.id) })));
}

/** The words of what a tool lacks, for the one line that takes the projects' place: "Claude Code: Needs a provider first." */
export const lackLine = (t) => `${t.name}: ${t.state.why}.`;
