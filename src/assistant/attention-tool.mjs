// read_attention: Tia reads the operator's attention list (GET /api/operator/attention, src/operator/feature.mjs).
// Read-only (L0): she does no act of the list through it. `show` also reads the owner's standing rules ("rules": each
// rule's sentence, on or off, its budget left) and what the rules did ("done"); changing them is the owner's alone.
//
// Made for a small model and a small budget: three closed parameters with defaults, a fixed short result (summary,
// items, more, next) of at most 4 KB, and a cursor so that a later call returns only what changed. The cursor is
// stateless: the kind it was read with, a dot, and six hex characters per item she was shown (a hash of its id and
// rev), so the server keeps nothing for it, and an item she was not shown yet comes in the next read.

import { createHash } from 'node:crypto';
import { KINDS } from '../operator/item.mjs';
import { int, obj, str } from './schema.mjs';
import { toolError } from './toolkit.mjs';

export const RESULT_BYTES = 4096;
const CURSOR_ITEM = 6;
const CURSOR_MAX = 50;
// The cursor's prefix is one of the kinds a read takes, so its form and length come from that list.
const READ_KINDS = ['all', ...KINDS];
const SINCE_FORM = new RegExp(`^(?:(?:${READ_KINDS.join('|')})\\.)?(?:[0-9a-f]{${CURSOR_ITEM}})*$`);
const SINCE_MAX = Math.max(...READ_KINDS.map((k) => k.length)) + 1 + CURSOR_ITEM * CURSOR_MAX;

const SHOWS = ['items', 'rules', 'done'];
const mark = (it) => createHash('sha256').update(`${it.id}\n${it.rev}`).digest('hex').slice(0, CURSOR_ITEM);
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One item as she gets it: what it is, its first facts, what the owner would tap. */
function brief(it, acts, factChars, facts) {
  const rec = it.acts.find((a) => a.id === it.recommended) || {};
  return {
    id: it.id, kind: it.kind, class: it.class, subject: cut(it.subject, 60), since: it.since,
    facts: it.facts.slice(0, facts).map((f) => cut(f, factChars)),
    recommended: rec.label || acts[it.recommended]?.label || it.recommended,
    why: cut(it.why, factChars),
  };
}

export const read_attention = {
  name: 'read_attention',
  level: 'L0',
  description: 'Read the attention list: what needs the owner now, ranked (what can lose work, stopped work, what waits for him, this computer, information), each item with its facts and the step he would tap. kind narrows it to one kind; limit is how many items (1 to 20, default 10); since is the cursor of an earlier result, to get only what changed. show "rules" reads the owner\'s standing rules (what Tia does by herself, on or off, budget left); show "done" reads what those rules did. You only read: the owner taps the steps and switches the rules on the Operator page (open_screen "operator").',
  input: obj({
    kind: str({ enum: ['all', ...KINDS], desc: 'all (the default), or one kind: limit (stopped at a usage limit), stuck (no progress), asks (waits for his answer or OK), ended (a session or Work run ended), provider (near a limit, signed out, gateway down), machine (load, memory, disk), leftover (a process left behind), repo (behind, ahead or not committed), live (login page or public link down), automation (a commit an automation made to his data), providerstop (a provider stopped a session or an agent in it: a refused model name, a lost sign-in, no answer, a server error, a refusal), unknown (a run failed for a reason nobody can explain).' }),
    limit: int({ min: 1, max: 20, desc: 'How many items at most (default 10).' }),
    since: str({ min: 0, max: SINCE_MAX, pattern: SINCE_FORM, desc: 'Not a time: the since value from next of an earlier read_attention result, to get only what changed since that result. Leave it out to read the whole list.' }),
    show: str({ enum: SHOWS, desc: 'items (the default): the attention list; rules: the owner\'s standing rules, each on or off, with its budget left; done: what the rules did by themselves, newest first.' }),
  }),
  // The one call that recovers from a wrong field (the core puts it after "Next:").
  recover(field, raw) {
    const kinds = ['all', ...KINDS];
    if (field === 'kind') {
      const k = String(raw?.kind ?? '').toLowerCase();
      const near = kinds.find((x) => x === k.replace(/s$/, '') || (k.length > 2 && x.startsWith(k.slice(0, 4))));
      return `call read_attention ${JSON.stringify({ kind: near || 'all' })} (kind is one of ${kinds.join(', ')})`;
    }
    if (field === 'since') return 'call read_attention {} for the whole list; since takes only the since value from next of an earlier read_attention result, never a time or an item id';
    if (field === 'limit') return 'call read_attention {"limit":20} (limit is a whole number from 1 to 20)';
    if (field === 'show') return 'call read_attention {"show":"rules"} (show is one of items, rules, done)';
    return 'call read_attention {} (its fields are kind, limit, since and show, all optional)';
  },
  async run(ops, a) {
    let r;
    try {
      r = await ops.attention({ kind: a.kind && a.kind !== 'all' ? a.kind : null });
    } catch (e) {
      if (e.status === 404) throw toolError('this computer has no attention list (its Hoprig is older)', 'call list_sessions and get_computer_status instead');
      throw toolError('the attention list could not be read', 'call read_attention again in a minute; if it fails again, call list_sessions');
    }
    if (a.show === 'rules' || a.show === 'done') return showReflexes(r, a.show, a.limit || 10);
    const kind = a.kind || 'all';
    const limit = a.limit || 10;
    const all = (r.items || []).filter((it) => kind === 'all' || it.kind === kind);
    // A cursor holds what one kind's read showed: another kind's items are neither new nor gone for it.
    const sinceKind = a.since !== undefined ? (/^([a-z]+)\./.exec(a.since)?.[1] || 'all') : null;
    if (sinceKind && sinceKind !== kind) {
      throw toolError(`that since value is from a read of kind ${sinceKind}, not ${kind}`, `call read_attention ${JSON.stringify(sinceKind === 'all' ? { since: a.since } : { kind: sinceKind, since: a.since })} for what changed there, or read_attention ${JSON.stringify(kind === 'all' ? {} : { kind })} for the whole ${kind === 'all' ? 'list' : `${kind} list`}`);
    }
    const seen = a.since !== undefined ? new Set(a.since.replace(/^[a-z]+\./, '').match(/.{6}/g) || []) : null;
    const changed = seen ? all.filter((it) => !seen.has(mark(it))) : all;
    const gone = seen ? [...seen].filter((m) => !all.some((it) => mark(it) === m)).length : 0;
    const nextFor = (shown) => {
      // What she has seen after this result: what she saw before and is still there, and what this result shows.
      const marks = [...new Set([...all.filter((it) => seen?.has(mark(it))).map(mark), ...shown.map(mark)])].slice(0, CURSOR_MAX);
      return [
        { act: 'open_screen {"screen":"operator"}', label: 'show the owner the Operator page, where he taps the recommended step' },
        { act: `read_attention ${JSON.stringify({ ...(kind === 'all' ? {} : { kind }), since: `${kind}.${marks.join('')}` })}`, label: 'later: what changed since this result, and what it did not show yet' },
      ];
    };
    const what = kind === 'all' ? 'item(s)' : `${kind} item(s)`;
    // The route sends its first 50 items: the whole list's count, and how many it did not send, come from it.
    const total = Number.isInteger(r.count) ? r.count : all.length;
    const unsent = Number.isInteger(r.more) && r.more > 0 ? r.more : 0;
    // A source that could not be read, or a detector that failed, may hide items: the list is then never "fine".
    const unread = [
      ...(r.watched || []).filter((w) => !w.ok && w.at).map((w) => `${w.source} (${cut(String(w.error || '').replace(/^could not be read: /, ''), 60)})`),
      ...(r.broken || []).map((b) => `the ${b.kind} check (${cut(b.error, 60)})`),
    ];
    // The kinds of the whole list, most first, when there is more than one: a small model then asks for the kind it needs.
    const byKind = kind === 'all' && r.kinds && Object.keys(r.kinds).length > 1 ? `: ${Object.entries(r.kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(', ')}` : '';
    const asOf = r.at ? ` as of ${String(r.at).slice(0, 16).replace('T', ' ')} UTC` : '';
    const missing = unread.length ? `; could not read: ${unread.slice(0, 4).join(', ')}, so this list may miss items` : '';
    const summary = seen
      ? `${changed.length} new or changed ${what}, ${gone} gone, ${total} in all${asOf}${r.hidden ? `; ${r.hidden} put off by the owner` : ''}${missing}.`
      : `${total} ${what} need the owner${byKind}${unread.length ? ' in what could be read' : ''}${asOf}${r.hidden ? `; ${r.hidden} put off by him` : ''}${missing}.`;
    // The fixed shape; the items get shorter, then fewer, until the result fits its budget.
    let take = Math.min(limit, changed.length);
    const shape = (n, chars, facts) => ({ items: changed.slice(0, n).map((it) => brief(it, r.acts || {}, chars, facts)), more: changed.length - n + unsent, next: nextFor(changed.slice(0, n)) });
    // The card of this result (cardmake.mjs): the first items as the list has them, with their rev and acts. It is
    // never rendered for her (core.mjs render reads summary and data only).
    const cardData = { items: changed.slice(0, 3), acts: r.acts || {}, total };
    for (const [chars, facts] of [[90, 4], [70, 3], [50, 2], [40, 1]]) {
      const data = shape(take, chars, facts);
      if (Buffer.byteLength(JSON.stringify({ summary, data })) <= RESULT_BYTES) return { summary, data, cardData };
    }
    let data;
    do {
      data = shape(take, 40, 1);
      take--;
    } while (take >= 0 && Buffer.byteLength(JSON.stringify({ summary, data })) > RESULT_BYTES);
    return { summary, data, cardData };
  },
};

const OPEN = { act: 'open_screen {"screen":"operator"}', label: 'show the owner the Operator page, where he switches the rules and sees what they did' };

/** The rules, or what they did: a fixed short shape within the same budget. Read only. */
function showReflexes(r, show, limit) {
  const x = r.reflexes;
  if (!x) throw toolError('this computer has no standing rules (its Hoprig is older)', 'call read_attention {} for the attention list');
  if (show === 'rules') {
    const on = x.rules.filter((ru) => ru.on).length;
    const summary = `${cut(x.said, 160)} ${on} of ${x.rules.length} rules on${x.projectsOut.length ? `; never in: ${x.projectsOut.slice(0, 5).map((n) => cut(n, 30)).join(', ')}` : ''}.`;
    const data = {
      rules: x.rules.map((ru) => ({ id: ru.id, rule: cut(ru.sentence, 120), on: ru.on, left: `${ru.left.hour} more this hour, ${ru.left.day} more today`, undo: ru.undo ? 'yes' : 'no' })),
      next: [OPEN, { act: 'read_attention {"show":"done"}', label: 'what the rules did' }],
    };
    return { summary, data };
  }
  const lines = (r.byTia || []).slice(0, limit).map((l) => ({ at: l.at, rule: l.by, subject: cut(l.subject, 60), act: l.act, result: cut(l.result, 100), done: l.ok === true, refused: l.refused === true }));
  let n = lines.length;
  const shape = () => ({ summary: `${(r.byTia || []).length} line(s) of what Tia did by herself or was refused, newest first; ${cut(x.said, 120)}`, data: { done: lines.slice(0, n), more: lines.length - n, next: [OPEN, { act: 'read_attention {"show":"rules"}', label: 'the rules, on or off' }] } });
  while (n > 0 && Buffer.byteLength(JSON.stringify(shape())) > RESULT_BYTES) n--;
  return shape();
}
