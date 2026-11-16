// What waits for the owner: a permission card (Allow, Allow in this chat, Do not allow with a reason), Claude's questions
// (one or several, each with its choices, several at once where it allows, and a free answer), and a plan with
// Claude Code's three answers (approve and accept edits, approve and ask before edits, keep planning with a note).
// The number keys answer the newest card (keys.js of the page routes them here). Answers go to POST /answer.
import { icon } from '../icons.js';
import { api, fill, h, toast } from '../lib.js';
import { mdView } from '../mdtext.js';
import { inputView } from './tools.js';
import { alwaysWords, askTitle, ruleWords } from './words.js';

const FILE_TOOLS = ['Bash', 'Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit'];

/** The number a button answers to, shown on it. */
const keyed = (n, ...kids) => [h('kbd.chat-key', { 'aria-hidden': 'true' }, String(n)), ...kids];

/**
 * A card for one `ask` event. o: { A (the chat's API path), cwd, after() (the state changed) }.
 * The card has .keys(n) (a number key pressed; true when it took it) and .closed(text, ok).
 */
export function askCard(ev, o) {
  const status = h('p.chat-ask-status', { role: 'status' });
  const actions = h('div.chat-ask-actions');
  const body = h('div.chat-ask-body');
  const extra = h('div.chat-ask-extra'); // the deny reason, the plan note
  const title = askTitle(ev.tool, ev.input || {});
  const el = h(`section.chat-item.chat-ask.chat-ask-${ev.type || 'permission'}`, { 'aria-label': title, tabindex: '-1' },
    h('div.chat-ask-head', icon(ev.type === 'question' ? 'info' : ev.type === 'plan' ? 'book' : 'alert', { size: 18 }), h('strong', title)),
    ev.description && !FILE_TOOLS.includes(ev.tool) ? h('p.chat-hint', ev.description) : null,
    body,
    ev.why ? h('p.chat-hint.chat-ask-why', icon('info', { size: 14 }), h('span', ev.why)) : null,
    actions, extra,
    // Claude Code's rule in words; it may cover only a part of a longer command, and then says so.
    ev.canAlways && ev.alwaysText ? h('p.chat-hint.chat-ask-scope', alwaysWords(ev)) : null,
    status);
  let keys = [];
  let busy = false;

  const answer = async (allow, more = {}) => {
    if (busy || el.done) return;
    busy = true;
    for (const b of el.querySelectorAll('button')) b.disabled = true;
    try {
      await api(`${o.A}/answer`, { request: ev.request, allow, ...more });
      o.after?.();
    } catch (e) {
      busy = false;
      if (e.status === 409) return; // answered meanwhile (another tab, or the turn ended): the next news closes it
      for (const b of el.querySelectorAll('button')) b.disabled = false;
      toast(e.message, { kind: 'error' });
    }
  };

  /** A note field with its own send (the deny reason, the plan's "keep planning"). */
  const note = (label, ok, send) => {
    const field = h('textarea.field.chat-ask-note', { rows: 2, placeholder: label, 'aria-label': label });
    fill(extra, h('div.chat-ask-notebox', field, h('div.chat-ask-actions',
      h('button.btn.secondary.danger-text', { type: 'button', onclick: () => send(field.value.trim()) }, ok),
      h('button.btn.ghost', { type: 'button', onclick: () => fill(extra) }, 'Back'))));
    field.focus();
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(field.value.trim());
      }
    });
  };

  if (ev.type === 'question' && Array.isArray((ev.input || {}).questions)) {
    // Each question with its choices; the answers go back the way Claude Code expects them (several joined by ", ").
    const chosen = new Map();
    const others = new Map();
    const qs = ev.input.questions.slice(0, 10);
    const rows = qs.map((q) => {
      const opts = Array.isArray(q.options) ? q.options.slice(0, 12) : [];
      const set = new Set();
      chosen.set(q.question, set);
      const btns = opts.map((op, n) => h('button.chat-choice', { type: 'button', role: q.multiSelect ? 'checkbox' : 'radio', 'aria-checked': 'false', onclick: () => pick(q, op.label) },
        h('span.chat-choice-label', op.label), op.description ? h('span.chat-choice-sub', op.description) : null, h('span.chat-choice-n', { 'aria-hidden': 'true' }, String(n + 1))));
      const other = h('input.field.chat-q-other', { type: 'text', placeholder: 'Or write your own answer', 'aria-label': `Your own answer to: ${q.question}` });
      other.addEventListener('input', () => others.set(q.question, other.value.trim()));
      const row = h('div.chat-q', h('p.chat-q-text', q.header ? h('span.badge', q.header) : null, ' ', q.question, q.multiSelect ? h('span.chat-hint', ' (choose any)') : null),
        h('div.chat-q-opts', { role: q.multiSelect ? 'group' : 'radiogroup', 'aria-label': q.question }, btns), other);
      row.q = q;
      row.btns = btns;
      return row;
    });
    const pick = (q, label) => {
      const set = chosen.get(q.question);
      if (!q.multiSelect) {
        const had = set.has(label);
        set.clear();
        if (!had) set.add(label);
      } else if (set.has(label)) set.delete(label);
      else set.add(label);
      const row = rows.find((r) => r.q === q);
      for (const b of row.btns) b.setAttribute('aria-checked', String(set.has(b.querySelector('.chat-choice-label').textContent)));
    };
    fill(body, rows);
    const send = () => {
      const answers = {};
      for (const q of qs) {
        const own = others.get(q.question);
        const picked = [...chosen.get(q.question)];
        const all = own ? [...picked, own] : picked;
        if (all.length) answers[q.question] = all.join(', ');
      }
      if (Object.keys(answers).length < qs.length) return toast(qs.length > 1 ? 'Answer every question first' : 'Choose an answer first', { kind: 'error' });
      answer(true, { answers });
    };
    fill(actions,
      h('button.btn.primary', { type: 'button', onclick: send }, icon('send', { size: 16 }), h('span', 'Send answers')),
      h('button.btn.secondary', { type: 'button', onclick: () => answer(false, { message: 'the user preferred to answer in a message' }) }, 'Answer in a message'));
    // Number keys pick a choice of the first question not answered yet (the only one, mostly).
    el.keys = (n) => {
      const row = rows.find((r) => !chosen.get(r.q.question).size) || rows[rows.length - 1];
      const op = (row.q.options || [])[n - 1];
      if (!op) return false;
      pick(row.q, op.label);
      return true;
    };
  } else if (ev.type === 'plan') {
    fill(body, ev.plan ? h('div.chat-plan', mdView(ev.plan)) : h('p.chat-hint', 'Claude wrote no plan text. Its messages above say what it wants to do.'));
    const keep = () => note('What should change in the plan? (optional)', 'Keep planning', (msg) => answer(false, { message: msg || 'keep planning' }));
    keys = [
      () => answer(true, { mode: 'acceptEdits' }),
      () => answer(true, { mode: 'manual' }),
      keep,
    ];
    fill(actions,
      h('button.btn.primary', { type: 'button', onclick: keys[0] }, keyed(1, h('span', 'Yes, and accept edits'))),
      h('button.btn.secondary', { type: 'button', onclick: keys[1] }, keyed(2, h('span', 'Yes, ask before edits'))),
      h('button.btn.secondary', { type: 'button', onclick: keys[2] }, keyed(3, h('span', 'No, keep planning'))));
  } else {
    fill(body, inputView({ ...ev, name: ev.tool, toolKind: kindOf(ev.tool), asking: true }, o.cwd));
    const deny = () => note('Why not? Claude reads this (optional)', 'Do not allow', (msg) => answer(false, msg ? { message: msg } : {}));
    keys = [() => answer(true), ev.canAlways ? () => answer(true, { always: true }) : null, deny].filter(Boolean);
    let n = 0;
    fill(actions,
      h('button.btn.primary', { type: 'button', onclick: () => answer(true) }, keyed(++n, icon('check', { size: 16 }), h('span', 'Allow'))),
      ev.canAlways ? h('button.btn.secondary', { type: 'button',
        title: ev.always === 'edits' ? 'Claude changes files without asking for the rest of this chat' : `Claude does not ask again in this chat for: ${ruleWords(ev.alwaysText) || 'this'}`,
        onclick: () => answer(true, { always: true }) }, keyed(++n, h('span', ev.always === 'edits' ? 'Allow all edits in this chat' : 'Allow in this chat'))) : null,
      h('button.btn.secondary.danger-text', { type: 'button', onclick: deny }, keyed(++n, icon('x', { size: 16 }), h('span', 'Do not allow'))));
  }
  if (!el.keys) el.keys = (n) => (keys[n - 1] ? (keys[n - 1](), true) : false);

  el.closed = (text, ok) => {
    if (el.done) return;
    el.done = true;
    el.classList.add('chat-is-decided');
    fill(actions);
    fill(extra);
    // Answered: one line. A permission's diff or command is on the tool card above; a question keeps its choices
    // (what was picked shows) but no empty "own answer" box.
    if (ev.type !== 'question' && ev.type !== 'plan') fill(body);
    for (const i of el.querySelectorAll('.chat-ask-scope, .chat-ask-why')) i.remove(); // about the answer, given now
    for (const i of el.querySelectorAll('.chat-q-other')) if (!i.value.trim()) i.remove();
    for (const i of el.querySelectorAll('button, input, textarea')) i.disabled = true;
    fill(status, icon(ok ? 'check' : 'x', { size: 14 }), h('span', text));
  };
  return el;
}

const KINDS = { Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'shell', Read: 'read', Grep: 'search', Glob: 'search', WebFetch: 'web', WebSearch: 'web' };
const kindOf = (tool) => KINDS[tool] || 'other';

/** The words of an ask-closed outcome: [text, ok]. */
export const OUTCOME = {
  allowed: ['You allowed this', true],
  'allowed-always': ['You allowed this for the rest of the chat', true],
  denied: ['You said no', false],
  cancelled: ['No longer waiting', false],
};
