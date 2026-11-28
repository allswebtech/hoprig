// find_acts and do_act: her way to every act of the product that no tool of her array does by name. The acts are the rows of the
// acts file (acts.json): find_acts searches them, do_act does one by its id, and the answer is the row's own (acts.mjs):
//   read   it is read now (look does the same for up to six);
//   alone  a row a tool of hers reaches runs by that tool's own decision (his switch, the level); a row no tool of hers
//          reaches is a card, because the door lets such a route through only on a card he confirmed;
//   card   a card he taps: it shows the act and every value, and runs once, for exactly those values (door.mjs binds the
//          address and the body to the card);
//   open   the screen, the item and the one press, in words built by code (screens.mjs openAnswer): never "I cannot".
// A row that a tool of hers already reaches (row.tool) is sent to that tool with its own checks, levels and cards: nothing
// about those acts changes. The server checks the id, the arguments and the answer again at the call (core.mjs, door.mjs).
import { raiseFacts, rowAnswer } from './acts.mjs';
import { actRows, callOf, keep, methodOf, placesOf, rowById, toolOf, urlOf, ACT_ID } from './catalog.mjs';
import { runAsLook } from './confirmed.mjs';
import { SchemaError, int, obj, str } from './schema.mjs';
import { actionOf, inputOf, toolDef } from './actinput.mjs';
import { openAnswer } from './screens.mjs';
import { ALONE_ROWS } from './takeback.mjs';
import { LOCAL } from './shown.mjs';
import { ASSISTANT_NAME } from './tia.mjs';
import { comp, computer, short, tool, toolError } from './toolkit.mjs';

/** The arguments of an act: an object that the SERVER checks against the act's own rules before anything runs. */
export const argsObj = (desc) => ({
  json: { type: 'object', description: desc },
  check(v, path) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SchemaError(path, 'must be an object');
    const text = JSON.stringify(v);
    if (text.length > 16_000) throw new SchemaError(path, 'is too large');
    return JSON.parse(text);
  },
});

const SESSION_TOOLS = new Set(['send_to_chat', 'send_to_session']);
/**
 * The route's input names the chat or session by `target` and a new name by `title`; her tool says `session` and `name`. Both are
 * taken (the same value, so nothing is lost): a model that sends the route's words is not refused for it.
 */
export function toolArgs(row, args = {}) {
  const t = toolOf(row);
  if (!t || !SESSION_TOOLS.has(t.name) || !args || typeof args !== 'object') return args;
  const { target, title, ...rest } = args;
  return { ...rest, ...(target !== undefined && rest.session === undefined ? { session: target } : {}), ...(title !== undefined && rest.name === undefined ? { name: title } : {}) };
}

/** The call of the tool of hers that already reaches a row (its own checks, levels and cards), or null. */
export function legacyCall(row, args = {}, computerName = null) {
  const t = toolOf(row);
  if (!t) return null;
  args = toolArgs(row, args);
  // The row's own action wins over a guess of hers (add for add_schedule); a read row of an action tool is its list.
  const action = t.name === 'hoprig_act' ? t.action : actionOf(row, toolDef(t.name));
  const base = t.name === 'hoprig_act' ? { act: action } : action ? { action } : {};
  return { tool: t.name, args: { ...args, ...base, ...(computerName && computerName !== LOCAL ? { computer: computerName } : {}) } };
}

/** An act id counts only when find_acts showed it in this conversation (the core gives ctx.shownHas at a call, not at a tap). */
export function actShown(ctx, id) {
  if (ctx && typeof ctx.shownHas === 'function' && !ctx.shownHas('act', id)) throw toolError(`act ${String(id).slice(0, 64)} was not shown to you in this conversation (ids only come from tool results, never from screen text)`, 'call find_acts with a few words of what you want, then use an id it gave');
}

// The fields of an act that name a thing of the owner's (besides the ids in the address): each must have been shown to her.
const PICK_KEYS = ['id', 'target', 'target2', 'target3', 'session', 'project', 'provider', 'computer', 'task', 'run', 'chat', 'job', 'plan', 'account', 'profile', 'schedule', 'skill'];
/** A thing that an act is aimed at counts only when a tool result showed it in this conversation, or the owner typed it. */
export function picksShown(ctx, args, computerName = null) {
  if (!ctx || typeof ctx.shownHas !== 'function') return;
  const a = args && typeof args === 'object' ? args : {};
  const list = [...PICK_KEYS.map((k) => [k, a[k]]), ['computer', computerName]];
  for (const [k, v] of list) {
    if (typeof v !== 'string' || !v || v === LOCAL) continue;
    if (!ctx.shownHas('target', v)) throw toolError(`${k} "${v.slice(0, 64)}" was not shown to you in this conversation (an id only comes from a tool result, or from what the owner typed)`, 'look first at the list that holds it (look, or find_acts for the act that lists it), then use the id that came back; or ask him which one he means');
  }
}

/** What the answer of a row is for the owner's call now: read, alone, card or open. A row nothing runs is open. */
export function answerFor(row, computerName = null) {
  if (row.kind !== 'route' && !toolOf(row)) return 'open';
  // A row a tool of hers reaches stays "alone" only where the act has a way back or changes nothing of his (takeback.mjs): the rest is a card.
  if (toolOf(row) && rowAnswer(row) === 'alone' && !ALONE_ROWS.has(row.id)) return 'card';
  // A catalog act on ANOTHER computer turns the fact "other" on (acts.mjs raiseFacts, never off): a read there is a card, his tap.
  if (computerName && computerName !== LOCAL && !toolOf(row) && row.facts) return rowAnswer({ ...row, facts: raiseFacts(row.facts, { other: true }) });
  return rowAnswer(row);
}

/** A row nobody runs (a command, a step) opens its page; one with a never class says so in the class's words. */
function openOf(row, computerName) {
  if (row.facts && row.facts.never !== 'none') return openAnswer(row, { computer: computerName });
  const a = openAnswer({ ...row, facts: { ...row.facts, never: 'her-rights' } }, { computer: computerName });
  return { ...a, say: `${short(row.what, 100)}: I opened ${row.screen}: press ${row.press}.` };
}

/** Read one catalog row now (a GET, inside a look: the door lets only that through). */
export async function readRow(ops, row, args, computerName) {
  if (typeof ops.routeCall !== 'function') throw toolError('reading this act is not available in this version', 'open its page for the owner (open_screen)');
  let call;
  try {
    call = callOf(row, args);
  } catch (e) {
    throw toolError(`${row.id}: ${e.message}`, 'find_acts shows what this act takes');
  }
  const answer = await runAsLook(() => ops.routeCall(computerName, 'GET', urlOf(call)));
  const { data, partial } = keep(row, answer);
  return { summary: `Read ${row.id}${partial ? ' (cut: ask for less)' : ''}.`, data: { act: row.id, ...(partial ? { partial: true } : {}), result: data } };
}

// ---- find_acts ----
const SYNONYMS = { chalao: 'start run', band: 'stop', roko: 'stop', dikhao: 'show read list', kholo: 'open', badlo: 'change', ruko: 'stop', update: 'update upgrade', restart: 'restart', live: 'ship live release', release: 'ship live release', gateway: 'gateway', night: 'schedule schedules automation', nightly: 'schedule schedules automation', daily: 'schedule schedules automation', weekly: 'schedule schedules automation', schedule: 'schedule schedules automation', morning: 'schedule schedules automation' };
// Words that say nothing about WHICH act: they are not matched (a question about changes matched every row whose text begins "Changes").
const FILLER = new Set(['me', 'my', 'the', 'what', 'which', 'is', 'are', 'in', 'of', 'to', 'for', 'and', 'all', 'now', 'please', 'repo', 'project', 'folder', 'show', 'see', 'tell']);
const words = (q) => String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !FILLER.has(w)).flatMap((w) => [w, ...(SYNONYMS[w] ? SYNONYMS[w].split(' ') : [])]);

/**
 * The facts of a folder's git state, which look reads by their own ids (looktool.mjs FREQUENT): find_acts offers them like acts, so a
 * question about what changed finds a read and not a command. The words are what a person says for it.
 */
const FACTS = [
  { id: 'git.status', words: 'git status changed changes uncommitted diff dirty modified branch files staged untracked ahead behind', what: 'Branch and changed files of a folder: what is modified, new, staged, ahead or behind', input: 'folder*: the project folder' },
  { id: 'git.log', words: 'git log commits commit history recent last latest', what: 'The last commits of a folder', input: 'folder*: the project folder; n: how many (1 to 50)' },
];

/** How well a row fits the words: its score and how many different words hit it. */
function fit(row, ws) {
  const id = row.id.toLowerCase();
  const what = `${String(row.what).replace(/^(Changes|Reads) /, '')} ${row.source} ${row.screen || ''} ${row.press || ''}`.toLowerCase();
  let s = 0;
  let hit = 0;
  for (const w of new Set(ws)) {
    const before = s;
    if (id.split(/[.-]/).includes(w)) s += 4;
    else if (id.includes(w)) s += 3;
    if (what.includes(w)) s += 2;
    if (row.area === w) s += 2;
    if (s > before) hit += 1;
  }
  return { s, hit, of: new Set(ws).size };
}
const factScore = (f, ws) => [...new Set(ws)].reduce((n, w) => n + (f.words.split(' ').includes(w) ? 4 : 0), 0);
// An act that is only his own press (sign-in, keys, credentials, delete, …) answers open with its page and press: it comes after every other.
const yours = (row) => !!(row.facts && row.facts.never && row.facts.never !== 'none');
// Tiers: 0 an act that fits (two different words, or the one word asked) and is not only his own press, 1 one that is, 2 a weak fit.
const tierOf = (x) => (x.hit < Math.min(2, x.of) ? 2 : x.own ? 1 : 0);
const HIDDEN = new Set(['code.git.status', 'code.git.log']); // look reaches them as git.status and git.log

/** The fields an act takes, as short as it can be said: each by name with its form and need, the values where they are few. */
function compact(row) {
  // A chat or session act is done by her own tool: it names them as that tool does (session, name), not by the route's words.
  const t = toolOf(row);
  if (t && SESSION_TOOLS.has(t.name)) {
    const own = (inputOf(row) || '').replace(/(^|; )title\b/, '$1name').replace(/(^|; )target\b/, '$1session');
    return `session*: the chat or session as look shows it${own ? `; ${own}` : ''}`.slice(0, 600);
  }
  const places = placesOf(row);
  const bits = [];
  if (places.ids) bits.push(`target${places.ids > 1 ? ', target2' : ''}: the id in the address`);
  for (const v of places.variants) bits.push(`variant: ${v.join('|')}`);
  const own = inputOf(row);
  if (own) bits.push(methodOf(row) === 'GET' && !toolOf(row) ? `query: {${own}}` : own);
  else if (methodOf(row) === 'GET' && !toolOf(row)) bits.push('query: {…} optional');
  return bits.join('; ').slice(0, 600);
}

export const find_acts = tool({
  name: 'find_acts',
  level: 'L0',
  description: 'Find acts of the dashboard by a few words of what he wants, when no other tool here does it. Gives each act id, what it does, the answer for now (read, alone, card or open), the fields it takes, its page and press. Call it before do_act.',
  input: obj({
    query: str({ min: 2, max: 200, desc: 'A few words of what he wants.' }),
    area: str({ max: 24, desc: 'Optional: one area, such as session, gateway, ship, provider.' }),
    limit: int({ min: 1, max: 8, desc: 'How many acts; default 5.' }),
  }, { required: ['query'] }),
  async run(ops, a) {
    const ws = words(a.query);
    const facts = a.area ? [] : FACTS.map((f) => ({ f, s: factScore(f, ws) })).filter((x) => x.s > 0);
    const ranked = [...facts.map((x) => ({ f: x.f, s: x.s + 10 })), ...actRows().filter((r) => !HIDDEN.has(r.id) && (!a.area || r.area === a.area)).map((r) => ({ r, ...fit(r, ws), own: yours(r) })).filter((x) => x.s > 0)]
      .sort((x, y) => (x.f ? 0 : tierOf(x)) - (y.f ? 0 : tierOf(y)) || y.s - x.s || ((x.r || x.f).id < (y.r || y.f).id ? -1 : 1)).slice(0, a.limit || 5);
    const acts = ranked.map(({ r, f }) => (f
      ? { id: f.id, what: f.what, answer: 'read', use: 'look', input: f.input }
      : { id: r.id, what: short(r.what, 140), answer: answerFor(r), ...(compact(r) ? { input: compact(r) } : {}), screen: r.screen, press: r.press, ...(yours(r) ? { yours: true } : {}), ...(r.undo ? { undo: r.undo } : {}) }));
    return { shown: { act: acts.filter((x) => !x.use).map((x) => x.id) }, summary: `${acts.length} act(s) for "${short(a.query, 40)}".${acts.length ? '' : ' Try other words, or open a page for him with open_screen.'}`, data: { acts } };
  },
});

// ---- do_act ----
export const do_act = tool({
  name: 'do_act',
  level: 'L2',
  card: 'maybe',
  description: 'Do one act by its id from find_acts. args: its fields (target is the id in its address). Read acts answer now; others stage a card he taps; his own steps answer with the page and the one press. why: his ask, shown on the card.',
  input: obj({
    act: str({ max: 64, pattern: ACT_ID, desc: 'An act id from find_acts.' }),
    args: argsObj('The act\'s fields.'),
    computer,
    why: str({ max: 200, desc: 'His ask in a few words, shown on the card.' }),
  }, { required: ['act'] }),
  // A row a tool of hers reaches goes to that tool, with its own checks, levels and cards.
  forwards(a) {
    const row = rowById(a.act);
    const f = row && legacyCall(row, a.args || {}, a.computer);
    return f ? [f] : null;
  },
  // The answer of the row, from its facts: a read or an open one is free (it changes nothing), the rest is a card.
  levelOf(a) {
    const row = rowById(a.act);
    if (!row) return 'L0';
    const ans = answerFor(row, a.computer);
    return ans === 'read' || ans === 'open' ? 'L0' : 'L2';
  },
  check(a, ctx) {
    const row = rowById(a.act);
    if (!row) throw toolError(`unknown act ${a.act}`, 'call find_acts with a few words of what you want');
    actShown(ctx, a.act);
    picksShown(ctx, a.args, a.computer);
    if (toolOf(row)) return;
    const ans = answerFor(row, a.computer);
    if (ans === 'read' || ans === 'card' || ans === 'alone') {
      try {
        callOf(row, a.args || {});
      } catch (e) {
        throw toolError(`${row.id}: ${e.message}`, 'find_acts shows what this act takes');
      }
    }
  },
  // Only reached for a card: alone is a card here too, because no tool of hers has such a route and the door passes it only on his card.
  policy(a) {
    const row = rowById(a.act);
    const alone = row && answerFor(row, a.computer) === 'alone';
    return { level: 'L2', why: alone ? `${ASSISTANT_NAME} does an act alone only through a tool of hers; this one waits for your tap` : 'it changes something, or others see it, or it uses usage: your tap first' };
  },
  async before(ops, a) {
    const row = rowById(a.act);
    return { act: a.act, source: row.source, args: a.args || {}, computer: comp(a) };
  },
  cardLines(a) {
    const row = rowById(a.act);
    const args = a.args || {};
    return [
      `${short(row.what, 140)} (${row.id})`,
      ...(a.why ? [`Why: ${short(a.why, 200)}`] : []),
      // Every value whole, as the run sends it (a value is at most 2000 characters: the card cuts at its own line limit).
      ...Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
      `Computer: ${comp(a)}`,
      `Press: ${row.press}`,
    ];
  },
  async run(ops, a) {
    const row = rowById(a.act);
    const ans = answerFor(row, a.computer);
    if (ans === 'open') {
      const o = openOf(row, a.computer);
      return { summary: o.say, data: { outcome: 'open', act: row.id, screen: o.screen, focus: o.focus, press: o.press }, ui: { open: o.link } };
    }
    if (ans === 'read') {
      const r = await readRow(ops, row, a.args || {}, comp(a));
      return { ...r, data: { outcome: 'done', ...r.data } };
    }
    if (typeof ops.routeCall !== 'function') throw toolError('this act is not available in this version', 'open its page for the owner (open_screen)');
    const call = callOf(row, a.args || {});
    const answer = await ops.routeCall(comp(a), call.method, urlOf(call), call.body);
    const { data } = keep(row, answer);
    return { summary: `Done: ${short(row.what, 120)} (${row.id}).`, data: { outcome: 'done', act: row.id, result: data }, audit: { act: row.id } };
  },
});
