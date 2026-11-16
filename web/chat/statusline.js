// The status line under the composer: what Claude does now, then the model, effort and mode it runs with, the cost
// so far, the context used and the plan's limits where the provider says them. Only the first part is read out by a
// screen reader when it changes (the list of the conversation is not: it would read every streamed word).
import { fill, h } from '../lib.js';
import { contextPercent, effortName, limitsLine, modeChip, modeOf, modelName, money } from './words.js';

const ACTIVITY = { requesting: 'Claude is thinking', compacting: 'Compacting the conversation', retrying: 'Retrying' };

/** What the chat does, in words. */
export function stateWords(v) {
  if (v.terminal) return 'Runs in a terminal';
  if (v.status === 'attention') return 'Needs your OK';
  if (v.status === 'working') {
    if (v.activity && ACTIVITY[v.activity]) return `${ACTIVITY[v.activity]}…`;
    const tool = (v.live || []).find((b) => b.kind === 'tool' && !b.written) || (v.live || []).find((b) => b.kind === 'tool');
    if (tool && tool.title) return `Working: ${tool.title}`;
    const bg = (v.tasks || []).filter((t) => t.status === 'running' && t.background).length;
    return bg && !(v.live || []).length ? `Working: ${bg} in the background` : 'Working…';
  }
  return v.lastError ? 'Stopped with an error' : 'Ready';
}

/** The rest of the line: [label, text] pairs (the label is for a screen reader and the title). */
export function statusParts(v) {
  // The owner's choice; on Auto, the model the coding tool says it runs.
  const model = v.model ? modelName(v.model) : `Auto${v.liveModel ? ` · ${modelName(String(v.liveModel).replace(/-\d.*$/, ''))}` : ''}`;
  const p = contextPercent(v.usage);
  const lim = limitsLine(v.limits);
  return [
    ['Model', model],
    ['Effort', v.effort ? effortName(v.effort) : 'effort Auto'],
    ['Mode', modeChip(modeOf(v))],
    v.ultracode ? ['Ultracode', 'ultracode'] : null,
    Number.isFinite(v.costTotal) && v.costTotal > 0 ? ['Cost so far', `${money(v.costTotal)} so far`] : null,
    p !== null ? ['Context', `context ${p}%`] : null,
    lim ? ['Plan limits', lim] : null,
  ].filter(Boolean);
}

export function createStatusLine() {
  const state = h('span.chat-st-state', { role: 'status', 'aria-live': 'polite' });
  const rest = h('span.chat-st-rest');
  const el = h('div.chat-status', h('span.chat-st-dot', { 'aria-hidden': 'true' }), state, rest);
  return {
    el,
    paint(v) {
      el.dataset.status = v.terminal ? 'terminal' : v.status === 'waiting' && v.lastError ? 'error' : v.status;
      fill(state, stateWords(v));
      fill(rest, statusParts(v).map(([label, text]) => h('span.chat-st-part', { title: label }, text)));
    },
  };
}
