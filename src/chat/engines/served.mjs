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
 * still shows). A mode the chat does not offer here (Claude Code's plan, auto or never-ask) runs as "manual".
 */
export const MODES = Object.freeze(['manual', 'acceptEdits', 'bypassPermissions']);
export const MODE_WORDS = Object.freeze({
  manual: { chip: 'Ask first', sub: 'Asks before it changes a file, runs a command, reads the web or leaves the folder' },
  acceptEdits: { chip: 'Accept edits', sub: 'Changes files without asking; asks before commands, the web and other folders' },
  bypassPermissions: { chip: 'Bypass', sub: 'Allows everything without asking (riskiest)', danger: true },
});
export const modeOf = (mode) => (MODES.includes(mode) ? mode : 'manual');

/** The rules a conversation gets for a mode (OpenCode's permission rules; the last that matches wins). */
export function modeRules(mode) {
  const ask = (actions) => actions.map((action) => ({ action, resource: '*', effect: 'ask' }));
  const m = modeOf(mode);
  // Bypass adds no "allow all" rule: such a rule would also win over the deny rules of the owner's own settings.
  // OpenCode's defaults allow almost everything; the chat allows what it still asks (asks.mjs).
  if (m === 'bypassPermissions') return [];
  if (m === 'acceptEdits') return ask(['shell', 'webfetch', 'external_directory']);
  return ask(['edit', 'shell', 'webfetch', 'external_directory']);
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
  if (!r || !r.ok) throw fail(409, `OpenCode's server cannot be used: ${(r && r.why) || 'it did not start'}`);
  const prov = (o.providers || serverProviders)(tool, [profile])[0];
  if (!prov) throw fail(400, `the provider "${profile.name}" has no key for OpenCode`);
  return { server: r.server, prov, release: (o.hold || holdServer)(tool) };
}

/** The model a conversation starts on: chosen, else the provider's own, else the first it lists (as a terminal does). */
export async function startModel(model, prov, profile, o = {}) {
  if (model) return model;
  if (prov.model) return prov.model;
  return ((await modelsOf(profile, o))[0] || {}).id || null;
}
