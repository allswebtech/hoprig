// Which environment variables are secrets: a provider's key or address, a coding tool's sign-in or server password,
// and Hoprig's own tokens. This is the one list. Everything that starts npm, an install script, a download, a
// coding tool's server or sign-in, or the demo takes these out with withoutSecrets() (an install also loses GitHub's
// tokens: forInstalls()); no other file keeps a list of its own. It matters when `hoprig tools install` or an update runs inside a session whose environment holds keys:
// an install script is code from the internet and must not see them.
//
// A coding tool started FOR a provider gets that provider's key afterwards, from the provider (profileEnv, toolEnv,
// serverEnv): taking all of them out first is what keeps one provider's key from reaching another provider's tool.

import { listProfiles } from './profiles.mjs';

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

// GitHub's tokens are the owner's own, for his own work: a coding tool's gh or git push, a project's packages from
// GitHub's registry. They stay for those. A program Hoprig installs or updates from the internet (npm packages and
// their scripts, an installer script, a kit, cloudflared) needs none of them.
const GITHUB = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);
// A provider may export a key under a name of its own (AWS_BEARER_TOKEN_BEDROCK, a gateway's KEY): a session started
// under it holds that variable, and so does an install run inside the session. Of what the stored providers export,
// the names that look like a credential are left out of an install too (not every name: a provider's proxy or
// region is no secret, and an install may need it).
const CREDENTIAL = /KEY|TOKEN|SECRET|PASSW|AUTH|CREDENTIAL|BEARER/i;

/** Names the stored providers export that look like a credential. Read on each install (rare), never cached. */
function providerKeys() {
  try {
    return new Set(listProfiles().flatMap((p) => Object.keys(p.env)).filter((k) => CREDENTIAL.test(k)));
  } catch {
    return new Set(); // no providers folder, or one that cannot be read: the fixed list still holds
  }
}

/** The environment of an install or update Hoprig runs from the internet: no secret, and no GitHub token either. */
export function forInstalls(env = process.env) {
  const out = withoutSecrets(env);
  const own = providerKeys();
  for (const k of Object.keys(out)) if (GITHUB.has(process.platform === 'win32' ? k.toUpperCase() : k) || own.has(k)) delete out[k];
  return out;
}

// What a program the owner defined as a gateway gets of the starting process's environment: only what a server needs
// to run (where programs and its own files are, language and time, a proxy and certificates for the providers it
// calls), and on Windows what the system needs. Nothing else: the PRERUN that starts it runs in a session's
// environment, which holds other providers' keys, cloud credentials, an SSH agent and the session's own marks, and
// no list of secrets can name them all. Its key arrives with each request.
const GATEWAY_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const GATEWAY_WINDOWS = new Set(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']);
const GATEWAY_PREFIXES = ['LC_', 'XDG_'];

/** The environment a gateway the owner defined starts with: the names above from `env`, nothing else. */
export function forGateway(env = process.env, platform = process.platform) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    const n = k.toUpperCase(); // proxy variables are often lower-case; Windows' names are case-blind
    const known = platform === 'win32' ? GATEWAY_NAMES.has(n) || GATEWAY_WINDOWS.has(n) : GATEWAY_NAMES.has(n) && (n === k || n.endsWith('_PROXY'));
    if (known || GATEWAY_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
