// A profile is one file, <profilesDir>/<name>.env, with KEY=VALUE lines:
//
//   LABEL=Work subscription            shown in menus (optional)
//   PRERUN=my-proxy start              shell command run before Claude starts (optional)
//   MODELS=claude-fable-*=claude-opus-5-5   model names this endpoint needs instead, for Auto mode's router
//                                      (optional; "from=to" pairs separated by commas, * matches anything)
//   CLAUDE_CODE_OAUTH_TOKEN=...        every other line is exported to Claude Code
//
// What a profile is, by what it exports:
//   nothing                                   "login"         the account stored by `claude /login`
//   CLAUDE_CODE_OAUTH_TOKEN                   "subscription"  another Claude account (`claude setup-token`)
//   ANTHROPIC_API_KEY / _AUTH_TOKEN / _BASE_URL   "api"       pay-per-token API, direct or through a proxy
//
// Values are secrets: nothing here prints them, and publicProfile() is the only shape that may leave the machine.
import fs from 'node:fs';
import path from 'node:path';
import { profilesDir } from './paths.mjs';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Words that are commands (hoprig's own, and common wrapper commands), so they cannot name a profile.
export const RESERVED = new Set([
  'run', 'add', 'rm', 'profiles', 'serve', 'hook', 'help', 'passwd', 'service', 'doctor', 'version', 'setup', 'claude', 'auto', 'pair', 'tokens', 'machines', 'mcp', 'addons', 'router', 'router-url', 'assistant', 'link', 'join', 'public', 'pc', 'demo', 'project', 'skills', 'workspace',
  'x', 'start', 'stop', 'restart', 'update', 'log', 'logs', 'open', 'status',
]);
const META = new Set(['LABEL', 'PRERUN', 'MODELS']);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Auth variables a profile decides. They are cleared before a profile is applied, so one never leaks into another. */
export const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name);
}

/** Parse KEY=VALUE lines. Supports comments, `export KEY=...`, and single or double quotes. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !KEY_RE.test(m[1])) continue;
    let v = m[2];
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const quote = (v) => (/^[A-Za-z0-9_@%+=:,./-]*$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`);

export function kindOf(env) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return 'api';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'subscription';
  return 'login';
}

/**
 * Pay-per-use: an Anthropic API key that goes straight to Anthropic (no address, or Anthropic's own). A key that
 * goes through a gateway (TRouteAI, a proxy, another computer's gateway) is not: what it costs is the gateway's
 * business. Auto mode uses pay-per-use providers only when the owner turns that on. The one place of this rule:
 * the page gets it as `paid` on every provider.
 */
export function isPayPerUse(env) {
  if (kindOf(env) !== 'api' || !(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) return false;
  if (!env.ANTHROPIC_BASE_URL) return true;
  try {
    return new URL(env.ANTHROPIC_BASE_URL).hostname === 'api.anthropic.com';
  } catch {
    return true; // an address that cannot be read: counted as paid, the safe side
  }
}

const DEFAULT_LABEL = { login: 'Claude account (stored login)', subscription: 'Claude subscription', api: 'API' };

function fileOf(name) {
  return path.join(profilesDir(), `${name}.env`);
}

/** Read one profile, or null when it does not exist. */
export function readProfile(name) {
  if (!validName(name)) return null;
  let text;
  try {
    text = fs.readFileSync(fileOf(name), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const all = parseEnv(text);
  const env = {};
  for (const [k, v] of Object.entries(all)) if (!META.has(k)) env[k] = v;
  const kind = kindOf(env);
  return { name, label: all.LABEL || DEFAULT_LABEL[kind], prerun: all.PRERUN || '', models: all.MODELS || '', kind, paid: isPayPerUse(env), env };
}

/** All profiles, sorted by name. */
export function listProfiles() {
  let names;
  try {
    names = fs.readdirSync(profilesDir());
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names
    .filter((f) => f.endsWith('.env'))
    .map((f) => f.slice(0, -4))
    .filter(validName)
    .sort()
    .map(readProfile)
    .filter(Boolean);
}

/** The only view of a profile that may be shown outside this machine: no values. */
export function publicProfile(p) {
  return { name: p.name, label: p.label, kind: p.kind, paid: p.paid === true };
}

/** Create or replace a profile. The folder is 700 and the file 600. */
export function writeProfile(name, { label = '', prerun = '', models = '', env = {} } = {}) {
  if (!validName(name)) throw new Error(`"${name}" is not a usable profile name (a-z, 0-9, - and _, not a command word)`);
  for (const k of Object.keys(env)) {
    if (!KEY_RE.test(k) || META.has(k)) throw new Error(`"${k}" is not a usable variable name`);
    if (/[\r\n]/.test(env[k])) throw new Error(`the value of ${k} has a line break`);
  }
  if (/[\r\n]/.test(label) || /[\r\n]/.test(prerun) || /[\r\n]/.test(models)) throw new Error('label, prerun and models must be one line');
  const lines = [];
  if (label) lines.push(`LABEL=${quote(label)}`);
  if (prerun) lines.push(`PRERUN=${quote(prerun)}`);
  if (models) lines.push(`MODELS=${quote(models)}`);
  for (const [k, v] of Object.entries(env)) lines.push(`${k}=${quote(v)}`);
  fs.mkdirSync(profilesDir(), { recursive: true, mode: 0o700 });
  const file = fileOf(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return readProfile(name);
}

export function deleteProfile(name) {
  if (!validName(name)) return false;
  try {
    fs.unlinkSync(fileOf(name));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/** The environment Claude Code gets for this profile: `base` without any auth variable, plus the profile's own. */
export function profileEnv(profile, base = process.env) {
  const env = { ...base };
  for (const k of AUTH_VARS) delete env[k];
  Object.assign(env, profile.env);
  env.HOPRIG_PROFILE = profile.name;
  return env;
}
