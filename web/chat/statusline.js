// The status line under the composer: what Claude does now (the tool that runs and for how long, or that it
// thinks), then the branch, the cost so far, the context used and the plan's limits where the provider says them.
// The model, effort and mode are the chips just above it: not said twice. Only the first part is read out by a
// screen reader when it changes (the list of the conversation is not: it would read every streamed word).
import { fill, h } from '../lib.js';
import { contextPercent, hasPlan, limitsLine, money, turnRuns } from './words.js';

const ACTIVITY = { requesting: 'Claude is thinking', compacting: 'Compacting the conversation', retrying: 'Retrying' };
const ASKING = { permission: 'Needs your OK', question: 'Claude asks you a question', plan: 'A plan waits for your OK' };

/** The tool of the main conversation that runs now (written whole, not yet answered), or null. */
const runningTool = (v) => (v.live || []).find((b) => b.kind === 'tool' && b.written && !b.agent) || null;

/** Seconds since `at` (the chat's clock), on this computer's clock. */
const secondsSince = (at, v) => Math.max(0, Math.round((Date.now() - (v.skew || 0) - at) / 1000));

/** What the chat does, in words. */
export function stateWords(v) {
  if (v.terminal) return 'Runs in a terminal';
  if (v.status === 'attention') return ASKING[v.asking] || ASKING.permission;
  if (v.status === 'working') {
    // A tool that runs is what Claude does now: its command (or title) and for how long.
    const tool = runningTool(v);
    if (tool && (tool.command || tool.title)) return `Running: ${tool.command || tool.title}${Number.isFinite(tool.runAt) ? ` · ${secondsSince(tool.runAt, v)} s` : ''}`;
    if (v.activity && ACTIVITY[v.activity]) return `${ACTIVITY[v.activity]}…`;
    if ((v.live || []).some((b) => b.kind === 'text' && !b.agent)) return 'Claude is writing…';
    if ((v.live || []).some((b) => b.kind === 'thinking' && !b.agent)) return 'Claude is thinking…';
    const bg = (v.tasks || []).filter((t) => t.status === 'running' && t.background).length;
    if (!turnRuns(v)) return bg ? `Working in the background: ${bg === 1 ? '1 task' : `${bg} tasks`}` : 'Working in the background…';
    return 'Working…';
  }
  if (v.lastEnd === 'stopped') return 'Stopped';
  if (v.lastEnd === 'limit' || (v.limit && !v.lastError)) return 'Stopped at the usage limit';
  return v.lastError ? 'Stopped with an error' : 'Ready';
}

/**
 * The dot's colour by what the chat does: a terminal runs it, an error, Stop, the usage limit (the danger colour the
 * limit has on Home and the providers), else the chat's status.
 */
export function statusKey(v) {
  if (v.terminal) return 'terminal';
  if (v.status !== 'waiting') return v.status;
  if (v.lastError) return 'error';
  if (v.lastEnd === 'stopped') return 'stopped';
  if (v.lastEnd === 'limit' || v.limit) return 'limit';
  return v.status;
}

/** The rest of the line: [label, text] pairs (the label is for a screen reader and the title). */
export function statusParts(v) {
  const p = contextPercent(v.usage);
  const lim = hasPlan(v) ? limitsLine(v.limits) : ''; // the plan's limits: a Claude subscription's only
  return [
    v.branch ? ['Git branch', v.branch] : null,
    Number.isFinite(v.costTotal) && v.costTotal > 0 ? ['Cost so far', `${money(v.costTotal)} so far`] : null,
    p !== null ? ['Context', `context ${p}%`] : null,
    lim ? ['Plan limits', lim] : null,
  ].filter(Boolean);
}

/** → { el, paint(v), stop() }: while a tool runs, its seconds count up once a second. */
export function createStatusLine() {
  const state = h('span.chat-st-state', { role: 'status', 'aria-live': 'polite' });
  const timer = h('span.chat-st-timer', { 'aria-hidden': 'true' }); // the seconds: shown, not read out each second
  const rest = h('span.chat-st-rest');
  const el = h('div.chat-status', h('span.chat-st-dot', { 'aria-hidden': 'true' }), state, timer, rest);
  let v = null;
  let tick = null;
  const words = () => {
    const w = stateWords(v);
    const m = / · (\d+) s$/.exec(w);
    // The words change only when the step does (a screen reader hears it once); the seconds beside them.
    fill(state, m ? w.slice(0, m.index) : w);
    fill(timer, m ? ` · ${m[1]} s` : '');
    return !!m;
  };
  return {
    el,
    paint(s) {
      v = s;
      el.dataset.status = statusKey(v);
      const counting = words();
      clearInterval(tick);
      tick = counting ? setInterval(words, 1000) : null;
      fill(rest, statusParts(v).map(([label, text]) => h('span.chat-st-part', { title: label, 'data-k': label }, text)));
    },
    stop: () => clearInterval(tick),
  };
}
