// The catalog of acts that find_acts, look and do_act reach: the rows of the acts file (acts.json) as the tools use them.
// Pure helpers, no tool and no door in here (door.mjs imports this file, the tools import it too):
//   - which rows the catalog tools run themselves: a route row with no tool of hers (a tool of hers already reaches the
//     others, do_act sends those to it), no never class, that only reads (a READ route) or that changes something (a CARD
//     route: it runs only as the act of a card the owner confirmed);
//   - how the arguments of such a row become an address and a body, checked strictly (the row's own input schema, else a
//     flat object of short values), and what a read keeps of its answer (picked fields, no secret field, a size cap).
import { isSecretFolder } from '../server/folders.mjs';
import { loadActs, rowAnswer, sourcePattern } from './acts.mjs';
import { expandHome } from './commandplaces.mjs';
import { redact } from './secrets.mjs';

export const ACT_ID = /^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,4}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// A field that says who the caller is or what a thing costs is never hers to send: the server takes those from the session.
const POWER_KEY = /^(roles?|tenants?|tenant_?id|price|prices|total|admin|is_?admin|permissions?)$/i;
const PATH_KEYS = ['target', 'target2', 'target3'];
const SECRET_KEY = /(key|token|secret|password|passwd|cookie|authorization|verifier|device_code|private)/i;

let CACHE = null;
const loaded = () => {
  if (!CACHE) {
    const all = loadActs().rows.filter((r) => r.kind !== 'not-an-act');
    CACHE = { all, byId: new Map(all.map((r) => [r.id, r])) };
  }
  return CACHE;
};
/** Every row that is an act. */
export const actRows = () => loaded().all;
/** The row of an act id, or null. */
export const rowById = (id) => loaded().byId.get(id) || null;
export const methodOf = (row) => row.source.split(' ')[0];
const isFree = (row) => row.kind === 'route' && !row.tool && row.facts && row.facts.never === 'none';
/** A route the catalog reads for her: a row that only reads (answer read), with no tool of hers and no class. */
export const isReadRoute = (row) => isFree(row) && rowAnswer(row) === 'read';
/** A route that changes something, no tool of hers reaches, no class: it passes the door only on a confirmed card. */
export const isCardRoute = (row) => isFree(row) && ['alone', 'card'].includes(rowAnswer(row));
/** The row's own tool of hers (the act is done by that tool's own checks), or null. */
export const toolOf = (row) => (row.tool && row.tool.name ? row.tool : null);

/** The routes of the catalog: [{ row, re, method }], for the door. */
export const catalogRoutes = () => actRows().filter((r) => isReadRoute(r) || isCardRoute(r)).map((row) => ({ row, re: sourcePattern(row.source), method: methodOf(row) }));

const PLACE = /(<id>|\([a-z|-]+\))/;
/** The address of a route row for these arguments: `target`, `target2` fill the ids, `variant` picks of (a|b). Throws a plain message. */
export function pathOf(row, args) {
  const p = row.source.replace(/^[A-Z]+ /, '');
  let n = 0;
  return p.split(PLACE).map((part) => {
    if (part === '<id>') {
      const v = args[PATH_KEYS[n++]];
      if (typeof v !== 'string' || !SEGMENT.test(v)) throw new Error(`${PATH_KEYS[n - 1]} is needed: the ${n === 1 ? 'id' : 'second id'} of the item (letters, digits, - _ . :), as a read showed it`);
      return v;
    }
    if (part.startsWith('(')) {
      const opts = part.slice(1, -1).split('|');
      if (!opts.includes(args.variant)) throw new Error(`variant is needed: one of ${opts.join(', ')}`);
      return args.variant;
    }
    return part;
  }).join('');
}

/** How many ids and whether a variant this row's address takes: for find_acts. */
export function placesOf(row) {
  const parts = row.source.replace(/^[A-Z]+ /, '').split(PLACE);
  return { ids: parts.filter((x) => x === '<id>').length, variants: parts.filter((x) => x.startsWith('(')).map((x) => x.slice(1, -1).split('|')) };
}

// ---- the arguments ----
const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
function flat(args, what) {
  const keys = Object.keys(args);
  if (keys.length > 16) throw new Error(`${what} may have at most 16 fields`);
  const out = {};
  for (const k of keys) {
    if (!KEY.test(k)) throw new Error(`${what}: "${k.slice(0, 20)}" is not a field name`);
    if (SECRET_KEY.test(k)) throw new Error(`${what}: "${k}" is a secret field: secrets never go through the assistant`);
    if (POWER_KEY.test(k)) throw new Error(`${what}: "${k}" is not a field she may send: the dashboard takes the role, the tenant and the price from the session and the product`);
    const v = args[k];
    if (!scalar(v) || v === null) throw new Error(`${what}.${k} must be text, a number or true or false`);
    if (typeof v === 'string' && (v.length > 2000 || v.includes('\0'))) throw new Error(`${what}.${k} is too long`);
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${what}.${k} must be a finite number`);
    out[k] = v;
  }
  return out;
}

/** The row's JSON Schema (type object, additionalProperties false, short typed properties) applied strictly to `body`. */
function bySchema(schema, body, what) {
  const props = schema.properties || {};
  for (const k of Object.keys(body)) if (!Object.hasOwn(props, k)) throw new Error(`${what}: unknown field "${k.slice(0, 30)}" (allowed: ${Object.keys(props).join(', ') || 'none'})`);
  const one = (s, v, p) => {
    if ('const' in s) { if (v !== s.const) throw new Error(`${p} must be ${JSON.stringify(s.const)}`); return; }
    if (s.type === 'string') { if (typeof v !== 'string' || v.length > (s.maxLength ?? 500)) throw new Error(`${p} must be text of at most ${s.maxLength ?? 500} characters`); return; }
    if (s.type === 'integer') { if (!Number.isInteger(v) || v < (s.minimum ?? -1e12) || v > (s.maximum ?? 1e12)) throw new Error(`${p} must be a whole number from ${s.minimum ?? 0} to ${s.maximum ?? 1e12}`); return; }
    if (s.type === 'boolean') { if (typeof v !== 'boolean') throw new Error(`${p} must be true or false`); return; }
    if (s.type === 'array') {
      if (!Array.isArray(v) || v.length > (s.maxItems ?? 20)) throw new Error(`${p} must be a list of at most ${s.maxItems ?? 20}`);
      v.forEach((x, i) => one(s.items || {}, x, `${p}[${i}]`));
      return;
    }
    throw new Error(`${p}: this field has no checkable type`);
  };
  for (const [k, v] of Object.entries(body)) one(props[k], v, `${what}.${k}`);
  return body;
}

/** Every string anywhere in `v`. */
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

/**
 * The call a catalog row makes for `args`: { method, path, query, body }. Throws an Error with a plain message that names the
 * field and the rule. Never a secret field, never a place that holds credentials.
 */
export function callOf(row, args = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const { target, target2, target3, variant, query, ...rest } = a; // eslint-disable-line no-unused-vars
  const path = pathOf(row, a);
  const method = methodOf(row);
  let q = null;
  let body = null;
  if (method === 'GET') {
    if (Object.keys(rest).length) throw new Error(`a read takes its fields in query: {…}, not directly (${Object.keys(rest).slice(0, 3).join(', ')})`);
    q = query === undefined ? {} : flat(query && typeof query === 'object' && !Array.isArray(query) ? query : {}, 'query');
  } else {
    if (query !== undefined) throw new Error('query is for a read; this act sends its fields as the body');
    body = row.input ? bySchema(row.input, rest, 'args') : flat(rest, 'args');
  }
  for (const s of strings(q || body)) {
    if (/^(~|\/|[A-Za-z]:[\\/])/.test(s) && isSecretFolder(expandHome(s))) throw new Error('that place holds credentials or a sign-in: it is the owner\'s alone');
  }
  return { method, path, query: q, body };
}

/** The address with its query, as the route takes it. */
export const urlOf = (call) => {
  if (!call.query || !Object.keys(call.query).length) return call.path;
  return `${call.path}?${new URLSearchParams(Object.entries(call.query).map(([k, v]) => [k, String(v)])).toString()}`;
};

// ---- what a read keeps ----
/** A copy of `v` without any field whose name is of the secret class, and with every value redacted. */
function clean(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, clean(x, depth + 1)]));
  return v;
}
const getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

/** What a read keeps: the row's pick (all of it for "*"), no secret-class field, at most `cap` characters; { data, partial }. */
export function keep(row, answer) {
  const pick = Array.isArray(row.pick) ? row.pick : ['*'];
  const cap = Math.min(Number(row.cap) || 4000, 4000);
  let data = pick.includes('*') ? answer : Object.fromEntries(pick.map((p) => [p, getPath(answer, p)]).filter(([, v]) => v !== undefined));
  data = clean(data);
  let text = JSON.stringify(data);
  let partial = false;
  if (text.length > cap) {
    partial = true;
    text = text.slice(0, cap);
    data = { cut: `${text}…` };
  }
  return { data, partial };
}

/** The answer of a row now: "read", "alone", "card" or "open" (never "none" for a catalog row). */
export const answerOfRow = (row, opts) => rowAnswer(row, opts);
