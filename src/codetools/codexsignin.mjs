// Codex's own sign-in: a "Codex sign-in" provider (SIGNIN=codex) means the ChatGPT account Codex keeps in its own
// folder ($CODEX_HOME, else ~/.codex). Hoprig never reads, copies or moves that sign-in. It asks Hoprig's copy of
// Codex whether it is signed in (`codex login status`: "Logged in using …" or "Not logged in", checked with 0.169),
// and signs in by running Hoprig's copy (`hoprig codex login --device-auth`: a link and a code for the browser), so
// nobody needs Codex on PATH or a global install (a global Codex updates itself).
import { capture } from '../setup/system.mjs';
import { codex } from './codex.mjs';
import { cleanEnv } from './servers.mjs';

const TTL_MS = 30_000;
let cached = null; // { at, value }

/** Hoprig's Codex with its no-self-update switches and `login <args>`. */
export const loginArgv = (args = []) => codex.argv([...codex.noSelfUpdate.args, 'login', ...args]);

/** What `codex login status` printed, as true (signed in), false (not) or null (cannot tell). */
export function readLoginStatus(r) {
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (/^\s*Not logged in/m.test(text)) return false;
  if (r.ok && /^\s*Logged in\b/m.test(text)) return true;
  return null;
}

/** Is Codex signed in on this computer? null when Codex is not installed or does not say. Cached for 30 seconds. */
export async function codexSignedIn({ run = capture, env = process.env, now = Date.now, fresh = false } = {}) {
  if (!codex.installedVersion()) return null;
  if (!fresh && cached && now() - cached.at < TTL_MS) return cached.value;
  const r = await run(loginArgv(['status']), { env: cleanEnv(env), timeout: 15_000 });
  cached = { at: now(), value: readLoginStatus(r) };
  return cached.value;
}

/** Forget the cached answer (after a sign-in, and in tests). */
export const forgetSignin = () => { cached = null; };
