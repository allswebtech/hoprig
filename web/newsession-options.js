// New session's closed "Options" (newsession-popup.js): the provider, what the coding tool may do without asking, how
// hard it thinks, the model, which conversation, and a plain terminal without a coding tool. What is left as it is
// takes what the last session in that project had (the App) or Settings (a terminal).
import { at, fill, h, kindLabel, profileState, servesTool } from './lib.js';
import { modelPicker } from './modelpicker.js';
import { LEAD_TERMINAL, leadSwitch } from './leadswitch.js';
import { otherToolOptions, select } from './newsession-tools.js';
import { autoSlowLine, defaultWords } from './newsession-words.js';
// The same plain words as Settings → New sessions (sessiondefaults.js).
import { BYPASS_MEANS, EFFORT, MODES } from './sessiondefaults.js';

export const LEAD_SAME = 'Left as it is: Lead on or off as your last session in the project, else as in Settings; the providers ticked as in Settings.';
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
    // "Lead model" shown off with its one line why (only Claude Code can lead), as Plan with AI shows it.
    return [otherToolOptions({ st, info: info || { modes: [] }, name: toolName, profiles, chat: app, same, byDefault: defaultWords(m, profiles, app ? same : null, tool, st.dir) }), app ? leadSwitch({ value: false, tool, onchange: () => {} }) : null, conversation, plain];
  }
  // The model: the models of the provider chosen (else the one this computer recommends), asked of that computer.
  const modelSlot = h('div');
  const drawModel = () => fill(modelSlot, modelPicker({
    provider: st.profile || (m && m.recommended) || null, tool: 'claude', value: st.model, key: 'Model', emptyLabel: same,
    at: (p) => at(st.m || null, p), onchange: (v) => (st.model = v || ''),
    hint: app ? 'The chips in the App change it at any time.' : 'Only this session. A provider that names its own model keeps it.',
  }));
  // "Lead model" for an App session only (a terminal session starts as it always did). A terminal session shows it off
  // with its one line why (leadswitch.js LEAD_TERMINAL), as another coding tool does.
  // Changed here, it is sent as shown; left as it is, a start takes the folder's last chat (else Settings), and while
  // no folder is chosen yet one line says so.
  const leadSlot = h('div');
  const drawLead = () => {
    const same = !st.leadTouched && !st.leadDir ? h('p.hint.ns-lead-same', LEAD_SAME) : null;
    const touched = () => {
      st.leadTouched = true;
      if (same) same.textContent = '';
    };
    fill(leadSlot, app ? [leadSwitch({ value: st.lead === true, partMode: st.permissionMode || null, modes: st.modes || null, provider: st.profile || st.leadProfile || (m && m.recommended) || null, at: (p) => at(st.m || null, p), onchange: (on) => (st.lead = on, touched()), others: st.others || null,
      onothers: (l, byOwner) => {
        st.others = l;
        if (byOwner) touched();
      } }), same] : leadSwitch({ value: false, off: LEAD_TERMINAL, onchange: () => {} }));
  };
  drawModel();
  drawLead();
  // As root, a default in Bypass would be refused at the start: the mode that asks is preselected, and the line under
  // the choice says why (st.rootBypass, from the computer's settings).
  if (st.rootDefaultBypass && !st.permissionMode) st.permissionMode = 'manual';
  // The line under "Use other providers" names the mode parts run in: drawn again when the mode changes.
  const setMode = (v) => {
    st.permissionMode = v;
    drawLead();
  };
  // Worktree: only Claude Code's App chat; a new conversation on a branch of its own. A folder that is no git repository
  // starts as usual and the chat says so.
  const worktree = app ? h('div.ns-worktree',
    h('label.toggle-line',
      h('input', { type: 'checkbox', checked: st.worktree === true, 'data-startctl': '', 'data-key': 'worktree', onchange: (e) => (st.worktree = e.target.checked) }),
      h('span', 'Work on a branch of its own (worktree)')),
    h('p.hint', 'A new branch and a separate copy of the project\'s files, so this chat\'s changes stay apart. Only in a git folder, and only for a new conversation.')) : null;
  return [
    select('Provider', st.profile, [['', defaultWords(m, profiles, app ? same : null, 'claude', st.dir)], ...profiles.map((p) => [p.name, p.virtual ? `${p.label} · uses your providers in order` : `${p.label} · ${kindLabel(p)} · ${profileState(p).text}`])], (v) => {
      st.profile = v;
      st.model = ''; // another provider has its own models
      drawModel();
      drawLead();
    }, (v) => (v ? null : autoSlowLine(m, profiles))),
    select('What Claude Code may do without asking', st.permissionMode, [['', same], ...Object.entries(MODES).filter(([k]) => !st.modes || st.modes.includes(k))], setMode,
      (v) => (v === 'bypassPermissions' ? BYPASS_MEANS : st.rootBypass || null)),
    select('How hard it thinks', st.effort, [['', same], ...Object.entries(EFFORT)], (v) => (st.effort = v)),
    // A model for this one session: try something cheaper without changing the setting for every session.
    modelSlot,
    leadSlot,
    worktree,
    conversation,
    plain,
  ];
}
