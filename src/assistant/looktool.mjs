// look: read up to six facts in ONE call. A fact is the id of a read act: the frequent ones are the reads she had before
// (sessions, session.screen, attention, computers, providers, projects, brain, work.today, work.list), which are answered by those
// tools as they were, and every other read row of the acts file (acts.json) is read through its route inside the look (the door
// lets a catalog read pass only here) and cut to the row's own pick, with no secret field, at most 4,000 characters. A fact that
// is not a read row is not run: its answer (card or open) comes back with the act id for do_act.
import { arr, obj, str } from './schema.mjs';
import { actShown, picksShown, answerFor, argsObj, legacyCall, readRow } from './catalogtools.mjs';
import { rowById, toolOf, ACT_ID } from './catalog.mjs';
import { comp, computer, tool, toolError } from './toolkit.mjs';
import { openAnswer } from './screens.mjs';
import { slowCause } from './slowcause.mjs';

/** The frequent facts: the tool of hers that answers each, and how its arguments are named. */
const FREQUENT = {
  sessions: (a) => ({ tool: 'list_sessions', args: a }),
  'session.screen': (a) => ({ tool: 'read_session', args: a }),
  attention: (a) => ({ tool: 'read_attention', args: a }),
  computers: (a) => ({ tool: 'get_computer_status', args: a }),
  providers: (a) => ({ tool: 'get_computer_status', args: { ...a, providers: true } }),
  projects: (a) => ({ tool: 'list_projects', args: a }),
  brain: (a) => ({ tool: 'read_brain', args: a }),
  'work.today': (a) => ({ tool: 'manage_work', args: { ...a, action: 'today' } }),
  'work.list': (a) => ({ tool: 'manage_work', args: { ...a, action: 'list' } }),
  'work.progress': (a) => ({ tool: 'manage_work', args: { ...a, action: 'progress' } }),
  // The git state of a folder (the code editor's own read routes): changed files, the branch, the last commits. folder = its root.
  'git.status': (a) => gitFact('code.git.status', a),
  'git.log': (a) => gitFact('code.git.log', a),
  // Why is it slow: the cause from what the router already measured (slowcause.mjs), no request of its own.
  'why-slow': (a) => ({ tool: 'look_slow', args: a }),
};
function gitFact(act, { folder, root, computer: c, ...rest }) {
  return { tool: 'look_row', args: { act, args: { query: { root: folder || root, ...rest } }, ...(c ? { computer: c } : {}) } };
}
export const FREQUENT_FACTS = Object.freeze(Object.keys(FREQUENT));

export const look = tool({
  name: 'look',
  level: 'L0',
  description: 'Read before you answer: up to 6 facts in ONE call, never one call per fact. A fact is {id, args?}. Frequent ids: sessions, session.screen, attention, computers, providers, projects, brain, work.today, work.list, work.progress, git.status {folder} (branch, changed files), git.log {folder, n} (last commits), why-slow (why providers are slow). Any other read act id from find_acts works too. A fact that is not a read says its answer and the id for do_act.',
  input: obj({
    facts: arr(obj({
      id: str({ max: 64, pattern: /^[a-z][a-z0-9.-]{1,63}$/, desc: 'A fact id.' }),
      args: argsObj('Its fields, if any.'),
      computer,
    }, { required: ['id'] }), { min: 1, max: 6 }),
  }, { required: ['facts'] }),
  // An act id that is not a frequent fact counts only when find_acts showed it in this conversation.
  check(a, ctx) {
    for (const f of a.facts) {
      if (FREQUENT[f.id]) continue;
      actShown(ctx, f.id);
      picksShown(ctx, f.args, f.computer);
    }
  },
  // Each fact goes to the tool that answers it (core.mjs runs the parts one after the other and joins the answers).
  forwards(a) {
    return a.facts.map((f) => {
      if (FREQUENT[f.id]) {
        const r = FREQUENT[f.id]({ ...(f.args || {}), ...(f.computer ? { computer: f.computer } : {}) });
        return r;
      }
      const row = ACT_ID.test(f.id) ? rowById(f.id) : null;
      const legacy = row && answerFor(row) === 'read' ? legacyCall(row, f.args || {}, f.computer) : null;
      if (legacy) return legacy;
      return { tool: 'look_row', args: { act: f.id, ...(f.args ? { args: f.args } : {}), ...(f.computer ? { computer: f.computer } : {}) } };
    });
  },
});

/** One catalog fact of a look: no tool of hers lists it (internal: not in her array, only a look reaches it). */
export const look_row = tool({
  name: 'look_row',
  level: 'L0',
  internal: true,
  description: 'One fact of look.',
  input: obj({ act: str({ max: 64 }), args: argsObj('Its fields.'), computer }, { required: ['act'] }),
  async run(ops, a) {
    const row = ACT_ID.test(a.act) ? rowById(a.act) : null;
    if (!row) throw toolError(`unknown fact ${a.act.slice(0, 40)}`, 'call find_acts with a few words of what you want, or use a frequent id of look');
    const ans = answerFor(row, a.computer);
    if (ans === 'read' && !toolOf(row)) return readRow(ops, row, a.args || {}, comp(a));
    const o = ans === 'open' && row.facts && row.facts.never !== 'none' ? openAnswer(row, { computer: a.computer }) : null;
    return {
      summary: `${row.id} is not a read: its answer is ${ans}. Next: do_act ${row.id}${o ? ` (${o.say})` : ''}.`,
      data: { act: row.id, answer: ans, screen: row.screen, press: row.press },
    };
  },
});

/** The fact why-slow: the cause of slow work on this computer's providers, from what the router measured (internal). */
export const look_slow = tool({
  name: 'look_slow',
  level: 'L0',
  internal: true,
  description: 'Why providers are slow.',
  input: obj({ computer }),
  async run(ops, a) {
    const v = slowCause(await ops.accounts({ computer: comp(a) }));
    return { summary: `${v.say}${v.next ? ` Next: ${v.next}` : ''}`, data: v };
  },
});
