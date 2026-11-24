// Reflexes: a rule the owner switched on does an item's recommended act at once, with no model. Every act goes through
// the owner's tap (`perform` in feature.mjs: the list built again, the item still there with the same rev, the act one
// of its own, the same tap twice done once), with the rule's own checks added on the freshly built item: the master
// switch and the rule are on, Tia is on, the project is not taken out, the budget allows it, and the rule's condition
// holds. There is no second way to do an act.
//
// Every act of a rule, done or refused, is one line of the timeline the taps write, with the rule's id in `by`. The same
// refusal of the same item as it is now (its rev) is written once, not on every tick.

import { randomBytes } from 'node:crypto';
import { resolveTia } from '../assistant/tia.mjs';
import { BUDGET_DEFAULTS, RULES, RULE_IDS, readOperator, ruleById, ruleFor } from './rules.mjs';
import { TICK_LINE, mayEndFor, readDecide } from './decide-store.mjs';
import { engineOwns } from '../mission/seam.mjs';
import { record } from './record.mjs';
import { recentMoves } from '../movelog.mjs';
import { ranBefore } from '../runs.mjs';
import { clock, span } from './detect/util.mjs';
import { TYPING, hold, paidTyping } from './money.mjs';

const HOUR = 3600_000;
/** "Tried twice": two acts on one subject, within the last day, after each of which the item was back within the hour. */
export const TRIES = 2;
const UNKNOWN = Symbol('unknown');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// A mission's limit asks the limit rule while a round of this dashboard (every 20 s) or of another one on the same
// state folder may hold the record: it waits a little for it, as a held lock means "not now", not "his".
const RULE_LOCK_WAIT_MS = 5000;
const LOCK_TRY_MS = 200;
const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// The card's line and its timeline line: long enough for the longest refusal decider.mjs paidWhy builds (140) with its
// longest ending (", and today's daily limit for paid use of $… is used up: it is yours", 75 characters).
const WORDS_MAX = 220;
/**
 * The card's words at most WORDS_MAX long. A longer reason (Auto mode's order of many providers with long names) is
 * cut at a word's end with an ellipsis, and keeps its ending, what it asks of him (": it is yours", the place to
 * go): never a name cut in two, never a sentence without its end.
 */
function cardWords(s) {
  const t = short(s, Infinity);
  if (t.length <= WORDS_MAX) return t;
  const at = t.lastIndexOf(': ');
  const tail = at > 0 && t.length - at <= 80 ? t.slice(at) : '';
  let head = t.slice(0, tail ? at : t.length);
  const room = WORDS_MAX - tail.length - 2; // the ellipsis, and a bracket it may close
  head = head.slice(0, room + 1);
  const sp = head.lastIndexOf(' ');
  head = (sp > 0 ? head.slice(0, sp) : head.slice(0, room)).replace(/[\s,;:(]+$/, '');
  const open = (head.match(/\(/g) || []).length > (head.match(/\)/g) || []).length;
  return `${head}…${open ? ')' : ''}${tail}`;
}

/** "Tia decides" (decider.mjs) enters this same door under this id: its act is the step the decision picked. */
export const DECIDE = 'decide';
const decisionRule = (act, why = null) => ({ id: DECIDE, act, why, undo: act === 'switch' ? ruleById('limit').undo : null, noUndo: act === 'switch' ? null : act === 'hold' ? 'Lift the hold on the Operator page.' : 'It cannot be undone.', ...(act === 'hold' ? { noUndoWays: ['operator-page'] } : {}) });

/**
 * A refusal of a rule's act: `code` names it (one line per item rev and code), `say: false` writes no line. `keep`: the
 * project ref the words name, the one text with a slash its line may keep (feature.mjs plain).
 */
// `ways`: the places the words name, as codes of the page's table of places (web/errorways.js): his card and the line
// carry them, and the Operator page draws a link from each one it knows.
const refusal = (code, words, say = true, keep = [], ways = null) => Object.assign(new Error(words), { refusal: { code, words, say, keep, ...(ways ? { ways } : {}) } });

export function reflexes({ ctx, perform, fresh, line, dir, now, accounts, projectOf, move }) {
  const rec = record({ dir, now });
  const settings = () => readOperator(ctx.config());
  const iso = (t) => new Date(t).toISOString();
  let running = null;
  let deciding = null; // a decision's act on its way (decided, leave, ahead): Tia OFF waits for it too

  const lineOf = (rule, it, extra) => ({ at: iso(now()), by: rule.id, item: it.id, kind: it.kind, subject: it.subject, act: rule.act, ...extra });
  function tell(data, rule, it, { code, words, keep, ways }) {
    const key = `${rule.id}|${it.id}|${it.rev}|${code}`;
    // The same refusal of the same picture of the item is kept as it is: a new time on every tick rewrote the record.
    // The card and its line on the timeline hold the same words, cut at the same length: a reason made of provider
    // names may run past the timeline's usual 160 characters, and a line cut mid-word says less than the card.
    const w = cardWords(words);
    const had = data.his[it.id];
    // A paid move the daily limit for paid use does not allow: the card offers the button that opens that limit.
    if (!had || had.rev !== it.rev || had.words !== w) data.his[it.id] = { rev: it.rev, words: w, at: now(), ...(code === 'cap' ? { cap: true } : {}), ...(ways ? { ways } : {}) };
    if (data.told[key]) return;
    data.told[key] = now();
    line.add(lineOf(rule, it, { ok: false, refused: true, result: w, keep, ...(ways ? { ways } : {}) }));
  }

  // The project an item belongs to (a name), null when it belongs to none, UNKNOWN when its folder could not be read.
  const ofFolder = (folder) => {
    if (!folder) return UNKNOWN;
    const p = projectOf(folder);
    return p === undefined ? UNKNOWN : p;
  };
  function projectOfItem(it, board) {
    if (['limit', 'stuck', 'asks'].includes(it.kind)) return ofFolder((board.sessions || []).find((x) => x.name === it.target.session)?.folder);
    if (it.kind === 'leftover') return ofFolder((board.leftovers || []).find((x) => x.pid === it.target.pid)?.cwd);
    return null; // a gateway and the public link serve every project
  }

  /** The rule's checks on the item as it is now; throws a refusal. */
  async function check(rule, it, board, data, id = null) {
    const s = settings();
    const decision = rule.id === DECIDE;
    const on = (x) => x.active && (decision ? readDecide(ctx.config()).on : x.rules[rule.id]);
    if (!on(s)) throw refusal('off', 'Tia does not act by herself now', false);
    // Two loops never act on one thing: what the mission's engine owns (seam.mjs OWNER_OF) no rule and no decision does.
    if (engineOwns(it)) throw refusal('mission', 'a mission\'s engine looks after it', false);
    if (decision) {
      // A rule that is on for the item acts first; a decision picks only a step prepared for the item as it is now.
      const r = ruleFor(it, { now: now() });
      if (r && s.rules[r.id]) throw refusal('rule', `the ${r.id} rule is on for it`, false);
      if (rule.act && !(it.steps || []).includes(rule.act)) throw refusal('not-its', `${rule.act} is not a step prepared for it now: it is yours`);
    } else if (ruleFor(it, { now: now() })?.id !== rule.id) throw refusal('not-its', 'the rule is not for this item now', false);
    if (data.stops[`${rule.id}|${it.id}`] != null) throw refusal('his', 'Tia tried twice: it is yours', false);
    if (s.projectsOut.length) {
      const p = projectOfItem(it, board);
      if (p === UNKNOWN) throw refusal('folder', 'its folder could not be read while a project is taken out: Tia leaves it to you');
      if (p && s.projectsOut.includes(p)) throw refusal('project', `it is in the project ${p}, where Tia never acts: it is yours`, true, [p]);
    }
    const t = now();
    // A decision's acts are held by the limits the owner sees and sets for "Tia decides" (one per call, so the same
    // numbers), with a rule's wait between two tries on one item; a rule's by its own.
    const dd = decision ? readDecide(ctx.config()) : null;
    const b = decision ? { perHour: dd.perHour, perDay: dd.perDay, waitMinutes: BUDGET_DEFAULTS.waitMinutes } : s.budgets[rule.id] || BUDGET_DEFAULTS;
    const mine = data.acts.filter((a) => a.rule === rule.id);
    // Who did them, in his words: a rule by its name (its line as before), a decision as hers.
    const who = decision ? 'Tia\'s decisions did' : `the ${rule.id} rule did`;
    const most = decision ? 'their most' : 'its most';
    // Before a decision's call (no act yet) its own budget of calls, read next under its lock, holds the same numbers
    // and names them: the acts are counted here at the act.
    const counted = !(decision && !rule.act);
    if (counted && mine.filter((a) => t - a.at < HOUR).length >= b.perHour) throw refusal('hour', `${who} ${b.perHour} acts in the last hour, ${most}: this one is yours`);
    if (counted && mine.length >= b.perDay) throw refusal('day', `${who} ${b.perDay} acts today, ${most}: this one is yours`);
    const here = mine.filter((a) => a.item === it.id);
    // The item is here now: an act on it within the last hour did not make it go away ("did not help"). Such acts are
    // counted over the day, so a loop that the hour rule spaces just over an hour apart is stopped too.
    for (const a of here) if (!a.back && t - a.at < HOUR) a.back = t;
    if (here.filter((a) => a.back).length >= TRIES) {
      data.stops[`${rule.id}|${it.id}`] = t;
      throw refusal('twice', `Tia tried twice${rule.act ? ` (${rule.act})` : ''} and it came back: it is yours now. She leaves it for a day, or until you tap it.`);
    }
    const last = Math.max(-Infinity, ...here.map((a) => a.at));
    if (t - last < b.waitMinutes * 60_000) throw refusal('wait', `Tia acted on it ${span(t - last)} ago; she waits ${b.waitMinutes} min before she tries again`);
    // A decision's switch is checked as the limit rule's (its own act is the rule's act); its typing into a session on a
    // provider billed by use as her own send_to_session there.
    const pay = rule.act === 'switch' ? await limitCheck(it, data, t, board) : decision && TYPING.includes(rule.act) ? await typingCheck(it, board) : null;
    // "Tia OFF" may have been pressed while the checks above waited: read the switches again after the last await.
    // perform does the act right after this returns, with no await between, so no press comes in between.
    const again = settings();
    if (!on(again)) throw refusal('off', 'Tia does not act by herself now', false);
    // A decision's stop needs his tick on the item's project, read again here: he may have taken it off while the call
    // ran, or before an owed act is done (decider.mjs OWED_MS). Read in the same synchronous step as the act.
    if (decision && rule.act === 'stop') {
      const p = projectOfItem(it, board);
      if (!p || p === UNKNOWN || !mayEndFor(ctx.config(), p)) throw refusal('tick', TICK_LINE);
    }
    // A move onto a provider billed by use is money like her own switch_account: held against the daily limit for paid
    // use here, in the same synchronous step as the last check above, right before the act (spend.mjs take). No such
    // limit, or the limit used up: nothing is written and the move is his, with the line that names it.
    if (pay) {
      const no = hold(pay.what, pay.cap, `${pay.kind || 'move'}-${id}`);
      if (no) throw refusal('cap', no);
    }
  }

  async function limitCheck(it, data, t, board) {
    const { session, to } = it.target;
    const acc = await accounts();
    if (acc?.autoSwitch?.enabled === true) throw refusal('auto', 'Auto mode is on and moves sessions at a limit by itself: Tia leaves it to Auto mode');
    const tia = resolveTia(ctx.config().assistant, acc || { profiles: [] });
    if (!tia.allowed.includes(to)) throw refusal('allowed', `${to} is not a provider Tia may use (Settings → Tia). You decide this move yourself.`, true, [], ['tia-settings']);
    // A provider paid per use: her own switch_account asks the owner first unless her level is "Hands off"
    // (policy.mjs), so a rule of hers does not spend that money either.
    const p = (acc?.profiles || []).find((x) => x.name === to);
    const paid = !p || p.kind === 'api' || p.paid === true;
    if (paid && tia.level !== 'handsoff') throw refusal('paid', `${to} is paid per use, and Tia moves a session there only at "Hands off" (Settings → Tia). You decide this move yourself.`, true, [], ['tia-settings']);
    // Every move counts, whoever made it: a rule's and his tap's (the move log), and every run of the session's
    // conversation that left `to` (runs.mjs ranBefore): the launcher's own Auto mode, his move by hand in a terminal.
    const conv = (board?.sessions || []).find((x) => x.name === session)?.conversation;
    const runs = typeof conv === 'string' && conv ? ranBefore(t).filter((r) => r.conversation === conv && r.profile === to).map((r) => ({ session, from: to, at: r.until })) : [];
    const left = [...data.moves, ...recentMoves(t), ...runs].filter((m) => m.session === session && m.from === to && t - m.at < HOUR).sort((a, b) => b.at - a.at)[0];
    if (left) throw refusal('back', `the session left ${to} ${span(t - left.at)} ago; Tia never moves it back within the hour: it is yours`);
    // At "Hands off" a paid move still needs the daily limit for paid use: check() holds it right before the act.
    return paid ? { what: `Moving this session to ${to}`, cap: tia.dailyCapUsd } : null;
  }

  // Typing into a session whose provider is billed by use: its next turn is paid per token, so it is money like her own
  // send_to_session there (core.mjs spendsPaid): only at "Hands off", and check() holds it against the daily limit for paid use.
  async function typingCheck(it, board) {
    const acc = (await accounts()) || { profiles: [] };
    const pt = paidTyping(it, board, acc);
    if (!pt) return null;
    const tia = resolveTia(ctx.config().assistant, acc);
    if (tia.level !== 'handsoff') throw refusal('paid', `${pt.what} costs money by use, and Tia types into such a session only at "Hands off" (Settings → Tia): it is yours`, true, [], ['tia-settings']);
    return { what: pt.what, cap: tia.dailyCapUsd, kind: 'type' };
  }

  // An act that was in flight when the dashboard stopped: written now, and it counts. A move keeps its from and to: it
  // counts for "never back within the hour", and Undo is offered (Undo itself checks that the session is on `to`).
  function settle(data) {
    const n = Object.keys(data.pending).length;
    for (const [key, p] of Object.entries(data.pending)) {
      const move = isObj(p.move) && typeof p.move.session === 'string' && typeof p.move.to === 'string' ? p.move : null;
      line.add({ at: iso(now()), by: p.rule, item: p.item, kind: p.kind, subject: p.subject, act: p.act, ok: false, cutOff: true, result: 'not known whether it was done: the dashboard stopped in the middle of it', ...(move ? { undo: p.id } : {}) });
      data.acts.push({ id: p.id, rule: p.rule, item: p.item, subject: p.subject, act: p.act, at: p.at, ok: null, result: 'not known whether it was done', ...(move ? { move } : {}) });
      if (move) data.moves.push({ ...move, at: p.at });
      delete data.pending[key];
    }
    return n;
  }

  function open() {
    const { data, broken } = rec.read();
    if (broken) line.add({ at: iso(now()), by: 'record', subject: 'what Tia did', act: 'none', ok: false, result: `could not be read: it was set aside, and she does nothing by herself until ${clock(data.frozenUntil, now())}` });
    settled = settle(data);
    return data;
  }
  let settled = 0; // acts the last open() settled: then the record is written, else they are settled again next time

  let changed = false; // the last act was refused because the item changed or went away (looked at again later)
  async function one(data, rule, it, board) {
    changed = false;
    const id = randomBytes(4).toString('hex');
    const key = `${rule.id}|${it.id}`;
    const moves = rule.act === 'switch';
    const from = moves ? (board.sessions || []).find((x) => x.name === it.target.session)?.provider ?? null : null;
    try {
      const r = await perform({ item: it.id, act: rule.act, seen: it.rev }, {
        guard: async (cur, l) => {
          await check(rule, cur, l.board, data, id);
          data.pending[key] = { id, rule: rule.id, item: cur.id, kind: cur.kind, subject: cur.subject, act: rule.act, at: now(), ...(moves ? { move: { session: cur.target.session, from, to: cur.target.to } } : {}) };
          rec.write(data);
        },
        extra: (ok) => ({ by: rule.id, ...(rule.why ? { decided: short(rule.why) } : {}), ...(ok && rule.undo ? { undo: id } : rule.noUndo ? { noUndo: rule.noUndo, ...(rule.noUndoWays ? { ways: rule.noUndoWays } : {}) } : {}) }),
      });
      if (r.again) return 0; // the owner tapped the same a moment ago: done once
      const at = now();
      data.acts.push({ id, rule: rule.id, item: it.id, subject: it.subject, act: rule.act, at, ok: true, result: short(r.said), ...(moves ? { move: { session: it.target.session, from, to: it.target.to } } : {}) });
      if (moves) data.moves.push({ session: it.target.session, from, to: it.target.to, at });
      return 1;
    } catch (e) {
      if (e.refusal) {
        if (e.refusal.say) tell(data, rule, it, e.refusal);
      } else if (isObj(e.details) && 'current' in e.details) {
        changed = true;
      } else {
        // The act was tried and failed: it counts. (An item that changed or went away is looked at again next round.)
        data.acts.push({ id, rule: rule.id, item: it.id, subject: it.subject, act: rule.act, at: now(), ok: false, result: short(e.message) });
      }
      return 0;
    } finally {
      delete data.pending[key];
      rec.write(data);
    }
  }

  /** One round: every item a rule that is on may act on. Nothing at all while the master switch or every rule is off. */
  function round() {
    const s = settings();
    if (!s.active || !RULE_IDS.some((id) => s.rules[id])) return Promise.resolve({ acted: 0 });
    if (running) return running;
    running = (async () => {
      if (!rec.lock()) return { acted: 0, locked: true };
      let acted = 0;
      try {
        const data = open();
        // A round with nothing to do writes nothing (the record exists only once a rule did or refused something).
        const was = rec.exists() ? null : JSON.stringify(data); // null: a record exists, it is written as always
        if (data.frozenUntil != null && now() < data.frozenUntil) {
          rec.write(data);
          return { acted: 0, frozen: true };
        }
        const l = await fresh();
        const todo = l.items.map((it) => [it, ruleFor(it, { now: now() })]).filter(([, r]) => r && s.rules[r.id]);
        for (const [it, rule] of todo) {
          if (!settings().active) break; // "Tia OFF" was pressed: no new act starts
          rec.touch();
          acted += await one(data, rule, it, l.board);
        }
        if (was === null || JSON.stringify(data) !== was) rec.write(data);
      } finally {
        rec.unlock();
      }
      return { acted };
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /** "Tia OFF": the master switch off; the act in flight ends (and its line is written) before this answers. */
  async function off() {
    const cur = isObj(ctx.config().operator) ? ctx.config().operator : {};
    ctx.saveConfig({ operator: { ...cur, acts: false } });
    const flight = running || deciding;
    if (running) await running.catch(() => {});
    if (deciding) await deciding.catch(() => {});
    return { inFlight: !!flight };
  }

  /** He tapped an item himself: a rule that tried twice on it may try again later. */
  function forget(itemId) {
    const d = rec.peek();
    if (!d || !(Object.keys(d.stops).some((k) => k.endsWith(`|${itemId}`)) || d.his[itemId]) || !rec.lock()) return;
    try {
      const data = rec.read().data;
      for (const k of Object.keys(data.stops)) if (k.endsWith(`|${itemId}`)) delete data.stops[k];
      delete data.his[itemId];
      rec.write(data);
    } finally {
      rec.unlock();
    }
  }

  const fail = (status, message) => Object.assign(new ctx.HttpError(status, message));

  /**
   * He undid what a rule did on an item (the Start-elsewhere hold's Undo): the rule leaves that item for the day, as
   * after two tries, or until he taps it. Waits for a round in flight once; false when the record stayed locked.
   */
  async function undoneByHim(ruleId, itemId, words) {
    // Only while that rule is on: with it off nothing would set it again, and the card must not speak of a rule.
    if (settings().rules[ruleId] !== true) return false;
    for (let i = 0; i < 2; i++) {
      if (rec.lock()) {
        try {
          const data = open();
          data.stops[`${ruleId}|${itemId}`] = now();
          data.his[itemId] = { rev: null, words: cardWords(words), at: now(), undone: true };
          rec.write(data);
        } finally {
          rec.unlock();
        }
        return true;
      }
      if (running) await running.catch(() => {});
    }
    return false;
  }

  /** Undo of a session moved by the limit rule: back to the provider it came from, when the state still allows it. */
  async function undo(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) throw fail(400, 'send { id }: the id of an act of Tia\'s');
    if (!rec.lock()) throw fail(409, 'Tia is in the middle of an act: try again in a moment');
    let data = null;
    try {
      data = open();
      const a = data.acts.find((x) => x.id === id);
      // A move cut off by a stop of the dashboard (ok null) may have been done: Undo checks below where the session is.
      if (!a || !a.move || a.ok === false) throw fail(404, 'there is no move of Tia\'s by that id to undo (it may be older than a day)');
      if (a.undone) throw fail(409, 'it was moved back already');
      const { session, from, to } = a.move;
      const l = await fresh();
      const s = (l.board.sessions || []).find((x) => x.name === session);
      if (!s || s.state === 'ended') throw fail(409, `session ${session} ended: there is nothing to move back`);
      if (s.provider !== to) throw fail(409, `session ${session} is no longer on ${to}: it was moved since, so Undo would not put it back`);
      const p = ((await accounts())?.profiles || []).find((x) => x.name === from);
      if (!p) throw fail(409, `${from} is no longer a provider on this computer`);
      // In words that need no time zone: how long it still is, not a clock time in UTC.
      if (p.limited && !(Number.isFinite(p.limited.until) && p.limited.until <= now())) throw fail(409, `the old provider ${from} is still at its limit${Number.isFinite(p.limited.until) ? ` for about ${span(p.limited.until - now())} more` : ''}: Undo can move the session back after that`);
      try {
        await move(session, from);
      } catch (e) {
        line.add({ at: iso(now()), item: a.item, kind: 'limit', subject: a.subject, act: 'undo', ok: false, result: short(e.message) });
        throw e;
      }
      a.undone = now();
      data.moves.push({ session, from: to, to: from, at: now() });
      line.add({ at: iso(now()), item: a.item, kind: 'limit', subject: a.subject, act: 'undo', ok: true, result: `Undo: moved back to ${from}` });
      return { ok: true, said: `${a.subject}: moved back to ${from}`, rule: a.rule };
    } finally {
      if (data) rec.write(data);
      rec.unlock();
    }
  }

  /** What the page and Tia read: the master switch, each rule with its budget left, what is his after two tries. */
  function view() {
    const s = settings();
    const d = rec.peek();
    const t = now();
    const acts = d?.acts || [];
    const rules = RULES.map((r) => {
      const mine = acts.filter((a) => a.rule === r.id);
      const b = s.budgets[r.id];
      return { id: r.id, sentence: r.sentence, detail: r.detail, act: r.act, on: s.rules[r.id], undo: r.undo, noUndo: r.noUndo, ...(r.ways ? { ways: r.ways } : {}), budget: b, left: { hour: Math.max(0, b.perHour - mine.filter((a) => t - a.at < HOUR).length), day: Math.max(0, b.perDay - mine.length) } };
    });
    const frozen = d?.frozenUntil != null && t < d.frozenUntil;
    const anyOn = RULE_IDS.some((id) => s.rules[id]);
    const said = !s.acts ? '"Tia acts by herself" is off: she follows none of the Operator\'s rules on her own and decides nothing by herself. Work you ask of her is not affected.'
      : !s.tia ? 'Tia is turned off in Settings → Tia, so she does nothing by herself.'
        : frozen ? `The record of what Tia did could not be read, so she does nothing by herself until ${clock(d.frozenUntil, t)}.`
          : !anyOn ? 'Tia may act, but every rule is off, so she does nothing by herself.'
            : 'Tia does by herself only what the rules that are on say, within their limits.';
    // What the card of an item says when a rule left it to him: why (the rev says which picture of it).
    const his = {};
    for (const [item, h] of Object.entries(d?.his || {})) his[item] = { rev: h.rev, words: h.words, ...(h.cap === true ? { cap: true } : {}), ...(Array.isArray(h.ways) ? { ways: h.ways } : {}) };
    for (const k of Object.keys(d?.stops || {})) {
      const [rule, item] = k.split('|');
      if (d.his?.[item]?.undone) continue; // his own Undo: its words are kept above
      his[item] = { rev: null, words: rule === DECIDE ? 'Tia tried twice by her decisions and it came back: it is yours now.' : `Tia tried twice (the ${rule} rule) and it came back: it is yours now.` };
    }
    const undoable = acts.filter((a) => a.move && a.ok !== false && !a.undone).map((a) => a.id);
    // A move he moved back: when, so Tia's line says so.
    const undone = Object.fromEntries(acts.filter((a) => a.move && a.undone).map((a) => [a.id, iso(a.undone)]));
    // The places `said` names (Tia off: Settings → Tia), as codes of the page's table of places.
    const ways = s.acts && !s.tia ? ['tia-off'] : null;
    return { acts: s.acts, tia: s.tia, active: s.active && !frozen, said, ...(ways ? { ways } : {}), rules, projectsOut: s.projectsOut, his, undoable, undone };
  }

  /** At the start: an act that was cut off by a stop of the dashboard is written now (only when there is a record). */
  function start() {
    if (!rec.exists() || !rec.lock()) return;
    try {
      const d = rec.peek();
      if (d && Object.keys(d.pending).length) rec.write(open());
    } finally {
      rec.unlock();
    }
  }

  // ---- a decision of Tia's (decider.mjs) through this door ----
  // Each holds the record's lock as a round does, so a rule's act and a decision's never run at the same time.
  // `waitMs`: how long to try again for a lock held by this dashboard's own round or by another dashboard.
  function withRecord(fn, { waitMs = 0 } = {}) {
    const go = async () => {
      const until = Date.now() + waitMs;
      for (;;) {
        if (running) await running.catch(() => {});
        if (rec.lock()) break;
        if (Date.now() >= until) return { locked: true };
        await new Promise((r) => setTimeout(r, LOCK_TRY_MS));
      }
      try {
        const data = open();
        if (data.frozenUntil != null && now() < data.frozenUntil) {
          rec.write(data);
          return { frozen: true };
        }
        // Written only when something changed (a record exists only once something was done or refused). An act open()
        // settled is a change: `data` holds it already, so comparing with it alone would leave it pending on disk.
        const was = rec.exists() && !settled ? JSON.stringify(data) : null;
        const out = await fn(data);
        if (was === null || JSON.stringify(data) !== was) rec.write(data);
        return out;
      } finally {
        rec.unlock();
      }
    };
    const p = (deciding || Promise.resolve()).catch(() => {}).then(go);
    const mine = p.finally(() => {
      if (deciding === mine) deciding = null;
    });
    deciding = mine;
    return mine;
  }

  /**
   * Before a call: the door's checks on the item with no step yet (the switches, the project taken out, "tried twice",
   * the wait between tries, the budget of acts). → null when a decision may be asked for, else the refusal (its line is
   * written once, as a rule's).
   */
  const ahead = (it, board) => withRecord(async (data) => {
    try {
      await check(decisionRule(null), it, board, data);
      return { ok: true };
    } catch (e) {
      if (!e.refusal) throw e;
      if (e.refusal.say) tell(data, decisionRule('ask_owner'), it, e.refusal);
      return { refusal: e.refusal };
    }
  }).then((r) => (r.ok ? null : r.refusal || { code: r.locked ? 'locked' : 'frozen', words: r.locked ? 'another act is on its way' : 'her record could not be read' }));

  /** The item is his: one line by "decide" (once per item rev and cause), and his card says why. */
  const leave = (it, code, words, ways = null) => withRecord(async (data) => {
    tell(data, decisionRule('ask_owner'), it, { code, words, ways });
    return {};
  });

  /** His card's line `words` on the item is no longer true (the tick it asked for is on): taken off. */
  const unsay = (it, words) => withRecord(async (data) => {
    if (data.his[it.id]?.words === cardWords(words)) delete data.his[it.id];
    return {};
  });

  /** The step a decision picked, done by the very path of a rule's act, with "decided: <why>" on its line. */
  const decided = (it, act, why) => withRecord(async (data) => {
    const l = await fresh();
    const acted = await one(data, decisionRule(act, why), it, l.board);
    return { acted, changed };
  });

  /**
   * A rule's answer to a mission's choice (decider.mjs mission): the mission's engine does the step, and it counts
   * against the rule's own budget, under the record's lock, as the rule's own acts do; it has no Undo (the mission goes
   * on from there). → { ok: true } when it may be done (then it is counted), { busy: true } when the record stayed
   * locked (the mission's engine then does what it did before the door), else { no: his words why not }.
   */
  // The rule's budget spent in `data` (the record's acts): its words, or null while it has room.
  const spent = (data, ruleId) => {
    const b = settings().budgets[ruleId] || BUDGET_DEFAULTS;
    const t = now();
    const mine = (data.acts || []).filter((a) => a.rule === ruleId);
    if (mine.filter((a) => t - a.at < HOUR).length >= b.perHour) return `the ${ruleId} rule did ${b.perHour} acts in the last hour, its most: this one is yours`;
    if (mine.length >= b.perDay) return `the ${ruleId} rule did ${b.perDay} acts today, its most: this one is yours`;
    return null;
  };
  // `pay()`: a move onto a provider billed by use is held against the daily limit for paid use here, last, in the same
  // synchronous step as the act is counted (→ null, or his line when that limit has no room).
  const ruleTook = (it, ruleId, act, said, pay = () => null) => withRecord(async (data) => {
    const refusal = spent(data, ruleId);
    if (refusal) return { refusal };
    const no = pay();
    if (no) return { refusal: no.replace(/\.$/, ': it is yours') };
    data.acts.push({ id: randomBytes(4).toString('hex'), rule: ruleId, item: it.id, subject: it.subject, act, at: now(), ok: true, result: short(said) });
    return { ok: true };
  }, { waitMs: RULE_LOCK_WAIT_MS }).then((r) => {
    if (r.ok) return { ok: true };
    if (r.refusal) return { no: r.refusal };
    if (!r.locked) return { no: 'her record of what she did could not be read: this one is yours' };
    // The record stayed locked: a budget already spent still makes it his (read without the lock, nothing written);
    // only while the budget has room does the mission's engine go on as it does without the door.
    const d = rec.peek();
    const no = d ? spent(d, ruleId) : null;
    return no ? { no } : { busy: true };
  });

  /** The project of an item (a name), null for none, undefined when its folder cannot be told. */
  const projectOf2 = (it, board) => {
    const p = projectOfItem(it, board);
    return p === UNKNOWN ? undefined : p;
  };

  return { round, off, undo, undoneByHim, view, forget, start, running: () => running, ahead, leave, unsay, decided, ruleTook, projectOfItem: projectOf2 };
}
