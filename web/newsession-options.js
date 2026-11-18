// New session's closed "Options" (newsession-popup.js): the provider, what the coding tool may do without asking, how
// hard it thinks, the model, which conversation, and a plain terminal without a coding tool. What is left as it is
// takes what the last session in that project had (the App) or Settings (a terminal).
import { h, kindLabel, profileState, servesTool } from './lib.js';
import { otherToolOptions, select } from './newsession-tools.js';
import { defaultWords } from './newsession-words.js';
// The same plain words as Settings → New-session defaults (sessiondefaults.js).
import { BYPASS_MEANS, EFFORT, MODELS, MODES } from './sessiondefaults.js';

const CONVERSATION = [['new', 'A new conversation'], ['continue', 'Continue the last one in the folder'], ['pick', 'Pick an earlier one']];

/**
 * o: { st (the popup's choices; changed here), where (the computer's state), run ('chat' | 'claude' | 'shell'), info
 * (another tool's modes and efforts, or null), toolName, onplain(on) } → nodes.
 */
export function optionsFor({ st, where: m, run, info, toolName, onplain }) {
  const plain = h('label.toggle-line.ns-plain',
    h('input', { type: 'checkbox', checked: st.plain, 'data-startctl': '', 'data-key': 'plain', onchange: (e) => onplain(e.target.checked) }),
    h('span', 'A plain terminal, without a coding tool'));
  // A plain terminal runs no coding tool: no provider, mode, model or conversation to choose.
  if (run === 'shell') return [plain, h('p.hint', 'A shell in the folder you pick; the choices above do not apply to it.')];
  const tool = st.tool || 'claude';
  const profiles = m ? m.profiles.filter((p) => servesTool(p, tool)) : []; // only the providers that serve the coding tool
  const app = run === 'chat';
  const same = app ? 'As your last session in the project' : 'As in Settings';
  const conversation = select('Conversation', st.conversation, CONVERSATION, (v) => (st.conversation = v));
  if (tool !== 'claude') {
    // Another coding tool: its own modes; the model is chosen from the provider's list in the App itself.
    return [otherToolOptions({ st, info: info || { modes: [] }, name: toolName, profiles, chat: app, same, byDefault: defaultWords(m, profiles, app ? same : null, tool, st.dir) }), conversation, plain];
  }
  return [
    select('Provider', st.profile, [['', defaultWords(m, profiles, app ? same : null, 'claude', st.dir)], ...profiles.map((p) => [p.name, p.virtual ? `${p.label} · uses your providers in order` : `${p.label} · ${kindLabel(p)} · ${profileState(p).text}`])], (v) => (st.profile = v)),
    select('What Claude Code may do without asking', st.permissionMode, [['', same], ...Object.entries(MODES)], (v) => (st.permissionMode = v),
      (v) => (v === 'bypassPermissions' ? BYPASS_MEANS : null)),
    select('How hard it thinks', st.effort, [['', same], ...Object.entries(EFFORT)], (v) => (st.effort = v)),
    // A model for this one session: try something cheaper without changing the setting for every session.
    select('Model', st.model, [['', same], ...(st.models || MODELS.map(([v]) => v)).map((v) => [v, (MODELS.find(([x]) => x === v) || [v, v])[1]])], (v) => (st.model = v),
      app ? 'The chips in the App change it at any time.' : 'Only this session. A provider that names its own model keeps it.'),
    conversation,
    plain,
  ];
}
