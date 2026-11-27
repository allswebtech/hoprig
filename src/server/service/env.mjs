// What every service definition (systemd, launchd, Windows Task Scheduler) shares.
import { LOCALE_VARS, installedLocales, localeThere } from '../../setup/locale.mjs';

// Variables copied from the installing shell into the service, when set. PATH is the important one: a service
// manager's own PATH does not include nvm's node, ~/.local/bin (claude) and the like.
export const CARRIED_ENV = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HOPRIG_CONFIG_DIR', 'HOPRIG_PROFILES_DIR', 'HOPRIG_STATE_DIR', 'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
];

/**
 * [name, value] of the carried variables that are set in `env`. A locale variable that names a locale this computer
 * lacks (`locales`: localeKey names, null when not known) is left out: the service would start every program with it.
 */
export const carried = (env = process.env, locales = installedLocales()) =>
  CARRIED_ENV.filter((k) => env[k] && (!LOCALE_VARS.includes(k) || localeThere(env[k], locales))).map((k) => [k, String(env[k])]);

/**
 * `expected` with the text between `from` and `to` taken from `existing`: the keeper compares a service file with what
 * the product would write, and the carried variables are those of the installing shell, which the keeper does not
 * have. Without both markers in both texts, `expected` is returned as it is.
 */
export function swapBetween(existing, expected, from, to) {
  if (typeof existing !== 'string') return expected;
  const a = existing.indexOf(from);
  const b = a < 0 ? -1 : existing.indexOf(to, a);
  const c = expected.indexOf(from);
  const d = c < 0 ? -1 : expected.indexOf(to, c);
  if (b < 0 || d < 0) return expected;
  return expected.slice(0, c) + existing.slice(a, b) + expected.slice(d);
}
