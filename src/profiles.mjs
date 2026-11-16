// A profile is one file, <profilesDir>/<name>.env, with KEY=VALUE lines:
//
//   LABEL=Work subscription            shown in menus (optional)
//   PRERUN=my-proxy start              shell command run before the coding tool starts (optional)
//   MODELS=claude-fable-*=claude-opus-5-5   model names this endpoint needs instead, for Auto mode's router
//                                      (optional; "from=to" pairs separated by commas, * matches anything)
//   API=messages,responses,chat,models the API shapes the endpoint answers, saved by "Test" (optional, see below)
//   TOOLS=claude,opencode              narrows the coding tools that may use it (optional)
//   SIGNIN=codex                       the sign-in Codex keeps itself (`codex login`), see "chatgpt" below
//   CLAUDE_CODE_OAUTH_TOKEN=...        every other line is exported to the coding tool
//
// What a profile is, by what it exports:
//   nothing                                   "login"         the account stored by `claude /login`
//   CLAUDE_CODE_OAUTH_TOKEN                   "subscription"  another Claude account (`claude setup-token`)
//   ANTHROPIC_API_KEY / _AUTH_TOKEN / _BASE_URL   "api"       a key for Claude's API, direct or through a gateway
//   OPENAI_API_KEY (+ OPENAI_BASE_URL)        "openai"        a key for OpenAI's API or a service that speaks it
//   SIGNIN=codex and nothing else             "chatgpt"       the ChatGPT account Codex is signed in to
//
// Which coding tools a profile serves (servesTools): a Claude sign-in serves Claude Code only, always (its terms
// allow no other program; enforced where a session or chat starts). A Codex sign-in serves Codex only. A key serves
// the tools whose API shape the endpoint answers: Claude Code needs "messages", Codex "responses", OpenCode
// "messages" or "chat". Without an API= line a Claude key counts as "messages" and an OpenAI key as "responses" and
// "chat" (what those services answer); "Test" on the Providers page asks the endpoint and writes the line.
//
// Values are secrets: nothing here prints them, and publicProfile() is the only shape that may leave the machine.
// It names only the coding tools this version offers (src/codetools/offered.mjs), and a provider that serves none
// of them (a Codex sign-in, a key that answers only Codex's API) comes with `unusable: true`: kept, not used.
import fs from 'node:fs';
import path from 'node:path';
import { offeredOnly } from './codetools/offered.mjs';
import { profilesDir } from './paths.mjs';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Words that are commands (hoprig's own, and common wrapper commands), so they cannot name a profile.
export const RESERVED = new Set([
  'run', 'add', 'rm', 'profiles', 'serve', 'hook', 'help', 'passwd', 'service', 'doctor', 'version', 'setup', 'claude', 'auto', 'pair', 'tokens', 'machines', 'mcp', 'addons', 'router', 'router-url', 'assistant', 'link', 'join', 'public', 'pc', 'demo', 'project', 'skills', 'workspace', 'tools', 'codex', 'opencode', 'chat',
  'x', 'start', 'stop', 'restart', 'update', 'log', 'logs', 'open', 'status',
]);
const META = new Set(['LABEL', 'PRERUN', 'MODELS', 'API', 'TOOLS', 'SIGNIN']);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Auth variables a profile decides, for every coding tool. They are cleared before a profile is applied, so one
 * provider's key never leaks into another provider or into another tool's environment.
 */
export const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'];
/** The API shapes an endpoint can answer: Claude's messages, OpenAI's responses and chat completions, a model list. */
export const API_SHAPES = Object.freeze(['messages', 'responses', 'chat', 'models']);
/** The coding tools, in their fixed order (the descriptors are in src/codetools; this file stays free of them). */
export const TOOL_IDS = Object.freeze(['claude', 'codex', 'opencode']);
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

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

/** The kind of a profile from what it exports (`meta`: its LABEL/API/SIGNIN… lines). */
export function kindOf(env, meta = {}) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return 'api';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'subscription';
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) return 'openai';
  if (meta.SIGNIN === 'codex') return 'chatgpt';
  return 'login';
}

/** A comma list of known words (API=, TOOLS=): unknown words are dropped, the order is the fixed one. */
const listOf = (v, known) => {
  const words = String(v || '').split(',').map((x) => x.trim().toLowerCase());
  return known.filter((k) => words.includes(k));
};

/**
 * Pay-per-use: an Anthropic API key that goes straight to Anthropic (no address, or Anthropic's own). A key that
 * goes through a gateway (TRouteAI, a proxy, another computer's gateway) is not: what it costs is the gateway's
 * business. Auto mode uses pay-per-use providers only when the owner turns that on. The one place of this rule:
 * the page gets it as `paid` on every provider.
 */
export function isPayPerUse(env) {
  if (kindOf(env) === 'openai') {
    // The same rule for OpenAI's own API: a key straight to it is paid; through a gateway it is not ours to say.
    if (!env.OPENAI_API_KEY) return false;
    try {
      return !env.OPENAI_BASE_URL || new URL(env.OPENAI_BASE_URL).hostname === 'api.openai.com';
    } catch {
      return true;
    }
  }
  if (kindOf(env) !== 'api' || !(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) return false;
  if (!env.ANTHROPIC_BASE_URL) return true;
  try {
    return new URL(env.ANTHROPIC_BASE_URL).hostname === 'api.anthropic.com';
  } catch {
    return true; // an address that cannot be read: counted as paid, the safe side
  }
}

const DEFAULT_LABEL = { login: 'Claude account (stored login)', subscription: 'Claude subscription', api: 'API', openai: 'OpenAI API', chatgpt: 'Codex sign-in' };

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
  const kind = kindOf(env, all);
  return {
    name, label: all.LABEL || DEFAULT_LABEL[kind], prerun: all.PRERUN || '', models: all.MODELS || '', kind, paid: isPayPerUse(env), env,
    api: listOf(all.API, API_SHAPES), tools: listOf(all.TOOLS, TOOL_IDS), signin: all.SIGNIN === 'codex' ? 'codex' : '',
  };
}

/** The lines of a profile that are not its environment, to write it again unchanged (rename, new model, sign-in). */
export const metaOf = (p) => ({ label: p.label, prerun: p.prerun, models: p.models, api: p.api || [], tools: p.tools || [], signin: p.signin || '' });

/**
 * The API shapes a key provider is known to answer: its API= line, else what its kind implies (a Claude key:
 * Claude's API; an OpenAI key: the Responses and chat APIs).
 */
export function knownShapes(p) {
  if (!p) return [];
  if (p.api && p.api.length) return [...p.api];
  return (p.kind || kindOf(p.env || {}, { SIGNIN: p.signin })) === 'openai' ? ['responses', 'chat'] : ['messages'];
}

/**
 * The coding tools a profile serves, in the fixed order. The one place of the rule (see the header). A Claude
 * sign-in ("login", "subscription") and Auto mode serve Claude Code and nothing else, whatever its file says.
 */
export function servesTools(p) {
  if (!p) return [];
  const kind = p.kind || kindOf(p.env || {}, { SIGNIN: p.signin }); // a profile object built in code may carry no kind
  if (kind === 'login' || kind === 'subscription' || kind === 'auto') return ['claude'];
  if (kind === 'chatgpt') return ['codex'];
  const shapes = knownShapes({ ...p, kind });
  const out = [];
  if (kind === 'api' && shapes.includes('messages')) out.push('claude'); // Claude Code reads only ANTHROPIC_* variables
  if (shapes.includes('responses')) out.push('codex'); // Codex speaks only the Responses API (0.169 refuses "chat")
  if (shapes.includes('messages') || shapes.includes('chat')) out.push('opencode');
  return p.tools && p.tools.length ? out.filter((t) => p.tools.includes(t)) : out;
}

/** The plain sentence that says why `p` may not be used for coding tool `tool` ('' when it may). */
export function whyNotServed(p, tool) {
  if (servesTools(p).includes(tool)) return '';
  const name = TOOL_NAMES[tool] || tool;
  const kind = p ? p.kind || kindOf(p.env || {}, { SIGNIN: p.signin }) : '';
  const why = kind === 'login' || kind === 'subscription' || kind === 'auto' ? 'a Claude subscription is for Claude Code only'
    : kind === 'chatgpt' ? 'it is the sign-in of another coding tool'
      : 'it does not answer the API that tool speaks (Test it on the Providers page, or choose another provider)';
  return `The provider "${p ? p.label || p.name : '?'}" cannot be used for ${name}: ${why}.`;
}

/** Throws the sentence of whyNotServed (status 400) when `p` may not be used for coding tool `tool`. */
export function assertServes(p, tool) {
  const why = whyNotServed(p, tool);
  if (why) throw Object.assign(new Error(why), { status: 400 });
}

/**
 * For the command line, when `p` cannot start `tool`: why, and the one thing to do instead (the command of a coding
 * tool this version offers that can use it, else how to pick or add another provider). Two lines.
 */
export function notServedLines(p, tool) {
  const other = offeredOnly(servesTools(p)).filter((t) => t !== tool);
  const cmd = (t) => (t === 'claude' ? `hoprig ${p.name}` : `hoprig ${t} ${p.name}`);
  return [
    `hoprig: ${whyNotServed(p, tool)}`,
    other.length ? `It works with ${other.map((t) => TOOL_NAMES[t]).join(' and ')}: ${cmd(other[0])}` : 'Choose another provider (hoprig profiles), or add one: hoprig add',
  ];
}

/**
 * Provider files whose name is now a command word (RESERVED: e.g. "tools", "codex", "opencode" since those became
 * commands). listProfiles leaves them out, so doctor names them; they are never deleted.
 */
export function hiddenProfiles() {
  try {
    return fs.readdirSync(profilesDir()).filter((f) => f.endsWith('.env') && RESERVED.has(f.slice(0, -4))).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
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

/**
 * The only view of a profile that may be shown outside this machine: no values, and only the coding tools this
 * version offers (a provider that serves none of them is `unusable`: kept, nothing uses it).
 */
export function publicProfile(p) {
  const tools = offeredOnly(servesTools(p));
  return { name: p.name, label: p.label, kind: p.kind, paid: p.paid === true, tools, ...(tools.length ? {} : { unusable: true }) };
}

/** Create or replace a profile. The folder is 700 and the file 600. */
export function writeProfile(name, { label = '', prerun = '', models = '', api = [], tools = [], signin = '', env = {} } = {}) {
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
  const apiList = listOf((api || []).join(','), API_SHAPES);
  if (apiList.length) lines.push(`API=${apiList.join(',')}`);
  const toolList = listOf((tools || []).join(','), TOOL_IDS);
  if (toolList.length) lines.push(`TOOLS=${toolList.join(',')}`);
  if (signin === 'codex') lines.push('SIGNIN=codex');
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

/**
 * The environment Claude Code gets for this profile: `base` without any auth variable, plus the profile's own. Every
 * Claude Code start (terminal, chat, Tia) goes through here, so a provider that does not serve Claude Code (an
 * OpenAI key, a Codex sign-in) is refused here too, not only in the pickers. Other tools: src/codetools/providers.mjs.
 */
export function profileEnv(profile, base = process.env) {
  assertServes(profile, 'claude');
  const env = { ...base };
  for (const k of AUTH_VARS) delete env[k];
  Object.assign(env, profile.env);
  env.HOPRIG_PROFILE = profile.name;
  return env;
}
