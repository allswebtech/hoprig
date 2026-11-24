// A locale the computer lacks. An ssh client sends its own LANG and LC_* (macOS sends LC_CTYPE=UTF-8, a desktop
// en_GB.UTF-8), and a fresh cloud server often has only C, C.UTF-8 and POSIX: every program then warns
// ("setlocale: LC_ALL: cannot change locale") and some fall back to ASCII. Set-up says so once, with the fix, and runs
// its programs with C.UTF-8 (else C); the service never carries such a variable (src/server/service/env.mjs).
import { execFileSync } from 'node:child_process';
import { osRelease } from './system.mjs';

export const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

/** One name as `locale -a` writes it: lower case, "utf8" for "UTF-8" ("en_US.UTF-8" -> "en_us.utf8"). */
export const localeKey = (name) => String(name).trim().toLowerCase().replace(/\.utf-?8\b/, '.utf8');
const ALWAYS = new Set(['c', 'posix']);

/** The names in `locale -a` output, as a Set of localeKey, or null when it could not say. */
export function parseLocales(text) {
  const names = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return names.length ? new Set(names.map(localeKey)) : null;
}

/** Does `value` name a locale of `locales` (null: not known, so yes)? */
export function localeThere(value, locales) {
  if (!value || !locales) return true;
  const k = localeKey(value);
  return ALWAYS.has(k) || locales.has(k);
}

/** The locales of this computer, read once (Linux; elsewhere null: nothing is judged). */
let mine;
export function installedLocales(platform = process.platform) {
  if (platform !== 'linux') return null;
  if (mine !== undefined) return mine;
  try {
    mine = parseLocales(execFileSync('locale', ['-a'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    mine = null;
  }
  return mine;
}

/** The variable that decides the locale (LC_ALL, else LC_CTYPE, else LANG) when it names one that is not there: { name, value }, else null. */
export function missingLocale(env, locales) {
  const name = LOCALE_VARS.find((k) => env[k]);
  return name && !localeThere(env[name], locales) ? { name, value: env[name] } : null;
}

/** `env` for set-up's programs when its locale is missing: LANG=C.UTF-8 (C where that is missing too), no LC_ALL or missing LC_CTYPE. */
export function withWorkingLocale(env, locales) {
  if (!missingLocale(env, locales)) return env;
  const out = { ...env };
  for (const k of LOCALE_VARS) if (out[k] && (k === 'LC_ALL' || !localeThere(out[k], locales))) delete out[k];
  out.LANG = localeThere('C.UTF-8', locales) ? 'C.UTF-8' : 'C';
  return out;
}

/**
 * The fix for `missing`, as it can be typed. A full name (en_GB.UTF-8) is made on Ubuntu by `locale-gen <name>`; Debian's
 * locale-gen takes no name (it builds what /etc/locale.gen lists), so it is chosen there. A value with no language part
 * (macOS sends LC_CTYPE=UTF-8) names no locale anything could make: the person's side changes it.
 * `release`: /etc/os-release as system.mjs osRelease reads it.
 */
export function localeFix(missing, { pm = null, release = osRelease() } = {}) {
  if (!/^[A-Za-z]{2,3}_[A-Za-z]{2}([.@]|$)/.test(missing.value)) return `export ${missing.name}=C.UTF-8 in your shell's start file on this computer, or stop your ssh client sending it (SendEnv LC_* in its ssh config)`;
  const ids = `${release.ID || ''} ${release.ID_LIKE || ''}`.split(/\s+/);
  if (ids.includes('ubuntu')) return `sudo locale-gen ${missing.value}`;
  if (pm === 'apt' || ids.includes('debian')) return `sudo dpkg-reconfigure locales (choose ${missing.value})`;
  return 'export LANG=C.UTF-8 in your shell\'s start file';
}

/** The one line set-up says, with the fix. `used`: the LANG its programs run with instead. */
export function localeWords(missing, used, sys = {}) {
  const fix = localeFix(missing, { pm: sys.pm, ...(sys.release ? { release: sys.release } : {}) });
  return `The locale ${missing.value} (${missing.name}, sent by your terminal) is not on this computer: set-up runs its programs with ${used}. Fix: ${fix}`;
}
