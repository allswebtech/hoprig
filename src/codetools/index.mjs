// The coding tools Hoprig runs: Claude Code and OpenCode (and Codex, built but not offered yet: see offered.mjs).
// Each is one descriptor (a plain object) in this folder with the same small shape, so the rest of Hoprig asks "which
// tool" instead of assuming Claude Code:
//
//   id, name            'claude' | 'codex' | 'opencode', and the name shown to people
//   managed             true: Hoprig installs and updates it in its own tools folder (npmtool.mjs)
//   home()              the tool's own folder (its config, sign-in and sessions)
//   installedVersion()  without starting the program, or null
//   info()              { installed, path, latest, method, updateAvailable } (latest null when it cannot be looked up)
//   install({ version?, onLine }), update({ onLine })   → { ok, version, output }
//   noSelfUpdate        (managed tools) what every start by Hoprig adds so the tool never updates itself
//   updateItem          { whenRunning: 'keeps-copy' | 'wait-until-none' }: may it be updated while a session runs
//
// config.json "codingTools": the tools that are on, e.g. ["claude", "opencode"]. Default ["claude"]. Installing a
// tool from the page or the command line turns it on. A tool that is not offered is read as if the value did not
// name it (no error: a config written by a version that offered it keeps working).
import { loadConfig, saveConfig } from '../config.mjs';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { isOffered } from './offered.mjs';
import { opencode } from './opencode.mjs';

/** Every coding tool Hoprig has a descriptor for, offered or not. Only the kept code of a tool and its tests use it. */
export const ALL_TOOLS = Object.freeze([claude, codex, opencode]);

// Which of them this version offers is decided in ONE place, offered.mjs (Codex is built but not offered yet; the
// reason and how to turn it on are there). TOOLS, TOOL_IDS and findTool below follow it.
export { isOffered, offeredOnly } from './offered.mjs';

export const TOOLS = Object.freeze(ALL_TOOLS.filter((t) => isOffered(t.id)));
export const TOOL_IDS = Object.freeze(TOOLS.map((t) => t.id));
export const DEFAULT_TOOLS = Object.freeze(['claude']);

/** An offered coding tool by id, or null (also for a tool that is built but not offered). */
export const findTool = (id) => TOOLS.find((t) => t.id === id) || null;
/** Any coding tool by id, offered or not: for the kept code of a tool once a request for it has been let through. */
export const anyTool = (id) => ALL_TOOLS.find((t) => t.id === id) || null;
/**
 * The plain sentence for an id that is not an offered coding tool. `cli`: for the command line, with the one thing to
 * do instead (the offered tools and the command that starts each).
 */
export function notOffered(id, { cli = false } = {}) {
  const built = anyTool(id);
  const text = built ? `${built.name} is not part of this version of Hoprig.` : `"${String(id ?? '').slice(0, 40)}" is not a coding tool: ${TOOL_IDS.join(', ')}`;
  if (!cli || !built) return text;
  return `${text} Start ${TOOLS.map((t) => `${t.name} with: hoprig${t.id === 'claude' ? '' : ` ${t.id}`}`).join(', or ')}.`;
}

/** The ids of the tools that are on, in the fixed order; a missing or broken setting means the default. */
export function enabledToolIds(cfg) {
  const v = cfg && cfg.codingTools;
  if (!Array.isArray(v)) return [...DEFAULT_TOOLS];
  const ids = TOOL_IDS.filter((id) => v.includes(id));
  return ids.length ? ids : [...DEFAULT_TOOLS];
}

export const enabledTools = (cfg) => enabledToolIds(cfg).map(findTool);

/** A value for "codingTools" from a person or a page: known ids only, at least one. Throws a plain sentence. */
export function cleanCodingTools(v) {
  if (!Array.isArray(v) || !v.length) throw new Error(`choose at least one coding tool: ${TOOL_IDS.join(', ')}`);
  for (const id of v) if (!TOOL_IDS.includes(id)) throw new Error(notOffered(id));
  return TOOL_IDS.filter((id) => v.includes(id));
}

/** The "codingTools" value with `id` turned on or off (off never leaves the list empty: that is refused). */
export function withTool(cfg, id, on) {
  const now = enabledToolIds(cfg);
  return cleanCodingTools(on ? [...now, id] : now.filter((x) => x !== id));
}

/** Turn `id` on in config.json (after an install). */
export function turnOn(id, { config = loadConfig, save = saveConfig } = {}) {
  save({ codingTools: withTool(config(), id, true) });
}
