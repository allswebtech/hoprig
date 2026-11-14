// What every service definition (systemd, launchd, Windows Task Scheduler) shares.

// Variables copied from the installing shell into the service, when set. PATH is the important one: a service
// manager's own PATH does not include nvm's node, ~/.local/bin (claude) and the like.
export const CARRIED_ENV = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HOPRIG_CONFIG_DIR', 'HOPRIG_PROFILES_DIR', 'HOPRIG_STATE_DIR', 'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
];

/** [name, value] of the carried variables that are set in `env`. */
export const carried = (env = process.env) => CARRIED_ENV.filter((k) => env[k]).map((k) => [k, String(env[k])]);
