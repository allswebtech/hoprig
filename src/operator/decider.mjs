// "Tia decides": for an item of a kind in the table (decide-table.mjs) that is new or changed, ONE short call to the
// cheapest model she may use, which picks one of the item's prepared steps or ask_owner. The step is then done through
// the reflexes' own door (reflex.mjs decided: the switches, the project taken out, the budget of acts, the item built
// again and still the same rev, the same act twice done once), and written to the same line with "decided: <why>".
//
// Off unless the owner turned it on (operator.decide.on) under the master switch, with Tia on: then nothing is read,
// written or called. On: an item is decided once per rev, only after its rev held for SETTLE_MS (changes within that
// time are one), never on a timer alone: a look with nothing new makes no call. Past a budget of calls or tokens no
// call is made and the item is his, with one line that names the budget.

import { autoLeftOut, chooseAccount, resolveTia } from '../assistant/tia.mjs';
import { claudeTurn } from '../skillhub/learnlook.mjs';
import { CHEAPEST } from '../skillhub/learnset.mjs';
import { readOperator, ruleFor, ruleOn } from './rules.mjs';
import { ASK, MISSION_KINDS, TABLE_KINDS, offeredSteps } from './decide-table.mjs';
import { engineOwns } from '../mission/seam.mjs';
import { SYSTEM, itemPrompt, parseDecision } from './decide-prompt.mjs';
import { CALL_TOKENS, TICK_LINE, decideStore, heldBy, heldUntil, mayEndFor, noteFor, readDecide, used } from './decide-store.mjs';
import { clock } from './detect/util.mjs';
import { randomBytes } from 'node:crypto';
import { paidName } from '../assistant/spend.mjs';
import { ACCOUNT } from '../assistant/toolkit.mjs';
import { TYPING, hold, ledger, mayCall, paidStep, paidTyping, room, settle } from './money.mjs';

export const SETTLE_MS = 5000;
export const CALL_TIMEOUT_MS = 60_000;
export const OWED_MS = 10 * 60_000;
/** Answers not taken (ask_owner, a failed call, a refused answer) on one item in a day before it is his with no call. */
export const ASKED_MAX = 2;
/** A pick of one id needs no long thinking: at Claude Code's own effort the model reasoned on in its answer, and a
 * right pick was lost as "not two lines". */
export const DECIDE_EFFORT = 'low';

/**
 * The provider Tia may spend for a call of her own (a decision, a look): the code her own turns use. Never per-use
 * money while a provider she may use is not billed by use (the limit rule and her own switch_account ask him first
 * there); one billed by use only when no other is left, and then as her own turn there: only at "Hands off" AND while
 * her daily limit for paid use has room (read here, nothing written: the call holds its share right before it starts).
 * Auto mode is judged by its order (spend.mjs paidName): free of charge only when no provider of its order is billed by
 * use, since the router may serve the call with any of them.
 * → { provider, paid?, cap? } | { error }.
 */
export function pickProvider(cfg, acc, l = ledger()) {
  const all = resolveTia(cfg.assistant, acc);
  // Auto mode with nothing left in the order the router really uses cannot serve a call: it is not picked, the call
  // goes on to another provider she may use, and with none the reason is the router's own.
  const autoOut = all.allowed.includes('auto') ? autoLeftOut(acc) : null;
  const tia = autoOut ? { ...all, allowed: all.allowed.filter((n) => n !== 'auto') } : all;
  if (autoOut && !tia.allowed.length) return { error: autoOut };
  const paid = (n) => {
    if (n === 'auto') return paidName('auto', acc);
    const p = (acc.profiles || []).find((x) => x.name === n);
    return !p || p.kind === 'api' || p.paid === true;
  };
  const unpaid = tia.allowed.filter((n) => !paid(n));
  let usable = unpaid;
  if (!unpaid.length && tia.allowed.length) {
    const no = mayCall(true, tia, l);
    // capped: the daily limit for paid use is why (none, or used up), so the item can offer the button that opens it.
    if (no) return { error: `${paidWhy(tia.allowed, acc)}, and ${no}`, ...(tia.level === 'handsoff' ? { capped: true } : {}) };
    usable = tia.allowed;
  }
  const c = chooseAccount({ ...tia, allowed: usable }, acc, 'claude');
  if (c.error) return { error: c.error };
  return unpaid.length ? { provider: c.account } : { provider: c.account, paid: true, cap: tia.dailyCapUsd };
}

/** How long a decision waits for a session of his in a turn on its provider, from when it was first due: a session waits on it. */
export const DECISION_WAIT_MS = 2 * 60_000;

/**
 * A session of his in a turn (working) on the provider a call of Tia's would use, or null: her call would compete
 * with it for that provider. Auto mode is the same as each provider of its order (the router may serve either with
 * any of them). `sessions`: the board's (sources.mjs: name, provider, state). `not`: a session the call is about.
 */
export function busyOn(provider, sessions, acc, not = null) {
  const order = Array.isArray(acc?.autoSwitch?.order) ? acc.autoSwitch.order : [];
  const reach = (n) => (n === 'auto' ? ['auto', ...order] : [n]);
  const mine = new Set(reach(provider));
  return (Array.isArray(sessions) ? sessions : []).find((s) => s && s.state === 'working' && s.name !== not && reach(s.provider).some((n) => mine.has(n))) || null;
}

/** Why every provider Tia may use is billed by use, in true words: Auto mode by the paid providers of its order. */
function paidWhy(allowed, acc) {
  if (!allowed.includes('auto')) return 'every provider Tia may use is billed by use';
  const order = Array.isArray(acc.autoSwitch?.order) ? acc.autoSwitch.order : [];
  // Only a name of a provider name's form goes into the line (as tia.mjs tiaChoices): it is shown on the item.
  const names = [...new Set(order)].filter((n) => typeof n === 'string' && ACCOUNT.test(n) && paidName(n, acc));
  // Two names at most, one when two would not fit: with its longest ending (", and today's daily limit for paid use of $… is
  // used up: it is yours", 75 characters) the item's line stays inside its 220 (reflex.mjs WORDS_MAX), also with names of 32 characters.
  const say = (k) => {
    const more = names.length - k;
    const shown = `${names.slice(0, k).join(', ')}${more ? ` and ${more} more` : ''}`;
    const auto = `Auto mode's order holds a provider billed by use${names.length ? ` (${shown})` : ''}`;
    return allowed.length > 1 ? `${auto}; every other provider she may use is too` : auto;
  };
  const two = say(Math.min(2, names.length));
  return two.length <= REASON_MAX ? two : say(1);
}
/** The longest reason paidWhy gives: the rest of the item's sentence (the cap or the level, "it is yours") fits in 80. */
const REASON_MAX = 140;

/**
 * The item's one line when a decision has no provider to call: one sentence with nothing nested. When money is why
 * (every provider she may use is billed by use, or the call's hold did not fit), the reason is the sentence itself,
 * and with the cap as the cause its code is 'cap', so the card offers "Set a daily limit for paid use".
 */
export function noProvider(c) {
  if (c.no) return { code: 'cap', words: `${c.no.replace(/\.$/, '')}: it is yours` };
  if (/billed by use/.test(c.error)) {
    const words = c.capped ? c.error.replace(/ \(Settings → Tia\)$/, '') : c.error;
    return { code: c.capped ? 'cap' : 'model', words: `${words[0].toUpperCase()}${words.slice(1)}: it is yours` };
  }
  return { code: 'model', words: `Tia has no provider to decide with (${c.error}): it is yours` };
}

/** A paid call: its hold taken now (→ { id }), or why not (→ { no }). Called right before the call starts. */
function holdCall(c, what) {
  if (!c.paid) return {};
  const id = `${what}-${randomBytes(4).toString('hex')}`;
  const no = hold(`A decision of Tia's on ${c.provider}`, c.cap, id);
  return no ? { no } : { id };
}

export function decider({ ctx, rx, dir, now = Date.now, accounts, asks, turn = claudeTurn, line = null }) {
  const store = decideStore({ dir, now });
  const firstSeen = new Map(); // item id → { rev, at }: a rev must hold SETTLE_MS before it is decided
  // item id → { rev, pick, why, at }: a step paid for whose act met the reflex record locked (an Undo, a forget, another
  // dashboard): done on a later look while the item is the same, with no new call; after OWED_MS it is his.
  const owed = new Map();
  let running = null;
  const told = new Set(); // a mission's choice left to him: its line once
  const waits = new Map(); // item id → { key, at }: first due while a session of his worked on the call's provider

  const on = () => {
    const cfg = ctx.config();
    return readOperator(cfg).active && readDecide(cfg).on;
  };

  /** The provider and model of a decision: the code Tia's own turns use; null with why when there is none. */
  async function choice() {
    const c = pickProvider(ctx.config(), (await accounts()) || { profiles: [] });
    return c.error ? c : { provider: c.provider, model: readDecide(ctx.config()).model || CHEAPEST, paid: !!c.paid, cap: c.cap ?? null };
  }

  // The items to decide now: a kind of the table, with a prepared step, no rule on for it, a rev not decided yet that
  // held SETTLE_MS.
  function due(items, data, s) {
    const t = now();
    const out = [];
    const ids = new Set();
    for (const it of items) {
      // An item of a mission's session whose kind the mission's engine owns (seam.mjs OWNER_OF): never decided here.
      if (!TABLE_KINDS.includes(it.kind) || !(it.steps || []).length || engineOwns(it)) continue;
      ids.add(it.id);
      if (data.seen[it.id] === it.rev) continue;
      // Seen with a paid move left out for money (`<rev>|<gate>`): looked at again on each tick, since the level or the
      // cap may change while the item stays the same; one() goes on only when the gate changed (decided once per gate).
      const r = ruleFor(it, { now: t });
      if (r && ruleOn(s, r.id)) continue; // a rule that is on acts first
      const f = firstSeen.get(it.id);
      if (!f || f.rev !== it.rev || f.at > t) {
        firstSeen.set(it.id, { rev: it.rev, at: t });
        continue;
      }
      if (t - f.at >= SETTLE_MS) out.push(it);
    }
    for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
    for (const id of waits.keys()) if (!ids.has(id)) waits.delete(id);
    return out;
  }

  /** Marks a paid call whose pick the door did not do; it counts as an answer not taken. */
  function notDone(call) {
    if (!store.lock()) return; // another dashboard holds the record: this one call goes uncounted
    try {
      const { data } = store.read();
      const c = data.calls.find((x) => x.at === call.at && x.item === call.item && x.rev === call.rev);
      if (c) {
        c.notDone = true;
        store.write(data);
      }
    } finally {
      store.unlock();
    }
  }

  async function one(it, board, d) {
    const block = await rx.ahead(it, board);
    if (block) return { item: it.id, his: block.code };
    // Budgets, read and taken under the record's lock: two dashboards on one state folder never both spend one.
    if (!store.lock()) return { item: it.id, locked: true };
    let call = null;
    try {
      const { data } = store.read();
      const t = now();
      // A record that could not be read was set aside: what today cost is not known, so no call until the freeze ends.
      if (data.frozenUntil != null && t < data.frozenUntil) {
        data.seen[it.id] = it.rev;
        store.write(data);
        await rx.leave(it, 'frozen', `Tia's record of decisions could not be read, so she makes none until ${clock(data.frozenUntil, t)}: it is yours`);
        return { item: it.id, his: 'frozen' };
      }
      const project = rx.projectOfItem(it, board);
      const note = project ? noteFor(ctx.config(), project) : '';
      let steps = offeredSteps(it, project ? mayEndFor(ctx.config(), project) : false);
      if (!steps.length) {
        // No step is the model's to pick: his, with no call. Left so only because stop needs his tick: seen with the
        // tick as part of the picture (as money below), so a tick he sets while the item stays the same brings it back.
        const tick = (it.steps || []).includes('stop');
        const key = tick ? `${it.rev}|tick:off` : it.rev;
        if (data.seen[it.id] === key) return { item: it.id, his: 'same' };
        data.seen[it.id] = key;
        store.write(data);
        // The card says so, so he knows what the tick would allow.
        if (tick) await rx.leave(it, 'tick', TICK_LINE);
        return { item: it.id, his: 'no-step' };
      }
      // Stop is offered, so the tick is on: a line that said it was needed is untrue now and leaves his card.
      if (steps.includes('stop')) await rx.unsay(it, TICK_LINE);
      // A step that spends by use is hers only at "Hands off" and inside the daily limit for paid use: a move onto a
      // provider billed by use, and typing into a session that runs on one (a nudge, an answer: its next turn is paid per
      // token). Below "Hands off", or when the limit has no room, such a step is not offered, and an item left with no step is his with
      // the line that names why, with no call (the door would refuse the step anyway: a call would buy nothing).
      const acc = (await accounts()) || { profiles: [] };
      const tia = resolveTia(ctx.config().assistant, acc);
      const ps = paidStep(it, acc, steps);
      const pt = paidTyping(it, board, acc);
      // A stuck session's nudge not given yet comes before its stop (the prompt says so, and so do his notes): when money
      // takes the nudge away, the stop goes with it, so a session is never ended where its nudge was still owed.
      const typed = it.kind === 'stuck' && steps.includes('nudge') ? [...TYPING, 'stop'] : TYPING;
      const gates = [
        ...(ps ? [{ steps: [ps.step], what: ps.what, low: `${ps.to} is paid per use, and Tia moves a session there only at "Hands off" (Settings → Tia): it is yours`, lowWays: ['tia-settings'] }] : []),
        ...(pt && steps.some((x) => TYPING.includes(x)) ? [{ steps: typed, what: pt.what, low: `${pt.what} costs money by use, and Tia types into such a session only at "Hands off" (Settings → Tia): it is yours`, lowWays: ['tia-settings'] }] : []),
      ];
      const low = tia.level !== 'handsoff';
      let money = null;
      for (const g of gates) {
        const why = low ? g.low : room(g.what, tia.dailyCapUsd);
        if (!why) continue;
        steps = steps.filter((x) => !g.steps.includes(x));
        money = money || { code: low ? 'paid' : 'cap', words: why, ...(low && g.lowWays ? { ways: g.lowWays } : {}) };
      }
      // The picture decided is the item AND what money allowed: he may set the cap the card asks for, or change the
      // level, while the item stays the same. Then it is decided again; with the same gate it is not.
      const key = !money ? it.rev : low ? `${it.rev}|level` : `${it.rev}|cap:${tia.dailyCapUsd ?? 'none'}`;
      if (data.seen[it.id] === key) return { item: it.id, his: 'same' };
      if (!steps.length) {
        data.seen[it.id] = key;
        store.write(data);
        await rx.leave(it, money.code, money.words, money.ways || null);
        return { item: it.id, his: money.code };
      }
      const u = used(data, t);
      const n = (x) => x.toLocaleString('en');
      const over = u.hour >= d.perHour ? `Tia made ${n(d.perHour)} decisions in the last hour, the limit of ${n(d.perHour)} an hour`
        : u.day >= d.perDay ? `Tia made ${n(d.perDay)} decisions today, the limit of ${n(d.perDay)} a day`
          : u.tokens >= d.tokensPerDay ? `Tia's decisions used ${n(u.tokens)} tokens today, the limit of ${n(d.tokensPerDay)} tokens a day` : null;
      data.seen[it.id] = key;
      // An item that comes and goes is a new event each time it comes back, and an answer that was not taken does not
      // count as a try at the door: two of them on one item today (ask_owner, or a pick the door did not do), and it is
      // his with no third call.
      const unanswered = data.calls.filter((x) => x.item === it.id && (x.pick === ASK || x.notDone === true)).length;
      if (!over && unanswered >= ASKED_MAX) {
        store.write(data);
        await rx.leave(it, 'asked-twice', `Tia left it to you ${unanswered} times today, so she asks no model about it again today: it is yours`);
        return { item: it.id, his: 'asked-twice' };
      }
      if (over) {
        store.write(data);
        await rx.leave(it, 'budget', `${over}, so you decide this one yourself (Operator → Tia decides → Change the limits)`, ['decide-limits']);
        return { item: it.id, his: 'budget' };
      }
      const c = await choice();
      if (c.error) {
        store.write(data);
        const w = noProvider(c);
        await rx.leave(it, w.code, w.words);
        return { item: it.id, his: w.code };
      }
      // A session of his in a turn on that provider: no call on this tick (nothing written, so a later tick decides
      // it), at most DECISION_WAIT_MS from when it was first due. The session the item is about waits on it: not counted.
      const busy = busyOn(c.provider, board?.sessions, acc, it.target?.session);
      const w = waits.get(it.id);
      if (busy) {
        if (!w || w.key !== key) waits.set(it.id, { key, at: t });
        if (t - waits.get(it.id).at < DECISION_WAIT_MS) return { item: it.id, waits: busy.provider };
      }
      waits.delete(it.id);
      const card = it.kind === 'asks' ? asks.card(it.target?.session) : null;
      const prompt = itemPrompt(it, { card, note, steps });
      store.touch();
      // A call on a provider billed by use: its hold is taken here, with no await before the call starts.
      const held = holdCall(c, 'decide');
      if (held.no) {
        store.write(data);
        await rx.leave(it, 'cap', noProvider(held).words);
        return { item: it.id, his: 'cap' };
      }
      const r = await turn({ provider: c.provider, model: c.model, system: SYSTEM, prompt, timeoutMs: CALL_TIMEOUT_MS, effort: DECIDE_EFFORT, fixedPrefix: true });
      // What the call reported it cost settles its hold; a call that failed keeps it for the day (it may have spent).
      if (held.id && r?.ok) settle(Number(r.usd) || 0, 'a decision of the Operator', held.id);
      // A provider that reports no usage: the call is counted at the largest size measured on a real model (Claude Code
      // adds its own parts, so the prompt's own length would count about a quarter of it).
      const tokens = Number.isFinite(r?.tokens) && r.tokens > 0 ? r.tokens : Math.max(CALL_TOKENS, Math.ceil((SYSTEM.length + prompt.length) / 3));
      const p = r?.ok ? parseDecision(r.text, steps) : { pick: ASK, why: '', fault: 'the call failed' };
      // The record keeps the pick and its cost; the reason goes only to the line (no free text of the model's is kept here).
      call = { at: now(), tokens, item: it.id, rev: it.rev, pick: p.pick, why: p.why, ...(p.fault ? { fault: p.fault } : {}) };
      const { why: _w, ...kept } = call;
      call.money = money; // only for the card below, never kept in the record
      data.calls.push(kept);
      store.write(data);
    } finally {
      store.unlock();
    }
    if (call.pick === ASK) {
      await rx.leave(it, 'asked', call.fault ? `It is yours: Tia could not decide (${call.fault})` : `It is yours: Tia did not pick a step (${call.why})`);
      // A paid move was left out for money: the card names it (with the cap's button), as the one thing he can allow;
      // the model's reason stays on the timeline line above.
      if (call.money) await rx.leave(it, call.money.code, call.money.words, call.money.ways || null);
      return { item: it.id, pick: ASK, tokens: call.tokens };
    }
    const done = await rx.decided(it, call.pick, call.why);
    if (done.locked || done.frozen) {
      owed.set(it.id, { rev: it.rev, pick: call.pick, why: call.why, at: now() });
      return { item: it.id, pick: call.pick, tokens: call.tokens, owed: true };
    }
    // The door refused the pick (or did nothing) while the item stayed the same: the call bought nothing, as ask_owner.
    if (!done.acted && !done.changed) notDone(call);
    return { item: it.id, pick: call.pick, tokens: call.tokens, acted: done.acted || 0, changed: !!done.changed };
  }

  /** One look: decides every item that is due. `list`: the attention list as built now (with its board). */
  function look(list) {
    if (!on()) return Promise.resolve({ decided: [] }); // off: nothing read, written or called
    if (running) return running;
    running = (async () => {
      const d = readDecide(ctx.config());
      const s = readOperator(ctx.config());
      let data = store.peek() || { seen: {} };
      // An item that went away is forgotten: when the same thing comes back (the same rev), it is a new event.
      const gone = list.present ? Object.keys(data.seen).filter((id) => !list.present.has(id)) : [];
      if (gone.length && store.lock()) {
        try {
          data = store.read().data;
          for (const id of gone) delete data.seen[id];
          store.write(data);
        } finally {
          store.unlock();
        }
      }
      const out = [];
      for (const [id, o] of [...owed]) {
        const it = list.items.find((i) => i.id === id);
        if (!it || it.rev !== o.rev) {
          owed.delete(id); // it changed or went away: the pick was for another picture of it
          continue;
        }
        if (now() - o.at > OWED_MS) {
          owed.delete(id);
          await rx.leave(it, 'locked', 'Tia picked a step, but another act held her record until it was too late to do it: it is yours');
          continue;
        }
        const done = await rx.decided(it, o.pick, o.why);
        if (!done.locked && !done.frozen) owed.delete(id);
        out.push({ item: id, pick: o.pick, owed: owed.has(id), acted: done.acted || 0 });
      }
      for (const it of due(list.items, data, s)) {
        if (!on()) break; // Tia OFF: no new decision starts
        out.push(await one(it, list.board, d));
      }
      return { decided: out };
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /**
   * A mission's choice (seam.mjs missionItem) through this same door: the same switches, the same budgets (and its own
   * count a day inside them), the same record and the same line under "Done by Tia". → null while "Tia decides" or its
   * switch for missions is off (the mission's engine does what it did before); { act, by, why } (the engine does the
   * step on its own task); { ask: true, why } (his: it waits for him).
   */
  async function mission(item0) {
    let item = item0;
    const cfg = ctx.config();
    const s = readOperator(cfg);
    const d = readDecide(cfg);
    if (!s.active || !d.on || !d.missions || !item || !MISSION_KINDS.includes(item.kind)) return null;
    const say = (extra) => line && line.add({ at: new Date(now()).toISOString(), item: item.id, kind: item.kind, subject: item.subject, ...extra });
    // `ways`: the places `why` names, as codes of the page's table of places (web/errorways.js), for its line.
    const his = (why, keep = [], ways = null) => {
      // Once per picture of the choice and reason: the engine may ask again on its next look.
      const key = `${item.id}|${item.rev}|${why}`;
      if (!told.has(key)) say({ by: 'decide', act: ASK, ok: false, refused: true, result: why, keep, ...(ways ? { ways } : {}) });
      told.add(key);
      if (told.size > 500) told.delete(told.values().next().value);
      return { ask: true, why };
    };
    if (item.project && s.projectsOut.includes(item.project)) return his(`it is in the project ${item.project}, where Tia never acts: it is yours`, [item.project]);
    // A rule of his that answers it acts first, with no model: the limit rule moves a task at a limit to the next
    // provider, within the rule's own budget (counted in the reflexes' record, as its other acts). Past it, his.
    // A next provider billed by use is money: below "Hands off" never hers, at "Hands off" only inside the daily limit
    // for paid use (held right before the engine is told to do it). It is left out of the steps when it may not be done.
    const acc = (await accounts()) || { profiles: [] };
    const tia = resolveTia(cfg.assistant, acc);
    const ps = paidStep(item, acc);
    const money = ps ? (tia.level !== 'handsoff' ? `${ps.to} is paid per use, and Tia moves a task there only at "Hands off" (Settings → Tia)` : room(ps.what, tia.dailyCapUsd)) : null;
    const moneyWays = ps && tia.level !== 'handsoff' ? ['tia-settings'] : null; // the place `money` names
    if (money) item = { ...item, steps: item.steps.filter((x) => x !== ps.step) };
    const pay = (act) => (ps && act === ps.step ? hold(ps.what, tia.dailyCapUsd, `mission-${randomBytes(4).toString('hex')}`) : null);
    if (item.kind === 'mission-limit' && s.rules.limit && money && !item.steps.length) return his(`${money.replace(/\.$/, '')}: it is yours`, [], moneyWays);
    if (item.kind === 'mission-limit' && s.rules.limit && item.steps.includes('next-provider')) {
      const result = `it goes on with ${item.to}, the next provider of your order`;
      const took = await rx.ruleTook(item, 'limit', 'next-provider', result, () => pay('next-provider'));
      // Her record stayed locked: nothing was counted, and the engine goes on as it does without the door. A next
      // provider billed by use is held all the same before that (or the task is his when the cap has no room).
      if (took.busy) {
        const no = pay('next-provider');
        return no ? his(`${no.replace(/\.$/, '')}: it is yours`) : null;
      }
      const no = took.no;
      if (no) {
        const key = `${item.id}|${item.rev}|${no}`;
        if (!told.has(key)) say({ by: 'limit', act: 'next-provider', ok: false, refused: true, result: no });
        told.add(key);
        return { ask: true, why: no };
      }
      say({ by: 'limit', act: 'next-provider', ok: true, result, noUndo: 'The mission goes on from here; stop it on its card.' });
      return { act: 'next-provider', by: 'the limit rule', why: '' };
    }
    if (!item.steps.length) return his(money ? `${money.replace(/\.$/, '')}: it is yours` : item.kind === 'mission-sent-back' ? 'a task sent back twice is yours: Tia has no step for it' : 'no step of hers fits it now: it is yours', [], money ? moneyWays : null);
    if (!store.lock()) return his('another decision held her record just then: it is yours');
    let call = null;
    try {
      const { data } = store.read();
      const t = now();
      if (data.frozenUntil != null && t < data.frozenUntil) {
        store.write(data);
        return his(`Tia's record of decisions could not be read, so she makes none until ${clock(data.frozenUntil, t)}: it is yours`);
      }
      // The same picture of the choice is decided once: asked again (a wait the engine looks at on every tick, a run
      // settled again after a restart), the pick it got stands, with no second call. It passes the same gates as a
      // fresh pick, read now: a step the level or the cap leaves out is his, and a paid move is held again before the
      // engine is told to do it (the level or the cap may have changed since, and a stored pick holds no money).
      const had = data.answers[item.id];
      if (had && had.rev === item.rev) {
        if (had.pick === ASK) return { ask: true, why: 'Tia left it to you' };
        if (!item.steps.includes(had.pick)) return his(money ? `${money.replace(/\.$/, '')}: it is yours` : 'no step of hers fits it now: it is yours', [], money ? moneyWays : null);
        const no = pay(had.pick);
        if (no) return his(`${no.replace(/\.$/, '')}: it is yours`);
        if (ps && had.pick === ps.step) say({ by: 'decide', act: had.pick, ok: true, result: `it goes on with ${item.to}, the next provider of your order`, noUndo: 'The mission goes on from here; stop it on its card.' });
        return { act: had.pick, by: 'Tia decides', why: '' };
      }
      const u = used(data, t);
      const n = (x) => x.toLocaleString('en');
      const over = u.hour >= d.perHour ? `Tia made ${n(d.perHour)} decisions in the last hour, the limit of ${n(d.perHour)} an hour`
        : u.day >= d.perDay ? `Tia made ${n(d.perDay)} decisions today, the limit of ${n(d.perDay)} a day`
          : u.missions >= d.missionsPerDay ? `Tia made ${n(d.missionsPerDay)} decisions about missions today, the limit of ${n(d.missionsPerDay)} a day`
            : u.tokens >= d.tokensPerDay ? `Tia's decisions used ${n(u.tokens)} tokens today, the limit of ${n(d.tokensPerDay)} tokens a day` : null;
      if (over) {
        store.write(data);
        return his(`${over}, so you decide this one yourself (Operator → Tia decides → Change the limits)`, [], ['decide-limits']);
      }
      const c = await choice();
      if (c.error) {
        store.write(data);
        return his(noProvider(c).words);
      }
      const note = item.project ? noteFor(cfg, item.project) : '';
      const steps = offeredSteps(item, item.project ? mayEndFor(cfg, item.project) : false);
      const prompt = itemPrompt(item, { note, steps });
      store.touch();
      const held = holdCall(c, 'decide');
      if (held.no) {
        store.write(data);
        return his(noProvider(held).words);
      }
      const r = await turn({ provider: c.provider, model: c.model, system: SYSTEM, prompt, timeoutMs: CALL_TIMEOUT_MS, effort: DECIDE_EFFORT, fixedPrefix: true });
      if (held.id && r?.ok) settle(Number(r.usd) || 0, 'a decision of the Operator', held.id);
      const tokens = Number.isFinite(r?.tokens) && r.tokens > 0 ? r.tokens : Math.max(CALL_TOKENS, Math.ceil((SYSTEM.length + prompt.length) / 3));
      const p = r?.ok ? parseDecision(r.text, steps) : { pick: ASK, why: '', fault: 'the call failed' };
      call = { at: now(), tokens, item: item.id, rev: item.rev, pick: p.pick, why: p.why, fault: p.fault || null };
      data.calls.push({ at: call.at, tokens, item: item.id, rev: item.rev, pick: p.pick, mission: true, ...(p.fault ? { fault: p.fault } : {}) });
      data.answers[item.id] = { rev: item.rev, pick: p.pick, at: call.at };
      store.write(data);
    } finally {
      store.unlock();
    }
    if (call.pick === ASK) return his(call.fault ? `It is yours: Tia could not decide (${call.fault})` : `It is yours: Tia did not pick a step (${call.why})`);
    // The picked step moves the task onto a provider billed by use: held now, right before the engine is told to do it.
    const no = pay(call.pick);
    if (no) return his(`${no.replace(/\.$/, '')}: it is yours`);
    say({ by: 'decide', act: call.pick, ok: true, result: call.pick === 'wait' ? 'the task waits until it can start again' : `it goes on with ${item.to}, the next provider of your order`, decided: call.why, noUndo: 'The mission goes on from here; stop it on its card.' });
    return { act: call.pick, by: 'Tia decides', why: call.why };
  }

  /** What the panel shows: the switch, the budgets and what today used. */
  function view() {
    const d = readDecide(ctx.config());
    const data = store.peek();
    const u = used(data, now());
    const held = heldUntil(now());
    const frozen = data?.frozenUntil != null && now() < data.frozenUntil ? new Date(data.frozenUntil).toISOString() : null;
    return { frozen, on: d.on, missions: d.missions, missionsPerDay: d.missionsPerDay, model: d.model, modelRefused: d.modelRefused, perHour: d.perHour, perDay: d.perDay, tokensPerDay: d.tokensPerDay, today: { calls: u.day, hour: u.hour, tokens: u.tokens, missions: u.missions }, held: held ? new Date(held).toISOString() : null, heldBy: held ? heldBy(now()) : null };
  }

  return { look, mission, view, enabled: on, running: () => running, store };
}
