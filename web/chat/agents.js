// The agents a chat runs: subagents (drawn inside the call that started them, tools.js), background agents, shells
// and workflows (with their phases and agents), each with its model and effort when known and a Stop of its own; and
// the one line above the composer ("4 in the background: ..."), which opens the whole tree. The tasks come with the chat's state
// (src/chat/tasks.mjs); a task's own stop is POST /tasks/<id>/stop.
import { icon } from '../icons.js';
import { closeSheet, errorWords, fill, h, openSheet } from '../lib.js';
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
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await stop(t.taskId);
    } finally {
      // A stop that did not reach the computer can be tried again: the rail keeps this button for as long as the task
      // runs (rail.js paintTasks). One that worked takes the row away with the next update.
      b.disabled = false;
    }
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

/** "4 background tasks · 2 agents · 1 shell · 1 workflow" (the part's head), or '' when nothing runs. */
export function taskCounts(tasks) {
  const now = running(tasks);
  if (!now.length) return '';
  const n = {};
  for (const t of now) n[TYPE[t.type] || 'agent'] = (n[TYPE[t.type] || 'agent'] || 0) + 1;
  return [`${now.length} background task${now.length === 1 ? '' : 's'}`, ...Object.entries(n).map(([k, x]) => `${x} ${k}${x === 1 ? '' : 's'}`)].join(' · ');
}

/** How long a task runs: "42 s", "1m 04s", "1h 02m". */
export function runFor(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The whole tree: what runs first, then what ended; each task with its line, its workflow and a Stop (the Background
 * tasks sheet; the session rail has a compact row per task, rail.js).
 */
export function taskTree(tasks, stop, jump, show) {
  if (!tasks.length) return h('p.chat-hint', 'No agents, background shells or workflows in this session yet.');
  const order = [...tasks].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return h('ul.chat-tasklist', order.map((t) => h(`li.chat-task.chat-s-${t.status || 'running'}`,
    h('div.chat-task-head',
      icon(t.type === 'shell' ? 'terminal' : t.type === 'workflow' ? 'grid' : 'sparkle', { size: 16 }),
      h('strong', t.title || TYPE[t.type] || 'task'),
      t.background ? h('span.badge', 'background') : null,
      t.status === 'running' && stop ? taskStop(t, stop) : null),
    h('p.chat-hint', taskLine(t)),
    t.error ? h('p.chat-hint.chat-task-err', t.error) : null,
    t.type === 'workflow' ? workflowView(t) : null,
    h('div.chat-task-links',
      show ? h('button.btn.small.ghost', { type: 'button', 'aria-label': `Output of ${t.title || TYPE[t.type] || 'task'}`, onclick: () => show(t.taskId) }, 'Output') : null,
      t.toolId && jump ? h('button.btn.small.ghost', { type: 'button', onclick: () => jump(t.toolId) }, 'Show in the chat') : null))));
}

/**
 * `parent`'s children become `nodes`, in order, moving only what must move: one that stays where it is is never taken
 * out (fill() would take every child out and put it back, and the browser moves the focus off a control taken out).
 */
export function place(parent, nodes) {
  const want = new Set(nodes);
  for (const c of [...parent.children]) if (!want.has(c)) c.remove();
  nodes.forEach((n, i) => {
    const at = parent.children[i] || null;
    if (n !== at) parent.insertBefore(n, at);
  });
}

const OUT_MS = 3000; // an open output of a task that runs is read again this often, only while it is open

/**
 * A task opened to its output (a shell's last lines, an agent's report), with its Stop beside it. `read()` → { text,
 * cut, running }; the sheet reads again while the task runs and the sheet is open, and when `again()` is called.
 * o: { task() (the task as it is now), read(), stop(taskId) | null, jump(toolId) | null }. → { done (resolves at close), again(),
 * follow() (the tasks were reported again: the sheet shows the task's state now) }
 */
export function openTaskOutput(o) {
  const t0 = o.task();
  const pre = h('pre.chat-task-out', { tabindex: 0, role: 'log', 'aria-label': `Output of ${t0.title || TYPE[t0.type] || 'task'}` });
  const cut = h('p.chat-hint.hidden', 'Earlier lines are not shown.');
  const sub = h('p.chat-hint');
  const actions = h('div.chat-task-links');
  let timer = null;
  let gone = false;
  let last = '';
  let shownStatus = null;
  async function load() {
    try {
      const r = await o.read();
      if (gone) return;
      const text = r && r.text ? r.text : '';
      if (text !== last) {
        last = text;
        const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24; // at the end: stays at the end
        fill(pre, text || (o.task().status === 'running' ? 'Nothing written yet.' : 'No output.'));
        if (stick) pre.scrollTop = pre.scrollHeight;
      }
      cut.classList.toggle('hidden', !(r && r.cut));
    } catch (e) {
      if (!gone) fill(pre, `The output could not be read: ${errorWords(e) || 'try again'}`);
    }
    paintTop();
  }
  function paintTop() {
    const t = o.task();
    fill(sub, taskLine(t));
    // The buttons are drawn again only when the task's state changed (a focused Stop is not taken out at each read).
    if (shownStatus !== t.status) {
      shownStatus = t.status;
      drawActions(t);
    }
    // One read at a time on a timer; none once the task is over (what it wrote is final).
    clearTimeout(timer);
    timer = t.status === 'running' && !gone ? setTimeout(load, OUT_MS) : null;
  }
  function drawActions(t) {
    const stop = t.status === 'running' && o.stop ? taskStop(t, async (id) => {
      await o.stop(id);
      load();
    }) : null;
    fill(actions, stop, t.toolId && o.jump ? h('button.btn.small.ghost', { type: 'button', onclick: () => o.jump(t.toolId) }, 'Show in the chat') : null);
  }
  const done = openSheet({ title: t0.title || TYPE[t0.type] || 'Task', subtitle: 'Output of this background task', wide: true, tall: true }, () => {
    paintTop();
    load();
    return [sub, actions, cut, pre];
  }).then(() => {
    gone = true;
    clearTimeout(timer);
  });
  // The chat reported the tasks again: the sheet shows the task as it is now (its state and Stop), and reads the output once
  // more when the state changed, so the lines it ended with are there.
  const follow = () => {
    if (gone) return;
    const was = shownStatus;
    paintTop();
    if (shownStatus !== was) load();
  };
  return { done, again: () => (gone ? null : load()), follow };
}

const PLURAL = { agent: 'agents', shell: 'shells', workflow: 'workflows', monitor: 'monitors' };

/**
 * The one line above the box, in words: the task when only one runs ("sleep 240 · 2 min"), else the count and what kinds
 * ("23 in the background: 15 shells, 8 workflows"). '' when nothing runs.
 */
export function bgWords(tasks, skew = 0, now = Date.now()) {
  const on = running(tasks);
  if (!on.length) return '';
  if (on.length === 1) {
    const t = on[0];
    const name = t.title || TYPE[t.type] || 'task';
    return Number.isFinite(t.startedAt) ? `${name} · ${took(Math.max(0, now - skew - t.startedAt))}` : name;
  }
  const n = {};
  for (const t of on) n[TYPE[t.type] || 'agent'] = (n[TYPE[t.type] || 'agent'] || 0) + 1;
  return `${on.length} in the background: ${Object.entries(n).map(([k, x]) => `${x} ${x === 1 ? k : PLURAL[k] || `${k}s`}`).join(', ')}`;
}

/**
 * The Background tasks line above the box (as Claude Code lists what runs under its prompt): ONE line, a dot and the
 * words (bgWords), and one press on it opens the Background tasks sheet: the whole tree, each task with its Stop and its
 * output. There is no list or fold of its own. o: { stop(taskId), canStop(), jump(toolId), output(taskId) } →
 * { el, open(), paint(tasks, skew), stopClock() }. The open sheet follows the tasks while it is open.
 */
export function agentsStrip(o) {
  let tasks = [];
  let skew = 0; // this computer's clock against the chat's (the page's state says it)
  let tick = null;
  // One task's Stop where the coding tool can (o.canStop), else none: the turn's Stop is the way there.
  const stop = () => (!o.canStop || o.canStop() ? o.stop : null);
  let body = null; // the open sheet's body: it follows the tasks
  let close = () => {};
  const jump = (id) => {
    close();
    o.jump(id);
  };
  // A click on a task opens its output (the sheet reads it from the chat's computer: o.output(taskId)).
  let outSheet = null; // the output sheet that is open: it follows the tasks as the chat reports them (paint)
  const show = o.output ? (id) => {
    const now = () => tasks.find((x) => x.taskId === id) || { taskId: id, status: 'stopped' };
    const sheet = openTaskOutput({ task: now, read: () => o.output(id), stop: stop(), jump: o.jump ? (tool) => { closeSheet(); o.jump(tool); } : null });
    outSheet = sheet;
    sheet.done.then(() => { if (outSheet === sheet) outSheet = null; });
  } : null;
  async function open() {
    if (body) return;
    body = h('div.chat-tree', taskTree(tasks, stop(), jump, show));
    await openSheet({ title: 'Background tasks', subtitle: 'Agents, shells and workflows of this session, each with its model and effort where the coding tool says them.' }, (c) => {
      close = c;
      return body;
    });
    body = null;
    close = () => {};
  }
  const label = h('span.chat-bg-label');
  const line = h('button.chat-bg-line', { type: 'button', 'aria-haspopup': 'dialog', onclick: open }, h('span.chat-strip-dot', { 'aria-hidden': 'true' }), label, icon('chevronRight', { size: 14 }));
  const el = h('section.chat-bg.hidden', { 'aria-label': 'Background tasks' }, line);
  const words = () => {
    const w = bgWords(tasks, skew);
    fill(label, w);
    line.setAttribute('aria-label', `Background tasks: ${w}. Open`);
  };
  return {
    el,
    open,
    /** The clock of the line stops (the page is left). */
    stopClock: () => clearInterval(tick),
    paint(tasksNow, skewNow = 0) {
      tasks = Array.isArray(tasksNow) ? tasksNow : [];
      skew = Number.isFinite(skewNow) ? skewNow : 0;
      const now = running(tasks);
      el.classList.toggle('hidden', !now.length);
      words();
      clearInterval(tick);
      // The seconds of one task count up once a second, only while it shows.
      tick = now.length === 1 ? setInterval(words, 1000) : null;
      if (tick && typeof tick.unref === 'function') tick.unref();
      if (body) fill(body, taskTree(tasks, stop(), jump, show));
      if (outSheet) outSheet.follow();
    },
  };
}
