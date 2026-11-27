// What POST /api/sessions checks before it starts a coding tool other than Claude Code in a terminal (Claude Code's checks stay in
// src/server/server.mjs): the tool is on and installed, and the choices for this one session are the tool's own.
import fs from 'node:fs';
import { anyTool, enabledToolIds, findTool, notOffered, TOOL_IDS } from './index.mjs';
import { herRightsLevel } from '../assistant/herrights.mjs';
import { hoprigVersion } from '../handsoff.mjs';

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
  // Each refusal carries the code of the place it names (web/errorways.js), so the page draws the button to it.
  if (!enabledToolIds(cfg).includes(toolId)) throw Object.assign(bad(`${t.name} is off on this computer. Turn it on in Settings → New sessions → Coding tools.`), { details: { code: 'tool-off' } });
  if (t.managed && !fs.existsSync(t.binPath())) throw Object.assign(new Error(`${t.name} is not installed on this computer. Install it in Settings → New sessions → Coding tools.`), { status: 409, details: { code: 'tool-install' } });
}

/**
 * Refuse a Codex or OpenCode session Tia starts while her administrator-rights level is below Full. Hoprig hands those
 * coding tools no PreToolUse hook, so her level cannot hold an administrator command in them: below Full such a session
 * would run `sudo` with no card (and could rewrite Hoprig's own settings), which is MORE than her level allows and more
 * than her own run_command tool may do. At Full her administrator commands run with no card anyway, so a session she
 * starts there matches the level and is allowed. Claude Code (its hook holds the level), a session that is not hers, and
 * Full all pass. The choke point is every start that knows it is hers: the terminal route and the one openChat.
 */
export function assertHerToolBound(toolId, { hers = false, cfg = {}, version = hoprigVersion() } = {}) {
  if (!hers || toolId === 'claude') return;
  if (herRightsLevel(cfg, version) === 'full') return;
  const name = (findTool(toolId) || anyTool(toolId) || { name: toolId }).name;
  throw bad(`Hoprig cannot hold an administrator command in ${name}, so a ${name} session Tia starts runs one with no card. Hoprig allows her to start ${name} only when her administrator-rights level is Full (Settings → Tia); below that, start this with Claude Code, whose hook holds the level.`);
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
