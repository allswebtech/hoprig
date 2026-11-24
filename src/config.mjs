// <configDir>/config.json. Every key is optional.
//
//   claudeBin   the Claude Code executable                      default "claude"
//   sessionDefaults  how new sessions start, each optional (lead: "Lead model" for chats and plans): default {}
//                 permissionMode  one of PERMISSION_MODES (what Claude Code may do without asking)
//                 effort          one of EFFORTS
//                 model           an alias (opus, sonnet…) or a full model name
//   claudeArgs  more arguments added to every launch (advanced)  default []
//   launcher    command the dashboard types into a tmux pane to start a session, as an array; the profile name
//               and the session arguments are appended. Default: this hoprig. Set it when you start Claude
//               through your own wrapper script.
//   server      dashboard settings (see src/server)
import fs from 'node:fs';
import { configDir, configFile } from './paths.mjs';

export const DEFAULTS = { claudeBin: 'claude', claudeArgs: [], sessionDefaults: {}, launcher: null, server: {} };

// The values Claude Code accepts (`claude --help`, 2.1.325).
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The model aliases a session may start with from the page (Claude Code resolves each to its newest model).
export const MODELS = ['opus', 'sonnet', 'haiku'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/; // as src/server/endpoint.mjs

/** A clean copy of session defaults: unknown keys and values that Claude Code would refuse are an error. */
export function cleanSessionDefaults(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('session defaults must be an object');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === '' || v === undefined) continue; // "not set": Claude Code's own default
    if (k === 'permissionMode') {
      if (!PERMISSION_MODES.includes(v)) throw new Error(`permission mode must be one of: ${PERMISSION_MODES.join(', ')}`);
    } else if (k === 'effort') {
      if (!EFFORTS.includes(v)) throw new Error(`effort must be one of: ${EFFORTS.join(', ')}`);
    } else if (k === 'model') {
      if (typeof v !== 'string' || !MODEL_RE.test(v)) throw new Error('model must be a model name such as opus, sonnet or claude-opus-5-5');
    } else if (k === 'others') {
      // "Use other providers": the providers ticked for new chats and plans (src/models/others.mjs checks them at a start).
      if (!Array.isArray(v) || v.length > 10 || v.some((n) => typeof n !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n))) throw new Error('others must be a list of provider names');
      if (!v.length) continue;
      out[k] = [...new Set(v)];
      continue;
    } else if (k === 'lead') {
      // "Lead model" for new chats and plans (src/models/lead.mjs): only on is kept; off is the default.
      if (typeof v !== 'boolean') throw new Error('lead must be true or false');
      if (!v) continue;
    } else throw new Error(`"${k}" is not a session default`);
    out[k] = v;
  }
  return out;
}

/** The arguments the session defaults stand for. They come first, so anything given later wins. */
export function sessionArgs(cfg = loadConfig()) {
  let d;
  try {
    d = cleanSessionDefaults(cfg.sessionDefaults || {});
  } catch {
    return []; // a broken setting must not stop a session from starting; the doctor and Settings report it
  }
  return [
    ...(d.permissionMode ? ['--permission-mode', d.permissionMode] : []),
    ...(d.effort ? ['--effort', d.effort] : []),
    ...(d.model ? ['--model', d.model] : []),
  ];
}

export function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${configFile()}: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...raw, server: { ...DEFAULTS.server, ...(raw.server || {}) } };
  if (!Array.isArray(cfg.claudeArgs) || cfg.claudeArgs.some((a) => typeof a !== 'string')) {
    throw new Error(`${configFile()}: "claudeArgs" must be an array of strings`);
  }
  if (cfg.launcher !== null && (!Array.isArray(cfg.launcher) || !cfg.launcher.length || cfg.launcher.some((a) => typeof a !== 'string'))) {
    throw new Error(`${configFile()}: "launcher" must be a non-empty array of strings`);
  }
  return cfg;
}

/** Merge `patch` into config.json (top-level keys; `server` is merged one level deep). File mode 600. */
export function saveConfig(patch) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${configFile()}: ${e.message}`);
  }
  const next = { ...raw, ...patch };
  if (patch.server) next.server = { ...(raw.server || {}), ...patch.server };
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configFile());
  return next;
}
