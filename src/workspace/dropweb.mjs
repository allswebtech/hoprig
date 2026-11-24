// `hoprig drop` from the Workspace page: the terminal's drop, question for question (docs/WORKSPACE.md, "Drop").
// Nothing here decides what a drop may remove: the check, the questions, the acts and the lock are drop.mjs's own;
// this file only answers the questions with what the owner pressed and typed on the page's sheet.
//
//   check(name)              drop.mjs's --check, with the terminal's own lines (dropcli.mjs printResult) and a
//                            one-use ticket bound to what the check found (its fingerprint), for ten minutes
//   drop(ticket, answers)    the drop itself: the ticket is used once; drop.mjs checks everything again (after a fetch)
//                            and, when that differs from what the sheet showed, nothing is asked or done and the new
//                            list comes back with a new ticket. answers: { work: true only on his press, defaults:
//                            { <repository>: 'push' | 'wip' } only on his press of that very answer, typed: what he
//                            typed into the field } (the server compares it with the project's name; no default)
import crypto from 'node:crypto';
import { NO_TERMINAL, dropProject } from './drop.mjs';
import { QUESTION, printResult, shareOwnFile } from './dropcli.mjs';
import { makeUi } from '../setup/ui.mjs';

export const TICKET_MS = 10 * 60_000;
const TICKET_RE = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/**
 * What a check found that a drop would ask about or refuse: equal only when the same things are only here, and the same
 * commits and the same content of the work files (drop.mjs seals: a commit amended after the check is another one).
 */
export function fingerprint(r) {
  const items = {
    refusals: (r.refusals || []).filter((x) => x.what !== NO_TERMINAL).map((x) => [x.repo, x.what]),
    pushes: r.pushes || [],
    asks: r.asks || [],
    seals: r.seals || [],
    confirm: (r.confirm || []).map((i) => [i.repo, i.path, i.kind, i.size, i.files ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/** The terminal's own words for a result (printResult), as lines without colours. */
function linesOf(r, mode, tilde) {
  let text = '';
  const ui = makeUi({ interactive: false, write: (s) => (text += s) });
  printResult(ui, r, mode);
  return plain(text).split('\n').map((l) => tilde(l.replace(/\s+$/, ''))).filter((l, i, a) => l || (i > 0 && a[i - 1]));
}

/** The questions the sheet asks, in the terminal's words and order. */
function questionsOf(r) {
  const out = [];
  for (const a of r.asks || []) {
    if (a.ask === 'work') out.push({ ask: 'work', repos: a.repos, words: QUESTION.work(a.repos.length) });
    else if (a.ask === 'default branch') {
      const c = { label: a.repo, def: { branch: a.branch, count: a.commits } };
      out.push({ ask: 'default branch', repo: a.repo, branch: a.branch, commits: a.commits, words: `${QUESTION.defaultBranch(c)}${a.memory ? QUESTION.defaultMemory : ''}.`, release: QUESTION.release(a.branch), choices: QUESTION.choices(a.branch).map(([value, words]) => ({ value, words })) });
    } else out.push({ ask: 'confirm', name: a.name, items: a.items, words: QUESTION.confirmPage(a.name) });
  }
  return out;
}

/**
 * The page's drop for one computer's dashboard. `ctx()`: { dir, projects }; `tilde(text)`: paths as ~ for the
 * page; `now()`, `run`, `share` for tests.
 */
export function pageDrop({ ctx, tilde: tildeOf = (s) => s, now = () => Date.now(), run, share } = {}) {
  const tilde = (s) => tildeOf(String(s)); // one argument only: never an index from map()
  const tickets = new Map(); // ticket → { name, fp, until }
  const used = new Map(); // ticket → until: a used one is named as used, not as old
  const sweep = () => {
    for (const [k, t] of tickets) if (t.until <= now()) tickets.delete(k);
    for (const [k, until] of used) if (until <= now()) used.delete(k);
  };
  const opts = () => ({ ctx: ctx(), ...(run ? { run } : {}) });
  const view = (r, mode, withTicket) => {
    const out = {
      name: r.ref || r.spec, result: r.result, ok: r.ok,
      lines: linesOf(r, mode, tilde),
      refusals: (r.refusals || []).filter((x) => x.what !== NO_TERMINAL).map((x) => ({ repo: x.repo, what: tilde(x.what), command: tilde(x.command || '') })),
      questions: mode === 'check' ? questionsOf(r) : [],
      confirm: (r.confirm || []).map((i) => ({ repo: i.repo, path: i.path, kind: i.kind, size: i.size, ...(i.files ? { files: i.files } : {}) })),
      did: (r.did || []).map(tilde), notes: (r.notes || []).map(tilde),
    };
    // A ticket only for a check that a drop could follow: something to drop and nothing that refuses.
    if (withTicket && mode === 'check' && r.ok && r.result !== 'not here' && !out.refusals.length) {
      sweep();
      const ticket = crypto.randomBytes(32).toString('hex');
      tickets.set(ticket, { name: r.ref, fp: fingerprint(r), until: now() + TICKET_MS });
      out.ticket = ticket;
      out.until = now() + TICKET_MS;
    }
    return out;
  };

  /** drop.mjs's --check of `name` (read only). `ticket`: give one (the owner's own page only). */
  async function check(name, { ticket = false } = {}) {
    const r = await dropProject(name, { ...opts(), mode: 'check' });
    return view(r, 'check', ticket);
  }

  /** The drop, with the owner's answers. → the result, or { result: 'changed' | 'expired', check } */
  async function drop(ticket, answers = {}) {
    if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return { result: 'expired', ok: false, error: 'open the sheet again: it has no valid ticket' };
    sweep();
    const t = tickets.get(ticket);
    tickets.delete(ticket); // used once, whatever happens next
    if (!t) return { result: 'expired', ok: false, error: used.has(ticket) ? 'this sheet was used already: check again, it checks the project again' : 'this sheet is older than ten minutes: check again, it checks the project again' };
    used.set(ticket, t.until);
    const typed = typeof answers.typed === 'string' ? answers.typed.trim() : '';
    const ask = {
      work: async () => answers.work === true,
      defaultBranch: async (c) => {
        const a = answers.defaults && Object.hasOwn(answers.defaults, c.label) ? answers.defaults[c.label] : null;
        return a === 'push' || a === 'wip' ? a : 'stop';
      },
      confirm: async (n) => typed !== '' && typed === n,
    };
    const r = await dropProject(t.name, { ...opts(), mode: 'drop', ask, share: share || (() => shareOwnFile(ctx().dir)), checked: (now2) => fingerprint(now2) === t.fp });
    if (r.result === 'changed') return { result: 'changed', ok: false, error: 'the project changed since the sheet opened: nothing was dropped. Here is what is only here now', check: await check(t.name, { ticket: true }) };
    // Stopped at a question (nothing done): the sheet gets a fresh check and ticket, so he can answer and press again.
    if (r.result === 'stopped' && !r.did.length) return { ...view(r, 'drop', false), check: await check(t.name, { ticket: true }) };
    return view(r, 'drop', false);
  }

  return { check, drop, tickets };
}
