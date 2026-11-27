// TRouteAI's own management interface, driven from Hoprig: ONE function (`callGateway`) sends every call, from a fixed
// list of the (method, path) pairs it may send (ALLOWED). Each entry names the fields of its answer that are kept
// (everything else is dropped), and a second filter drops any field that looks like a credential. The routes that
// answer with stored sign-ins, keys or exports are not on the list, so they cannot be called.
//
// A credential (the command token, a temporary key) is sent only
//   - to the literal address 127.0.0.1,
//   - to a listener that runs as this user (trouteaibase.sameUserListener: one whose owner cannot be told is someone
//     else's),
//   - with the command token read from its file for this one call (trouteaibase.commandToken), and no forwarding header.
// The few acts whose routes refuse the command token (the sign-in acts of an account) get a key with the manage scope
// that is made for that one call and removed right after, also when the call fails (`withManageKey`).
// Every refusal is one plain sentence (ManageError.message); nothing here logs or returns a key, token or sign-in.
import fs from 'node:fs';
import nodePath from 'node:path';
import { commandToken, dataFolder, sameUserListener } from './trouteaibase.mjs';

export class ManageError extends Error {
  /** `status`: the HTTP status Hoprig answers with; `code`: a short word a page can act on. */
  constructor(message, status = 502, code = 'refused') {
    super(message);
    this.name = 'ManageError';
    this.status = status;
    this.code = code;
  }
}

const TIME_MS = 10_000;
const BODY_MAX = 2_000_000;
const ID = '[A-Za-z0-9_-]{1,120}';
const PROVIDER = '[a-z0-9][a-z0-9-]{0,59}';

// What reads as a credential, by the name of its field: dropped from every answer that is not for Hoprig's own use.
const CREDENTIAL_NAME = /(api_?key|access_?token|refresh_?token|id_?token|token|secret|password|passwd|credential|cookie|authorization|verifier|device_?code|private_?key|^key$)/i;
/** `value` without any property that looks like a credential (deep). */
export function scrub(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!CREDENTIAL_NAME.test(k)) out[k] = scrub(v, depth + 1);
  return out;
}

/** A text from the gateway, as one short plain line without anything that looks like a key. */
export function plain(text, max = 240) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\b(sk|pk|gh[pousr]|xox[a-z]|AIza|ya29|eyJ)[A-Za-z0-9._-]{8,}/g, '…')
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, '…')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const str = (v, max = 200) => (typeof v === 'string' ? plain(v, max) : null);
// An id the gateway made (a UUID is 36 characters): kept whole when it is only letters, digits, - and _, which is also all a route
// takes; plain() would turn it into a dot, as it does a key.
// A provider's or a model's name as the gateway writes it (openai-compatible-chat-<uuid>/gpt-5): the same, with / . : allowed.
const refOf = (v, max = 200) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_.:/@+-]+$/.test(v) ? v : str(v, max));
// An address the gateway gives for the owner to open (a one-time sign-in link, a provider's sign-in page): kept whole, with its long
// parts (the one-time code, the code challenge), or nothing; plain() would cut each of them to a dot and the link would open nothing.
const urlOf = (v, max = 2000) => (typeof v === 'string' && v.length <= max && /^https?:\/\/[^\s]+$/.test(v) ? v : null);
const idOf = (v, max = 120) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v) ? v : null);
const bool = (v) => v === true;
const when = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ---- what each answer keeps ----
const pickAccounts = (j) => ({
  accounts: arr(rec(j).connections).map((c) => ({
    id: idOf(c.id, 120),
    provider: refOf(c.provider, 80),
    name: str(c.displayName || c.name || c.email, 120) || 'Account',
    email: str(c.email, 120),
    on: c.isActive !== false,
    status: str(c.testStatus, 40),
    lastTested: when(c.lastTested),
    lastError: str(c.lastError, 300),
    errorCode: str(String(c.errorCode ?? ''), 40) || null,
    limitedUntil: when(c.rateLimitedUntil),
    authType: str(c.authType, 20),
  })).filter((a) => a.id),
});
const pickTest = (j) => ({ valid: bool(rec(j).valid), error: str(rec(j).error, 300), testedAt: when(rec(j).testedAt), latencyMs: Number.isFinite(rec(j).latencyMs) ? rec(j).latencyMs : null });
const pickLimits = (j) => {
  const out = {};
  for (const [id, c] of Object.entries(rec(rec(j).caches))) {
    const q = rec(rec(c).quotas);
    out[id] = {
      plan: str(rec(c).plan, 60),
      message: str(rec(c).message, 200),
      fetchedAt: when(rec(c).fetchedAt),
      windows: Object.entries(q).map(([name, w]) => {
        const left = Number.isFinite(rec(w).remainingPercentage) ? rec(w).remainingPercentage
          : Number.isFinite(rec(w).remaining) && Number.isFinite(rec(w).total) && rec(w).total > 0 ? (rec(w).remaining / rec(w).total) * 100 : null;
        return { name: str(name, 60), percentLeft: left === null ? null : Math.max(0, Math.min(100, Math.round(left))), resetsAt: when(rec(w).resetAt) };
      }),
    };
  }
  return { limits: out };
};
const pickOneLimit = (j) => ({ plan: str(rec(j).plan, 60), message: str(rec(j).message, 200), ...pickLimits({ caches: { one: j } }).limits.one });
const modelName = (m) => (typeof m === 'string' ? m : rec(m).model || rec(m).name || rec(m).id || '');
const pickCombos = (j) => ({
  combos: arr(rec(j).combos).map((c) => ({ id: idOf(c.id, 120), name: str(c.name, 100), strategy: str(c.strategy, 40), models: arr(c.models).map((m) => refOf(String(modelName(m)), 120)).filter(Boolean).slice(0, 20) })).filter((c) => c.id),
});
const pickOptions = (j) => ({
  providers: arr(rec(j).providers).map((p) => ({
    id: refOf(p.providerId, 80),
    name: str(p.displayName || p.providerId, 80),
    active: Number.isFinite(p.activeConnectionCount) ? p.activeConnectionCount : 0,
    models: arr(p.models).map((m) => ({ id: refOf(m.id, 160), qualified: refOf(m.qualifiedModel || m.id, 200), name: str(m.name || m.id, 160) })).filter((m) => m.qualified),
  })).filter((p) => p.id),
});
const pickKeys = (j) => ({ keys: arr(rec(j).keys).map((k) => ({ id: idOf(k.id, 120), name: str(k.name, 200), manage: arr(k.scopes).some((s) => s === 'manage' || s === 'admin'), createdAt: when(k.createdAt) })).filter((k) => k.id) });
// A made thing: the answer itself, or wrapped as { connection } or { combo }.
const pickMade = (j) => {
  const o = rec(rec(j).connection || rec(j).combo || j);
  return { id: idOf(o.id, 120), name: str(o.name, 200) };
};
const pickMessage = (j) => ({ message: str(rec(j).message, 200) });
const pickCatalog = (j) => {
  const list = Array.isArray(j) ? j : arr(rec(j).providers || rec(j).catalog || rec(j).items);
  const FLOWS = ['api-key', 'device-code', 'link-and-paste', 'own-page'];
  return {
    providers: list.map((e) => ({
      id: str(rec(e).id, 80), name: str(rec(e).name, 100), category: str(rec(e).category, 60), authHint: str(rec(e).authHint, 200), apiHint: str(rec(e).apiHint, 200),
      website: typeof rec(e).website === 'string' && /^https:\/\//.test(e.website) ? e.website.slice(0, 200) : null,
      flow: FLOWS.includes(rec(e).flow) ? e.flow : 'own-page',
    })).filter((e) => e.id && /^[a-z0-9][a-z0-9-]*$/.test(e.id) && e.name),
  };
};
// The gateway sign-in state (a public route of its own): only these three yes-or-no answers are kept. Its hasPassword is named
// signInSet here: the filter above drops any field with "password" in its name.
const pickSignIn = (j) => ({ requireLogin: rec(j).requireLogin === true, signInSet: rec(j).hasPassword === true, oidcEnabled: rec(j).oidcEnabled === true });
const pickLink = (j) => ({ url: urlOf(rec(j).url || rec(j).link || rec(j).href, 600) });
// For Hoprig's own use only (never returned to a page): what a sign-in act needs to go on.
const pickDevice = (j) => ({ userCode: str(rec(j).user_code, 60), link: urlOf(rec(j).verification_uri_complete || rec(j).verification_uri, 500), deviceCode: typeof rec(j).device_code === 'string' ? j.device_code : null, codeVerifier: typeof rec(j).codeVerifier === 'string' ? j.codeVerifier : null, interval: Number.isFinite(rec(j).interval) ? j.interval : 5, expiresIn: Number.isFinite(rec(j).expires_in) ? j.expires_in : 600, extraData: rec(j).extraData ?? null });
const pickAuthorize = (j) => ({ authUrl: urlOf(rec(j).authUrl, 2000), state: typeof rec(j).state === 'string' ? j.state : null, codeVerifier: typeof rec(j).codeVerifier === 'string' ? j.codeVerifier : null, redirectUri: str(rec(j).redirectUri, 500), supported: rec(j).supported !== false, error: str(rec(j).error, 300) });
const pickPoll = (j) => ({ success: bool(rec(j).success), pending: bool(rec(j).pending), error: str(rec(j).error, 100), description: str(rec(j).errorDescription, 300) });
const pickConnected = (j) => ({ success: rec(j).success !== false, id: idOf(rec(rec(j).connection).id, 120) });
const pickMadeKey = (j) => ({ id: idOf(rec(j).id, 120), key: typeof rec(j).key === 'string' ? j.key : null });

/**
 * The list of what may be sent. `inner`: the answer is for Hoprig's own use and is never returned by a route (it holds
 * what a sign-in act needs). `secret`: the answer holds a credential: only `withManageKey` may send it.
 * `bearer`: the route refuses the command token (it takes a session or a key with the manage scope).
 * `plain`: a public route of the gateway: it is asked with no token and no key at all.
 */
export const ALLOWED = [
  { id: 'accounts', method: 'GET', re: /^\/api\/providers(\?limit=\d{1,4})?$/, pick: pickAccounts },
  { id: 'add-key', method: 'POST', re: /^\/api\/providers$/, pick: pickMade },
  { id: 'accounts-off', method: 'PATCH', re: /^\/api\/providers$/, pick: pickMessage },
  { id: 'account-remove', method: 'DELETE', re: new RegExp(`^/api/providers/${ID}$`), pick: pickMessage },
  { id: 'account-test', method: 'POST', re: new RegExp(`^/api/providers/${ID}/test$`), pick: pickTest, ms: 30_000 },
  { id: 'catalog', method: 'GET', re: /^\/api\/providers\/catalog$/, pick: pickCatalog },
  { id: 'limits', method: 'GET', re: /^\/api\/usage\/provider-limits$/, pick: pickLimits },
  { id: 'limit-live', method: 'GET', re: new RegExp(`^/api/usage/${ID}$`), pick: pickOneLimit, ms: 20_000 },
  { id: 'combos', method: 'GET', re: /^\/api\/combos$/, pick: pickCombos },
  { id: 'combo-make', method: 'POST', re: /^\/api\/combos$/, pick: pickMade },
  { id: 'combo-remove', method: 'DELETE', re: new RegExp(`^/api/combos/${ID}$`), pick: pickMessage },
  { id: 'combo-options', method: 'GET', re: /^\/api\/combos\/builder\/options$/, pick: pickOptions },
  { id: 'keys', method: 'GET', re: /^\/api\/keys$/, pick: pickKeys },
  { id: 'key-remove', method: 'DELETE', re: new RegExp(`^/api/keys/${ID}$`), pick: pickMessage },
  { id: 'key-make', method: 'POST', re: /^\/api\/keys$/, pick: pickMadeKey, secret: true },
  { id: 'sign-in-state', method: 'GET', re: /^\/api\/settings\/require-login$/, pick: pickSignIn, plain: true },
  { id: 'open-link', method: 'POST', re: /^\/api\/auth\/link$/, pick: pickLink },
  { id: 'device-code', method: 'GET', re: new RegExp(`^/api/oauth/${PROVIDER}/device-code$`), pick: pickDevice, inner: true, bearer: true, ms: 20_000 },
  { id: 'device-poll', method: 'POST', re: new RegExp(`^/api/oauth/${PROVIDER}/poll$`), pick: pickPoll, bearer: true, ms: 20_000 },
  { id: 'authorize', method: 'GET', re: new RegExp(`^/api/oauth/${PROVIDER}/authorize\\?redirect_uri=[A-Za-z0-9%._~:/-]{1,300}$`), pick: pickAuthorize, inner: true, bearer: true },
  { id: 'exchange', method: 'POST', re: new RegExp(`^/api/oauth/${PROVIDER}/exchange$`), pick: pickConnected, bearer: true, ms: 20_000 },
];

const find = (method, path) => ALLOWED.find((e) => e.method === method && e.re.test(path));

const sentenceFor = (entry, status, body, port) => {
  const said = plain(typeof rec(body).error === 'string' ? body.error : rec(rec(body).error).message || rec(body).message || '', 200);
  if (status === 401 || status === 403) {
    return entry.bearer
      ? 'TRouteAI refused the temporary sign-in key Hoprig made for this step. Try again; if it keeps refusing, use TRouteAI\'s own page.'
      : 'TRouteAI did not accept Hoprig\'s command token. It accepts it only from the user who runs TRouteAI, with the same data folder: start TRouteAI from Hoprig (Providers → TRouteAI) and try again.';
  }
  if (status === 404) return said && !/^not found$/i.test(said) ? said : 'This TRouteAI has no such thing (an older version?).';
  if (status === 400 || status === 409 || status === 422) return said || 'TRouteAI did not accept that.';
  if (status === 429) return 'TRouteAI is busy: try again in a moment.';
  return `TRouteAI answered with an error (HTTP ${status})${said ? `: ${said}` : ''}.`.replace(/\.\.$/, '.');
};

/**
 * The one call (a short time limit: 10 s, 20 to 30 s for a test or a sign-in step that asks the provider). `opts`: { port, body, bearer (a key for a bearer-only route), folder (the data folder), deps }.
 * → the filtered answer, or throws a ManageError with one plain sentence. `deps` (tests): fetch, sameUser, token, timeoutMs.
 */
export async function callGateway(method, path, opts = {}) {
  const entry = find(method, path);
  if (!entry) throw new ManageError('Hoprig does not send that to TRouteAI.', 500, 'not-allowed');
  if (entry.secret && !opts.allowSecret) throw new ManageError('Hoprig does not send that to TRouteAI.', 500, 'not-allowed');
  const deps = opts.deps || {};
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ManageError('TRouteAI\'s port is not a usable number.', 500, 'port');
  const who = await (deps.sameUser || sameUserListener)(port);
  if (who === 'none') throw new ManageError(`TRouteAI is not running on this computer (nothing answers on port ${port}). Start it first: Providers → TRouteAI, Start.`, 409, 'down');
  if (who !== 'own') throw new ManageError(`A program that is not yours listens on port ${port}, so Hoprig sends it nothing. Stop it, or start TRouteAI on another port.`, 409, 'foreign');
  const headers = { accept: 'application/json' };
  if (entry.bearer) {
    if (typeof opts.bearer !== 'string' || !opts.bearer) throw new ManageError('This step needs a temporary sign-in key.', 500, 'internal');
    headers.authorization = `Bearer ${opts.bearer}`;
  } else if (!entry.plain) {
    const token = (deps.token || commandToken)(opts.folder || dataFolder());
    if (!token) {
      const folder = opts.folder || dataFolder();
      if (!fs.existsSync(nodePath.join(folder, 'cli-token'))) {
        const { GATEWAY_PIN } = await import('../addons/gateways.mjs');
        throw new ManageError(`TRouteAI runs, but it has no command token file: the program that runs is older than ${GATEWAY_PIN} (the first that writes it), or it was started before it was updated. Next step: if the copy on this computer is older than ${GATEWAY_PIN}, press Update (Providers → TRouteAI), then press Restart there, so the copy on this computer runs.`, 409, 'token');
      }
      throw new ManageError('Hoprig cannot read TRouteAI\'s command token (others can read its file, or it is not yours, or it is not a token). Start TRouteAI once from Hoprig as this user, then try again.', 409, 'token');
    }
    headers['x-trouteai-cli-token'] = token;
  }
  let body;
  if (opts.body !== undefined && method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res;
  let text;
  try {
    res = await (deps.fetch || fetch)(`http://127.0.0.1:${port}${path}`, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs || entry.ms || TIME_MS) });
    text = (await res.text()).slice(0, BODY_MAX);
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ManageError(`TRouteAI did not answer in time (${Math.round((deps.timeoutMs || entry.ms || TIME_MS) / 1000)} seconds). Try again in a moment.`, 504, 'slow');
    throw new ManageError(`TRouteAI does not answer on port ${port}. Start it first: Providers → TRouteAI, Start.`, 409, 'down');
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status >= 300) {
    const err = new ManageError(sentenceFor(entry, res.status, json, port), res.status === 404 ? 404 : res.status >= 500 ? 502 : 409, res.status === 404 ? 'absent' : 'refused');
    err.upstream = res.status;
    throw err;
  }
  const kept = entry.pick(json);
  return entry.inner || entry.secret ? kept : scrub(kept);
}

/**
 * Run `fn(callWithKey)` with a key that has the manage scope, made for this one act and removed right after, also when
 * `fn` throws. `callWithKey(method, path, body)` sends a bearer-only route with it. A key that could not be removed is
 * said (the thrown or returned error carries `leftKey`: its name), never kept.
 */
export async function withManageKey(opts, fn) {
  const name = `Hoprig sign-in step ${Date.now().toString(36)}`;
  const made = await callGateway('POST', '/api/keys', { ...opts, allowSecret: true, body: { name, scopes: ['manage'] } });
  if (!made.id || !made.key) throw new ManageError('TRouteAI did not make the temporary sign-in key.', 502, 'refused');
  let out;
  let failed = null;
  try {
    out = await fn((method, path, body) => callGateway(method, path, { ...opts, bearer: made.key, body }));
  } catch (e) {
    failed = e;
  }
  try {
    await callGateway('DELETE', `/api/keys/${encodeURIComponent(made.id)}`, opts);
  } catch {
    const left = new ManageError(`A temporary sign-in key named "${name}" could not be removed: remove it under Keys.`, 502, 'left-key');
    left.leftKey = name;
    if (!failed) failed = left;
    else failed.leftKey = name;
  }
  if (failed) throw failed;
  return out;
}
