// What a linked hub changed here with its machine token, in this computer's Activity log (the automation log,
// <stateDir>/automation.log, that Automations → Activity shows).
//
// One place for every feature: the machines gate calls auditToken() for each request it lets through with a token.
// When the answer is finished, a change that succeeded and matches one of CHANGES is written as one plain sentence
// that names the token, such as "The main computer office-pc started the public link".
//
// Only the method, the path, the status and the token's NAME are used. The request body, its headers, keys,
// tokens and passwords are never read here: the Setup routes carry the computer's administrator password.
import path from 'node:path';
import { gatewayTitle } from '../addons/gateways.mjs';
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
    ? `The token of the main computer ${name} was revoked; the ${keys === 1 ? 'gateway key' : `${keys} gateway keys`} it made ended with it, and the sharing of the gateways stays as it is`
    : `The token of the main computer ${name} was revoked`;
}

// A gateway goes by its title (src/addons/gateways.mjs), the public link by its plain name.
const addonName = (id) => (id === 'public-link' ? 'the public link' : !/^[a-z0-9-]{1,40}$/.test(id) ? 'an add-on' : gatewayTitle(id) || `the add-on ${id}`);
const ADDON_VERBS = { install: 'installed', update: 'updated', start: 'started', stop: 'stopped', remove: 'removed' };
const ACTION_WORDS = {
  'fixed-sign-in': 'started the sign-in to Cloudflare for the Custom public link',
  'fixed-cancel': 'cancelled the sign-in to Cloudflare for the Custom public link',
  'fixed-create': 'set up the Custom public link',
  'fixed-token': 'set up the Custom public link with a tunnel token',
  'fixed-on': 'turned on the Custom public link',
  'fixed-off': 'turned off the Custom public link',
  'fixed-forget': 'stopped using the Custom public link',
  'fixed-add-service': 'added a service to the Custom public link',
  'fixed-remove-service': 'removed a service from the Custom public link',
  'quick-service-start': 'gave a service on this computer a temporary address',
  'quick-service-stop': 'stopped the temporary address of a service on this computer',
};
// A gateway by its title, as the add-on lines name it; one this computer does not know by its id.
const gatewayName = (s) => (!/^[a-z0-9-]{1,40}$/.test(s) ? 'a gateway' : gatewayTitle(s) || `the gateway ${s}`);

/**
 * [method, path, (match) => what was done, asks]. Every capture is checked by the regex itself, so it is safe to
 * show. `asks`: the route may answer with a question instead of doing it (Setup: the password or a terminal first).
 */
export const CHANGES = [
  ['POST', /^\/api\/addons\/([a-z0-9-]{1,40})\/(install|update|start|stop|remove)$/, (m) => `${ADDON_VERBS[m[2]]} ${addonName(m[1])}`],
  ['POST', /^\/api\/addons\/([a-z0-9-]{1,40})\/do\/([a-z-]{1,40})$/, (m) => ACTION_WORDS[m[2]] || `ran "${m[2]}" of ${addonName(m[1])}`],
  // The body says on or off; it is not read here, so the line says only that the switch was used.
  ['POST', /^\/api\/public-link$/, () => 'switched the public link on or off'],
  ['POST', /^\/api\/public-link\/custom\/([a-z-]{1,20})$/, (m) => ACTION_WORDS[`fixed-${m[1]}`] || 'changed the Custom public link'],
  ['POST', /^\/api\/public-link\/temporary\/(add-service|remove-service)$/, (m) => ACTION_WORDS[m[1] === 'add-service' ? 'quick-service-start' : 'quick-service-stop']],
  ['POST', /^\/api\/gateways\/([a-z][a-z0-9-]{0,30})\/share$/, (m) => `changed the sharing of ${gatewayName(m[1])}`],
  ['POST', /^\/api\/gateways\/([a-z][a-z0-9-]{0,30})\/keys$/, (m) => `made a key for ${gatewayName(m[1])}`],
  ['POST', /^\/api\/gateways\/keys\/([0-9a-f]{12})\/remove$/, (m) => `removed the gateway key ${m[1]}`],
  ['POST', /^\/api\/pcsetup\/setup$/, () => 'ran Set up this computer', true],
  ['POST', /^\/api\/pcsetup\/fix$/, () => 'ran a fix from PC → Setup', true],
  ['POST', /^\/api\/pcsetup\/recipe$/, () => 'ran a setup recipe', true],
  ['POST', /^\/api\/workspace\/link$/, () => "linked Claude Code's own folder into the AI brain"],
  ['POST', /^\/api\/workspace\/git\/identity$/, () => "changed git's name and e-mail"],
  ['POST', /^\/api\/workspace\/git\/signin$/, () => 'started the GitHub sign-in'],
  ['POST', /^\/api\/workspace\/git\/brain$/, () => "created the AI brain's repository or saved the AI brain to it"],
  ['POST', /^\/api\/workspace\/map\/commit$/, () => "saved the workspace map in the AI brain's history"],
  ['POST', /^\/api\/system\/processes\/end$/, () => 'ended a process from the Task manager'],
  ['POST', /^\/api\/services\/action$/, () => 'started, stopped or restarted a service', true],
  // The code editor: what changed, never which file or what was in it (the body is not read).
  ['POST', /^\/api\/code\/file$/, () => 'saved a file in the code editor'],
  ['POST', /^\/api\/code\/create$/, () => 'made a file or folder in the code editor'],
  ['POST', /^\/api\/code\/rename$/, () => 'renamed a file or folder in the code editor'],
  ['POST', /^\/api\/code\/delete$/, () => 'deleted a file or folder in the code editor'],
  ['POST', /^\/api\/code\/git\/discard$/, () => 'discarded changes in the code editor'],
  ['POST', /^\/api\/code\/git\/commit$/, () => 'made a git commit in the code editor'],
  // Files on the desktop: what was done, never which file or what was in it.
  ['POST', /^\/api\/files\/upload$/, () => 'uploaded a file in Files'],
  ['POST', /^\/api\/files\/new$/, () => 'made a file or folder in Files'],
  ['POST', /^\/api\/files\/rename$/, () => 'renamed a file or folder in Files'],
  ['POST', /^\/api\/files\/move$/, () => 'moved files in Files'],
  ['POST', /^\/api\/files\/copy$/, () => 'copied files in Files'],
  ['POST', /^\/api\/files\/trash$/, () => 'moved files to the trash in Files'],
  ['POST', /^\/api\/files\/trash\/restore$/, () => 'put a file back from the trash in Files'],
  ['POST', /^\/api\/files\/trash\/empty$/, () => 'emptied the trash in Files'],
  ['POST', /^\/api\/files\/delete$/, () => 'deleted files for good in Files'],
  ['POST', /^\/api\/files\/pack$/, () => 'packed files into an archive in Files'],
  ['POST', /^\/api\/files\/unpack$/, () => 'unpacked an archive in Files'],
];

/** { did, asks } for `method p` done by the token called `name`, or null when it is not a change we log. */
export function changeOf(method, p, name) {
  for (const [m, re, words, asks] of CHANGES) {
    const match = m === method ? re.exec(p) : null;
    if (match) return { did: `The main computer ${name} ${words(match)}`, asks: asks === true };
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
