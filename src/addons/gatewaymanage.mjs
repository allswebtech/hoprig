// The shipped gateway managed in Hoprig's own pages: its accounts with their limits, Add (by a pasted key, by a code, by a link and
// the address pasted back), its combos, the keys Hoprig made, and its own page opened signed in. Every act goes through
// the one allowlisted client (src/gateway/trouteaimanage.mjs); only the shipped gateway is managed this way, a gateway
// the owner defined himself keeps its link out. For the owner's own page or a linked main computer (its token, relayed
// at /m/<name>/…), never for Tia's door and never for a coding session (caller 'self' is refused on every route).
//
//   GET  /api/gatewayhost/<id>/accounts            { computer, accounts: [{ id, provider, name, email, on, state, says,
//                                                      lastTested, limitedUntil }] }   state: ok | off | limited | error | new
//   GET  /api/gatewayhost/<id>/limits[?account=id] { limits: { <account id>: { plan, message, windows: [{ name,
//                                                      percentLeft, resetsAt }] } } }  cached; with ?account= read live
//   POST /api/gatewayhost/<id>/accounts/<id>/(test|remove) { confirm }       test: { valid, says }
//   POST /api/gatewayhost/<id>/accounts/<id>/on { confirm, on }
//   GET  /api/gatewayhost/<id>/providers           { catalog: true, providers: [{ id, name, category, authHint, apiHint,
//                                                      website, flow }] } or { catalog: false, sentence }
//   POST /api/gatewayhost/<id>/add/key { confirm, provider, name, apiKey }   { id, valid, says }  (key: never returned)
//   POST /api/gatewayhost/<id>/add/code { confirm, provider }                { ticket, userCode, link, interval, expiresIn }
//   POST /api/gatewayhost/<id>/add/poll { confirm, ticket }                  { pending } | { done, id } (sent while its sheet is open)
//   POST /api/gatewayhost/<id>/add/link { confirm, provider }                { ticket, link }
//   POST /api/gatewayhost/<id>/add/finish { confirm, ticket, address }       { done, id }
//   POST /api/gatewayhost/<id>/add/cancel { confirm, ticket }
//   GET  /api/gatewayhost/<id>/combos              { combos: [{ id, name, strategy, models }] }
//   GET  /api/gatewayhost/<id>/combos/options?name=<model>   { providers: [{ id, name, models }], suggested: [qualified] }
//   POST /api/gatewayhost/<id>/combos/make { confirm, name, models? }        { id, name, models }
//   POST /api/gatewayhost/<id>/combos/<id>/remove { confirm }
//   GET  /api/gatewayhost/<id>/keys                { keys: [{ id, name }] }   only the keys Hoprig made
//   POST /api/gatewayhost/<id>/keys/<id>/remove { confirm }
//   POST /api/gatewayhost/<id>/open { confirm }    { url } (a one-time sign-in link) or { url: null }
//
// `confirm` is this computer's name, as in gatewayhost.mjs. Nothing runs by itself: a look happens when a page opens or
// a person presses, and a sign-in code's poll is the page's, while its sheet is open. What Add keeps between two steps
// (a code's device code, a link's verifier) is kept here in memory under a ticket and never sent to a page.
import { randomBytes } from 'node:crypto';
import { callGateway, ManageError, plain, withManageKey } from '../gateway/trouteaimanage.mjs';
import { dataFolder } from '../gateway/trouteaibase.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { gatewayAddons } from './gateways.mjs';

const OWN_PAGE = 'This gateway cannot list its providers for Hoprig yet (an older version), so Add opens the gateway\'s own page.';
const KEY_NAME = /^Hoprig\b/;
const REDIRECT = 'http://localhost:8080/callback';
const TICKETS_MAX = 4;

/** The words for an account's last error, in plain terms. */
export function errorWords(text, code) {
  const t = String(text || '');
  const c = String(code || '');
  if (!t && !c) return null;
  if (/\b(401|403)\b|invalid.{0,12}(key|token|credential)|unauthori[sz]ed|expired|revoked|forbidden/i.test(`${t} ${c}`)) return 'The provider refused the key or the sign-in. Add the account again.';
  if (/\b429\b|rate.?limit|quota|too many|limit (is )?reached|exhausted/i.test(`${t} ${c}`)) return 'The provider says its limit is reached.';
  if (/ENOTFOUND|ECONN|ETIMEDOUT|timed? ?out|network|fetch failed|unreachable/i.test(t)) return 'Hoprig could not reach the provider.';
  return plain(t, 160) || null;
}

/** One account of the gateway's list, with its state in a word and its trouble in a sentence. */
export function accountView(a, now = Date.now()) {
  const limited = a.limitedUntil && a.limitedUntil > now;
  const bad = a.lastError || ['error', 'expired', 'unavailable', 'failed'].includes(String(a.status || '').toLowerCase());
  const state = !a.on ? 'off' : limited ? 'limited' : bad ? 'error' : ['active', 'success', 'ok'].includes(String(a.status || '').toLowerCase()) ? 'ok' : 'new';
  return { id: a.id, provider: a.provider, name: a.name, email: a.email, on: a.on, state, says: state === 'limited' ? 'Its limit is reached for now.' : state === 'error' ? errorWords(a.lastError, a.errorCode) || 'The last test failed.' : null, lastTested: a.lastTested, limitedUntil: limited ? a.limitedUntil : null };
}

export function gatewayManageFeature(ctx, opts = {}) {
  const list = opts.addons || (() => gatewayAddons());
  const name = opts.computer || (() => defaultHubLabel());
  const call = opts.call || callGateway;
  const keyed = opts.withKey || withManageKey;
  const folderOf = opts.folder || (() => dataFolder()); // the one data folder rule, as the start line and Set up use it
  const now = opts.now || Date.now;
  const tickets = new Map();
  const fail = (status, message, extra = {}) => Object.assign(new ctx.HttpError(status, message), extra);
  const URLS = '[a-z][a-z0-9-]{0,30}';
  const ID = '([A-Za-z0-9_-]{1,120})';

  const refuseSelf = (req) => {
    if (ctx.caller && ctx.caller(req) === 'self') throw fail(403, 'The gateway\'s accounts, combos and keys are managed only by its owner, on the page');
  };
  /** The shipped gateway and its call options, or a 404 for another. */
  function target(id) {
    const a = list().find((x) => x.id === id);
    if (!a || a.defined === true || !a.gateway) throw fail(404, 'Hoprig manages only the gateway it installs; a gateway you added yourself keeps its own page.');
    return { addon: a, opts: { port: Number(a.gateway.port()), folder: folderOf(a), deps: opts.deps } };
  }
  const run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ManageError) throw fail(e.status === 404 ? 404 : e.status === 504 ? 504 : e.status >= 500 ? 502 : 409, e.message, { details: { code: e.code, ...(e.leftKey ? { leftKey: e.leftKey } : {}) } });
      throw e;
    }
  };
  async function get(req, id) {
    refuseSelf(req);
    return target(id);
  }
  async function post(req, id) {
    refuseSelf(req);
    const b = await ctx.readJson(req);
    if (typeof b.confirm !== 'string' || b.confirm !== name()) throw Object.assign(fail(400, `confirm it for this computer: send confirm with its name (${name()})`), { details: { code: 'confirm' } });
    return { b, ...target(id) };
  }
  const sId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : null);
  const provId = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(v) ? v : null);
  const needProvider = (b) => provId(b.provider) || (() => { throw fail(400, 'say which provider to add'); })();

  /** The catalog when the gateway answers it, else null (an older version). */
  const catalogOf = async (o) => {
    try {
      const c = await call('GET', '/api/providers/catalog', o);
      return c.providers.length ? c.providers : null;
    } catch (e) {
      if (e instanceof ManageError && e.code === 'absent') return null;
      throw e;
    }
  };
  const flowOf = async (o, provider) => (await catalogOf(o))?.find((p) => p.id === provider)?.flow || null;
  const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) ? u : null);

  function keep(t) {
    for (const [k, v] of tickets) if (v.until < now()) tickets.delete(k);
    while (tickets.size >= TICKETS_MAX) tickets.delete(tickets.keys().next().value);
    const id = randomBytes(12).toString('hex');
    tickets.set(id, t);
    return id;
  }
  const ticketOf = (b, kind) => {
    const t = typeof b.ticket === 'string' ? tickets.get(b.ticket) : null;
    if (!t || t.kind !== kind) throw fail(410, 'This step is over. Start the sign-in again.');
    if (t.until < now()) {
      tickets.delete(b.ticket);
      throw fail(410, 'This step ran out of time. Start the sign-in again.');
    }
    return t;
  };

  return {
    name: 'gatewaymanage',
    routes: [
      ['GET', new RegExp(`^/api/gatewayhost/(${URLS})/accounts$`), async (req, m) => {
        const { opts: o } = await get(req, m[1]);
        const r = await run(() => call('GET', '/api/providers', o));
        return { computer: name(), accounts: r.accounts.map((a) => accountView(a, now())) };
      }],
      ['GET', new RegExp(`^/api/gatewayhost/(${URLS})/limits$`), async (req, m, q) => {
        const { opts: o } = await get(req, m[1]);
        const one = q && q.get ? q.get('account') : null;
        if (one !== null) {
          const id = sId(one) || (() => { throw fail(400, 'say which account'); })();
          const r = await run(() => call('GET', `/api/usage/${id}`, o));
          return { limits: { [id]: { plan: r.plan, message: r.message, fetchedAt: now(), windows: r.windows } } };
        }
        return run(() => call('GET', '/api/usage/provider-limits', o));
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/accounts/${ID}/test$`), async (req, m) => {
        const { opts: o } = await post(req, m[1]);
        const r = await run(() => call('POST', `/api/providers/${m[2]}/test`, { ...o, body: {} }));
        return { valid: r.valid, says: r.valid ? null : errorWords(r.error) || 'The test failed.' };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/accounts/${ID}/on$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        if (typeof b.on !== 'boolean') throw fail(400, 'say on: true or on: false');
        await run(() => call('PATCH', '/api/providers', { ...o, body: { ids: [m[2]], isActive: b.on } }));
        return { ok: true, on: b.on };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/accounts/${ID}/remove$`), async (req, m) => {
        const { opts: o } = await post(req, m[1]);
        await run(() => call('DELETE', `/api/providers/${m[2]}`, o));
        return { ok: true };
      }],
      ['GET', new RegExp(`^/api/gatewayhost/(${URLS})/providers$`), async (req, m) => {
        const { opts: o } = await get(req, m[1]);
        const providers = await run(() => catalogOf(o));
        return providers ? { catalog: true, providers } : { catalog: false, sentence: OWN_PAGE };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/add/key$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        const provider = needProvider(b);
        const key = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
        if (!key || key.length > 4000 || /[\s\x00-\x1f]/.test(key)) throw fail(400, 'Paste the key as it is, on one line, without spaces.'); // eslint-disable-line no-control-regex
        const label = typeof b.name === 'string' && b.name.trim() ? plain(b.name, 100) : provider;
        const flow = await run(() => flowOf(o, provider));
        if (flow && flow !== 'api-key') throw fail(409, 'This provider does not take a pasted key here: choose its sign-in instead.');
        const made = await run(() => call('POST', '/api/providers', { ...o, body: { provider, apiKey: key, name: label } }));
        if (!made.id) return { id: null, valid: null, says: 'The gateway added it, but gave no number to test it with. Open the list and press Test.' };
        const t = await run(() => call('POST', `/api/providers/${made.id}/test`, { ...o, body: {} }));
        return { id: made.id, valid: t.valid, says: t.valid ? null : errorWords(t.error) || 'The test failed.' };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/add/code$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        const provider = needProvider(b);
        const flow = await run(() => flowOf(o, provider));
        if (flow && flow !== 'device-code') throw fail(409, 'This provider does not sign in with a code.');
        const d = await run(() => keyed(o, (send) => send('GET', `/api/oauth/${provider}/device-code`)));
        const link = https(d.link);
        if (!d.deviceCode || !d.userCode || !link) throw fail(409, 'The gateway did not give a code and a link for this provider. Use its own page.');
        const until = now() + Math.min(d.expiresIn, 900) * 1000;
        const ticket = keep({ kind: 'code', provider, deviceCode: d.deviceCode, codeVerifier: d.codeVerifier, extraData: d.extraData, until, next: 0, every: Math.max(3, d.interval) * 1000 });
        return { ticket, userCode: d.userCode, link, interval: Math.max(3, d.interval), expiresIn: Math.round((until - now()) / 1000) };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/add/poll$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        const t = ticketOf(b, 'code');
        if (now() < t.next) return { pending: true };
        t.next = now() + t.every;
        const body = { deviceCode: t.deviceCode, ...(t.codeVerifier ? { codeVerifier: t.codeVerifier } : {}), ...(t.extraData ? { extraData: t.extraData } : {}) };
        const r = await run(() => keyed(o, (send) => send('POST', `/api/oauth/${t.provider}/poll`, body)));
        if (r.success) {
          tickets.delete(b.ticket);
          return { done: true };
        }
        if (r.pending || r.error === 'slow_down') {
          if (r.error === 'slow_down') t.every += 5000;
          return { pending: true };
        }
        tickets.delete(b.ticket);
        throw fail(409, plain(r.description || r.error || 'The sign-in did not finish.', 200));
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/add/link$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        const provider = needProvider(b);
        const flow = await run(() => flowOf(o, provider));
        if (flow && flow !== 'link-and-paste') throw fail(409, 'This provider does not sign in with a link.');
        const a = await run(() => keyed(o, (send) => send('GET', `/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}`)));
        const link = https(a.authUrl);
        if (!link || a.supported === false || !a.codeVerifier && !a.state) throw fail(409, a.error || 'The gateway gave no sign-in link for this provider. Use its own page.');
        const ticket = keep({ kind: 'link', provider, codeVerifier: a.codeVerifier, state: a.state, redirectUri: a.redirectUri || REDIRECT, until: now() + 15 * 60_000 });
        return { ticket, link };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/add/finish$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        const t = ticketOf(b, 'link');
        const text = typeof b.address === 'string' ? b.address.trim() : '';
        if (!text || text.length > 4000) throw fail(400, 'Paste the address the browser ended on after you signed in.');
        let code = null;
        let state = null;
        try {
          const u = new URL(text);
          code = u.searchParams.get('code');
          state = u.searchParams.get('state');
        } catch {
          code = /^[\w.~%-]{6,2000}$/.test(text) ? text : null; // a bare code
        }
        if (!code) throw fail(400, 'That address has no code in it. Paste the whole address of the page the browser ended on.');
        if (state && t.state && state !== t.state) throw fail(409, 'That address belongs to another sign-in. Start again and paste the new one.');
        await run(() => keyed(o, (send) => send('POST', `/api/oauth/${t.provider}/exchange`, { code, redirectUri: t.redirectUri, ...(t.codeVerifier ? { codeVerifier: t.codeVerifier } : {}), ...(t.state ? { state: t.state } : {}) })));
        tickets.delete(b.ticket);
        return { done: true };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/add/cancel$`), async (req, m) => {
        const { b } = await post(req, m[1]);
        if (typeof b.ticket === 'string') tickets.delete(b.ticket);
        return { ok: true };
      }],
      ['GET', new RegExp(`^/api/gatewayhost/(${URLS})/combos$`), async (req, m) => {
        const { opts: o } = await get(req, m[1]);
        return run(() => call('GET', '/api/combos', o));
      }],
      ['GET', new RegExp(`^/api/gatewayhost/(${URLS})/combos/options$`), async (req, m, q) => {
        const { opts: o } = await get(req, m[1]);
        const want = String((q && q.get && q.get('name')) || '').trim().toLowerCase();
        const r = await run(() => call('GET', '/api/combos/builder/options', o));
        const providers = r.providers.filter((p) => p.active > 0 && p.models.length);
        const suggested = want ? providers.flatMap((p) => p.models).filter((x) => [x.id, x.qualified, x.name].some((n) => String(n).toLowerCase() === want || String(n).toLowerCase().endsWith(`/${want}`))).map((x) => x.qualified) : [];
        return { providers, suggested };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/combos/make$`), async (req, m) => {
        const { b, opts: o } = await post(req, m[1]);
        const comboName = typeof b.name === 'string' ? b.name.trim() : '';
        if (!/^[a-zA-Z0-9_/.\-[\] ]{1,100}$/.test(comboName)) throw fail(400, 'A combo\'s name has letters, digits, spaces and - _ / . [ ] only, up to 100.');
        const r = await run(() => call('GET', '/api/combos/builder/options', o));
        const known = new Set(r.providers.filter((p) => p.active > 0).flatMap((p) => p.models.map((x) => x.qualified)));
        let models = Array.isArray(b.models) ? b.models.filter((x) => typeof x === 'string') : [];
        if (!models.length) models = r.providers.filter((p) => p.active > 0).flatMap((p) => p.models).filter((x) => [x.id, x.name].some((n) => String(n).toLowerCase() === comboName.toLowerCase())).map((x) => x.qualified);
        if (!models.length) throw fail(409, `No account of the gateway offers a model called ${comboName}. Choose the models the combo should send to.`, { details: { code: 'pick' } });
        const bad = models.find((x) => !known.has(x));
        if (bad) throw fail(409, `${plain(bad, 80)} is not offered by an account that is on.`);
        const made = await run(() => call('POST', '/api/combos', { ...o, body: { name: comboName, models, strategy: 'priority' } }));
        return { id: made.id, name: comboName, models };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/combos/${ID}/remove$`), async (req, m) => {
        const { opts: o } = await post(req, m[1]);
        await run(() => call('DELETE', `/api/combos/${m[2]}`, o));
        return { ok: true };
      }],
      ['GET', new RegExp(`^/api/gatewayhost/(${URLS})/keys$`), async (req, m) => {
        const { opts: o } = await get(req, m[1]);
        const r = await run(() => call('GET', '/api/keys', o));
        return { keys: r.keys.filter((k) => KEY_NAME.test(k.name || '')).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt })) };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/keys/${ID}/remove$`), async (req, m) => {
        const { opts: o } = await post(req, m[1]);
        const r = await run(() => call('GET', '/api/keys', o));
        const k = r.keys.find((x) => x.id === m[2]);
        if (!k || !KEY_NAME.test(k.name || '')) throw fail(409, 'Hoprig removes only the keys it made itself. Other keys are removed in the gateway\'s own page.');
        await run(() => call('DELETE', `/api/keys/${m[2]}`, o));
        return { ok: true };
      }],
      ['POST', new RegExp(`^/api/gatewayhost/(${URLS})/open$`), async (req, m) => {
        const { opts: o } = await post(req, m[1]);
        let r = null;
        try {
          r = await call('POST', '/api/auth/link', { ...o, body: {} });
        } catch (e) {
          if (!(e instanceof ManageError) || e.code !== 'absent') throw e instanceof ManageError ? fail(e.status >= 500 ? 502 : 409, e.message, { details: { code: e.code } }) : e;
        }
        // Only a link to this computer's own gateway: its address and port, over http.
        let url = null;
        try {
          const u = new URL(r?.url || '');
          if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && Number(u.port) === o.port) url = u.href;
        } catch {
          url = null;
        }
        return { url };
      }],
    ],
  };
}
