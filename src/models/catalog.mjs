// A provider's models: the one list behind every model picker and every server check of a model's name (the Tia
// page, Plan with AI, the new-session sheet, the App's model menu, Work's "Do it", the schedules, Settings).
//
//   a key or a gateway ("api", "openai")   the endpoint's own list (GET <base>/v1/models), asked by the server with
//                                          the profile's own values when a picker opens or a profile is checked, kept
//                                          ten minutes per profile (and per address and key, so a changed profile is
//                                          asked again), never asked by a timer; plus what the profile itself names
//                                          (ANTHROPIC_MODEL and the like, and the targets of its MODELS= map).
//   a Claude sign-in ("login",             Claude Code's own models for a subscription, as data read from one version
//     "subscription")                      of the tool (claude-subscription.json); the tool's own default is every
//                                          picker's empty choice (no model is sent).
//   Auto mode                              the family names: it moves between providers, and each one takes them.
//   another coding tool (OpenCode)         the provider's list as that tool's chat already reads it (served.mjs).
//
// When no list can be had (the endpoint is down, lists nothing, refuses the question, has no key): the family names
// as before, one line that says why, and an exact name may be typed (MODEL_RE). What leaves this file holds model
// names and plain words only: never a key, an address or an account.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { endpointOf, modelEfforts } from '../codetools/providers.mjs';
import { MODEL_RE, explain, scrub } from '../server/endpoint.mjs';
import { readProfile } from '../profiles.mjs';

export { MODEL_RE };
/** Claude Code's family names: they always work for Claude Code, on every provider (it resolves them itself). */
export const FAMILIES = Object.freeze(['opus', 'sonnet', 'haiku']);
export const KEEP_MS = 10 * 60_000;
/** A failed ask is kept this long only: an endpoint that comes back (or a key fixed outside) is asked again soon. */
export const FAIL_KEEP_MS = 30_000;
const TIMEOUT_MS = 10_000;
const BODY_CAP = 2 * 1024 * 1024;
const MAX = 500; // entries kept of one list
const NO_LIST = 'Could not get this provider\'s model list';
const NOT_FOUND = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']); // the name of the address is known to nobody
const NAMED_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];

const SUBSCRIPTION = JSON.parse(fs.readFileSync(new URL('./claude-subscription.json', import.meta.url), 'utf8'));
/** The tool and its version the subscription's list was read for. */
export const SUBSCRIPTION_READ = Object.freeze({ tool: SUBSCRIPTION.tool, version: SUBSCRIPTION.version });
// One label per family, wherever it is offered (a subscription, the fallback, Auto mode): from the one data file.
const FAMILY_ENTRIES = Object.freeze(FAMILIES.map((id) => ({ id, label: SUBSCRIPTION.models.find((m) => m.id === id).label })));
// What Claude Code itself takes on a subscription beyond its menu: its aliases and the exact ids it knows (an older
// exact id saved in a chat or a schedule keeps working, whether or not its caller passes it as saved).
const SUBSCRIPTION_TAKES = new Set([...SUBSCRIPTION.models.map((m) => m.id), ...SUBSCRIPTION.aliases, ...SUBSCRIPTION.exact]);
// Claude Code cuts a "[1m]" after an id and a date after an exact id (claude-sonnet-4-5-20250929) before it looks the
// id up in its own table, so both forms of a name it knows are taken too.
const subscriptionTakes = (id) => {
  const bare = id.replace(/\[1m\]$/i, '');
  return SUBSCRIPTION_TAKES.has(id) || SUBSCRIPTION_TAKES.has(bare) || SUBSCRIPTION.exact.includes(bare.replace(/-\d{8}$/, ''));
};

// Characters nobody can see, or that move text around, never reach a label.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const labelOf = (s, id) => {
  const t = typeof s === 'string' ? s.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return t || id;
};

/** One entry of a model list as the page gets it: { id, label, efforts?, window1m?, images? }; null for a bad id. */
export function entryOf(m) {
  const id = typeof m === 'string' ? m : m && typeof m.id === 'string' ? m.id : null;
  if (!id || !MODEL_RE.test(id)) return null;
  const o = m && typeof m === 'object' ? m : {};
  const caps = o.capabilities && typeof o.capabilities === 'object' && !Array.isArray(o.capabilities) ? o.capabilities : {};
  const e = { id, label: labelOf(o.display_name || o.name, id) };
  const efforts = modelEfforts(o);
  if (efforts.length) e.efforts = efforts;
  const win = [o.context_window, o.max_input_tokens, o.context_length, caps.context_window, caps.max_input_tokens].find((x) => Number.isFinite(x));
  if (win >= 1_000_000 || o.context_1m === true || caps.context_1m === true) e.window1m = true;
  const mods = [o.input_modalities, caps.input_modalities, o.architecture && o.architecture.input_modalities].find(Array.isArray);
  if ([caps.image_input, caps.vision, o.supports_images, o.supports_vision].includes(true) || (mods && mods.includes('image'))) e.images = true;
  return e;
}

/** The model names a profile itself gives: its model variables and the targets of its MODELS= map. */
export function namedBy(p) {
  const env = (p && p.env) || {};
  const out = NAMED_VARS.map((k) => env[k]).filter(Boolean);
  for (const pair of String((p && p.models) || '').split(',')) {
    const to = pair.split('=')[1];
    if (to) out.push(to.trim());
  }
  return [...new Set(out.filter((x) => MODEL_RE.test(x)))];
}

const profileOf = (p) => (typeof p === 'string' ? (p === 'auto' ? { name: 'auto', kind: 'auto' } : readProfile(p)) : p);
const keyOf = (p, ep) => `${p.name}\0${crypto.createHash('sha256').update(`${ep.base}\0${ep.key}\0${ep.auth}`).digest('hex').slice(0, 16)}`;
const kept = new Map(); // keyOf → { at, models, why }
const lastList = new Map(); // keyOf → the last list the endpoint gave, kept past KEEP_MS: a check uses it, a picker asks again
const asking = new Map(); // keyOf → the ask on its way: pickers that open at the same moment share it

/** Read at most BODY_CAP bytes of a response as text. */
async function capped(r) {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > BODY_CAP) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Ask the endpoint for its list, with the profile's own key and header first (a refused key is tried once with the
 * other header). → { models: [entries] } or { why: plain words }. A redirect is never followed.
 */
async function ask(ep, fetchImpl) {
  let last = null;
  for (const auth of ep.auth === 'bearer' ? ['bearer', 'x'] : ['x', 'bearer']) {
    let r;
    try {
      r = await fetchImpl(`${ep.base}/v1/models?limit=1000`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'anthropic-version': '2023-06-01', ...(auth === 'bearer' ? { Authorization: `Bearer ${ep.key}` } : { 'x-api-key': ep.key }) },
      });
    } catch (e) {
      // Never the error's own text: it can hold the whole address (fetch quotes it). A system code, or plain words.
      const code = e && e.cause && typeof e.cause.code === 'string' ? e.cause.code : '';
      const cause = e && e.name === 'TimeoutError' ? `it did not answer within ${TIMEOUT_MS / 1000} seconds` : NOT_FOUND.has(code) ? 'no computer has the provider\'s address' : 'the provider\'s address does not answer';
      return { why: `${NO_LIST}: ${cause}.` };
    }
    let text;
    try {
      text = await capped(r);
    } catch {
      return { why: `${NO_LIST}: the answer broke off.` };
    }
    if (text === null) return { why: `${NO_LIST}: the answer was too large.` };
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (r.status === 401 || r.status === 403) {
      last = { status: r.status, json };
      continue;
    }
    if (r.status === 404) return { why: `${NO_LIST}: this address has no model list (404). The provider may still take an exact model name.` };
    if (r.status !== 200) return { why: `${NO_LIST}. ${said({ status: r.status, json }, ep)}` };
    const list = json && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : null;
    if (!list) return { why: `${NO_LIST}: the answer held no model list.` };
    const seen = new Set();
    const models = [];
    // A paged answer (has_more) gave only its first page: a name on a later page is served too, as past a cut list.
    let cut = Boolean(json && json.has_more === true);
    for (const m of list) {
      const e = entryOf(m);
      if (!e || seen.has(e.id)) continue;
      if (models.length >= MAX) {
        cut = true; // more than MAX: a name past them is served too, so the check never refuses against this list
        break;
      }
      seen.add(e.id);
      models.push(e);
    }
    return models.length ? { models, ...(cut ? { cut } : {}) } : { why: 'This provider lists no models.' };
  }
  return { why: `${NO_LIST}. ${said(last, ep)}` };
}
/** What the endpoint's answer means, without its key or its address (the service's own words may quote either). */
const said = (r, ep) => scrub(explain(r, 'the service', ep.key), ep.key, ep.base);

/** Why the profile's address cannot be asked at all (null when it can): a name and password in it, or not a web address. */
function baseProblem(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return `${NO_LIST}: the provider's address is not a web address.`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${NO_LIST}: the provider's address is not a web address (http or https).`;
  if (u.username || u.password) return `${NO_LIST}: the provider's address holds a name and password. Remove them from the address under Providers.`;
  return null;
}

const fallback = (why, extra = []) => ({
  source: 'fallback', models: [...FAMILY_ENTRIES, ...extra.filter((n) => !FAMILIES.includes(n)).map((id) => ({ id, label: `${id} (named by this provider)` }))], why, typed: true,
});
const withNamed = (models, names) => [...models, ...names.filter((n) => !models.some((m) => m.id === n)).map((id) => ({ id, label: `${id} (named by this provider)` }))];
/** A kept answer as a view: the list (`cut` when the endpoint lists more than MAX), else the fallback with its why. */
const viewOf = (hit, names) => (hit.models ? { source: 'endpoint', models: withNamed(hit.models, names), why: null, typed: false, ...(hit.cut ? { cut: true } : {}) } : fallback(hit.why, names));
const subscription = () => ({ source: 'subscription', models: SUBSCRIPTION.models.map(({ id, label, window1m }) => ({ id, label, ...(window1m ? { window1m } : {}) })), why: null, typed: false, read: SUBSCRIPTION_READ });
const auto = () => ({ source: 'auto', models: [...FAMILY_ENTRIES], why: null, typed: false, note: 'Auto mode moves between your providers; each of them takes these names.' });

/**
 * What a picker shows for `profile` (a profile or its name) and coding tool `tool`: { provider, source, models, why,
 * typed, ... }. `source`: endpoint | subscription | auto | tool | fallback. Asks the endpoint at most once in
 * KEEP_MS per profile. o: { fetchImpl, now(), toolModels(profile) (another tool's list, served.mjs) }.
 */
export async function modelsFor(profile, { tool = 'claude', fetchImpl = globalThis.fetch, now = Date.now, toolModels = null } = {}) {
  const p = profileOf(profile);
  if (!p) return { provider: String(profile), ...fallback('There is no such provider.') };
  const head = { provider: p.name };
  if (tool !== 'claude') {
    const list = toolModels ? await toolModels(p) : [];
    const models = list.map(entryOf).filter(Boolean);
    return { ...head, ...(models.length ? { source: 'tool', models, why: null, typed: false } : { source: 'fallback', models: [], why: 'The provider gave no model list for this coding tool.', typed: true }) };
  }
  if (p.kind === 'auto') return { ...head, ...auto() };
  if (p.kind === 'login' || p.kind === 'subscription') return { ...head, ...subscription() };
  const ep = endpointOf(p);
  const names = namedBy(p);
  if (!ep || !ep.key) return { ...head, ...fallback(`${NO_LIST}: this provider has no key to ask with.`, names) };
  const refused = baseProblem(ep.base);
  if (refused) return { ...head, ...fallback(refused, names) };
  const k = keyOf(p, ep);
  let hit = kept.get(k);
  if (!hit || now() - hit.at >= (hit.models ? KEEP_MS : FAIL_KEEP_MS)) {
    let pending = asking.get(k);
    if (!pending) {
      const at = now();
      pending = ask(ep, fetchImpl).then((r) => {
        const got = { at, ...r };
        kept.set(k, got);
        if (got.models) lastList.set(k, got);
        return got;
      }).finally(() => asking.delete(k));
      asking.set(k, pending);
    }
    hit = await pending;
  }
  // The same rule as knownModelsFor: a failure after a list that was had keeps that list, with the failure as its why,
  // so the picker and the check of a typed name read the same list.
  const last = hit.models ? null : lastList.get(k);
  if (last) return { ...head, ...viewOf(last, names), why: `${hit.why} These are the models it listed last.` };
  return { ...head, ...viewOf(hit, names) };
}

/**
 * The same from what is known now, without asking anyone (for a check and a view that cannot wait): the last list an
 * endpoint gave decides also after KEEP_MS (only a picker asks again); an endpoint never asked gives
 * { source: 'unknown' } with the family names and the profile's names.
 */
export function knownModelsFor(profile, { tool = 'claude', now = Date.now, toolKnown = null } = {}) {
  const p = profileOf(profile);
  if (!p) return { provider: String(profile), ...fallback('There is no such provider.') };
  const head = { provider: p.name };
  if (tool !== 'claude') {
    const models = (toolKnown ? toolKnown(p.name) : []).map(entryOf).filter(Boolean);
    return { ...head, source: models.length ? 'tool' : 'unknown', models, why: null, typed: !models.length };
  }
  if (p.kind === 'auto') return { ...head, ...auto() };
  if (p.kind === 'login' || p.kind === 'subscription') return { ...head, ...subscription() };
  const ep = endpointOf(p);
  const names = namedBy(p);
  // A provider that can never be asked says why, as modelsFor does: asking later would not help.
  if (!ep || !ep.key) return { ...head, ...fallback(`${NO_LIST}: this provider has no key to ask with.`, names) };
  const refused = baseProblem(ep.base);
  if (refused) return { ...head, ...fallback(refused, names) };
  const k = keyOf(p, ep);
  const hit = kept.get(k);
  const last = lastList.get(k);
  // A fresh failure decides only where no list was ever had: an endpoint down for a moment never drops an open chat's
  // menu to the family names, nor lets the check take any name.
  if (hit && now() - hit.at < (hit.models ? KEEP_MS : FAIL_KEEP_MS) && (hit.models || !last)) return { ...head, ...viewOf(hit, names) };
  // Ten minutes decide only when a picker asks again: the last list the endpoint gave still decides a check (a schedule
  // at night is checked as a start by day is).
  if (last) return { ...head, ...viewOf(last, names) };
  return { ...head, ...fallback(null, names), source: 'unknown' };
}

/**
 * Whether a view that stays open without being a picker (a chat's page) should ask the endpoint now: only a provider
 * whose endpoint would be asked, and only when its last ask, whatever it gave, is KEEP_MS old or there was none. Not
 * the check's view: that keeps the last list for ever, so a model the endpoint adds later would never reach the menu;
 * and a failure is kept only FAIL_KEEP_MS for a picker, so a page's every state send would ask a refused key again.
 */
export function askDue(profile, { now = Date.now } = {}) {
  const p = profileOf(profile);
  if (!p || p.kind === 'auto' || p.kind === 'login' || p.kind === 'subscription') return false;
  const ep = endpointOf(p);
  if (!ep || !ep.key || baseProblem(ep.base)) return false;
  const k = keyOf(p, ep);
  // An ask on its way: due, so a chat opened now is sent the list too (modelsFor shares that ask: no second request).
  if (asking.has(k)) return true;
  const hit = kept.get(k);
  return !hit || now() - hit.at >= KEEP_MS;
}

/**
 * Whether model `id` may start a session of `tool` on `profile`, from what is known now (never asks): null when it
 * may, else the plain reason. Accepted: a name of the provider's list, a family name (Claude Code), a value saved
 * earlier (`saved`: a chat's, a plan's, a task's, a schedule's, Tia's, the new-session default), or a checked exact
 * name where no list is known. Refused: a name that is not a model name, and a name the provider's own list leaves out.
 */
export function modelProblem(profile, id, { tool = 'claude', saved = [], now = Date.now, toolKnown = null } = {}) {
  if (typeof id !== 'string' || !MODEL_RE.test(id)) return 'that is not a model name (letters, digits and . _ : / @ + - [ ], up to 120, a letter or digit first)';
  if (saved.includes(id)) return null;
  return refusedBy(knownModelsFor(profile, { tool, now, toolKnown }), id, tool);
}

/** Why view `v` refuses model `id` of `tool`, without what was saved (null when it takes it): the check and the mark. */
function refusedBy(v, id, tool = 'claude') {
  if (tool === 'claude' && FAMILIES.includes(id)) return null;
  if (v.models.some((m) => m.id === id)) return null;
  if (v.cut) return null; // the endpoint lists more than is kept: a checked name past them may well be served
  if (v.source === 'endpoint' || v.source === 'tool') return `the provider does not serve "${id}": it is not in its list of ${v.models.length} models`;
  if (v.source === 'subscription') {
    if (subscriptionTakes(id)) return null;
    if (id === 'default') return '"default" is not a model name: choose the default in the list to let Claude Code choose';
    return `"${id}" is not one of the models Claude Code offers a subscription`;
  }
  if (v.source === 'auto') return 'Auto mode takes a family name: opus, sonnet or haiku';
  return null; // no list is known: a checked exact name
}

/** The ids of a view, with the saved values it leaves out after them (shown marked, never replaced). */
export function idsWith(view, saved = []) {
  const ids = view.models.map((m) => m.id);
  return [...ids, ...saved.filter((s) => typeof s === 'string' && s && !ids.includes(s))];
}

export const NOT_LISTED = 'not in this provider\'s list';
/**
 * The saved values a provider's real list leaves out, to be shown with NOT_LISTED: exactly those the check would refuse
 * if they were not saved. A family name (Claude Code), a name past a cut or paged list and an id Claude Code takes on a
 * subscription are not marked. Without a real list (the fallback, an endpoint never asked, Auto mode): [].
 */
export function notListedOf(view, saved = [], tool = 'claude') {
  if (!['endpoint', 'tool', 'subscription'].includes(view.source)) return [];
  return [...new Set(saved.filter((s) => typeof s === 'string' && s && refusedBy(view, s, tool)))];
}

/** Tests and a changed profile: forget what was kept (one profile, or all). */
export function forgetModels(name = null) {
  for (const m of [kept, lastList, asking]) for (const k of [...m.keys()]) if (name === null || k.startsWith(`${name}\0`)) m.delete(k);
}
