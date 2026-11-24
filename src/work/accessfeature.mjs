// Settings → Work → "Another program": the owner's routes for Work tokens, webhooks and their limits (access.mjs).
//
//   GET  /api/work/access                                      { tokens, webhooks, limits } (never a hash or a secret)
//   POST /api/work/access/tokens { name, confirmed? }          make a token: first the question, then with
//                                                              `confirmed: true` { token: { id, name, created }, secret }
//   POST /api/work/access/tokens/revoke { id }                 revoke it (its webhooks go with it)
//   POST /api/work/access/webhooks { token, url, events, ownNetwork?, answer?, confirmed? }
//                                                              add one: the question names the address; then { webhook, secret }
//   POST /api/work/access/webhooks/remove { id }
//   POST /api/work/access/limits { perMinute?, perDay? }
//
// Only the page's own request with the owner's sign-in (caller "page"): Tia (her door refuses these routes, and
// in-process she is caller "self"), another computer's link or machine token (caller "computer") and a Work token (its
// own door, tokenfeature.mjs) are refused on every one of them, also the list. The token and the secret are in the
// answer of the one confirmed request only.
import { addWebhook, checkHook, checkRoom, listWebhooks, listWorkTokens, removeWebhook, revokeWorkToken, setWorkLimits, workLimits, createWorkToken, EVENTS } from './access.mjs';
import { resolveHook } from './hookaddr.mjs';
import { tokenName } from '../machines/names.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, details: { code } });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (b, allowed) => {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object', 'bad-request');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`, 'bad-request');
};
export const EVENT_WORDS = { done: 'task done', result: 'result ready', 'needs-you': 'needs you' };
// The same events inside the question's sentence ("when a task … is done, has its result ready or needs you").
const EVENT_PHRASE = { done: 'is done', result: 'has its result ready', 'needs-you': 'needs you' };
const orList = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`);
const ID = /^[0-9a-f]{12}$/;

/** o: { sctx (the server's ctx), readJson, ownerOnly (Work's refusal of Tia's token), hooks (hooks.mjs: poked after a change), lookup? }. → routes. */
export function accessRoutes(o) {
  const pageOnly = (req) => {
    if (o.ownerOnly) o.ownerOnly(req); // Tia's token, refused by the route itself as every Work route does
    // No way to tell who sent it: refused, never taken for the page.
    if (!o.sctx.caller || o.sctx.caller(req) !== 'page') throw fail(403, 'Work tokens and webhooks are made, listed and revoked only on this dashboard\'s own page, by you', 'owner-page');
  };
  const confirmedOf = (b) => {
    if (b.confirmed !== undefined && b.confirmed !== true) throw fail(400, 'confirmed is true or left out', 'bad-request');
    return b.confirmed === true;
  };
  const poke = () => {
    try {
      o.hooks && o.hooks.poke();
    } catch {
      /* the deliveries look again on their own */
    }
  };
  const view = () => ({ tokens: listWorkTokens(), webhooks: listWebhooks(), limits: workLimits(), events: EVENTS.map((e) => ({ id: e, words: EVENT_WORDS[e] })) });
  return [
    ['GET', /^\/api\/work\/access$/, async (req) => {
      pageOnly(req);
      return view();
    }],
    ['POST', /^\/api\/work\/access\/tokens$/, async (req) => {
      pageOnly(req);
      const b = await o.readJson(req);
      keys(b, ['name', 'confirmed']);
      const name = tokenName(b.name);
      if (!name) throw fail(400, 'the name is 1 to 60 letters, digits, spaces or ._@()-', 'bad-name');
      if (listWorkTokens().some((t) => t.name === name)) throw fail(409, `a Work token is named "${name}" already: choose another name`, 'name-taken');
      const confirmed = confirmedOf(b);
      checkRoom('token'); // a 51st is refused before the question, not after the yes
      if (!confirmed) {
        return { confirm: `Make a Work token named "${name}"? A program that has it can add tasks to your Work list and read the tasks it added and their results, and nothing else. It is shown once: copy it into that program.` };
      }
      const t = createWorkToken(name);
      return { token: { id: t.id, name: t.name, created: t.created }, secret: t.token };
    }],
    ['POST', /^\/api\/work\/access\/tokens\/revoke$/, async (req) => {
      pageOnly(req);
      const b = await o.readJson(req);
      keys(b, ['id']);
      if (typeof b.id !== 'string' || !ID.test(b.id)) throw fail(400, 'give the id of a Work token', 'bad-request');
      const gone = revokeWorkToken(b.id);
      if (!gone.length) throw fail(404, 'there is no such Work token (revoked already?)', 'not-found');
      poke();
      return { revoked: gone, ...view() };
    }],
    ['POST', /^\/api\/work\/access\/webhooks$/, async (req) => {
      pageOnly(req);
      const b = await o.readJson(req);
      keys(b, ['token', 'url', 'events', 'ownNetwork', 'answer', 'confirmed']);
      const confirmed = confirmedOf(b);
      const { confirmed: _c, ...rest } = b;
      const h = checkHook(rest);
      checkRoom('webhook');
      // The address is checked now as each delivery checks it: every address its name resolves to.
      await resolveHook(h.url, { ownNetwork: h.ownNetwork, ...(o.lookup ? { lookup: o.lookup } : {}) });
      const tname = (listWorkTokens().find((t) => t.id === h.token) || {}).name;
      if (!confirmed) {
        return {
          confirm: `Send to ${h.url} when a task that the Work token "${tname}" added ${orList(h.events.map((e) => EVENT_PHRASE[e]))}?`
            + ` Each delivery has the event, the task's id, title and state, the run's id and the time${h.answer ? ', and the session\'s answer' : ''}, signed with a secret shown once.`
            + (h.ownNetwork ? ' You marked it as on your own network: it may go to this computer or a private network.' : ''),
          url: h.url,
        };
      }
      const r = addWebhook(h);
      poke();
      return r;
    }],
    ['POST', /^\/api\/work\/access\/webhooks\/remove$/, async (req) => {
      pageOnly(req);
      const b = await o.readJson(req);
      keys(b, ['id']);
      if (typeof b.id !== 'string' || !ID.test(b.id)) throw fail(400, 'give the id of a webhook', 'bad-request');
      const gone = removeWebhook(b.id);
      if (!gone.length) throw fail(404, 'there is no such webhook', 'not-found');
      poke();
      return { removed: gone.length, ...view() };
    }],
    ['POST', /^\/api\/work\/access\/limits$/, async (req) => {
      pageOnly(req);
      const b = await o.readJson(req);
      keys(b, ['perMinute', 'perDay']);
      return { limits: setWorkLimits(b) };
    }],
  ];
}
