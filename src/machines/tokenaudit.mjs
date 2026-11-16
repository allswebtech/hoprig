// What a linked hub changed here with its machine token, in this computer's Activity log (the automation log,
// <stateDir>/automation.log, that Automations → Activity shows).
//
// One place for every feature: the machines gate calls auditToken() for each request it lets through with a token.
// When the answer is finished, a change that succeeded and matches one of CHANGES is written as one plain sentence
// that names the token, such as "The hub office-pc started the public link".
//
// Only the method, the path, the status and the token's NAME are used. The request body, its headers, keys,
// tokens and passwords are never read here: the Setup routes carry the computer's administrator password.
import path from 'node:path';
import { createActivityLog } from '../automation/store.mjs';
import { stateDir } from '../paths.mjs';

/** One line in the Activity log, by "hub" (web/automation.js names it). Never throws. */
export function recordHubActivity(did, outcome = 'ok') {
  try {
    return createActivityLog(path.join(stateDir(), 'automation.log')).add({ automation: 'hub', did, outcome });
  } catch {
    return null; // the log is a convenience
  }
}

/** The line for a revoked token, written by revokeToken (tokens.mjs) in whichever process revoked it. */
export function revokedWords(name, keys = 0) {
  return keys
    ? `The token of the hub ${name} was revoked; the ${keys === 1 ? 'gateway key' : `${keys} gateway keys`} it made ended with it, and the sharing of the gateways stays as it is`
    : `The token of the hub ${name} was revoked`;
}

const ADDON_NAMES = { 'public-link': 'the public link', trouteai: 'TRouteAI' };
const addonName = (id) => ADDON_NAMES[id] || (/^[a-z0-9-]{1,40}$/.test(id) ? `the add-on ${id}` : 'an add-on');
const ADDON_VERBS = { install: 'installed', update: 'updated', start: 'started', stop: 'stopped' };
const ACTION_WORDS = {
  'fixed-sign-in': 'started the sign-in to Cloudflare for the fixed address',
  'fixed-cancel': 'cancelled the sign-in to Cloudflare for the fixed address',
  'fixed-create': 'set up the fixed address',
  'fixed-token': 'set up the fixed address with a tunnel token',
  'fixed-on': 'turned on the fixed address',
  'fixed-off': 'turned off the fixed address',
  'fixed-forget': 'stopped using the fixed address',
  'fixed-add-service': 'added a service to the fixed address',
  'fixed-remove-service': 'removed a service from the fixed address',
  'quick-service-start': 'gave a service on this computer a temporary address',
  'quick-service-stop': 'stopped the temporary address of a service on this computer',
};
const safeId = (s) => (/^[a-z0-9-]{1,40}$/.test(s) ? s : 'a gateway');

/**
 * [method, path, (match) => what was done, asks]. Every capture is checked by the regex itself, so it is safe to
 * show. `asks`: the route may answer with a question instead of doing it (Setup: the password or a terminal first).
 */
export const CHANGES = [
  ['POST', /^\/api\/addons\/([a-z0-9-]{1,40})\/(install|update|start|stop)$/, (m) => `${ADDON_VERBS[m[2]]} ${addonName(m[1])}`],
  ['POST', /^\/api\/addons\/([a-z0-9-]{1,40})\/do\/([a-z-]{1,40})$/, (m) => ACTION_WORDS[m[2]] || `ran "${m[2]}" of ${addonName(m[1])}`],
  ['POST', /^\/api\/gateways\/([a-z][a-z0-9-]{0,30})\/share$/, (m) => `changed the sharing of the gateway ${safeId(m[1])}`],
  ['POST', /^\/api\/gateways\/([a-z][a-z0-9-]{0,30})\/keys$/, (m) => `made a key for the gateway ${safeId(m[1])}`],
  ['POST', /^\/api\/gateways\/keys\/([0-9a-f]{12})\/remove$/, (m) => `removed the gateway key ${m[1]}`],
  ['POST', /^\/api\/pcsetup\/setup$/, () => 'ran Set up this computer', true],
  ['POST', /^\/api\/pcsetup\/fix$/, () => 'ran a fix from PC → Setup', true],
  ['POST', /^\/api\/pcsetup\/recipe$/, () => 'ran a setup recipe', true],
  ['POST', /^\/api\/workspace\/link$/, () => "linked Claude Code's own folder into the AI brain"],
  ['POST', /^\/api\/workspace\/git\/identity$/, () => "changed git's name and e-mail"],
  ['POST', /^\/api\/workspace\/git\/signin$/, () => 'started the GitHub sign-in'],
  ['POST', /^\/api\/workspace\/git\/brain$/, () => "created the AI brain's repository"],
  ['POST', /^\/api\/workspace\/map\/commit$/, () => "saved the workspace map in the AI brain's history"],
  ['POST', /^\/api\/system\/processes\/end$/, () => 'ended a process from the Task manager'],
  ['POST', /^\/api\/services\/action$/, () => 'started, stopped or restarted a service', true],
];

/** { did, asks } for `method p` done by the token called `name`, or null when it is not a change we log. */
export function changeOf(method, p, name) {
  for (const [m, re, words, asks] of CHANGES) {
    const match = m === method ? re.exec(p) : null;
    if (match) return { did: `The hub ${name} ${words(match)}`, asks: asks === true };
  }
  return null;
}

/**
 * Called by the machines gate for a request it let in with `entry` (the token's stored entry). Records when the
 * answer is finished with a status below 400. On a route that may ask first, an answer that asks (needsPassword,
 * needsTerminal) did nothing yet and is not recorded; only those flags of that answer are looked at, and only
 * on those routes (no other answer is read: the gateway's carries a new key).
 */
export function auditToken(req, res, p, entry, record = recordHubActivity) {
  const c = entry && typeof entry.name === 'string' ? changeOf(req.method, p, entry.name) : null;
  if (!c) return;
  let asked = false;
  if (c.asks) {
    const end = res.end;
    res.end = function (chunk, ...rest) {
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        if (text.length < 4096 && text.startsWith('{')) {
          const a = JSON.parse(text);
          asked = a.needsPassword === true || a.needsTerminal === true || a.needsConfirm === true;
        }
      } catch {
        /* not JSON: a change like any other */
      }
      return end.call(this, chunk, ...rest);
    };
  }
  res.once('finish', () => {
    if (res.statusCode < 400 && !asked) record(c.did);
  });
}
