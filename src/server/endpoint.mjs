// Talking to a provider's endpoint for Providers (./accounts.mjs): its models, one tiny test request, and which API
// shapes it answers (probeShapes, for "Test"). Every response body is capped and every call has a time limit; a key
// is never part of an error message (scrub).
import { API_SHAPES } from '../profiles.mjs';

export const FETCH_TIMEOUT_MS = 15_000;
const BODY_CAP = 2 * 1024 * 1024;
/** A model id: a letter or digit first (a coding tool would read a leading "-" as an option). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Anything that could be a secret is cut out of text that leaves the server. */
export const scrub = (s, ...secrets) => {
  let out = String(s || '');
  for (const x of secrets) if (x && x.length >= 6) out = out.split(x).join('***');
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '***').replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
};

/** Read at most BODY_CAP bytes of a response as text. */
async function readCapped(r) {
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
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const HEADERS = { x: (key) => ({ 'x-api-key': key }), bearer: (key) => ({ Authorization: `Bearer ${key}` }) };

/**
 * One request to the endpoint. Redirects are never followed (a redirect could carry the key to another host).
 * Resolves { status, json, text } or { error } for network failures.
 */
async function call(fetchImpl, url, { method = 'GET', key, auth, body }) {
  try {
    const r = await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'anthropic-version': '2023-06-01', ...(body ? { 'content-type': 'application/json' } : {}), ...HEADERS[auth](key) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await readCapped(r);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  } catch (e) {
    const cause = e.cause && (e.cause.code || e.cause.message);
    return { error: e.name === 'TimeoutError' ? 'it did not answer within 15 seconds' : cause || e.message };
  }
}

/** What went wrong, in plain words, from an HTTP answer. */
export function explain(r, host, key) {
  if (r.error) return `Cannot reach ${host}: ${scrub(r.error, key)}`;
  const said = r.json && r.json.error ? (typeof r.json.error === 'string' ? r.json.error : r.json.error.message || r.json.error.type || '') : '';
  const extra = said ? ` The service said: "${scrub(said, key)}"` : '';
  if (r.status >= 300 && r.status < 400) return `${host} answered with a redirect (${r.status}). Use the final address instead; the key is not sent on to another address.`;
  if (r.status === 401) return `The key was refused (401).${extra}`;
  if (r.status === 403) return `The key may not do this (403).${extra}`;
  if (r.status === 404) return `Not found at this address (404): check the address and the model name.${extra}`;
  if (r.status === 429) return `Too many requests or no credit left (429).${extra}`;
  if (r.status === 529 || r.status === 503) return `The service is overloaded right now (${r.status}). Try again in a moment.${extra}`;
  if (r.status >= 500) return `The service had an error (${r.status}).${extra}`;
  return `The request was not accepted (${r.status}).${extra}`;
}

function modelsOf(json) {
  const list = json && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : null;
  if (!list) return null;
  const out = [];
  for (const m of list) {
    const id = m && typeof m.id === 'string' ? m.id : typeof m === 'string' ? m : null;
    if (!id || !MODEL_RE.test(id)) continue;
    out.push({ id, name: m && typeof m.display_name === 'string' ? m.display_name.slice(0, 80) : id });
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * List the models with either header. Returns { auth: 'x'|'bearer'|null, models: [...]|null, note }.
 * `auth` is null when no list exists (the test request decides then); a refused key is an error.
 */
export async function listModels(fetchImpl, baseUrl, key, prefer = 'x') {
  const host = new URL(baseUrl).host;
  const url = `${baseUrl}/v1/models?limit=1000`;
  let last = null;
  for (const auth of prefer === 'bearer' ? ['bearer', 'x'] : ['x', 'bearer']) {
    const r = await call(fetchImpl, url, { key, auth });
    if (r.error) throw fail(502, explain(r, host, key));
    if (r.status === 200) {
      const models = modelsOf(r.json);
      if (models) return { auth, models, note: models.length ? '' : 'The service lists no models; type the model name.' };
      return { auth, models: null, note: 'The service gave no model list; type the model name.' };
    }
    last = r;
    if (r.status !== 401 && r.status !== 403) break; // only a refused key is worth the other header
  }
  if (last && (last.status === 401 || last.status === 403)) throw fail(400, explain(last, host, key));
  return { auth: null, models: null, note: 'This service has no model list; type the model name.' };
}

/**
 * One tiny real request. Returns { ok, auth, error? }. `auth` is tried first; a refused key is tried once with the
 * other header (a model list may be open to anyone, so the header it accepted proves nothing).
 */
export async function testModel(fetchImpl, baseUrl, key, auth, model) {
  const host = new URL(baseUrl).host;
  const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] };
  let last = null;
  for (const a of auth === 'bearer' ? ['bearer', 'x'] : ['x', 'bearer']) {
    const r = await call(fetchImpl, `${baseUrl}/v1/messages`, { method: 'POST', key, auth: a, body });
    if (!r.error && r.status === 200) return { ok: true, auth: a };
    last = r;
    if (r.error || (r.status !== 401 && r.status !== 403)) break;
  }
  return { ok: false, auth, passing: passing(last), error: explain(last, host, key) };
}

/**
 * A failure that says nothing about whether the endpoint serves an API: no answer, a timeout, too many requests,
 * an overloaded or broken server. Only a clear answer (a refused key, an unknown route, a bad request) says it does not.
 */
export const passing = (r) => Boolean(r) && (Boolean(r.error) || r.status === 408 || r.status === 429 || r.status >= 500);

/**
 * Which API shapes the endpoint answers ("Test" on a provider): one tiny request per shape with `model` —
 *   messages    POST /v1/messages          (Claude's API; Claude Code, OpenCode)
 *   responses   POST /v1/responses         (OpenAI's Responses API; Codex, OpenCode)
 *   chat        POST /v1/chat/completions  (OpenAI's chat completions; OpenCode)
 *   models      GET  /v1/models            (a model list, for the pickers)
 * A shape counts only on a 200. Returns { ok, shapes, unsure, auth, error? }: ok when at least one shape a coding
 * tool can use answered; error when none did (a refused key says so). `unsure`: the shapes whose request failed for
 * a passing reason (see passing): this test cannot say they are missing. `auth`: the header Claude's API took.
 */
export async function probeShapes(fetchImpl, baseUrl, key, auth, model, { only = null } = {}) {
  const host = new URL(baseUrl).host;
  const shapes = [];
  const unsure = [];
  let refused = null;
  let other = null;
  const m = only && !only.includes('messages') ? { ok: false } : await testModel(fetchImpl, baseUrl, key, auth, model);
  if (m.ok) shapes.push('messages');
  else {
    other = m.error || null;
    if (m.passing) unsure.push('messages');
  }
  const openai = [
    ['responses', '/v1/responses', { model, input: 'Hi', max_output_tokens: 16 }],
    ['chat', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Hi' }], max_completion_tokens: 16 }],
  ];
  for (const [shape, p, body] of openai) {
    if (only && !only.includes(shape)) continue;
    const r = await call(fetchImpl, `${baseUrl}${p}`, { method: 'POST', key, auth: 'bearer', body });
    if (!r.error && r.status === 200) shapes.push(shape);
    else {
      if (passing(r)) unsure.push(shape);
      if (r.status === 401 || r.status === 403) refused = r;
      else if (!other) other = explain(r, host, key);
    }
  }
  const list = await call(fetchImpl, `${baseUrl}/v1/models?limit=1000`, { key, auth: m.ok ? m.auth : 'bearer' });
  if (!list.error && list.status === 200 && modelsOf(list.json)) shapes.push('models');
  else if (passing(list)) unsure.push('models');
  const ok = shapes.some((x) => x !== 'models');
  return { ok, shapes, unsure, auth: m.ok ? m.auth : auth, ...(ok ? {} : { error: refused && !m.ok ? explain(refused, host, key) : other || 'The service answered none of the APIs a coding tool uses.' }) };
}

/**
 * The API= line after a Test: what answered now, plus what the provider was known to answer before and this test
 * could not check (a passing failure). One overloaded moment never takes a coding tool away from a provider.
 */
export function shapesAfterTest(before, probe) {
  const keep = (before || []).filter((x) => probe.unsure.includes(x) && !probe.shapes.includes(x));
  return API_SHAPES.filter((x) => probe.shapes.includes(x) || keep.includes(x));
}

// ---------- the subscription sign-in (`claude setup-token` in a terminal we hold) ----------

