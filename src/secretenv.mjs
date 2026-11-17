// Which environment variables are secrets: a provider's key or address, a coding tool's sign-in or server password,
// and Hoprig's own tokens. This is the one list. Everything that starts npm, an install script, a download, a
// coding tool's server or sign-in, or the demo takes these out with withoutSecrets(); no other file keeps a list of
// its own. It matters when `hoprig tools install` or an update runs inside a session whose environment holds keys:
// an install script is code from the internet and must not see them.
//
// A coding tool started FOR a provider gets that provider's key afterwards, from the provider (profileEnv, toolEnv,
// serverEnv): taking all of them out first is what keeps one provider's key from reaching another provider's tool.

/** Secrets by exact name. */
const NAMES = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', // another Claude account's sign-in (`claude setup-token`)
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', // an OpenAI provider: its key, and its address (which may carry a key itself)
  'CODEX_API_KEY', // Codex's own key variable
  'OPENCODE_PASSWORD', // the password of an OpenCode server Hoprig started
  'HOPRIG_ASSISTANT_TOKEN', 'HOPRIG_ASSISTANT_TOKEN_FILE', // Tia's way into the dashboard, and the file that holds it
  'HOPRIG_PASSWORD_FILE', // the dashboard's password on a first start
]);

/** Secrets by the start of their name. */
const PREFIXES = [
  'ANTHROPIC_', // a Claude provider: key, token, address, custom headers (often a key), its model names
  'HOPRIG_OPENCODE_KEY', // the variable an OpenCode provider block names for its key (one per provider)
  'HOPRIG_CODEX_KEY', // the same for Codex
  'HOPRIG_CODEX_WS', // the token of a Codex app server Hoprig started
];

/** Is `name` a secret? Names are compared as written (Windows' case-blind names are written in capitals here). */
export const isSecretVar = (name) => {
  const n = String(name);
  const up = process.platform === 'win32' ? n.toUpperCase() : n;
  return NAMES.has(up) || PREFIXES.some((p) => up.startsWith(p));
};

/** A copy of `env` without any secret. */
export function withoutSecrets(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!isSecretVar(k)) out[k] = v;
  return out;
}
