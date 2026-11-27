// New session's "More options" (newsession-popup.js): only what is needed at the start and cannot be changed after it,
// or whose change after it costs a second session. Everything else (provider, what it may do without asking, how hard
// it thinks, the model, Lead) is changed in the chat itself and in Settings → New sessions; a start leaves it out, so
// the server takes the folder's last chat, else Settings.
import { icon } from './icons.js';
import { TOOL_NAMES, h } from './lib.js';

/** The words of what differs from the plain start (the App, Claude Code), or '' when nothing does. `tools`: [{ id, name }]. */
export function summaryOf(st, tools = []) {
  const parts = [];
  if (st.openAs === 'terminal') parts.push('Terminal');
  if (st.tool && st.tool !== 'claude') parts.push((tools.find((t) => t.id === st.tool) || {}).name || TOOL_NAMES[st.tool] || st.tool);
  return parts.join(' · ');
}

const toggle = (key, label, line, checked, onchange) => h('div.ns-opt',
  h('label.toggle-line',
    h('input', { type: 'checkbox', checked, 'data-startctl': '', 'data-key': key, onchange: (e) => onchange(e.target.checked) }),
    h('span', label)),
  line ? h('p.hint', line) : null);

/**
 * o: { st (the popup's choices; changed here), tools ([{ id, name }]: the coding tools ready for the way chosen),
 * toolName(id), onchange(what) ('way' | 'tool'), also (the "Read other projects too" fold, or null) } → nodes. At most five: Open in a terminal, Coding
 * tool (only with two or more ready), An earlier conversation, On a branch of its own (the App with Claude Code), Read
 * other projects too (only where the workspace map offers something).
 */
export function optionsFor({ st, tools, toolName, onchange, also = null }) {
  const out = [toggle('terminal', 'Open in a terminal', `${toolName(st.tool || 'claude')}'s own screen instead of the chat`, st.openAs === 'terminal', (on) => {
    st.openAs = on ? 'terminal' : 'app';
    onchange('way');
  })];
  if (tools.length > 1) {
    out.push(h('div.ns-opt.ns-opt-tool',
      h('span.field-label', 'Coding tool'),
      h('div.ns-seg', { role: 'radiogroup', 'aria-label': 'Coding tool' }, tools.map((t) =>
        h('button.ns-seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(t.id === st.tool), 'data-choice': t.id, 'data-startctl': '', onclick: () => {
          if (t.id === st.tool) return;
          st.tool = t.id;
          st.picked = t.id;
          onchange('tool');
        } }, t.name)))));
  }
  out.push(toggle('earlier', 'An earlier conversation', null, st.earlier === true, (on) => (st.earlier = on)));
  if (st.openAs === 'app' && (st.tool || 'claude') === 'claude') {
    out.push(toggle('worktree', 'On a branch of its own', 'Changes stay apart until you merge them. Git projects only.', st.worktree === true, (on) => (st.worktree = on)));
  }
  if (also) out.push(also);
  return out;
}

/** The button that opens them, with the words of a choice that is not the plain one at its left. */
export function moreButton({ open, summary, onclick }) {
  return h('button.ns-more', { type: 'button', 'aria-expanded': String(open), 'data-key': 'more', onclick },
    summary ? h('span.ns-more-sum', summary) : null,
    h('span.ns-more-text', 'More options'),
    icon('chevronDown', { size: 16 }));
}
