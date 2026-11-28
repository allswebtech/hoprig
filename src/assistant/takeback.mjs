// What she may do ALONE (the owner's switch "Tia acts by herself" is on) and how each such act is taken back. The rule (design: she
// does alone only what changes nothing but Hoprig's own state and is undone with one press):
//   (a) back  the act records the value before it and the act that restores it; Activity then shows ONE press Undo that the person
//             presses, that restores the state, once (undo.mjs). Where the value before cannot be read, or cannot be put back
//             (a chat with no name: a name cannot be taken away again), the call is a card.
//   (b) card  an act with no true way back (a message sent into a session, a stop, a close, a start of work, a provider switch of
//             running work, a sync, a setting of the machine) is a card even with the switch on: switchGate (policy.mjs) makes it so.
//   free      an act that changes nothing of his (a note to him, a screen opened, a check for updates, ending her own job).
// ONE table: the gate, find_acts' answer, the Undo and the census test all read it, so a new act is a card until it has an entry here.
import { LOCAL } from './shown.mjs';
import { comp, toolError } from './toolkit.mjs';

const CHAT = /^chat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const chatId = (name) => (CHAT.exec(String(name)) || [])[1] || null;
const sessionOf = async (ops, a) => (await ops.listSessions({ computer: comp(a) })).find((x) => x.name === a.session && (x.computer || LOCAL) === comp(a)) || null;
const titleOf = (c) => (c && typeof c.title === 'string' ? c.title.trim() : '');

/**
 * The acts she does alone with a way back. key: what matches (matchOf below); rows: the rows of the acts file whose answer stays
 * "alone"; capture(ops, a, ctx): the state before, or null when it cannot be put back; record(a, kept, result): what Activity keeps
 * ({ kind, ... }, or null when this call changed nothing); restore(ops, rec, ctx): puts it back and says what it did.
 * own: the tool itself already records its undo (hoprig_act), so nothing is added.
 */
export const BACKS = Object.freeze({
  'rename-chat': {
    rows: ['chats.title'],
    why: 'a chat with no name of its own cannot be given back that state: a name cannot be taken away again',
    async capture(ops, a) {
      const t = titleOf(await sessionOf(ops, a));
      return t ? { title: t } : null;
    },
    record: (a, kept) => ({ kind: 'rename-chat', computer: comp(a), session: a.session, name: a.name, value: kept.title }),
    async restore(ops, r) {
      const c = await sessionOf(ops, { session: r.session, computer: r.computer });
      if (!c) throw toolError('the chat is gone, so there is nothing to put back', 'leave it');
      if (titleOf(c) !== String(r.name).trim()) throw toolError('the chat was renamed again since: left as it is', 'leave it');
      await ops.renameChat({ computer: r.computer, id: chatId(r.session), title: r.value });
      return { summary: `The chat is called "${r.value}" again.` };
    },
  },
  'rename-session': {
    rows: ['sessions.rename'],
    async capture(ops, a) {
      const c = await sessionOf(ops, a);
      return c ? { name: a.session, created: c.created } : null;
    },
    record: (a, kept) => ({ kind: 'rename-session', computer: comp(a), session: a.name, value: kept.name, created: kept.created }),
    async restore(ops, r) {
      const c = await sessionOf(ops, { session: r.session, computer: r.computer });
      if (!c) throw toolError('the session is not there under that name any more: left as it is', 'leave it');
      // The name may belong to another session of his by now: only the one she renamed is put back.
      if (c.created !== r.created) throw toolError('that name is on another session now: left as it is', 'leave it');
      await ops.renameSession({ computer: r.computer, session: r.session, name: r.value });
      return { summary: `The session is called ${r.value} again.` };
    },
  },
  'watch-add': {
    rows: [],
    capture: async () => ({}),
    // A watch that was there already was not added by this call: nothing to take back.
    record: (a, kept, result) => (result && result.audit && result.audit.watch && result.audit.already !== true ? { kind: 'watch-add', id: result.audit.watch } : null),
    async restore(ops, r, ctx) {
      if (!ctx.watches || !ctx.watches.remove(r.id)) throw toolError('the watch is not there any more: left as it is', 'leave it');
      return { summary: 'The watch is removed again.' };
    },
  },
  'watch-remove': {
    rows: [],
    async capture(ops, a, ctx) {
      const w = ctx.watches && ctx.watches.list().find((x) => x.id === a.id);
      return w ? { watch: w } : null;
    },
    record: (a, kept) => ({ kind: 'watch-remove', watch: kept.watch }),
    async restore(ops, r, ctx) {
      const put = ctx.watches && ctx.watches.put(r.watch);
      if (!put || put.error) throw toolError(put && put.error ? put.error : 'this dashboard keeps no watches', 'leave it');
      return { summary: 'The watch is back.' };
    },
  },
  'hold-starts': { rows: ['act.hold-starts'], own: true, capture: async () => ({}), record: () => null },
  'change-plan': {
    rows: ['act.change-plan', 'work.plans-write'],
    own: true,
    // The plan's old title and goal are read by the act itself; a plan that cannot be read now cannot be put back.
    async capture(ops, a) {
      const now = await ops.workPlanOne({ computer: comp(a), id: a.item });
      return now && now.plan ? {} : null;
    },
    record: () => null,
  },
  'rename-computer': {
    rows: ['machine.label', 'machines.rename'],
    why: 'a computer with no name of its own cannot be given back that state',
    async capture(ops, a) {
      const c = (await ops.computers()).find((x) => x.name === comp(a));
      const label = c && typeof c.label === 'string' ? c.label.trim() : '';
      return label ? { label } : null;
    },
    record: (a, kept) => ({ kind: 'rename-computer', computer: comp(a), name: a.label, value: kept.label }),
    async restore(ops, r) {
      const c = (await ops.computers()).find((x) => x.name === r.computer);
      if (!c || String(c.label || '').trim() !== String(r.name).trim()) throw toolError('the computer was renamed again since: left as it is', 'leave it');
      await ops.renameComputer({ computer: r.computer, label: r.value });
      return { summary: `The computer is called "${r.value}" again.` };
    },
  },
  'pause-automations': {
    rows: [],
    // Paused already: nothing changes, nothing to take back (the record is dropped below).
    async capture(ops, a) {
      return { paused: !!(((await ops.automation({ computer: comp(a) })).settings || {}).paused) };
    },
    record: (a, kept) => (kept.paused ? null : { kind: 'pause-automations', computer: comp(a) }),
    async restore(ops, r) {
      await ops.automationSettings({ computer: r.computer, patch: { paused: false } });
      return { summary: 'The automations run again.' };
    },
  },
  // A job she opened to watch a session (a goal): the press stops that job. Joining a session to a job that exists is not put back by this.
  'watch-session': {
    rows: ['act.watch-session'],
    capture: async () => ({}),
    record: (a, kept, result) => (result && result.data && typeof result.data.job === 'string' ? { kind: 'watch-session', job: result.data.job } : null),
    async restore(ops, r, ctx) {
      const j = ctx.jobs.get(r.job);
      if (!j || j.state === 'done' || j.state === 'stopped') throw toolError('the job has ended already: left as it is', 'leave it');
      ctx.jobs.finish(r.job, 'stopped', 'taken back by the owner');
      return { summary: 'The job is stopped: nothing watches that session for her any more.' };
    },
  },
  review: {
    rows: ['skillhub.review', 'skillhub.update-review'],
    // A review fetched a skill into quarantine and installed nothing: cancelling it deletes the fetched files again.
    capture: async () => ({}),
    record: (a, kept, result) => (result && result.audit && typeof result.audit.review === 'string' ? { kind: 'review', computer: comp(a), review: result.audit.review } : null),
    async restore(ops, r) {
      await ops.skillCancel({ computer: r.computer, id: r.review });
      return { summary: 'The review is cancelled: its fetched files are gone.' };
    },
  },
  // Her acts on the owner's tasks keep their own record and their own Undo on the result card (worktool.mjs, core.mjs undoView).
  work: { rows: ['work.items', 'work.items-write', 'work.items.plan'], own: true, viaCard: true, capture: async () => ({}), record: () => null },
});

/** Acts that change nothing of his: no switch, no undo (policy.mjs NO_SWITCH holds the first three; a check for updates only looks). */
export const FREE = Object.freeze({
  notify_owner: ['act.notify-owner'], open_screen: ['act.open-screen'], finish_job: ['act.finish-job'], 'manage_computer.check_updates': ['updates.check'],
});

const HOLD_OK = new Set(['title', 'goal']);
/** The key of the entry for a call of tool `name` with input `a`, or null (no way back: a card). */
export function backKey(name, a = {}) {
  switch (name) {
    case 'send_to_chat': return a.name !== undefined ? 'rename-chat' : null;
    case 'send_to_session': return a.name !== undefined ? 'rename-session' : null;
    case 'watch_work': return a.action === 'add' ? 'watch-add' : a.action === 'remove' ? 'watch-remove' : null;
    case 'hoprig_act':
      if (a.act === 'hold-starts') return 'hold-starts';
      // Only a change of a plan's title or goal is put back (its old words are kept); a new plan or a milestone is not.
      if (a.act === 'change-plan') return a.item !== undefined && a.value && typeof a.value === 'object' && Object.keys(a.value).length && Object.keys(a.value).every((k) => HOLD_OK.has(k)) ? 'change-plan' : null;
      return null;
    case 'watch_session': return a.goal !== undefined && a.job === undefined ? 'watch-session' : null;
    case 'manage_computer': return a.action === 'rename' ? 'rename-computer' : null;
    case 'manage_automation': return a.action === 'pause' ? 'pause-automations' : null;
    case 'manage_skills': return a.action === 'review' || a.action === 'update_review' ? 'review' : null;
    case 'manage_work': return ['add', 'edit', 'done', 'reopen', 'undo'].includes(a.action) ? 'work' : null;
    default: return null;
  }
}

/**
 * HER OWN WORK: the sessions she starts and the sessions she started herself (her jobs). Starting, writing to, answering, stopping and
 * moving the provider of those is what the owner's level "Do the work" / "Hands off" (Settings → Tia) lets her do, judged by that level,
 * the daily limit and her allow-lists (policy.mjs); none of it can be unsent, so it has no Undo. It is alone ONLY on those sessions and
 * only while the switch is on: the same acts on a session she did not start (his) are a card. Empty this list and every one is a card.
 */
export const OWN_WORK = Object.freeze({
  start_chat: 'new', start_session: 'new', send_to_chat: 'hers', send_to_session: 'hers', stop_session: 'hers', switch_account: 'hers', watch_session: 'hers',
});

/** { kind: 'free' } | { kind: 'back', key, entry } | { kind: 'work' } | null: what a call of `name` with `a` is when it would run alone. `f`: the facts of the call. */
export function aloneOf(name, a = {}, f = {}) {
  // An administrator command at Full: the owner's own level for her administrator rights (Settings → Tia) is his consent, judged by policy.mjs.
  if (name === 'run_command') return { kind: 'his-setting' };
  if (FREE[name] || (a && a.action && FREE[`${name}.${a.action}`])) return { kind: 'free' };
  const key = backKey(name, a);
  if (key) return { kind: 'back', key, entry: BACKS[key] };
  const w = OWN_WORK[name];
  // Only a start of NEW work is hers; going on in, resuming or forking one of his earlier conversations is a card.
  if (w === 'new' && (a.conversation !== undefined || (a.mode || 'new') !== 'new' || a.fork_of !== undefined)) return null;
  if (w === 'new' || (w === 'hers' && f && (f.mine === true || f.herWork === true))) return { kind: 'work' };
  return null;
}

/** The rows of the acts file whose answer stays "alone" (they have a way back or change nothing); every other row with a tool is a card. */
export const ALONE_ROWS = new Set([...Object.values(BACKS).flatMap((b) => b.rows), ...Object.values(FREE).flat()]);
