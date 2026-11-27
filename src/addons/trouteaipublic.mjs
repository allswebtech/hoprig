// A public address for the shipped gateway: a second host name on the SAME named tunnel as Hoprig's own Custom link
// (fixedlink.mjs addService), made only by the owner's press on the gateway's own page (#/providers/trouteai), never by
// itself, never by Tia, a coding session, a linked computer or the command line.
//
//   GET  /api/gatewayhost/trouteai/public          { state: on | off | unavailable, hostname, url, answers, told, linkOn,
//                                                    need, why }       (routes in gatewayhost.mjs)
//   POST /api/gatewayhost/trouteai/public { confirm, on }   → { ok, lines } or 409 { need, error }
//
// What it writes, and where (nothing else is written):
//   - Cloudflare: one CNAME for the name, to the tunnel, made once (`tunnel route dns`, by fixedlink addService);
//   - Hoprig: in addons/fixed-link/fixed.json the entry { hostname, port, gateway: 'trouteai' } of `extra`, the one
//     record of this switch (config.yml gets its ingress rule at every tunnel start, from the same list);
//   - the gateway: the environment TROUTEAI_PUBLIC_BASE_URL=https://<name>, added by the listen rule (localgateway.mjs)
//     to every start Hoprig makes and to its service file while the entry exists.
//
// The name is not typed: "tai-" and the first label of Hoprig's own Custom name, under the same domain
// (pc.example.com gives tai-pc.example.com; an apex name example.com gives tai.example.com): one level only, which
// Cloudflare's free certificate covers.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { dataFolder } from '../gateway/trouteaibase.mjs';
import { readFixed } from './cloudflared.mjs';

export const GATEWAY = 'trouteai';
export const DEFAULT_PORT = 20017;
/** The words of every side door that is closed: this switch is the page's alone. */
export const OWN_PAGE = 'TRouteAI\'s public address is turned on and off on its own page.';

/** The shipped gateway's port (config addons.trouteai.port, else its default). */
export const gatewayPort = (cfg = null) => Number(((cfg || loadConfig()).addons || {})[GATEWAY]?.port) || DEFAULT_PORT;

/** The public name for Hoprig's Custom name `hostname`, or null when it would not be a valid host name. */
export function tailName(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  const name = labels.length === 2 ? `tai.${labels.join('.')}` : `tai-${labels[0]}.${labels.slice(1).join('.')}`;
  const first = name.split('.')[0];
  return first.length <= 63 && name.length <= 253 ? name : null;
}

/** The entry of the fixed address's list that leads to this gateway: its own mark, else the same port (a name added by hand). */
export function entryOf(fixed, port = gatewayPort()) {
  const extra = (fixed && fixed.extra) || [];
  return extra.find((x) => x.gateway === GATEWAY) || extra.find((x) => Number(x.port) === Number(port)) || null;
}

/** The environment a start of the gateway gets while its public name exists (localgateway.mjs listenRule). */
export function baseEnv(fixed = readFixed()) {
  const e = fixed && fixed.mode === 'named' ? entryOf(fixed) : null;
  return e ? { TROUTEAI_PUBLIC_BASE_URL: `https://${e.hostname}` } : {};
}

const WHY = {
  'link-custom': 'Set up Hoprig\'s public link as Custom first (Settings, Public link).',
  'link-off': 'Turn Hoprig\'s public link on first (Settings, Public link).',
  'not-running': 'Start TRouteAI first.',
  'first-password': 'TRouteAI still uses its first password. Set your own first.',
  'no-password': 'TRouteAI has no password. Set one first.',
  'open-api': 'TRouteAI answers its model address without a key, so it stays private.',
  'name-long': 'The name for TRouteAI would be too long for a host name.',
  busy: 'The public link is busy with something else; wait until it finishes.',
};
const refuse = (need, why = WHY[need]) => ({ ok: false, need, error: why });

/**
 * Why the public address cannot be turned on now: { need, error } or null. Reads only: fixed.json, the link's state,
 * the gateway's data folder (whether its first-password file is there), its sign-in state and its model address.
 * `deps`: link () → the public link's status, gateway () → { installed, running } of the shipped gateway, signIn ()
 * → { requireLogin, signInSet (its hasPassword), oidcEnabled } | null, firstFile (), openApi (port) → a path | null, dns (name) → the
 * hostnames already there (for a name in use for another port).
 */
export async function cannotTurnOn(deps = {}) {
  const fixed = deps.fixed ? deps.fixed() : readFixed();
  if (!fixed || fixed.mode !== 'named') return refuse('link-custom', fixed && fixed.mode === 'token' ? 'With a tunnel token the names are set in the Cloudflare dashboard, so TRouteAI\'s address cannot be made from here. Set up Hoprig\'s public link as Custom first (Settings, Public link).' : WHY['link-custom']);
  const link = deps.link ? await deps.link() : null;
  if (!link || link.on !== true || link.kind !== 'custom') return refuse('link-off');
  const gw = deps.gateway ? await deps.gateway() : { installed: false, running: false };
  if (!gw.installed || !gw.running) return refuse('not-running');
  const file = deps.firstFile ? deps.firstFile() : path.join(dataFolder(), 'initial-admin-password.txt');
  if (fs.existsSync(file)) return refuse('first-password');
  const s = deps.signIn ? await deps.signIn() : null;
  if (!s) return refuse('no-password', 'TRouteAI\'s sign-in state could not be read, so its public address stays off. Update TRouteAI, then try again.');
  if (s.requireLogin === false || (s.signInSet !== true && s.oidcEnabled !== true)) return refuse('no-password');
  const port = gatewayPort();
  if (await (deps.openApi || ((p) => import('./localservice.mjs').then((m) => m.openApi(p))))(port)) return refuse('open-api');
  const name = tailName(fixed.hostname);
  if (!name) return refuse('name-long');
  const other = (fixed.extra || []).find((x) => x.hostname === name && Number(x.port) !== port);
  if (other) return refuse('name-taken', `${name} already leads to port ${other.port}. Remove that name in Settings, Public link, first.`);
  return null;
}

/**
 * What the page shows: { state, hostname, url, answers, told, linkOn, need, why }. `on`: an entry leads to the gateway
 * (also one made by hand: it is shown as it is, and marked as this switch's own only on the next press). `off`: it
 * can be turned on. `unavailable`: `need` and `why` say what is missing.
 */
export async function stateOf(deps = {}) {
  const fixed = deps.fixed ? deps.fixed() : readFixed();
  const e = fixed && fixed.mode === 'named' ? entryOf(fixed) : null;
  const link = deps.link ? await deps.link().catch(() => null) : null;
  if (e) return { state: 'on', hostname: e.hostname, url: `https://${e.hostname}`, answers: null, told: e.told === true, linkOn: Boolean(link && link.on === true), need: null, why: null };
  const no = await cannotTurnOn(deps);
  const hostname = fixed && fixed.hostname ? tailName(fixed.hostname) : null;
  return no ? { state: 'unavailable', hostname, url: null, answers: null, told: false, linkOn: Boolean(link && link.on === true), need: no.need, why: no.error } : { state: 'off', hostname, url: `https://${hostname}`, answers: null, told: false, linkOn: true, need: null, why: null };
}

/**
 * Turn the public address on: every refusal first, then the name on the tunnel (the tunnel restarts by itself).
 * `deps.step(name, body, opts)` is the link's customStep. → { ok, hostname, url, lines } or { ok: false, need, error }.
 * Restarting the gateway and rewriting its service are the route's (it holds the gateway's one press).
 */
export async function turnOn(deps = {}) {
  const no = await cannotTurnOn(deps);
  if (no) return no;
  const fixed = (deps.fixed || readFixed)();
  const name = tailName(fixed.hostname);
  const e = entryOf(fixed);
  if (e) return { ok: true, hostname: e.hostname, url: `https://${e.hostname}`, lines: [`${e.hostname} leads to TRouteAI already.`], already: true };
  const lines = [];
  const r = await deps.step('add-service', { port: gatewayPort(), hostname: name, confirmed: true }, { internal: GATEWAY, onLine: (l) => lines.push(l) });
  if (!r.ok) return refuse(/already a DNS record/.test(r.error || '') ? 'dns-taken' : 'step', r.error || 'The name could not be added to the tunnel.');
  return { ok: true, hostname: name, url: `https://${name}`, lines: [...lines, `TRouteAI has the public address https://${name}.`] };
}

/** Turn it off: the entry leaves the tunnel's list, so the name answers Not found. Its DNS record stays in Cloudflare. */
export async function turnOff(deps = {}) {
  const fixed = (deps.fixed || readFixed)();
  const e = fixed && fixed.mode === 'named' ? entryOf(fixed) : null;
  if (!e) return { ok: true, already: true, lines: ['TRouteAI had no public address.'] };
  const lines = [];
  const r = await deps.step('remove-service', { hostname: e.hostname }, { internal: GATEWAY, onLine: (l) => lines.push(l) });
  if (!r.ok) return refuse('step', r.error || 'The name could not be taken out of the tunnel.');
  // The tunnel step already says that the DNS record stays; said once.
  return { ok: true, hostname: e.hostname, lines: lines.some((l) => /DNS record/.test(l)) ? lines : [...lines, `${e.hostname} no longer leads to TRouteAI. Its DNS record stays in Cloudflare: delete it there if you no longer need it.`] };
}
