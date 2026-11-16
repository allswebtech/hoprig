// What a coding tool gets from a provider when Hoprig starts it. The provider's key travels in a variable of the
// started process (for a tool's server: one variable per provider it serves); nothing is written into the tool's own
// config file, and nothing of one provider (or of the surrounding shell) reaches another tool's environment.
// What the tool passes on to the commands it runs for the model is its own business: Codex is told to drop the key
// variables there (codex.keyFilter); OpenCode has no such filter (2.3), so a command in an OpenCode session can read
// the keys of the OpenCode providers and its server's password. The same user can read the provider files anyway;
// this is a second layer, not the first.
//
//   Claude Code   the provider's variables as they are (src/profiles.mjs profileEnv; unchanged)
//   Codex         a model-provider block given on the command line (`-c model_providers.hoprig.…`, checked with
//                 Codex 0.169: base_url, env_key, wire_api "responses" — "chat" is refused there) and the key in
//                 HOPRIG_CODEX_KEY, the variable the block names. A Codex sign-in needs neither: Codex uses the
//                 ChatGPT account it keeps in its own folder.
//   OpenCode      a provider block in a config file in Hoprig's own folder (OPENCODE_CONFIG; OpenCode merges it
//                 over its global config, so the brain's instructions stay), whose key is "{env:HOPRIG_OPENCODE_KEY}"
//                 (OpenCode reads the variable when it starts): the file holds no secret. Its models are the ones the
//                 provider itself lists (providerModels); OpenCode's own list does not know a gateway's models.
//
// startSettings(tool, profile, …) refuses a provider that does not serve the tool (profiles.mjs servesTools): a
// Claude subscription never reaches Codex or OpenCode.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { AUTH_VARS, assertServes, kindOf } from '../profiles.mjs';
import { codex } from './codex.mjs';
import { opencode } from './opencode.mjs';

/** The variable each tool reads the key from (named in its provider block). */
export const KEY_VAR = Object.freeze({ codex: 'HOPRIG_CODEX_KEY', opencode: 'HOPRIG_OPENCODE_KEY' });
/** The provider id Hoprig uses inside Codex's and OpenCode's config ("openai" and others are reserved by Codex). */
export const PROVIDER_ID = 'hoprig';
const FETCH_TIMEOUT_MS = 10_000;
// A letter or digit first: an id that starts with "-" would be read as an option by the tool.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;

const trimBase = (u) => String(u).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
const modelOf = (p) => (p.env && p.env.ANTHROPIC_MODEL) || (/^\*=([^,]+)$/.exec(p.models || '') || [])[1] || '';

/**
 * A key provider's endpoint, server side only: { base (without /v1), key, auth: 'x'|'bearer', model }. null for a
 * provider without a key (a sign-in). The base comes from ANTHROPIC_BASE_URL or OPENAI_BASE_URL, else the service's own.
 */
export function endpointOf(p) {
  const env = (p && p.env) || {};
  const kind = p.kind || kindOf(env);
  if (kind === 'api') {
    return { base: trimBase(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'), key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '', auth: env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x', model: modelOf(p) };
  }
  if (kind === 'openai') return { base: trimBase(env.OPENAI_BASE_URL || 'https://api.openai.com'), key: env.OPENAI_API_KEY || '', auth: 'bearer', model: modelOf(p) };
  return null;
}

/** A TOML string (Codex parses every -c value as TOML): JSON's escapes are TOML's, plus DEL. */
export const tomlString = (s) => JSON.stringify(String(s)).replace(/\x7f/g, '\\u007f');

/**
 * The environment `tool` (codex | opencode) gets for `profile`: `base` without any provider variable of any tool,
 * the tool's own no-self-update switches, and the key in the one variable its provider block names.
 */
export function toolEnv(tool, profile, base = process.env) {
  assertServes(profile, tool);
  const env = { ...base };
  for (const k of [...AUTH_VARS, ...Object.values(KEY_VAR)]) delete env[k];
  for (const k of Object.keys(env)) if (/^ANTHROPIC_/.test(k)) delete env[k];
  Object.assign(env, (tool === 'codex' ? codex : opencode).noSelfUpdate.env);
  const ep = endpointOf(profile);
  if (ep && ep.key) env[KEY_VAR[tool]] = ep.key;
  env.HOPRIG_PROFILE = profile.name;
  return env;
}

/** Codex: its command-line settings for `profile` (no self-update, and the provider block for a key). */
export function codexArgs(profile) {
  assertServes(profile, 'codex');
  const args = [...codex.noSelfUpdate.args, ...codex.keyFilter];
  const ep = endpointOf(profile);
  const set = (k, v) => args.push('-c', `${k}=${tomlString(v)}`);
  // A Codex sign-in: Codex's own OpenAI provider with its stored account, named so its config cannot choose another.
  if (!ep) return set('model_provider', 'openai'), args;
  set('model_provider', PROVIDER_ID);
  set(`model_providers.${PROVIDER_ID}.name`, profile.label || profile.name);
  set(`model_providers.${PROVIDER_ID}.base_url`, `${ep.base}/v1`);
  set(`model_providers.${PROVIDER_ID}.env_key`, KEY_VAR.codex);
  set(`model_providers.${PROVIDER_ID}.wire_api`, 'responses');
  if (ep.model) set('model', ep.model);
  return args;
}

/**
 * OpenCode: the config Hoprig gives it for `profile` (no secret in it). `models`: the ids the provider lists; the
 * pinned model is always among them. Claude's API shape is preferred when the endpoint answers both.
 */
export function opencodeConfig(profile, models = []) {
  assertServes(profile, 'opencode');
  const ep = endpointOf(profile);
  const shapes = profile.api && profile.api.length ? profile.api : (profile.kind || kindOf(profile.env || {})) === 'openai' ? ['chat'] : ['messages'];
  const pkg = shapes.includes('messages') ? '@opencode/ai/providers/anthropic-compatible' : '@opencode/ai/providers/openai-compatible';
  const ids = [...new Set([ep.model, ...models].filter((m) => typeof m === 'string' && MODEL_RE.test(m)))].slice(0, 200);
  return {
    $schema: 'https://opencode.ai/config.json',
    ...opencode.noSelfUpdate.config,
    providers: {
      [PROVIDER_ID]: {
        name: profile.label || profile.name,
        package: pkg,
        settings: { baseURL: `${ep.base}/v1`, apiKey: `{env:${KEY_VAR.opencode}}` },
        models: Object.fromEntries(ids.map((id) => [id, { name: id }])),
      },
    },
    ...(ep.model ? { model: `${PROVIDER_ID}/${ep.model}` } : {}),
  };
}

/** The folder of the OpenCode config files Hoprig writes (one per provider; never OpenCode's own folder). */
export const opencodeConfigDir = () => path.join(stateDir(), 'codetools', 'opencode');

/**
 * Write `profile`'s OpenCode config into Hoprig's folder; returns the variables that point OpenCode at it, to be
 * added to toolEnv('opencode', …). The file is private (0600) although it holds no key.
 */
export function writeOpencodeConfig(profile, models = [], dir = opencodeConfigDir()) {
  const file = path.join(dir, `${profile.name}.json`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(opencodeConfig(profile, models), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { OPENCODE_CONFIG: file };
}

/** What `tool` needs at start for `profile`: { args, env } (OpenCode's env names its config file). */
export async function startSettings(tool, profile, { base = process.env, fetchImpl = globalThis.fetch, dir } = {}) {
  if (tool === 'codex') return { args: codexArgs(profile), env: toolEnv('codex', profile, base) };
  if (tool === 'opencode') {
    const env = toolEnv('opencode', profile, base);
    return { args: [...opencode.noSelfUpdate.args], env: { ...env, ...writeOpencodeConfig(profile, await providerModels(profile, { fetchImpl }), dir) } };
  }
  throw new Error(`no start settings for "${tool}" here (Claude Code: profiles.mjs profileEnv)`);
}

/**
 * The model ids the provider itself lists (GET <base>/v1/models), [] when it lists none or cannot be reached. The
 * key goes only to the provider's own address; a redirect is never followed.
 */
export async function providerModels(profile, { fetchImpl = globalThis.fetch } = {}) {
  const ep = endpointOf(profile);
  if (!ep || !ep.key) return [];
  for (const auth of ep.auth === 'bearer' ? ['bearer', 'x'] : ['x', 'bearer']) {
    try {
      const r = await fetchImpl(`${ep.base}/v1/models?limit=1000`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'anthropic-version': '2023-06-01', ...(auth === 'bearer' ? { Authorization: `Bearer ${ep.key}` } : { 'x-api-key': ep.key }) },
      });
      if (r.status === 401 || r.status === 403) continue;
      if (r.status !== 200) return [];
      const j = JSON.parse(await r.text());
      const list = Array.isArray(j && j.data) ? j.data : Array.isArray(j) ? j : [];
      return list.map((m) => (m && typeof m.id === 'string' ? m.id : typeof m === 'string' ? m : null)).filter((id) => id && MODEL_RE.test(id)).slice(0, 200);
    } catch {
      return [];
    }
  }
  return [];
}
