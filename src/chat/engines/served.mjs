// What a chat engine needs that runs on a coding tool's server (opencode.mjs): the provider it may use, the server,
// the models and the choices of the chips. It runs on the ONE server per computer that Hoprig keeps for the tool
// (src/codetools/servers.mjs; the terminal sessions of the tool use the same one), never on a second one; an open
// chat holds that server, so nothing stops it under the chat. It runs only on a provider that serves the tool
// (src/profiles.mjs servesTools: a Claude subscription never reaches it), checked again at every start, so a chat
// that moves or resumes is held to it too. The models are the ones the provider lists.
import { assertServes, readProfile } from '../../profiles.mjs';
import { providerModelList } from '../../codetools/providers.mjs';
import { ensureServer, holdServer, serverProviders } from '../../codetools/servers.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * The permission modes of an OpenCode chat, with the chip's words. The ids are the chat's own (the page's mode chip
 * and Shift+Tab know them): "manual" asks before it changes a file, runs a command, fetches a page or leaves the
 * folder; "acceptEdits" the same without the files; "bypassPermissions" allows everything (a question to the owner
 * still shows, and a delete the chat cannot read: src/chat/asks.mjs openCodeAllows). A mode the chat does not offer here (Claude Code's plan, auto or never-ask) runs as "manual".
 */
export const MODES = Object.freeze(['manual', 'acceptEdits', 'bypassPermissions']);
export const MODE_WORDS = Object.freeze({
  manual: { chip: 'Ask first', sub: 'Asks before it changes a file, runs a command, reads the web or leaves the folder' },
  acceptEdits: { chip: 'Accept edits', sub: 'Changes files without asking; asks before commands, the web and other folders' },
  bypassPermissions: { chip: 'Bypass', sub: 'Runs everything without asking; asks only before a delete written in plain sight outside the folder (riskiest)', danger: true },
});
export const modeOf = (mode) => (MODES.includes(mode) ? mode : 'manual');

/**
 * The rules a conversation gets for a mode (OpenCode's permission rules; the last that matches wins), then the owner's
 * own rules for the shell from his first deny on (`own`: ownRules), so that a rule of the chat never turns his "deny"
 * into "ask" (seen on OpenCode 2.3: a conversation's rules come after those of his config files, and its "ask" for every
 * shell call won over his deny of one).
 * Bypass: OpenCode's own defaults allow everything, so without a rule a shell call would never be seen, `rm -rf ~`
 * included. Every shell call is asked, and the chat answers it at once (src/chat/asks.mjs openCodeAllows): a card only
 * for a delete it cannot read as plain. Edits, pages and other folders stay unasked. No "allow all" rule: it would
 * also win over his deny rules.
 */
export function modeRules(mode, own = []) {
  const ask = (actions) => actions.map((action) => ({ action, resource: '*', effect: 'ask' }));
  const m = modeOf(mode);
  const his = Array.isArray(own) ? own : [];
  if (m === 'bypassPermissions') return [...ask(['shell']), ...his];
  if (m === 'acceptEdits') return [...ask(['shell', 'webfetch', 'external_directory']), ...his];
  return [...ask(['edit', 'shell', 'webfetch', 'external_directory']), ...his];
}

// OpenCode's wildcard for an action or a resource: * any run of characters, ? one.
const matches = (pattern, s) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(s);

/**
 * The owner's own rules that reach the shell, as they follow the chat's rules (modeRules): from OpenCode's config
 * documents as its server reads them for a folder (GET /api/config: his global file, the project's own, Hoprig's), the
 * config's rules and those of the agents a chat runs, in his order, from his first "deny" on, with every effect that is
 * not "deny" turned into "ask". The last match then says what he said: denied where his own last matching rule denies;
 * asked (answered by the chat or put to him, as the mode says) where a later rule of his excepts it ("git *" deny, then
 * "git status" allow); and what none of his rules names is asked by the chat's own rule. Before his first deny nothing
 * is needed: the chat's rule asks for it. null where the rules are of a shape not known (a failed read).
 */
export function ownRules(documents) {
  const all = [];
  // Rules of a shape OpenCode 2.3 does not answer with (it gives every config file's permissions as a list of { action,
  // resource, effect }, also for a file that writes the older "permission": { "bash": { … } }): not read (null).
  const wellFormed = (r) => r && typeof r === 'object' && ['allow', 'ask', 'deny'].includes(r.effect) && typeof r.action === 'string' && typeof r.resource === 'string';
  let unknown = false;
  const take = (rules) => {
    if (rules === undefined) return;
    if (!Array.isArray(rules) || !rules.every(wellFormed)) {
      unknown = true;
      return;
    }
    for (const r of rules) if (matches(r.action, 'shell')) all.push({ action: r.action, resource: r.resource, effect: r.effect === 'deny' ? 'deny' : 'ask' });
  };
  for (const d of Array.isArray(documents) ? documents : []) {
    const info = d && d.info && typeof d.info === 'object' ? d.info : null;
    if (!info) continue;
    if (info.permission !== undefined) unknown = true; // the older key, never in its answer
    take(info.permissions);
    // The agents a chat's conversation runs: "build" and its subagents' "general" (another agent's rules are its own).
    const agents = info.agents && typeof info.agents === 'object' ? info.agents : {};
    for (const name of ['build', 'general']) take(agents[name] && agents[name].permissions);
  }
  if (unknown) return null;
  const first = all.findIndex((r) => r.effect === 'deny');
  return first < 0 ? [] : all.slice(first).slice(0, 500);
}

/** The efforts (OpenCode: the model's variant). */
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Ultracode: the highest effort the model lists (else the highest the chat offers). */
export function topEffort(listed) {
  const known = (Array.isArray(listed) ? listed : []).filter((e) => ORDER.includes(e) && e !== 'none');
  const pool = known.length ? known : EFFORTS;
  return [...pool].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).at(-1) || null;
}

/** The provider `name` for the coding tool, or a 400 that says why it cannot be used (servesTools). */
export function providerFor(name, tool) {
  const p = name && name !== 'auto' ? readProfile(name) : null;
  if (!p) throw fail(400, name === 'auto' ? 'Auto mode is for Claude Code only: choose a provider' : `there is no provider "${name}"`);
  try {
    assertServes(p, tool);
  } catch (e) {
    throw fail(400, e.message);
  }
  return p;
}

// The models a provider lists, kept a few minutes (the model chip asks often).
const MODELS_MS = 5 * 60_000;
const modelCache = new Map();
/** [{ id, efforts }] of the provider `profile`. */
export async function modelsOf(profile, { fetchImpl } = {}) {
  const key = profile.name;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < MODELS_MS) return hit.list;
  const list = await providerModelList(profile, fetchImpl ? { fetchImpl } : {}).catch(() => []);
  modelCache.set(key, { at: Date.now(), list });
  return list;
}
/** The same, from the cache only (never waits): what a view can show at once. */
export const knownModels = (name) => (modelCache.get(name) || {}).list || [];
/** Tests: a provider's list as if it had been asked. */
export const rememberModels = (name, list) => modelCache.set(name, { at: Date.now(), list });

/**
 * The tool's server for one chat session on `profile`: { server, prov, release }. o: stand-ins (tests): ensure,
 * providers, hold. Throws a 409 with the server's own reason when it cannot be used.
 */
export async function onServer(tool, profile, o = {}) {
  const r = await (o.ensure || ensureServer)(tool, { need: profile.name });
  if (!r || !r.ok) throw fail(409, (r && r.why) || 'its server did not start'); // the reason says the tool's name
  const prov = (o.providers || serverProviders)(tool, [profile])[0];
  if (!prov) throw fail(400, `the provider "${profile.name}" has no key for OpenCode`);
  // Held from now on. The upkeep that stops an unused server leaves it alone meanwhile: the ask above made it fresh.
  return { server: r.server, prov, release: (o.hold || holdServer)(tool) };
}

/** The model a conversation starts on: chosen, else the provider's own, else the first it lists (as a terminal does). */
export async function startModel(model, prov, profile, o = {}) {
  if (model) return model;
  if (prov.model) return prov.model;
  return ((await modelsOf(profile, o))[0] || {}).id || null;
}
