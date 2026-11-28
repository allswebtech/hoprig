// watch_work (design 2.1 tool 7, "watch"): tell the owner when something needs him, without a model turn. The watch is the
// owner's own state (watches.mjs): adding and removing one changes nothing else and is taken back with one press (remove).
// Never poll by yourself: add a watch, answer, and stop. The dashboard evaluates watches in its attention loop and pushes.
import { WHEN, WHEN_OF, ON, TELL, HOURS, WAKES_PER_DAY, WATCH_ID, sentence } from './watches.mjs';
import { int, obj, str } from './schema.mjs';
import { toolError, tool } from './toolkit.mjs';

const brief = (w) => ({ id: w.id, watches: `${w.on}${w.target ? ` ${w.target}` : ''}`, when: w.when, tell: w.tell, hours: w.hours, state: w.firedAt ? 'told' : 'waiting', until: new Date(w.expiresAt).toISOString() });

export const watch_work = tool({
  name: 'watch_work',
  // A list is a read; adding or removing a watch is her own small act on Hoprig's state: alone only with his switch on, else a card (core.mjs).
  level: 'L1',
  card: 'maybe',
  levelOf: (a) => (a.action === 'list' ? 'L0' : 'L1'),
  description: `Tell the owner when something needs him ("tell me when"); never poll yourself. add (on, target, when), list or remove (id). tell: push (default, no model), row (a row in Needs you) or wake (wakes you for a decision, ${WAKES_PER_DAY} a day at most). hours ${HOURS.min} to ${HOURS.max}, default 24. A watch tells once.`,
  input: obj({
    action: str({ enum: ['add', 'list', 'remove'], full: true }),
    on: str({ enum: ON, full: true, desc: 'What to watch.' }),
    target: str({ max: 64, oneLine: true, desc: 'Its name or id as a tool result showed it.' }),
    when: str({ enum: WHEN, full: true, desc: 'When to tell.' }),
    tell: str({ enum: TELL, full: true, desc: 'How: push, row or wake.' }),
    hours: int({ min: HOURS.min, max: HOURS.max, desc: 'How long to watch (default 24).' }),
    id: str({ max: 12, pattern: WATCH_ID, desc: 'The watch to remove, from add or list.' }),
  }, { required: ['action'] }),
  check(a) {
    if (a.action === 'add') {
      for (const k of ['on', 'when']) if (a[k] === undefined) throw toolError(`add needs "${k}"`, `add ${k}`);
      if (!WHEN_OF[a.on].includes(a.when)) throw toolError(`a ${a.on} can be watched for: ${WHEN_OF[a.on].join(', ')}`, `call watch_work add with when one of those`);
      if (a.id !== undefined) throw toolError('add takes no "id"', 'leave id out');
    } else if (a.action === 'remove') {
      if (a.id === undefined) throw toolError('remove needs "id"', 'call watch_work list for the ids');
    } else if (a.id !== undefined || a.on !== undefined || a.when !== undefined) throw toolError('list takes no other field', 'call watch_work {"action":"list"}');
  },
  before: async (ops, a) => ({ action: a.action }),
  cardLines: (a) => (a.action === 'remove'
    ? [`Stop watching: watch ${a.id}`]
    : [`Watch ${a.on}${a.target ? ` ${a.target}` : ''} and tell you ${a.when === 'needs-me' ? 'when it needs you' : `when it ${a.when}`}`, `Tell by: ${a.tell === 'row' ? 'a row in Needs you' : a.tell === 'wake' ? 'waking Tia' : 'a push'}, for ${a.hours || 24} hour(s)`]),
  async run(ops, a, ctx) {
    const store = ctx.watches;
    if (!store) throw toolError('this dashboard keeps no watches', 'tell the owner in your answer');
    if (a.action === 'list') {
      const list = store.list();
      return { summary: `${list.length} watch(es).`, data: { watches: list.map(brief) } };
    }
    if (a.action === 'remove') {
      if (!store.remove(a.id)) throw toolError(`there is no watch ${a.id}`, 'call watch_work {"action":"list"} for the ids');
      return { summary: `Watch ${a.id} is removed.`, data: { removed: a.id }, audit: { watch: a.id, removed: true } };
    }
    const r = store.add({ on: a.on, target: a.target, when: a.when, tell: a.tell, hours: a.hours });
    if (r.error) throw toolError(r.error, 'fix that field and call watch_work add again');
    const w = r.watch;
    return {
      summary: `${r.already ? 'Already watching' : 'Watching'}: you will be told ${w.tell === 'row' ? 'in Needs you' : 'by a push'} when ${sentence(w).replace(/\.$/, '')}, for up to ${w.hours} hour(s). Remove it with watch_work remove ${w.id}.`,
      data: brief(w), audit: { watch: w.id, on: w.on, when: w.when, tell: w.tell, ...(r.already ? { already: true } : {}) },
    };
  },
});
export { watch_work as watch };
