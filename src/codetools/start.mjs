// What POST /api/sessions checks before it starts a coding tool other than Claude Code in a terminal (Claude Code's checks stay in
// src/server/server.mjs): the tool is on and installed, and the choices for this one session are the tool's own.
import fs from 'node:fs';
import { anyTool, enabledToolIds, findTool, notOffered, TOOL_IDS } from './index.mjs';

// A letter or digit first: an id that starts with "-" would be read as an option by the tool.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** The coding tool named by a request (absent: Claude Code). Throws a 400 for anything else, a tool not offered too. */
export function toolFromRequest(v) {
  if (v === undefined || v === null || v === '') return 'claude';
  if (!TOOL_IDS.includes(v)) throw bad(anyTool(v) ? notOffered(v) : `the coding tool must be one of: ${TOOL_IDS.join(', ')}`);
  return v;
}

/** The tool may start here: it is offered and on (Settings, codingTools), and installed in Hoprig's tools folder. */
export function assertToolReady(toolId, cfg) {
  const t = findTool(toolId);
  if (!t) throw bad(notOffered(toolId));
  if (!enabledToolIds(cfg).includes(toolId)) throw bad(`${t.name} is off on this computer. Turn it on, or install it from Settings → Updates.`);
  if (t.managed && !fs.existsSync(t.binPath())) throw Object.assign(new Error(`${t.name} is not installed on this computer. Install it from Settings → Updates.`), { status: 409 });
}

/** The launcher flags for one session's choices (`permissionMode`, `effort`, `model`), from the tool's own lists. */
export function toolFlags(toolId, b = {}) {
  const t = anyTool(toolId); // toolFromRequest let it through already
  const flags = [];
  const given = (x) => x !== undefined && x !== null;
  if (given(b.permissionMode)) {
    if (!t.options.permissionModes.includes(b.permissionMode)) throw bad(`the permission mode for ${t.name} must be one of: ${t.options.permissionModes.join(', ')}`);
    flags.push('--permission-mode', b.permissionMode);
  }
  if (given(b.effort)) {
    if (!t.options.efforts.includes(b.effort)) throw bad(`the effort for ${t.name} must be one of: ${t.options.efforts.join(', ')}`);
    flags.push('--effort', b.effort);
  }
  if (given(b.model)) {
    if (typeof b.model !== 'string' || !MODEL_RE.test(b.model)) throw bad('the model must be a model id such as claude-sonnet-5-5');
    flags.push('--model', b.model);
  }
  return flags;
}
