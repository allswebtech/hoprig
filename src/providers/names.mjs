// The model names Claude Code can send through a profile's endpoint, kept as data with the version they were read
// from: what each alias means today, and the names the tool falls back to when the endpoint refuses a model (its
// model data, `fallback_3p`). A gateway that knows the first name but not one it falls back to stops the work when
// the tool falls back (seen: the newest model flagged a request, the tool sent it on to the model before it, and the
// gateway answered "400 Ambiguous model"). The provider check (check.mjs) asks for each of these names as a session
// sends them, after the session's map where its switch is on (sessionmap.mjs).
//
// Read from Claude Code 2.1.328 against a stand-in endpoint: `--model opus` sent claude-opus-5-5, `sonnet`
// claude-sonnet-5-5, `haiku` claude-haiku-5-5, `fable` claude-fable-5-2, no model at all claude-opus-5-5. The chains
// are each model's `fallback_3p` in that version's model data, followed to their end (a model with none): how many
// steps the tool walks on one refusal was not measured, so every name it may reach is asked.
// Read again when a new Claude Code changes its aliases (docs/PROVIDERS.md says how).

export const TOOL_VERSION = '2.1.328';

/** What each alias means today on an endpoint of the owner's choice (the model the tool starts on is `opus`'s). */
export const ALIASES = Object.freeze({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' });

/** Each chain: a name, then the names the tool falls back to in turn. */
export const FALLBACKS = Object.freeze([
  ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1'],
  ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5'],
  ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0'],
  ['claude-haiku-5-5', 'claude-haiku-4-5'],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
]);

/** The small model's names: the tool does not rename them through modelOverrides, only by ANTHROPIC_DEFAULT_HAIKU_MODEL. */
export const isSmall = (name) => /^claude-haiku-/.test(String(name)) || name === 'haiku';

// The variables of a profile that name a model the tool then sends instead of the alias's own.
const OWN = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];

/** Every name of the data, once, in the order of the chains. */
export function toolNames() {
  return [...new Set(FALLBACKS.flat())];
}

/**
 * What the tool can send through `profile` ({ env }), as a plain session of it sends them: [{ asks, also, sends, why }],
 * one row per name sent (`asks`: the first name that sends it, `also`: every name that does; `why`: where `asks` comes
 * from). `map` is the session's map ({ overrides, haiku }: sessionmap.mjs sessionMap, with `overrides` null where the
 * installed Claude Code does not take it). No router stands between a plain session and its endpoint, so a profile's
 * MODELS reach the request only through that map: the profile's own model variables go out as they are (unless the
 * map names them), and the small model's names go out as the profile's small model when it names one, else as the
 * map's. The profile's own variables come first: the tool starts on them.
 */
export function namesFor(profile, map = null) {
  const env = profile?.env || {};
  const over = map?.overrides || {};
  const small = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || map?.haiku || null;
  const asked = [];
  for (const k of OWN) if (env[k]) asked.push({ asks: env[k], why: `the profile's ${k}`, sends: over[env[k]] || env[k] });
  for (const chain of FALLBACKS) {
    chain.forEach((n, i) => asked.push({ asks: n, why: i === 0 ? aliasOf(n) : `what ${chain[i - 1]} falls back to`, sends: isSmall(n) ? small || n : over[n] || n }));
  }
  const out = [];
  const by = new Map();
  for (const a of asked) {
    const row = by.get(a.sends);
    if (row) {
      if (!row.also.includes(a.asks)) row.also.push(a.asks);
      continue;
    }
    const r = { asks: a.asks, also: [a.asks], sends: a.sends, why: a.why };
    by.set(a.sends, r);
    out.push(r);
  }
  return out;
}

function aliasOf(name) {
  const alias = Object.keys(ALIASES).find((k) => ALIASES[k] === name);
  return alias ? `what "${alias}" means today` : 'a name the tool asks for';
}

/** The model a picture goes to: the one the tool starts on through this profile, after the session's map. */
export function pictureModel(profile, map = null) {
  const n = profile?.env?.ANTHROPIC_MODEL || ALIASES.opus;
  return map?.overrides?.[n] || n;
}
