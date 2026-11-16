// A tool call as a card, drawn by its kind: an edit or write as a real diff, a shell command with its output and how
// it ended, a read, a search, a web page, a skill, an agent (its own steps nest inside, see timeline.js) and a
// workflow (its phases and agents, see agents.js). Long output shows its first lines and a "Show all". Whether a
// call worked is said by an icon and a word as well as a colour. Everything from Claude is set as text.
import { icon } from '../icons.js';
import { fill, h } from '../lib.js';
import { mdView } from '../mdtext.js';
import { taskLine, taskStop, workflowView } from './agents.js';
import { addedView, diffView, hunkCounts, hunksOf } from './diff.js';
import { exitCode, inFolder, lineCount, toolLine } from './words.js';

const SHOW_LINES = 12;
const OPEN_KINDS = new Set(['edit', 'agent', 'workflow', 'plan', 'question']); // open by default: what they did is the point

/** Text shown by its first lines, with a "Show all" that opens the rest in place (no scroll box inside the list). */
export function outputView(text, { err = false, lines = SHOW_LINES, cls = 'chat-out' } = {}) {
  const all = String(text || '').replace(/\n+$/, '');
  const rows = all.split('\n');
  const pre = h(`pre.${cls}${err ? '.chat-is-err' : ''}`, rows.length > lines + 3 ? rows.slice(0, lines).join('\n') : all);
  if (rows.length <= lines + 3) return pre;
  const more = h('button.btn.small.ghost.chat-showall', { type: 'button', onclick: () => {
    fill(pre, all);
    more.remove();
  } }, `Show all ${rows.length} lines`);
  return h('div.chat-outwrap', pre, more);
}

/** The input of an edit as a diff (the edit's own lines, since the file's numbers come with the result). */
function editInput(name, i) {
  if (name === 'Write') return addedView(i.content || '');
  if (name === 'NotebookEdit') return outputView(i.new_source || '', { cls: 'chat-code' });
  const pairs = Array.isArray(i.edits) ? i.edits : [i];
  return diffView(pairs.flatMap((e) => hunksOf(e.old_string || '', e.new_string || '')), { numbers: false });
}

/** What a tool call was given, as a person reads it. */
export function inputView(ev, cwd) {
  const i = ev.input || {};
  const path = (p) => (p ? h('p.chat-path', inFolder(p, cwd)) : null);
  switch (ev.toolKind) {
    case 'edit':
      return [path(i.file_path || i.notebook_path), editInput(ev.name, i)];
    case 'shell':
      return [
        i.command ? h('pre.chat-cmd', h('span.chat-cmd-prompt', { 'aria-hidden': 'true' }, '$ '), i.command) : null,
        i.description ? h('p.chat-hint', i.description) : null,
        i.run_in_background ? h('p.chat-hint', icon('clock', { size: 13 }), ' Runs in the background') : null,
      ];
    case 'read':
      return i.file_path ? h('p.chat-path', inFolder(i.file_path, cwd), i.offset ? ` · from line ${i.offset}` : '', i.limit ? ` · ${i.limit} lines` : '') : null;
    // The head already names the pattern, the address or the query: here only what it adds.
    case 'search':
      return i.path || i.glob ? h('p.chat-path', i.path ? `in ${inFolder(i.path, cwd)}` : '', i.path && i.glob ? ' · ' : '', i.glob || '') : null;
    case 'web':
      return i.prompt ? h('p.chat-hint', i.prompt) : null;
    case 'agent':
      return [
        h('p.chat-hint', [i.subagent_type, i.model, i.effort ? `effort ${i.effort}` : null].filter(Boolean).join(' · ')),
        i.prompt ? h('details.chat-prompt', h('summary', 'The task it was given'), outputView(i.prompt, { cls: 'chat-plain' })) : null,
      ];
    case 'plan':
      return i.plan ? mdView(i.plan) : null;
    case 'question':
      return (Array.isArray(i.questions) ? i.questions : []).map((q) => h('p.chat-hint', q.question || ''));
    case 'todo':
      return null;
    case 'workflow':
      return i.script ? h('details.chat-prompt', h('summary', 'Its script'), outputView(i.script, { cls: 'chat-code' })) : null;
    default:
      if (ev.name === 'Skill') return i.args ? h('p.chat-path', i.args) : null;
      return Object.keys(i).length ? outputView(JSON.stringify(i, null, 2), { cls: 'chat-code' }) : null;
  }
}

/**
 * A tool call's card. ev: the `tool` event, or a `tool-start` while its input is still written. o: { cwd, stopTask }.
 * The card has: .finish(toolEvent), .result(resultEvent), .progress(elapsedS), .task(task), and .steps (where a
 * subagent's own events go).
 */
export function toolCard(ev, o = {}) {
  const state = h('span.chat-tool-state', { 'aria-hidden': 'true' });
  const verb = h('span.chat-tool-verb');
  const detail = h('span.chat-tool-detail');
  const end = h('span.chat-tool-end');
  const said = h('span.chat-tool-said'); // "failed", "running": the state in words
  const input = h('div.chat-tool-input');
  const out = h('div.chat-tool-result');
  const taskBox = h('div.chat-tool-task');
  const steps = h('div.chat-steps');
  const el = h('details.chat-item.chat-tool.chat-is-running',
    h('summary', state, verb, detail, said, end),
    h('div.chat-tool-body', input, taskBox, steps, out));
  el.dataset.kind = ev.toolKind || 'other';
  el.steps = steps;
  let last = ev;
  let added = null;
  let quiet = false; // a card that waits for the owner shows the input (a question, a plan): not twice

  const counts = (c) => fill(end, h('span.chat-plus', `+${c.added}`), ' ', h('span.chat-minus', `−${c.removed}`));
  const head = (e) => {
    const line = e.input ? toolLine(e.name, e.input) : { verb: toolLine(e.name, {}).verb, detail: e.title || '', mono: e.toolKind !== 'agent' };
    fill(verb, line.verb);
    detail.className = `chat-tool-detail${line.mono ? ' mono' : ''}`;
    const i = e.input || {};
    // An edit: the file, and what it changes at the end of the line (Claude Code's own count once it ran).
    if (e.toolKind === 'edit' && e.input) {
      fill(detail, inFolder(i.file_path || i.notebook_path, o.cwd));
      if (!added && e.name !== 'NotebookEdit') counts(e.name === 'Write' ? { added: lineCount(i.content), removed: 0 } : hunkCounts((Array.isArray(i.edits) ? i.edits : [i]).flatMap((x) => hunksOf(x.old_string || '', x.new_string || ''))));
    } else fill(detail, line.detail || e.title || '');
  };
  head(ev);

  el.finish = (e) => {
    last = e;
    el.dataset.kind = e.toolKind || 'other';
    head(e);
    if (!quiet) fill(input, inputView(e, o.cwd));
    if (OPEN_KINDS.has(e.toolKind) && !el.dataset.touched) el.open = e.toolKind !== 'agent' || !e.agent;
  };
  el.addEventListener('toggle', () => (el.dataset.touched = '1'));
  if (ev.input) el.finish(ev);

  el.progress = (s) => {
    if (el.classList.contains('chat-is-running') && Number.isFinite(s)) fill(end, `${Math.round(s)} s`);
  };

  const result = (res) => {
    // Claude Code wraps a refused or broken call in <tool_use_error>: the words inside are what the owner reads.
    const r = { ...res, text: String(res.text || '').replace(/^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/, '$1') };
    el.classList.remove('chat-is-running');
    el.classList.add(r.ok ? 'chat-is-ok' : 'chat-is-err');
    fill(state, icon(r.ok ? 'check' : 'x', { size: 14 }));
    const code = last.toolKind === 'shell' ? exitCode(r.text) : null;
    fill(said, r.ok ? null : code !== null ? `failed · exit ${code}` : 'failed');
    if (!r.ok) el.open = true;
    const kind = last.toolKind;
    if (kind === 'edit' && r.ok) {
      if (r.diff && r.diff.length) {
        // Claude Code's own patch: the file's real line numbers.
        fill(input, h('p.chat-path', inFolder((last.input || {}).file_path, o.cwd)), diffView(r.diff));
        added = hunkCounts(r.diff);
        counts(added);
      }
      return fill(out);
    }
    // The to-do list is in the dock; a question's answers and a plan's approval are on their own card.
    if ((kind === 'todo' || kind === 'plan' || kind === 'question') && r.ok) return fill(out);
    if (kind === 'read' && r.ok) {
      fill(end, `${lineCount(r.text)} lines`);
      return fill(out, h('details.chat-prompt', h('summary', 'What it read'), outputView(r.text, { cls: 'chat-code' })));
    }
    if (kind === 'agent' && r.ok) return fill(out, r.text ? h('details.chat-prompt', h('summary', 'Its report'), h('div.chat-agent-answer', mdView(r.text))) : null);
    if (kind === 'workflow' && r.ok) return fill(out, r.text ? h('details.chat-prompt', h('summary', 'What Claude Code said'), outputView(r.text, { cls: 'chat-code' })) : null);
    if (kind === 'shell') {
      fill(out, r.text ? outputView(r.text, { err: !r.ok }) : h('p.chat-hint', 'No output.'));
      if (r.ok && !(last.input || {}).run_in_background) fill(end, code !== null ? `exit ${code}` : '');
      return out;
    }
    return fill(out, r.text ? outputView(r.text, { err: !r.ok }) : h('p.chat-hint', 'No output.'));
  };

  let task = null;
  el.result = (r) => {
    const x = result(r);
    if (task) el.task(task); // a result that comes after the task ended does not hide how it ended
    return x;
  };

  // The task this call started (an agent, a background shell, a workflow): its state, model, use and Stop.
  el.task = (t) => {
    task = t || null;
    if (!t) return fill(taskBox);
    const running = t.status === 'running';
    el.classList.toggle('chat-is-taskrun', running);
    fill(taskBox,
      h('div.chat-task-line', h('span', taskLine(t)), running && o.stopTask ? taskStop(t, o.stopTask) : null),
      t.type === 'workflow' ? workflowView(t) : null);
    // The call itself went well (it started the task); how the task ended is told by the icon and in words too.
    if (t.status === 'failed' || t.status === 'stopped') {
      fill(said, t.status);
      fill(state, icon(t.status === 'failed' ? 'x' : 'stop', { size: 14 }));
      el.classList.add(t.status === 'failed' ? 'chat-is-taskfail' : 'chat-is-taskstop');
    }
  };

  el.quiet = () => {
    quiet = true;
    fill(input);
    el.open = false; // one line: the card below shows it
  };
  el.kindOf = () => last.toolKind;
  el.added = () => added;
  return el;
}
