// New session's two first choices (newsession-popup.js): how the session opens (App or Terminal) and which coding
// tool runs in it. Each coding tool shows its state on the chosen computer; one that is not ready says in plain words
// what is missing and links to where it is fixed, and cannot be chosen.
import { icon } from './icons.js';
import { h, link, servesTool } from './lib.js';

/** The two ways to work in a session. The App is the chat page (web/chat/), the Terminal the tool's own screen. */
export const OPEN_AS = [
  { id: 'app', name: 'App', line: 'A chat, like the Claude Code app', icon: 'text' },
  { id: 'terminal', name: 'Terminal', line: 'The coding tool in a terminal', icon: 'terminal' },
];

/** What this browser chose last time (prefs 'new.openAs'); the very first time, the App. */
export const openAsDefault = (saved) => (OPEN_AS.some((o) => o.id === saved) ? saved : 'app');

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

/**
 * The one line that says what a start uses, over the project list ("On Workstation · in the App · with Claude Code"):
 * the choices themselves are folded under it and open on a press. `computer` only where several are linked; `known`
 * false while the coding tools are still being asked for.
 */
export function choiceLine({ computer = null, openAs = 'app', tool = null, plain = false, known = true, unreachable = false }) {
  const parts = computer ? [`On ${computer}`] : [];
  if (unreachable) parts.push('cannot be reached now');
  else if (plain) parts.push('a plain terminal, without a coding tool');
  // "the App" / "a terminal": the names of the tiles the fold opens to, as every Home card's pill says it.
  else parts.push(openAs === 'terminal' ? 'in a terminal' : 'in the App', !known ? 'looking at the coding tools…' : tool ? `with ${tool}` : 'no coding tool is ready');
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Arrow keys move the choice inside a row of tiles, as in any group of radio buttons. */
function arrows(e) {
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

/** One large tile: a radio button with an icon, a name and one line (`disabled`: shown, not a choice). */
function tile({ id, name, line, ic, chosen, onpick, disabled = false }) {
  return h(`button.ns-tile${chosen ? '.ns-is-chosen' : ''}${disabled ? '.ns-is-off' : ''}`, {
    type: 'button', role: 'radio', 'aria-checked': String(chosen), 'data-choice': id, disabled, onclick: onpick,
  },
  h('span.ns-tile-icon', icon(ic, { size: 20 })),
  h('span.ns-tile-text', h('span.ns-tile-name', name), h('span.ns-tile-line', line)),
  chosen ? h('span.ns-tile-tick', icon('check', { size: 16 })) : null);
}

/**
 * "Computer", where several are linked: the same tiles as the rows under it. o: { computers: [{ id, name, line,
 * disabled }], chosen (id), choose(id) } → node.
 */
export function computerTiles({ computers, chosen, choose }) {
  return h('div.ns-tiles', { role: 'radiogroup', 'aria-label': 'Computer', onkeydown: arrows }, computers.map((c) =>
    tile({ id: c.id, name: c.name, line: c.line, ic: 'cpu', chosen: c.id === chosen, disabled: c.disabled && c.id !== chosen, onpick: () => choose(c.id) })));
}

/** "Open as": App or Terminal. o: { chosen, choose(id) } → node. */
export function openAsTiles({ chosen, choose }) {
  return h('div.ns-tiles', { role: 'radiogroup', 'aria-label': 'Open as', onkeydown: arrows }, OPEN_AS.map((o) =>
    tile({ id: o.id, name: o.name, line: o.line, ic: o.icon, chosen: o.id === chosen, onpick: () => choose(o.id) })));
}

/**
 * "Coding tool": one tile per tool the computer's list names. o: { tools: [{ id, name, state }], chosen, choose(id),
 * onleave() (a link to Settings or Providers was followed: the popup closes) } → node. A tool that is not ready is no
 * button: its name, what is missing and the link that goes there.
 */
export function toolTiles({ tools, chosen, choose, onleave = () => {} }) {
  return h('div.ns-tiles', { role: 'radiogroup', 'aria-label': 'Coding tool', onkeydown: arrows }, tools.map((t) => {
    const ic = t.id === 'claude' ? 'sparkle' : 'code';
    if (t.state.ready) return tile({ id: t.id, name: t.name, line: 'Ready', ic, chosen: t.id === chosen, onpick: () => choose(t.id) });
    // What fixes it: a page elsewhere (a link; the popup closes), or another choice here (`act`: a button).
    const fix = t.state.act
      ? h('button.ns-fix', { type: 'button', onclick: t.state.act }, t.state.fix)
      : h(t.state.button ? 'a.btn.small.secondary.ns-fixbtn' : 'a', { href: t.state.href, onclick: onleave }, t.state.fix);
    return h('div.ns-tile.ns-is-off', { 'data-choice': t.id },
      h('span.ns-tile-icon', icon(ic, { size: 20 })),
      h('span.ns-tile-text', h('span.ns-tile-name', t.name), h('span.ns-tile-line', `${t.state.why}: `, fix)));
  }));
}
