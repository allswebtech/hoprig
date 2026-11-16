// The agents a chat runs: subagents (drawn inside the call that started them, tools.js), background agents, shells
// and workflows (with their phases and agents), each with its model and effort when known and a Stop of its own; and
// the strip "2 agents running" above the composer, which opens the whole tree. The tasks come with the chat's state
// (src/chat/tasks.mjs); a task's own stop is POST /tasks/<id>/stop.
import { icon } from '../icons.js';
import { fill, h, openSheet } from '../lib.js';
import { effortName, kilo, modelName, took } from './words.js';

const TYPE = { agent: 'agent', shell: 'shell', workflow: 'workflow', monitor: 'monitor' };
const STATUS = { running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped', pending: 'waiting' };

/** One line of a task: what it does now, its model and effort, what it used. */
export function taskLine(t) {
  const u = t.usage || {};
  return [
    STATUS[t.status] || t.status || '',
    t.status === 'running' ? t.now || t.summary || '' : '', // an ended task's summary is its report: on the card
    t.model ? modelName(t.model) : null,
    t.effort ? `effort ${effortName(t.effort).toLowerCase()}` : null,
    Number.isFinite(u.tools) && u.tools ? `${u.tools} tool${u.tools === 1 ? '' : 's'}` : null,
    Number.isFinite(u.tokens) && u.tokens ? `${kilo(u.tokens)} tokens` : null,
    Number.isFinite(u.ms) && u.ms ? took(u.ms) : null,
  ].filter(Boolean).join(' · ');
}

/** The Stop of one task. */
export function taskStop(t, stop) {
  return h('button.btn.small.secondary.chat-taskstop', { type: 'button', 'aria-label': `Stop ${t.title || 'this task'}`, onclick: async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.disabled = true;
    await stop(t.taskId);
  } }, icon('stop', { size: 14 }), h('span', 'Stop'));
}

/** A workflow's phases, each with its agents and their state. */
export function workflowView(t) {
  const phases = Array.isArray(t.phases) ? t.phases : [];
  const agents = Array.isArray(t.agents) ? t.agents : [];
  if (!phases.length && !agents.length) return null;
  const groups = phases.length ? phases.map((p) => ({ title: p.title, list: agents.filter((a) => a.phase === p.index) })) : [{ title: '', list: agents }];
  const loose = phases.length ? agents.filter((a) => !phases.some((p) => p.index === a.phase)) : [];
  if (loose.length) groups.push({ title: 'Other', list: loose });
  return h('ol.chat-wf', groups.map((g) => h('li.chat-wf-phase',
    g.title ? h('strong', g.title) : null,
    g.list.length ? h('ul.chat-wf-agents', g.list.map((a) => h(`li.chat-wf-agent.chat-s-${String(a.state || 'queued').replace(/[^a-z]/g, '')}`,
      h('span.chat-wf-mark', { 'aria-hidden': 'true' }, a.state === 'done' ? '✓' : a.state === 'failed' ? '✗' : a.state === 'running' ? '▸' : '○'),
      h('span.chat-wf-label', a.label || a.agentId || 'agent'),
      h('span.chat-wf-meta', [a.state, a.model ? modelName(a.model) : null, a.effort ? `effort ${a.effort}` : null, a.tools ? `${a.tools} tools` : null, a.tokens ? `${kilo(a.tokens)} tokens` : null, a.ms ? took(a.ms) : null].filter(Boolean).join(' · '))))) : null)));
}

const running = (tasks) => tasks.filter((t) => t.status === 'running');

/** "2 agents · 1 shell running" (the strip's words), or '' when nothing runs. */
export function runningWords(tasks) {
  const now = running(tasks);
  if (!now.length) return '';
  const n = {};
  for (const t of now) n[TYPE[t.type] || 'agent'] = (n[TYPE[t.type] || 'agent'] || 0) + 1;
  return `${Object.entries(n).map(([k, x]) => `${x} ${k}${x === 1 ? '' : 's'}`).join(' · ')} running`;
}

/** The whole tree: what runs first, then what ended; each task with its line, its workflow and a Stop. */
function tree(tasks, stop, jump) {
  if (!tasks.length) return h('p.chat-hint', 'No agents, background shells or workflows in this chat yet.');
  const order = [...tasks].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return h('ul.chat-tasklist', order.map((t) => h(`li.chat-task.chat-s-${t.status || 'running'}`,
    h('div.chat-task-head',
      icon(t.type === 'shell' ? 'terminal' : t.type === 'workflow' ? 'grid' : 'sparkle', { size: 16 }),
      h('strong', t.title || TYPE[t.type] || 'task'),
      t.background ? h('span.badge', 'background') : null,
      t.status === 'running' ? taskStop(t, stop) : null),
    h('p.chat-hint', taskLine(t)),
    t.error ? h('p.chat-hint.chat-task-err', t.error) : null,
    t.type === 'workflow' ? workflowView(t) : null,
    t.toolId && jump ? h('button.btn.small.ghost', { type: 'button', onclick: () => jump(t.toolId) }, 'Show in the chat') : null)));
}

/**
 * The strip above the composer and the sheet it opens. o: { stop(taskId), jump(toolId) }. → { el, paint(tasks) }
 * The open sheet follows the tasks while it is open.
 */
export function agentsStrip(o) {
  let tasks = [];
  let body = null; // the open sheet's body: it follows the tasks
  let close = () => {};
  const jump = (id) => {
    close();
    o.jump(id);
  };
  const label = h('span');
  const el = h('button.chat-strip.hidden', { type: 'button', onclick: async () => {
    body = h('div.chat-tree', tree(tasks, o.stop, jump));
    await openSheet({ title: 'Agents and background work', subtitle: 'Each with its model and effort where Claude Code says them.' }, (c) => {
      close = c;
      return body;
    });
    body = null;
    close = () => {};
  } }, h('span.chat-strip-dot', { 'aria-hidden': 'true' }), label, icon('chevronRight', { size: 14 }));
  return {
    el,
    paint(list) {
      tasks = Array.isArray(list) ? list : [];
      const words = runningWords(tasks);
      el.classList.toggle('hidden', !words);
      fill(label, words);
      if (body) fill(body, tree(tasks, o.stop, jump));
    },
  };
}
