// New session's parts for the coding tool (newsession.js): the choice of the tool where a computer offers more than
// one, and the Options of another tool than Claude Code. The choice is a row of toggle buttons: a press chooses the
// tool for the project opened next, a second press leaves it to each project again.
import { icon } from './icons.js';
import { h, kindLabel, profileState } from './lib.js';
import { EFFORT } from './sessiondefaults.js';

/**
 * One choice under Options. `hint` is a line under it: a text, or a function of the value chosen (it changes as soon
 * as the choice does, so a warning shows at once).
 */
export function select(label, value, options, onchange, hint) {
  const hintOf = typeof hint === 'function' ? hint : () => hint;
  const line = h('span.hint');
  const say = (v) => {
    const text = hintOf(v) || '';
    line.textContent = text;
    line.classList.toggle('hidden', !text);
  };
  say(value);
  return h('label.fieldrow', h('span.field-label', label),
    h('select.field', { onchange: (e) => (onchange(e.target.value), say(e.target.value)) }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))),
    line);
}

/**
 * The coding tools as toggle buttons. o: { tools: [{ id, name }], chosen (id or ''), choose(id or '') } → node. The
 * page draws them again after a choice; focusTool() puts the focus back on the button that was pressed.
 */
export function toolButtons({ tools, chosen, choose }) {
  return h('div.ns-pcs', { role: 'group', 'aria-label': 'Coding tool' }, tools.map((t) => {
    const on = chosen === t.id;
    return h(`button.ns-pc${on ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(on), 'data-tool': t.id, onclick: () => choose(on ? '' : t.id, t.id) },
      h('span.ns-pc-icon', icon(t.id === 'claude' ? 'sparkle' : 'code', { size: 18 })),
      h('span.ns-pc-text', h('span.ns-pc-name', t.name), h('span.ns-pc-sub', on ? 'Chosen' : 'Use for the next chat')),
      on ? h('span.ns-pc-tick', icon('check', { size: 16 })) : null);
  }));
}
export const focusTool = (slot, id) => {
  const b = slot.querySelector(`button[data-tool="${id}"]`);
  if (b) b.focus();
};

/**
 * What another tool's terminal may do without asking, as POST /api/sessions takes it: 'ask' unless the owner chose
 * otherwise (OpenCode's own defaults allow almost everything, so they are only an explicit choice, said plainly).
 */
export const terminalMode = (v) => (v === 'own' ? null : v === 'bypassPermissions' ? 'bypassPermissions' : 'ask');

/**
 * The Options of another coding tool. o: { st, info (its modes, mode words, efforts), name, profiles, chat (a chat,
 * not a terminal), same (the words of "as the last chat"), byDefault (the words of the provider left unchosen) } → nodes
 * after the "Open in" row.
 */
export function otherToolOptions({ st, info, name, profiles, chat, same, byDefault = null }) {
  const words = info.modeWords || {};
  const modes = chat ? info.modes.map((x) => [x, words[x] ? words[x].chip : x]) : [['ask', 'Ask first'], ['own', `${name}'s own defaults: edits and runs commands without asking`], ['bypassPermissions', 'Bypass']];
  const mode = modes.some(([x]) => x === st.permissionMode) ? st.permissionMode : chat ? '' : 'ask';
  const warn = (v) => (v === 'bypassPermissions' || v === 'own' ? `${name} can run any command and change any file without asking.` : null);
  return [
    select('Provider', st.profile, [['', byDefault || (chat ? same : 'The first that serves it')], ...profiles.map((p) => [p.name, `${p.label} · ${kindLabel(p)} · ${profileState(p).text}`])], (v) => (st.profile = v)),
    select(`What ${name} may do without asking`, mode, chat ? [['', same], ...modes] : modes, (v) => (st.permissionMode = v), warn),
    select('How hard it thinks', st.effort, [['', chat ? same : 'The model\'s own default'], ...(info.efforts || Object.keys(EFFORT)).map((x) => [x, EFFORT[x] || x])], (v) => (st.effort = v)),
  ];
}
