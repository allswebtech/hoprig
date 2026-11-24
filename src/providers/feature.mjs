// The Providers page's part for one provider: its check, its map (what sessions get, or would get with its switch on), and what is left.
//
//   GET  /api/providers/<name>/health   { check: { applies, count, last }, map: { rules }, left }: read only, sends nothing
//   POST /api/providers/<name>/check    runs "Check this provider" once (the owner's press, from his own page) → { result }
//   POST /api/providers/<name>/mend     { sends, on } puts the last check's MODELS line for that name into the provider's
//                                       MODELS, and with `on` turns the map on for its sessions in the same press (the
//                                       owner's press, from his own page) → { ok, models, on }
//   POST /api/providers/<name>/map      { on } turns the map on or off for every session and chat of this provider
//                                       (the owner's press, from his own page) → { ok, on }
//
// Only the POST sends anything to a provider, and only the owner's page may make it (not another computer's token, not
// Tia's door). No key, token or account name is in any answer: the profile's environment never leaves the server.

import { metaOf, readProfile, validName, writeProfile } from '../profiles.mjs';
import { profileUsage } from '../routerstate.mjs';
import { checkOnce, checkPlan, lastCheck } from './check.mjs';
import { leftOf } from './left.mjs';
import { claudeVersionQuick } from '../claudecode.mjs';
import { mapPreview, mapSettings } from './sessionmap.mjs';

const PRESS_GAP_MS = 10_000;
// One rule of a MODELS line the check made: a name or a glob, "=", a model name.
const RULE = /^[A-Za-z0-9*][A-Za-z0-9._:/@+\-[\]*]{0,119}=[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;

export function providersFeature(ctx, { fetchImpl = fetch, now = Date.now, version = () => claudeVersionQuick() } = {}) {
  const fail = (status, message) => new ctx.HttpError(status, message);
  const profileOr404 = (m) => {
    const name = decodeURIComponent(m[1]);
    const p = validName(name) ? readProfile(name) : null;
    if (!p) throw fail(404, 'There is no such provider');
    return p;
  };
  const pressed = new Map(); // name → when the last press began: a second press within PRESS_GAP_MS joins it

  const health = (p, req) => {
    const v = version();
    const plan = checkPlan(p, { version: v });
    // What a session WOULD get with the switch on (the page shows it rule by rule, and whether it is on).
    const map = mapPreview(p);
    // An older or unknown Claude Code takes no modelOverrides: only the small model's rule reaches its sessions, and
    // the page says so instead of listing renames the sessions never get.
    const takes = !!mapSettings(map, v).modelOverrides;
    const rules = takes ? map.rules : map.rules.filter((r) => r.by === 'small');
    return {
      name: p.name,
      // `press`: this caller may press. Another computer's page reaches this route with the hub's token, and a press
      // from there is refused (only the owner's own page sends to a provider): it is pressed on that computer's page.
      check: { applies: plan.applies, count: plan.count, last: lastCheck(p.name), press: ctx.caller(req) === 'page' },
      map: { on: p.mapSessions === true, models: !!p.models, rules: rules.slice(0, 40), version: v || null, untaken: map.rules.length - rules.length, change: ctx.caller(req) === 'page' },
      left: leftOf(p.name, profileUsage(now())[p.name] || null, now()),
    };
  };

  const routes = [
    ['GET', /^\/api\/providers\/([^/?]+)\/health$/, async (req, m) => health(profileOr404(m), req)],
    ['POST', /^\/api\/providers\/([^/?]+)\/check$/, async (req, m) => {
      if (ctx.caller(req) !== 'page') throw fail(403, 'only the owner checks a provider, from the dashboard\'s page');
      await ctx.readJson(req);
      const p = profileOr404(m);
      if (!checkPlan(p).applies) throw fail(409, `"${p.label}" signs in: there is no endpoint of its own to check`);
      const last = pressed.get(p.name) || 0;
      if (now() - last < PRESS_GAP_MS) throw fail(429, 'This provider was checked a moment ago. Wait a few seconds.');
      pressed.set(p.name, now());
      return { result: await checkOnce(p, { fetchImpl, now, version: version() }) };
    }],
    // The MODELS line of the last check, put into the provider as it was offered. Only the line the server made itself
    // is written (the page names the refused model, never the text), and only while the provider's MODELS are still
    // the ones the line was made from: a line made from other rules would drop the new ones.
    ['POST', /^\/api\/providers\/([^/?]+)\/mend$/, async (req, m) => {
      if (ctx.caller(req) !== 'page') throw fail(403, 'only the owner changes a provider\'s model map, from the dashboard\'s page');
      const b = await ctx.readJson(req);
      const p = profileOr404(m);
      const last = lastCheck(p.name);
      const row = typeof b?.sends === 'string' ? (last?.rows || []).find((r) => r.verdict === 'refused' && r.sends === b.sends && r.mend?.models) : null;
      if (!row) throw fail(404, 'The last check has no such line. Check this provider again.');
      if (typeof last.models !== 'string' || last.models !== (p.models || '')) throw fail(409, 'This provider\'s model map changed since the check. Check it again first.');
      const models = String(row.mend.models).replace(/^MODELS=/, '');
      if (!models.split(',').every((r) => RULE.test(r))) throw fail(400, 'That line is not a model map');
      // The switch only when the owner said so in the same press (`on: true`): never turned on in silence.
      const on = b.on === true ? true : p.mapSessions === true;
      writeProfile(p.name, { ...metaOf(p), models, mapSessions: on, env: p.env });
      return { ok: true, models, on };
    }],
    // The switch "Use these names for every session on this provider": only from the owner's own page (never Tia's
    // door, which calls as 'self', and never another computer's token).
    ['POST', /^\/api\/providers\/([^/?]+)\/map$/, async (req, m) => {
      if (ctx.caller(req) !== 'page') throw fail(403, 'only the owner turns a provider\'s model map on or off, from the dashboard\'s page');
      const b = await ctx.readJson(req);
      if (typeof b?.on !== 'boolean') throw fail(400, 'say on: true or on: false');
      const p = profileOr404(m);
      if (b.on && !p.models) throw fail(409, 'This provider has no model map to use');
      writeProfile(p.name, { ...metaOf(p), mapSessions: b.on, env: p.env });
      return { ok: true, on: b.on };
    }],
  ];
  return { name: 'providers', routes };
}
