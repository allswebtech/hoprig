// New session's Options parts (newsession-options.js): one choice with its line, and the Options of another coding
// tool than Claude Code.
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
    h('select.field', { 'data-key': label, onchange: (e) => (onchange(e.target.value), say(e.target.value)) }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))),
    line);
}

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
  // In a chat the bypass is Hoprig's own (src/chat/asks.mjs openCodeAllows): every command is put to Hoprig, which
  // answers it at once, except a delete written in plain sight (src/asking.mjs mayDelete) that is no plain delete. A
  // terminal's is the tool's own (OpenCode's --auto).
  const warn = (v) => (v === 'bypassPermissions' && chat
    ? `${name} runs commands and changes files without asking. Hoprig asks you first only when a command names a delete in plain sight (rm, find -delete, git clean and a few more) that is not plainly inside the folder it runs in. It is no wall: a script, a program or a command written to get around it can still delete. What your own ${name} settings deny stays denied.`
    : v === 'bypassPermissions' || v === 'own' ? `${name} can run any command and change any file without asking.` : null);
  return [
    select('Provider', st.profile, [['', byDefault || (chat ? same : 'The first that serves it')], ...profiles.map((p) => [p.name, `${p.label} · ${kindLabel(p)} · ${profileState(p).text}`])], (v) => (st.profile = v)),
    select(`What ${name} may do without asking`, mode, chat ? [['', same], ...modes] : modes, (v) => (st.permissionMode = v), warn),
    select('How hard it thinks', st.effort, [['', chat ? same : 'The model\'s own default'], ...(info.efforts || Object.keys(EFFORT)).map((x) => [x, EFFORT[x] || x])], (v) => (st.effort = v)),
  ];
}
