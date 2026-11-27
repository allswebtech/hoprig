// hoprig_act: one tool for every act that has no tool of its own. An act is named as the inventory names it
// (src/assistant/inventory.json, rows "act <name>"), and its level is not written here: it is what levelFor
// (acts.mjs) gives for the six facts of its row, run again on the facts of each call, which the server looks up itself
// and never takes from the model (a paid provider sets spends, another computer sets other, a place in the credentials
// folder sets never; a message the owner spoke turns an L1 act that cannot be put back by one press into L2).
//
// The description of the tool never lists the acts: `act: "list"` with a word returns the matching ones, so the tool
// array stays byte-identical (and cached) when an act is added. A new act is a row in the inventory and one entry in
// ACTS below; inventory.test fails when either is missing.
//
// What mends (restart a gateway, reopen a session, hold new starts, clean Hoprig's own temporary files, probe a provider)
// are the functions of src/operator/mends.mjs, the same ones the rules use; here they run on her word.
import { isSecretFolder } from '../server/folders.mjs';
import { stoppedAt } from '../addons/stopmark.mjs';
import { levelFor, loadInventory, raiseFacts } from './acts.mjs';
import { anyJson, obj, str } from './schema.mjs';
import { LOCAL } from './shown.mjs';
import { ASSISTANT_NAME } from './tia.mjs';
import { comp, computer, findSession, session, toolError } from './toolkit.mjs';
import { SETTINGS, auto_mode_act, change_setting_act } from './owner-tools.mjs';

// The inventory is read when an act is first judged, never when this file loads: the server starts without reading it.
let ROWS = null;
const factsOf = (name) => {
  if (!ROWS) ROWS = new Map(loadInventory().rows.filter((r) => r.kind === 'act').map((r) => [r.act.replace(/^act /, ''), r]));
  return ROWS.get(name).facts;
};
const WEEK = 7 * 24 * 3600_000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The functions of the mends: injected by a test as ops.mends, else src/operator/mends.mjs. */
async function mendsOf(ops) {
  if (ops.mends) return ops.mends;
  try {
    return await import('../operator/mends.mjs');
  } catch {
    throw toolError('this Hoprig has no mends yet', 'tell the owner; the Health page shows the state');
  }
}
async function mend(ops, name, arg) {
  const m = await mendsOf(ops);
  if (typeof m[name] !== 'function') throw toolError(`this Hoprig cannot do ${name} yet`, 'tell the owner');
  const r = await m[name](arg);
  if (r && r.ok === false) throw toolError(`it did not work: ${String(r.said || r.error || 'no reason given').slice(0, 160)}`, 'tell the owner what it said; do not try again at once');
  return r || {};
}
const thisOnly = (a) => {
  if (comp(a) !== LOCAL) throw toolError('this act works on this computer only for now', 'leave computer out');
};
const needs = (a, ...keys) => {
  for (const k of keys) if (a[k] === undefined) throw toolError(`act ${a.act} needs ${k}`, `add ${k}, or call hoprig_act with act "list" and a word to see what an act needs`);
};
const ID = (a, what = 'item') => {
  if (typeof a.item !== 'string' || !NAME.test(a.item)) throw toolError(`item is the ${what}'s name: letters, digits, - and _`, 'copy the name from a read tool');
};
const sessionsOn = async (ops, a, name) => {
  try {
    return (await ops.listSessions({ computer: comp(a) })).filter((c) => c.profile && c.profile.name === name).length;
  } catch {
    return 0;
  }
};
const sessionsWord = (n) => (n === 1 ? '1 session' : `${n} sessions`);

/** What an act records so that Undo in Activity can put it back (acts that cannot say how, say what to do instead). */
const undoOf = (act, item, value) => ({ act, item, ...(value !== undefined ? { value } : {}) });

// ---- the acts. level: levelFor of the row's facts. what: one line for `list`. needs: the arguments. ----
export const ACTS = {
  list: {
    what: 'list the acts that match a word, with their levels and what each needs',
    needs: ['word (optional)'],
    check() {},
    async run(ops, a, ctx) {
      const w = String(a.word || '').toLowerCase();
      if (w === 'undo' || w === 'recent') return recentActs(ctx);
      const out = Object.entries(ACTS).filter(([name, x]) => !w || name.includes(w) || x.what.toLowerCase().includes(w)).map(([name, x]) => ({ act: name, level: x.level, what: x.what, needs: x.needs }));
      return { summary: `${out.length} act(s)${w ? ` for "${w.slice(0, 30)}"` : ''}. Levels: L0 free, L1 she may do alone only when the owner allows it (else a card), L2 a card.`, data: { acts: out } };
    },
  },
  'probe-provider': {
    what: 'look at whether a provider\'s address or a gateway answers (sends no key, uses no tokens)',
    needs: ['item: the provider or gateway name'],
    check: (a) => ID(a, 'provider'),
    async run(ops, a) {
      const r = await mend(ops, 'probeProvider', { name: a.item });
      return { summary: `${a.item}: ${r.said ? String(r.said).slice(0, 160) : r.up === false ? 'does not answer' : 'answers'}.`, data: { provider: a.item, up: r.up !== false } };
    },
  },
  'restart-gateway': {
    what: 'restart or start a gateway the owner set up and did not stop himself',
    needs: ['item: the gateway name'],
    check(a) {
      ID(a, 'gateway');
      thisOnly(a);
    },
    async before(ops, a) {
      if (stoppedAt(a.item)) throw toolError(`${a.item} was stopped by the owner himself: starting it again is his`, 'tell him; open_screen "health"');
      return { gateway: a.item, sessions: await sessionsOn(ops, a, a.item) };
    },
    cardLines: (a, b) => [`Restart the gateway ${a.item}?`, `${sessionsWord(b.sessions)} on it wait a few seconds.`],
    async run(ops, a) {
      if (stoppedAt(a.item)) throw toolError(`${a.item} was stopped by the owner himself: starting it again is his`, 'tell him; open_screen "health"');
      await mend(ops, 'restartGateway', { id: a.item });
      return { summary: `The gateway ${a.item} was restarted.`, data: { gateway: a.item }, audit: { gateway: a.item, undo: undoOf('stop-gateway', a.item) } };
    },
  },
  'stop-gateway': {
    what: 'stop a gateway: the sessions on it stop answering until it starts again',
    needs: ['item: the gateway name'],
    check(a) {
      ID(a, 'gateway');
      thisOnly(a);
    },
    async before(ops, a) {
      return { gateway: a.item, sessions: await sessionsOn(ops, a, a.item) };
    },
    cardLines: (a, b) => [`Stop the gateway ${a.item}?`, `${sessionsWord(b.sessions)} on it stop answering until it starts again.`],
    async run(ops, a) {
      await mend(ops, 'stopGateway', { id: a.item });
      return { summary: `The gateway ${a.item} was stopped.`, data: { gateway: a.item }, audit: { gateway: a.item, undo: undoOf('restart-gateway', a.item) } };
    },
  },
  'restart-hoprig': {
    what: 'restart Hoprig on a computer: pages reconnect in a few seconds, sessions keep running',
    needs: [],
    check() {},
    cardLines: (a) => [`Restart Hoprig on ${comp(a) === LOCAL ? 'this computer' : comp(a)}?`, `Pages reconnect in about 5 seconds; sessions keep running.${comp(a) === LOCAL ? ` ${ASSISTANT_NAME} answers again once it is back.` : ''}`],
    async run(ops, a) {
      const r = await ops.restartDashboard({ computer: comp(a) });
      if (!r || r.restarting !== true) throw toolError('Hoprig there cannot restart itself: it does not run as a background service', 'tell the owner he stops it and starts it again by hand');
      return { summary: `Hoprig on ${comp(a)} is restarting.`, data: { computer: comp(a), restarting: true }, audit: { computer: comp(a) } };
    },
  },
  'reopen-session': {
    what: 'reopen a session whose coding tool died, where it stopped (nothing is sent to it)',
    needs: ['session'],
    check: (a) => needs(a, 'session'),
    async before(ops, a) {
      const c = await findSession(ops, a, { chatOk: true });
      return { session: c.name };
    },
    cardLines: (a) => [`Reopen session ${a.session} where it stopped?`, 'Nothing is sent to it.'],
    async run(ops, a) {
      await findSession(ops, a, { chatOk: true });
      await mend(ops, 'reopenSession', { computer: comp(a), session: a.session });
      return { summary: `${a.session} was reopened where it stopped; nothing was sent to it.`, data: { session: a.session }, audit: { session: a.session, undo: { say: 'close the session with stop_session' } } };
    },
  },
  'continue-session': {
    what: 'carry on a session stopped on an error: sends the carry-on message (L1 for her own session, a card for his)',
    needs: ['session'],
    check: (a) => needs(a, 'session'),
    async before(ops, a) {
      const c = await findSession(ops, a);
      return { session: c.name, account: c.profile ? c.profile.name : null };
    },
    cardLines: (a, b) => [`Send "Continue from where you stopped" to ${a.session}?`, b.account ? `It runs on provider ${b.account}.` : 'It runs on its own provider.'],
    async run(ops, a) {
      await findSession(ops, a);
      await ops.continueSession({ computer: comp(a), session: a.session });
      return { summary: `The carry-on message was sent to ${a.session}.`, data: { session: a.session }, audit: { session: a.session, undo: { say: 'stop the session with stop_session' } } };
    },
  },
  'hold-starts': {
    what: 'hold new starts by schedules and by her, or release them (never the owner\'s own presses)',
    needs: ['value: true to hold, false to release'],
    check(a) {
      needs(a, 'value');
      if (typeof a.value !== 'boolean') throw toolError('value is true (hold) or false (release)', 'call again with true or false');
      thisOnly(a);
    },
    async run(ops, a) {
      await mend(ops, a.value ? 'hold' : 'release', { by: 'tia' });
      return { summary: a.value ? 'New starts by schedules and by her are held.' : 'Held starts are released.', data: { held: a.value }, audit: { held: a.value, undo: undoOf('hold-starts', undefined, !a.value) } };
    },
  },
  'clean-own-temp': {
    what: 'clean Hoprig\'s own temporary files: logs older than 14 days, update copies but the last, test homes in its temp folder',
    needs: [],
    check: thisOnly,
    async before(ops, a) {
      const r = await mend(ops, 'cleanOwnTemp', { dryRun: true });
      return { bytes: Number.isFinite(r.bytes) ? r.bytes : null };
    },
    cardLines: (a, b) => [`Free ${b.bytes === null ? 'some' : bytesWord(b.bytes)} of Hoprig's own old logs and copies?`],
    async run(ops) {
      const r = await mend(ops, 'cleanOwnTemp', {});
      const freed = Number.isFinite(r.bytes) ? r.bytes : null;
      return { summary: `Hoprig's own old files were cleaned${freed === null ? '' : `: ${bytesWord(freed)} freed`}.`, data: { freed }, audit: { freed } };
    },
  },
  'change-plan': {
    what: 'make or change a plan: its title, goal, milestones and order',
    needs: ['value: { title, goal, milestones? }', 'item: the plan id, left out for a new plan'],
    check(a) {
      needs(a, 'value');
      if (!a.value || typeof a.value !== 'object' || Array.isArray(a.value)) throw toolError('value is an object of the plan\'s fields', 'give title, goal, projects or milestones');
      const ok = ['title', 'goal', 'projects', 'milestones'];
      for (const k of Object.keys(a.value)) if (!ok.includes(k)) throw toolError(`"${k}" is not a field of a plan she may set`, `the fields are ${ok.join(', ')}`);
      if (a.item !== undefined) ID(a, 'plan');
    },
    async run(ops, a) {
      if (a.item === undefined) {
        const r = await ops.route({ computer: comp(a), method: 'POST', path: '/api/work/plans', body: a.value });
        const id = r && r.plan && r.plan.id;
        return { summary: 'A plan was made.', data: { plan: id || null }, audit: { plan: id || null, undo: { say: 'drop the plan on the Work page' } } };
      }
      const now = await ops.workPlanOne({ computer: comp(a), id: a.item });
      const before = now && now.plan ? { title: now.plan.title, goal: now.plan.goal } : null;
      await ops.route({ computer: comp(a), method: 'POST', path: `/api/work/plans/${encodeURIComponent(a.item)}`, body: { seen: now.hash, ...a.value } });
      const back = before && Object.keys(a.value).every((k) => k === 'title' || k === 'goal') ? Object.fromEntries(Object.keys(a.value).map((k) => [k, before[k]])) : null;
      return { summary: `The plan ${a.item} was changed.`, data: { plan: a.item }, audit: { plan: a.item, ...(back ? { undo: undoOf('change-plan', a.item, back) } : { undo: { say: 'change the plan back on the Work page' } }) } };
    },
  },
  'undo-act': {
    what: 'undo one of her acts from Activity, from any conversation of the last 7 days (act list with the word undo shows them)',
    needs: ['item: the number of the act as act list gives it'],
    check(a) {
      needs(a, 'item');
      if (!/^\d{10,16}$/.test(String(a.item))) throw toolError('item is the number the list gave', 'call hoprig_act with act "list" and word "undo"');
    },
    // The act it would do is judged by its own level too (undoing a restart is a stop).
    async facts(ops, a, ctx) {
      const e = entryOf(ctx, a.item);
      const inv = e && e.result && e.result.undo && e.result.undo.act && ACTS[e.result.undo.act];
      return { inverse: inv ? inv.level : null };
    },
    async before(ops, a, ctx) {
      const e = entryOf(ctx, a.item);
      if (!e) throw toolError('no such act in the last 7 days, or it was undone already', 'call hoprig_act with act "list" and word "undo"');
      return { what: whatOf(e) };
    },
    cardLines: (a, b) => [`Undo: ${b.what}?`],
    async run(ops, a, ctx) {
      const e = entryOf(ctx, a.item);
      if (!e) throw toolError('no such act in the last 7 days, or it was undone already', 'call hoprig_act with act "list" and word "undo"');
      const u = e.result.undo;
      if (!u.act) throw toolError(`that act cannot be undone from here: ${String(u.say || 'no way is recorded').slice(0, 120)}`, 'tell the owner');
      const inv = ACTS[u.act];
      const args = { act: u.act, ...(u.item !== undefined ? { item: u.item } : {}), ...(u.value !== undefined ? { value: u.value } : {}), ...(e.input && e.input.computer ? { computer: e.input.computer } : {}) };
      inv.check(args, ctx);
      await inv.run(ops, args, ctx);
      return { summary: `Undone: ${whatOf(e)}.`, data: { undone: Number(a.item) }, audit: { undid: Number(a.item) } };
    },
  },
  'auto-order': {
    what: 'put a provider in the Auto order, where sessions move at a limit',
    needs: ['item: the provider', 'value: its place, 1 is first (left out: last)'],
    check(a) {
      ID(a, 'provider');
      if (a.value !== undefined && !(Number.isInteger(a.value) && a.value >= 1 && a.value <= 10)) throw toolError('value is a place from 1 to 10', 'leave it out for the last place');
    },
    // A provider paid per use is told on the card and counts against her daily cap.
    async facts(ops, a) {
      const r = await ops.accounts({ computer: comp(a) });
      const p = (r.profiles || []).find((x) => x.name === a.item);
      if (!p) throw toolError(`there is no provider "${a.item}"`, 'call get_computer_status with providers: true for the names');
      return { paid: p.kind === 'api' || p.paid === true, order: (r.autoSwitch && r.autoSwitch.order) || [] };
    },
    async before(ops, a) {
      const r = await ops.accounts({ computer: comp(a) });
      const p = (r.profiles || []).find((x) => x.name === a.item);
      if (!p) throw toolError(`there is no provider "${a.item}"`, 'call get_computer_status with providers: true for the names');
      return { order: (r.autoSwitch && r.autoSwitch.order) || [], paid: p.kind === 'api' || p.paid === true, first: ((r.autoSwitch && r.autoSwitch.order) || [])[0] || null };
    },
    cardLines: (a, b) => [
      `Put ${a.item} ${a.value === undefined ? 'last' : placeWord(a.value)} in the order?`,
      `Sessions move there when ${b.first && b.first !== a.item ? b.first : 'the first provider'} is at its limit.`,
      ...(b.paid ? [`${a.item} is paid per use and counts against your daily cap.`] : []),
    ],
    async run(ops, a) {
      const r = await ops.accounts({ computer: comp(a) });
      const old = (r.autoSwitch && r.autoSwitch.order) || [];
      const rest = old.filter((n) => n !== a.item);
      const at = a.value === undefined ? rest.length : Math.min(a.value - 1, rest.length);
      const order = [...rest.slice(0, at), a.item, ...rest.slice(at)];
      await ops.setAutoSwitch({ computer: comp(a), patch: { order } });
      return { summary: `${a.item} is in the Auto order now.`, data: { order }, audit: { undo: old.length ? { act: 'auto-mode', value: { order: old } } : { say: 'take it out of the order on the Providers page' } } };
    },
  },
  'auto-mode': {
    what: 'Auto mode: on or off, its order, and whether a session moves back (was set_auto_mode)',
    needs: ['value: { enabled?, order?, return_to_preferred? }'],
    check(a) {
      needs(a, 'value');
      if (!a.value || typeof a.value !== 'object' || Array.isArray(a.value)) throw toolError('value is an object', 'give enabled, order or return_to_preferred');
      const bad = Object.keys(a.value).find((k) => !['enabled', 'order', 'return_to_preferred'].includes(k));
      if (bad) throw toolError(`"${bad}" is not part of Auto mode`, 'give enabled, order or return_to_preferred');
      if ('enabled' in a.value && typeof a.value.enabled !== 'boolean') throw toolError('enabled is true or false', 'call again');
      if ('return_to_preferred' in a.value && typeof a.value.return_to_preferred !== 'boolean') throw toolError('return_to_preferred is true or false', 'call again');
      if ('order' in a.value && !(Array.isArray(a.value.order) && a.value.order.length >= 1 && a.value.order.length <= 10 && a.value.order.every((n) => typeof n === 'string' && NAME.test(n)))) throw toolError('order is a list of 1 to 10 provider names', 'call get_computer_status with providers: true for the names');
    },
    before: (ops, a) => auto_mode_act.before(ops, mapAuto(a)),
    cardLines: (a, b) => auto_mode_act.cardLines(mapAuto(a), b),
    async run(ops, a) {
      const m = mapAuto(a);
      const before = await auto_mode_act.before(ops, m);
      const r = await auto_mode_act.run(ops, m);
      const value = { ...(m.enabled !== undefined ? { enabled: before.enabled } : {}), ...(m.order && before.order.length ? { order: before.order } : {}) };
      return { ...r, audit: { undo: Object.keys(value).length ? { act: 'auto-mode', value } : { say: 'switch it back on the Providers page' } } };
    },
  },
  'change-setting': {
    what: 'change one dashboard setting (was change_setting; get_computer_status with settings: true shows the keys)',
    needs: ['item: the setting key', 'value: its new value'],
    check(a) {
      needs(a, 'item', 'value');
      if (!Object.hasOwn(SETTINGS, a.item)) throw toolError(`item must be one of: ${Object.keys(SETTINGS).join(', ')}`, 'call get_computer_status with settings: true for the current values');
      change_setting_act.check(mapSetting(a));
    },
    before: (ops, a) => change_setting_act.before(ops, mapSetting(a)),
    cardLines: (a, b) => change_setting_act.cardLines(mapSetting(a), b),
    cardForm: (a, b) => change_setting_act.cardForm(mapSetting(a), b),
    async run(ops, a) {
      const m = mapSetting(a);
      const before = await change_setting_act.before(ops, m);
      const r = await change_setting_act.run(ops, m);
      return { ...r, audit: { setting: a.item, undo: before.current === null ? { say: 'set it back by hand in Settings' } : { act: 'change-setting', item: a.item, value: before.current } } };
    },
  },
};

const mapAuto = (a) => ({ ...(a.value && a.value.enabled !== undefined ? { enabled: a.value.enabled } : {}), ...(a.value && a.value.order ? { order: a.value.order } : {}), ...(a.value && a.value.return_to_preferred !== undefined ? { return_to_preferred: a.value.return_to_preferred } : {}), ...(a.computer ? { computer: a.computer } : {}) });
const mapSetting = (a) => ({ key: a.item, value: a.value, ...(a.computer ? { computer: a.computer } : {}) });
const placeWord = (n) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][n - 1];
const bytesWord = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// What the audit log holds of her acts: any conversation, the last 7 days, not undone yet.
function undone(entries) {
  return new Set(entries.filter((e) => e.tool === 'hoprig_act' && e.outcome === 'done' && e.result && Number.isFinite(e.result.undid)).map((e) => e.result.undid));
}
function entryOf(ctx, at) {
  if (!ctx || !ctx.audit) return null;
  const all = ctx.audit.since(ctx.now() - WEEK);
  const gone = undone(all);
  return all.find((e) => String(e.at) === String(at) && e.tool === 'hoprig_act' && e.outcome === 'done' && e.result && e.result.undo && !gone.has(e.at) && ACTS[e.input && e.input.act] && e.input.act !== 'undo-act') || null;
}
const whatOf = (e) => `${String(e.input.act).replace(/-/g, ' ')}${typeof e.input.item === 'string' ? ` ${e.input.item}` : ''}`;
function recentActs(ctx) {
  if (!ctx || !ctx.audit) return { summary: 'No record of her acts is kept here.', data: { acts: [] } };
  const all = ctx.audit.since(ctx.now() - WEEK);
  const gone = undone(all);
  const out = all.filter((e) => e.tool === 'hoprig_act' && e.outcome === 'done' && e.result && e.result.undo && !gone.has(e.at) && ACTS[e.input && e.input.act] && e.input.act !== 'undo-act')
    .reverse().slice(0, 10).map((e) => ({ id: String(e.at), what: whatOf(e), minutes_ago: Math.max(0, Math.round((ctx.now() - e.at) / 60_000)), can_undo: !!e.result.undo.act }));
  return { summary: `${out.length} act(s) of hers in the last 7 days that can be undone.`, data: { acts: out } };
}

// The row of `list` is "act list-acts"; every other act is named as its row is.
const rowName = (act) => (act === 'list' ? 'list-acts' : act);
for (const [name, x] of Object.entries(ACTS)) Object.defineProperty(x, 'level', { enumerable: true, configurable: true, get: () => levelFor(factsOf(rowName(name))) });

/** The facts of one call: the row's, and what the server found for this call turned on (never turned off). */
export function callFacts(a, f = {}, found = {}) {
  const base = factsOf(rowName(a.act));
  const found2 = {};
  if (a.computer && a.computer !== LOCAL) found2.other = true;
  const sess = f.session || null;
  if (sess && sess.paid) found2.spends = true;
  if (found.paid) found2.spends = true;
  // A session she did not start is the owner's: acting on it is seen by him.
  if (a.session && sess && !f.mine) found2.seen = true;
  if (a.session && !sess) found2.seen = true; // not found: the owner's, until it is found
  const cwd = sess && sess.cwd;
  if (cwd && isSecretFolder(cwd)) found2.never = 'credentials';
  return raiseFacts(base, found2);
}

/**
 * The level of one call (policy.mjs): { level, why } or { refuse, next }.
 * `f.spoken`: the owner spoke the message (the server only raises from it). `tia.actAlone`: Settings → Tia, What she may do alone,
 * Tia acts by herself; `tia.level` "ask" turns every L1 act into a card.
 */
export function decide(a, f = {}, tia = {}) {
  const x = ACTS[a.act];
  if (!x) return { refuse: `there is no act "${String(a.act).slice(0, 40)}"`, next: 'call hoprig_act with act "list" and a word' };
  const facts = callFacts(a, f, f.extra || {});
  const plain = levelFor(facts);
  const level = levelFor(facts, { spoken: f.spoken === true });
  if (level === 'N') return { refuse: `${facts.never === 'credentials' ? 'a place that holds credentials' : 'that'} is the owner's own hand only: no tool of hers does it`, next: 'tell the owner; open_screen shows him the page' };
  if (level === 'L0') return { level: 'L0' };
  if (level === 'L2') return { level: 'L2', why: plain === 'L1' ? 'you spoke this, and it cannot be put back with one press' : whyCard(facts) };
  // L1 from here. Undoing an act is as strict as the act it does.
  if (a.act === 'undo-act' && f.extra && f.extra.inverse === 'L2') return { level: 'L2', why: 'undoing it is an act that needs your tap' };
  if (tia.level === 'ask') return { level: 'L2', why: 'the owner set "Ask me"' };
  if (tia.actAlone !== true) return { level: 'L2', why: `${ASSISTANT_NAME} may not act alone yet: Settings → ${ASSISTANT_NAME}, What she may do alone, ${ASSISTANT_NAME} acts by herself` };
  return { level: 'L1' };
}
function whyCard(facts) {
  if (facts.spends) return 'it uses the usage of a provider or money';
  if (facts.other) return 'it acts on another computer';
  if (facts.seen) return 'others may see it, or it is the owner\'s own session';
  return 'it cannot be put back with one press';
}

export const hoprig_act = {
  name: 'hoprig_act',
  level: 'L2',
  card: 'maybe',
  description: 'Do one act by its name; act "list" with word returns the matching acts, their levels and what each needs ("undo" lists her acts of the last 7 days). item names what it acts on, session a session, value the new value. Reading is free; some acts run at once, others stage a card.',
  input: obj({
    act: str({ min: 2, max: 40, pattern: /^[a-z][a-z-]{1,39}$/, desc: 'The act, or list.' }),
    word: str({ max: 40, desc: 'With list: a word to match.' }),
    item: str({ max: 80, desc: 'What it acts on: a gateway, provider, plan, setting key or act number.' }),
    session,
    value: anyJson({ desc: 'The new value.' }),
    computer,
  }, { required: ['act'] }),
  acts: ACTS,
  levelOf: (a) => (ACTS[a.act] ? ACTS[a.act].level : 'L2'),
  check(a, ctx) {
    const x = ACTS[a.act];
    if (!x) throw toolError(`there is no act "${a.act}"`, 'call hoprig_act with act "list" and a word to find one');
    for (const k of Object.keys(a)) if (!['act', 'computer', 'word', 'item', 'session', 'value'].includes(k)) throw toolError(`"${k}" does not go with hoprig_act`, 'use act, item, session, value, word, computer');
    x.check(a, ctx);
  },
  // What only the server knows for this call (a provider's price kind, the act an undo would do): never from the model.
  async facts(ops, a, ctx) {
    const x = ACTS[a.act];
    if (!x || !x.facts) return null;
    const r = await x.facts(ops, a, ctx);
    return r && r.inverse !== undefined ? { inverse: r.inverse } : r ? { paid: r.paid === true } : null;
  },
  policy: (a, f, tia) => decide(a, f, tia),
  before: async (ops, a, ctx) => {
    const x = ACTS[a.act];
    return { act: a.act, ...(x.before ? await x.before(ops, a, ctx) : {}) };
  },
  cardLines: (a, b) => (ACTS[a.act].cardLines ? ACTS[a.act].cardLines(a, b) : [`${a.act.replace(/-/g, ' ')}${a.item ? ` ${a.item}` : ''}`]),
  cardForm: (a, b) => (ACTS[a.act].cardForm ? ACTS[a.act].cardForm(a, b) : null),
  formValue: (k, v) => (k === 'value' && typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v),
  run: (ops, a, ctx) => ACTS[a.act].run(ops, a, ctx),
};
