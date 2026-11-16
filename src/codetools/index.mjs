// The coding tools Hoprig runs: Claude Code, Codex and OpenCode. Each is one descriptor (a plain object) in this
// folder with the same small shape, so the rest of Hoprig asks "which tool" instead of assuming Claude Code:
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
// config.json "codingTools": the tools that are on, e.g. ["claude", "codex"]. Default ["claude"]. Installing a tool
// from the page or the command line turns it on.
import { loadConfig, saveConfig } from '../config.mjs';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { opencode } from './opencode.mjs';

export const TOOLS = Object.freeze([claude, codex, opencode]);
export const TOOL_IDS = Object.freeze(TOOLS.map((t) => t.id));
export const DEFAULT_TOOLS = Object.freeze(['claude']);

export const findTool = (id) => TOOLS.find((t) => t.id === id) || null;

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
  for (const id of v) if (!TOOL_IDS.includes(id)) throw new Error(`"${String(id).slice(0, 40)}" is not a coding tool (${TOOL_IDS.join(', ')})`);
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
