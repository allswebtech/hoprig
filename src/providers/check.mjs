// "Check this provider": one round of small requests to a profile's own endpoint with its own key, so a model name the
// endpoint does not serve is found BEFORE it stops a session (names.mjs says which names the coding tool can send). Each
// request is max_tokens 1 and one word; one more carries a tiny picture for the model a picture would go to. The answer
// is a short list: served, not served (with the endpoint's words, cleaned), or not told (a limit, an error, no answer);
// and for each gap the one line that mends it. The owner presses for it on the Providers page; it runs once by itself
// only when a gateway profile is made through the product (firstCheck). A look, a tick, a page view or a profile edit
// never sends anything. Only a profile with an endpoint of its own (a key, a gateway) is checked: a sign-in is not.
//
// The last result is kept in the state folder (providers/checks.json) without the key: the endpoint's words are cleaned
// by the table's cleaner (keys, tokens, e-mail addresses) and the key itself is cut out once more.

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { classify, cleanLine } from './table.mjs';
import { claudeVersionQuick } from '../claudecode.mjs';
import { TOOL_VERSION, isSmall, namesFor, pictureModel } from './names.mjs';
import { compareVersions } from '../setup/system.mjs';
import { MAP_SINCE, configDirOf, ownOverrides, sessionMap } from './sessionmap.mjs';

const TIMEOUT_MS = 15_000;
const AT_ONCE = 4;
const SAID_MAX = 160;
const BODY_MAX = 64 * 1024;
const ANTHROPIC = 'https://api.anthropic.com';
// A 1 by 1 picture: the smallest a model can be asked to look at.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const file = () => path.join(stateDir(), 'providers', 'checks.json');

/** True for a profile the check may ask: Claude's API with a key, direct or through a gateway. */
export const checkable = (p) => !!p && p.kind === 'api' && !!(p.env?.ANTHROPIC_API_KEY || p.env?.ANTHROPIC_AUTH_TOKEN);

/**
 * What a press would send: each name as a plain session of `p` sends it (after the map it gets, only where the installed
 * Claude Code `version` takes the map), and the picture's model. `count` is the number of requests.
 */
export function checkPlan(p, { version = claudeVersionQuick() } = {}) {
  if (!checkable(p)) return { applies: false, count: 0, names: [], picture: null };
  // `takes`: this Claude Code takes the map, so a MODELS line can mend a name for its sessions (else it changes nothing).
  const takes = !!version && compareVersions(version, MAP_SINCE) >= 0;
  const own = ownOverrides(configDirOf(p));
  const m = sessionMap(p, { own });
  // A profile that maps nothing gets no map of its own, but its plain session still reads the owner's settings file:
  // his modelOverrides rename the large names all the same, so they are what such a session sends.
  const overrides = takes ? m.overrides || (Object.keys(own).length ? own : null) : null;
  const map = { haiku: m.haiku, overrides };
  const names = namesFor(p, map);
  // `own`: the owner's entries, which win over the profile's map for a session (so no MODELS line mends those names).
  // `on`: the owner turned the map on for this provider's sessions; while it is off a MODELS line mends nothing for a
  // session, and its mend says so (the names asked are then the plain ones: the map is not applied above).
  return { applies: true, count: names.length + 1, names, picture: pictureModel(p, map), takes, own: takes ? own : {}, on: p.mapSessions === true };
}

/** The family of a model name (opus, sonnet, haiku, fable), to offer a served model of the same kind first. */
const family = (n) => /(opus|sonnet|haiku|fable)/.exec(String(n))?.[1] || '';

function endpointOf(p) {
  const base = String(p.env.ANTHROPIC_BASE_URL || ANTHROPIC).replace(/\/+$/, '');
  const headers = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (p.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${p.env.ANTHROPIC_AUTH_TOKEN}`;
  else headers['x-api-key'] = p.env.ANTHROPIC_API_KEY;
  return { url: `${base}/v1/messages`, headers, secrets: [p.env.ANTHROPIC_AUTH_TOKEN, p.env.ANTHROPIC_API_KEY].filter((s) => s && s.length >= 6) };
}

// A name that follows the word for an account, a user, an organisation or a team, quoted ('account "relay-team-a"')
// or labelled ('user: alex', 'org=acme'): the endpoint's words often name whose key it is, and that name is not shown
// or kept. Plain prose ("user message is empty") is left as it is.
const WHO = '(account|user(?:name)?|org(?:anization|anisation)?|team|owner|workspace)';
const QUOTED = new RegExp(`\\b${WHO}(\\s*(?:id|name)?\\s*[:=]?\\s*)(["'\`])([^"'\`\\s]{2,80})\\3`, 'gi');
const LABELLED = new RegExp(`\\b${WHO}(\\s*(?:id|name)?\\s*[:=]\\s*)([\\w.@+-]{2,80})`, 'gi');
// The shortest start of a secret that is masked where it stands alone ("relay-made-up-tok…").
const PREFIX_MIN = 12;

/** Every start of `secret` of PREFIX_MIN characters or more that `s` holds, masked. */
function maskPrefixes(s, secret) {
  if (secret.length < PREFIX_MIN) return s;
  const head = secret.slice(0, PREFIX_MIN);
  let out = '';
  let i = 0;
  for (let at = s.indexOf(head); at >= 0; at = s.indexOf(head, i)) {
    let n = PREFIX_MIN;
    while (at + n < s.length && n < secret.length && s[at + n] === secret[n]) n++;
    out += `${s.slice(i, at)}***`;
    i = at + n;
  }
  return out + s.slice(i);
}

/** The endpoint's own words, cleaned: no key or a start of it, token, e-mail address or account name, one short line. */
export function cleanSaid(text, secrets = []) {
  let s = String(text ?? '').slice(0, 4000);
  try {
    const j = JSON.parse(s);
    const e = j?.error;
    s = typeof e === 'string' ? e : e?.message || e?.type || s;
  } catch {
    /* not JSON: the words as they came */
  }
  for (const x of secrets) s = maskPrefixes(s.split(x).join('***'), x);
  s = cleanLine(s).replace(QUOTED, (m, word, sep, q) => `${word}${sep}${q}***${q}`).replace(LABELLED, (m, word, sep) => `${word}${sep}***`).replace(/\s+/g, ' ').trim();
  return s.length > SAID_MAX ? `${s.slice(0, SAID_MAX - 1)}…` : s;
}

// At most BODY_MAX bytes of an answer are read, then the rest is dropped unread: a gateway's body is outside the
// product's control, and a whole one read first (r.text()) can hold hundreds of megabytes per request.
async function headOf(r) {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  try {
    while (n < BODY_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).subarray(0, BODY_MAX).toString('utf8');
}

async function ask(fetchImpl, ep, model, content) {
  try {
    const r = await fetchImpl(ep.url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: ep.headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content }] }),
    });
    if (r.status === 200) {
      // A served name needs no words: its answer is not read at all.
      await r.body?.cancel().catch(() => {});
      return { status: 200, said: '' };
    }
    const head = await headOf(r);
    return { status: r.status, said: cleanSaid(head, ep.secrets), type: typeOf(head) };
  } catch (e) {
    return { status: 0, said: e?.name === 'TimeoutError' ? 'it did not answer within 15 seconds' : cleanSaid(e?.cause?.code || e?.message || 'no answer', ep.secrets) };
  }
}

/** The error type of an answer's body (Claude's API: { error: { type } }), or ''. */
function typeOf(text) {
  try {
    const t = JSON.parse(text)?.error?.type;
    return typeof t === 'string' ? t.slice(0, 60) : '';
  } catch {
    return '';
  }
}

/**
 * served | refused | key (the key was refused: nothing else is told) | untold (a limit, an error, no answer, or a
 * refusal whose words do not say the model is the cause). A 400 or 404 alone says nothing about the name: a gateway
 * that wants more than max_tokens 1, or a base address with a wrong path, refuses every request the same way. Only the
 * endpoint's words or type name the model: the table's own rows (an ambiguous or unknown model, an input the model does
 * not take), or Claude's API's "not_found_error" whose message names the model ("model: <name>").
 */
function verdict({ status, said, type }) {
  if (status === 200) return 'served';
  if (status === 401 || status === 403) return 'key';
  if (![400, 404, 422].includes(status)) return 'untold';
  const c = classify({ status, type, text: said });
  if (c && (c.reason === 'model' || c.reason === 'input')) return 'refused';
  return type === 'not_found_error' && /^model:/i.test(said) ? 'refused' : 'untold';
}

/**
 * The words every request was refused with, when they are the same for all, none was served and none of them names
 * the model; else null. Words that name the model (a gateway that knows only its own combo names) are about each
 * name: those rows stay gaps, each with its mend.
 */
function sameForAll(rows) {
  const first = rows[0];
  if (rows.length < 2 || rows.some((r) => r.verdict === 'served' || r.verdict === 'refused' || r.status !== first.status || r.said !== first.said)) return null;
  return { status: first.status, said: first.said };
}

// The profile's variables that name a model: a MODELS rule does not rename them for a plain session.
const OWN_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
const glob = (pattern) => new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/**
 * The MODELS value that sends every name of row `r` (`also`: each name the tool sends as the refused model) to `alt`
 * instead: the profile's rules that lead to the refused model lead to `alt`, and a name no such rule covers gets a
 * rule of its own in front. So the names the tool falls back to are mended with the first. Null when only the
 * profile's own variables send it (MODELS does not rename those: its model is changed instead), or only the owner's
 * own modelOverrides (`own`: his entry wins over the profile's for a session, so the line would change nothing).
 */
export function modelsMend(p, r, alt, own = {}) {
  const vars = new Set(OWN_VARS.map((k) => p.env?.[k]).filter(Boolean));
  // The owner's modelOverrides do not rename a small-model name (Claude Code 2.1.328): such an entry sends nothing.
  const names = (r.also || [r.asks]).filter((n) => !vars.has(n) && !(Object.hasOwn(own, n) && !isSmall(n)));
  if (!names.length) return null;
  const rules = String(p.models || '').split(',').map((x) => x.trim()).filter((x) => x.indexOf('=') > 0);
  const split = rules.map((x) => [x.slice(0, x.indexOf('=')).trim(), x.slice(x.indexOf('=') + 1).trim()]);
  // The rule that decides a name is its first match (as mapModel reads them).
  const covered = (n) => split.find(([from]) => glob(from).test(n))?.[1] === r.sends;
  const front = names.filter((n) => !covered(n)).map((n) => `${n}=${alt}`);
  const rest = split.map(([from, to]) => `${from}=${to === r.sends ? alt : to}`);
  return `MODELS=${[...front, ...rest].join(',')}`;
}

/** The rows of a round, each refused name with its mend, and the picture's (`own`: the owner's modelOverrides). */
export function mends(p, rows, picture, { takes = true, own = {} } = {}) {
  const served = rows.filter((r) => r.verdict === 'served').map((r) => r.sends);
  for (const r of rows) {
    if (r.verdict !== 'refused') continue;
    const kind = family(r.asks) || family(r.sends);
    const same = served.find((s) => kind && family(s) === kind);
    const alt = same || served[0] || null;
    // An older or unknown Claude Code takes no map: a MODELS line would be written and change nothing for a session.
    const models = alt && takes ? modelsMend(p, r, alt, own) : null;
    // A served model of another kind is offered only with words that say so.
    const other = models && !same && kind ? ` (${alt} is not ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} model: it answers, but it is another kind)` : '';
    // A name the owner's own settings send there: only he changes that file (Hoprig only reads it).
    const yours = (r.also || [r.asks]).filter((n) => Object.hasOwn(own, n) && !isSmall(n));
    r.mend = { combo: `Add a combo named "${r.sends}" at the gateway`, models };
    // A MODELS line reaches a session only where the owner turned the map on: the line itself never says it, each reader
    // adds it for the switch as it is when it is read (withSwitch), so a line kept from before a change stays true.
    r.mend.line = models ? `${r.mend.combo}, or set ${models}${other}` : r.mend.combo;
    if (other) r.mend.note = other.slice(2, -1);
    if (yours.length) {
      const them = yours.length > 1 ? 'them' : 'it';
      r.mend.yours = `${yours.join(', ')} ${yours.length > 1 ? 'are' : 'is'} sent as ${r.sends} by your own Claude Code settings (modelOverrides in its settings.json), which win over this provider's map: change ${them} there. Hoprig does not change that file.`;
      r.mend.line += `, or change ${yours.join(', ')} in your own Claude Code settings (modelOverrides)`;
    }
  }
  if (picture?.verdict === 'refused') {
    // The name itself is served for text (the round asked it): no combo of that name is to be made, its pictures are.
    picture.mend = { combo: `At the gateway, let ${picture.sends} take pictures, or send its pictures to a model that does`, models: null };
    picture.mend.line = picture.mend.combo;
  }
}

/** One round against the profile's endpoint. Resolves the result that is kept (without any key). */
export async function runCheck(p, { fetchImpl = fetch, now = Date.now, version } = {}) {
  const plan = checkPlan(p, version === undefined ? {} : { version });
  if (!plan.applies) throw Object.assign(new Error('Only a provider with an endpoint and a key of its own can be checked: a sign-in has none.'), { status: 409 });
  const ep = endpointOf(p);
  const jobs = [
    ...plan.names.map((n) => ({ ...n, content: 'Hi' })),
    { asks: plan.picture, sends: plan.picture, why: 'a picture', picture: true, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } }, { type: 'text', text: 'Hi' }] },
  ];
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i];
      const r = await ask(fetchImpl, ep, j.sends, j.content);
      out[i] = { asks: j.asks, also: j.also || [j.asks], sends: j.sends, why: j.why, verdict: verdict(r), status: r.status || null, said: r.said };
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  // The same answer to every request, with words that do not name the model, is about the endpoint, not about N names:
  // it is told once (no row of it is a gap).
  const endpoint = sameForAll(out);
  const picture = out.pop();
  mends(p, out, picture, { takes: plan.takes, own: plan.own });
  // `models`: the rules the MODELS lines were made from (a line is used only while the provider still has them).
  const result = { name: p.name, at: new Date(now()).toISOString(), tool: TOOL_VERSION, count: jobs.length, models: p.models || '', rows: out, picture, endpoint };
  keep(p.name, result);
  return result;
}

// ---- the kept results ----

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function keep(name, result) {
  const all = readAll();
  all[name] = result;
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** The last result of `name`'s check, or null. */
export const lastCheck = (name) => readAll()[name] || null;

/** The words a MODELS mend needs while the provider's map is off for its sessions. */
export const SWITCH_WORDS = 'and turn on "Use these names for every session on this provider"';

/** A mend's line for the switch as it is now (`on`): a MODELS line says it needs the switch while the switch is off. */
export const withSwitch = (mend, on) => (mend.models && !on ? mend.line.replace(`, or set ${mend.models}`, `, or set ${mend.models} ${SWITCH_WORDS}`) : mend.line);

/** The gaps of the last check: [{ name, mend }] (the picture's too), for the model-name item (`on`: the switch now). */
export function gapsOf(result, { on = false } = {}) {
  if (!result) return [];
  const rows = [...(result.rows || []), ...(result.picture ? [{ ...result.picture, picture: true }] : [])];
  // `combo` and `off` too: an item whose reason has no room for the whole line says the combo and what the line needs.
  return rows.filter((r) => r.verdict === 'refused' && r.mend).map((r) => ({ name: r.sends, asks: r.asks, picture: !!r.picture, mend: withSwitch(r.mend, on), combo: r.mend.combo, models: !!r.mend.models, off: !!r.mend.models && !on }));
}

// One round at a time per profile: a second press while one runs gets the same round.
const running = new Map();
export function checkOnce(p, opts) {
  if (running.has(p.name)) return running.get(p.name);
  const r = runCheck(p, opts).finally(() => running.delete(p.name));
  running.set(p.name, r);
  return r;
}

/**
 * The one round that runs by itself: when a gateway profile is made through the product. It runs in the background
 * (the page does not wait for it); a failure is kept as nothing, and the owner can press for the check again.
 */
export function firstCheck(p, opts) {
  if (!checkable(p) || !p.env.ANTHROPIC_BASE_URL) return null;
  return checkOnce(p, opts).catch(() => null);
}
