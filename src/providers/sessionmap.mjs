// The map for sessions: a profile's MODELS rules, which Auto mode's router applies to each request, given to a
// plain session (and a chat) of that profile through the coding tool's own setting, so an agent that asks for "opus" or
// a name the tool falls back to reaches the same endpoint under a name it serves. It renames a model on the SAME
// profile's endpoint and key only: the address, the key and the profile stay as they are.
//
// ONLY WHERE THE OWNER TURNED IT ON (the profile's MAPSESSIONS=on, from his page or his command): MODELS were written
// for Auto mode's router, and an update must not send every session of a provider to another model by itself. With the
// switch off a session gets nothing from here (no rename, no small model's name); the page shows what it WOULD get
// (mapPreview). Auto mode's router reads MODELS as before, with or without the switch.
//
// What Claude Code 2.1.328 does with it (read in a temporary home): a `--settings` file's `modelOverrides` REPLACES the
// owner's own `modelOverrides` (they are not merged), so his entries are read from his settings file and copied into
// the session's, and for a name both map his entry wins. It renames the large models, also inside agents, but not the
// small model: that one is named by ANTHROPIC_DEFAULT_HAIKU_MODEL, which is set for that session only. The owner's
// settings file is only read, never written. Auto mode's router keeps its own mapping (mapModel): an Auto session gets
// no map here, so nothing is mapped twice.

import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from '../paths.mjs';
import { isPayPerUse } from '../profiles.mjs';
import { mapModel } from '../router.mjs';
import { compareVersions } from '../setup/system.mjs';
import { ALIASES, TOOL_VERSION, isSmall, toolNames } from './names.mjs';

// The version the setting was read from; an older or unknown Claude Code gets no `modelOverrides` (the small model's
// variable is plain environment and is set for every version).
export const MAP_SINCE = TOOL_VERSION;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;

/**
 * The Claude Code folder a session of `profile` reads its settings from: the profile's own CLAUDE_CONFIG_DIR (an
 * account of its own), else the default. The flag file replaces that folder's modelOverrides, so they are the ones to
 * copy in: another folder's would send this endpoint another account's model names.
 */
export const configDirOf = (profile) => profile?.env?.CLAUDE_CONFIG_DIR || claudeDir();

/** The owner's own modelOverrides (his Claude Code settings file), read only: { name: name }. */
export function ownOverrides(dir = claudeDir()) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).modelOverrides;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    return Object.fromEntries(Object.entries(m).filter(([k, v]) => typeof v === 'string' && NAME.test(k) && NAME.test(v)));
  } catch {
    return {};
  }
}

// The rules a session of `profile` is mapped by. A bare "*=<model>" is the model the owner chose on Providers (save and
// "Change model" write it beside ANTHROPIC_MODEL, which the session starts on anyway). On a key that is paid per use
// it is not spread over every other name: the small model's calls and an agent's sonnet or haiku calls would then
// all be billed as the chosen model, which the owner never chose. Only his explicit name rules map there.
function rulesOf(profile) {
  const all = String(profile.models || '').split(',').map((r) => r.trim()).filter(Boolean);
  const paid = typeof profile.paid === 'boolean' ? profile.paid : isPayPerUse(profile.env || {});
  return (paid ? all.filter((r) => !/^\*\s*=/.test(r)) : all).join(',');
}

// The literal names a profile's rules name (no "*"): mapped too, beside the tool's own names.
const literals = (models) => String(models || '').split(',').map((r) => r.slice(0, Math.max(0, r.indexOf('='))).trim()).filter((n) => n && !n.includes('*') && NAME.test(n));

/**
 * The map a session of `profile` gets: { overrides, haiku, rules } where `overrides` is the settings value (null when
 * the profile maps nothing large), `haiku` the small model's name for ANTHROPIC_DEFAULT_HAIKU_MODEL (null: none), and
 * `rules` every rename as the page shows it: [{ from, to, by: 'profile' | 'yours' | 'small' }].
 */
export function sessionMap(profile, { own } = {}) {
  if (!profile || profile.mapSessions !== true) return { overrides: null, haiku: null, rules: [] };
  return mapPreview(profile, { own });
}

/** What a session of `profile` WOULD get with the switch on (the page shows it before he turns it on): as sessionMap. */
export function mapPreview(profile, { own = ownOverrides(configDirOf(profile)) } = {}) {
  const none = { overrides: null, haiku: null, rules: [] };
  if (!profile || profile.kind === 'auto' || profile.router) return none;
  const models = rulesOf(profile);
  if (!models) return none;
  const ours = {};
  let haiku = null;
  const rules = [];
  for (const n of [...new Set([...toolNames(), ...literals(models)])]) {
    const to = mapModel(n, { models });
    if (!to || to === n || !NAME.test(to)) continue;
    if (isSmall(n)) {
      // The default small model's own rule first (what "haiku" means today), else the first small name's.
      if (!haiku || n === ALIASES.haiku) haiku = to;
      continue;
    }
    ours[n] = to;
  }
  if (profile.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL) haiku = null; // the profile names its small model itself
  const names = Object.keys(ours);
  if (!names.length) return { overrides: null, haiku, rules: haiku ? [{ from: 'the small model', to: haiku, by: 'small' }] : [] };
  for (const n of names) if (!(n in own)) rules.push({ from: n, to: ours[n], by: 'profile' });
  for (const [n, to] of Object.entries(own)) rules.push({ from: n, to, by: 'yours' });
  if (haiku) rules.push({ from: 'the small model', to: haiku, by: 'small' });
  return { overrides: { ...ours, ...own }, haiku, rules };
}

/** The settings to add to a session's settings file: { modelOverrides } for a Claude Code that surely reads it, else {}. */
export function mapSettings(map, version) {
  if (!map?.overrides || !version || compareVersions(version, MAP_SINCE) < 0) return {};
  return { modelOverrides: map.overrides };
}

/** The session's environment with the small model's name, unless the environment names it already. */
export function mapEnv(env, map) {
  if (map?.haiku && !env.ANTHROPIC_DEFAULT_HAIKU_MODEL) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = map.haiku;
  return env;
}
