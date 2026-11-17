// Where hoprig keeps things. Every location can be moved with an environment variable; nothing is hard-coded
// to one machine. Functions (not constants) so a test can change the environment between calls.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const home = () => os.homedir();

const windows = process.platform === 'win32';

/**
 * Settings and profiles: $HOPRIG_CONFIG_DIR, else $XDG_CONFIG_HOME/hoprig, else ~/.config/hoprig
 * (on Windows %APPDATA%\hoprig).
 */
export const configDir = () =>
  env.HOPRIG_CONFIG_DIR ||
  (env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, 'hoprig')
    : windows && env.APPDATA
      ? path.join(env.APPDATA, 'hoprig')
      : path.join(home(), '.config', 'hoprig'));

/** One `<name>.env` file per profile: $HOPRIG_PROFILES_DIR, else <configDir>/profiles. */
export const profilesDir = () => env.HOPRIG_PROFILES_DIR || path.join(configDir(), 'profiles');

export const configFile = () => path.join(configDir(), 'config.json');

/**
 * Runtime state (who runs where, last used profile): $HOPRIG_STATE_DIR, else $XDG_STATE_HOME/hoprig, else
 * ~/.local/state/hoprig (on Windows %LOCALAPPDATA%\hoprig\state).
 */
export const stateDir = () =>
  env.HOPRIG_STATE_DIR ||
  (env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'hoprig')
    : windows && env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'hoprig', 'state')
      : path.join(home(), '.local', 'state', 'hoprig'));

/** One JSON file per running launcher. */
export const runsDir = () => path.join(stateDir(), 'runs');

/**
 * The coding tools Hoprig installs itself (Codex, OpenCode): one npm prefix per tool under $HOPRIG_TOOLS_DIR, else
 * <stateDir>/tools. Never a global install.
 */
export const toolsDir = () => env.HOPRIG_TOOLS_DIR || path.join(stateDir(), 'tools');

/** The per-launch settings file handed to Claude Code (our hooks), one per running launcher. */
export const hookSettingsDir = () => path.join(stateDir(), 'hook-settings');

/** Claude Code's own folder. Sessions live in <claudeDir>/projects, shared by every profile. */
/** This computer's host name as the dashboard tells it (HOPRIG_HOSTNAME: the demo's made-up one). */
export const hostName = () => env.HOPRIG_HOSTNAME || os.hostname();
export const claudeDir = () => env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');

/**
 * The workspace (docs/WORKSPACE.md): $HOPRIG_WORKSPACE_DIR, else the "workspaceDir" setting (read in
 * src/workspace/layout.mjs, which knows the settings file), else ~/Workspace.
 */
export const workspaceEnvDir = () => env.HOPRIG_WORKSPACE_DIR || null;
export const defaultWorkspaceDir = () => path.join(home(), 'Workspace');

/** Absolute path of the hoprig executable script (bin/hoprig.mjs). */
export const binFile = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hoprig.mjs');

/** The small program Claude Code starts for a hook event (bin/hoprig-hook.mjs): `hoprig hook` without the rest. */
export const hookFile = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hoprig-hook.mjs');

// Where Hoprig comes from: the one place the install, the update and the lookup of the newest version all read, so
// they cannot drift apart (install.sh and install.ps1 carry the same address; a test holds them to it). Today that
// is the public repository's main branch: npm installs its tarball directly, and the newest version is the one in
// package.json on that branch. When the package is published on npm, this becomes the package name, and the
// lookup in src/setup/selfupdate.mjs asks npm instead.
const REPO = 'allswebtech/hoprig';
const BRANCH = 'main';
const SOURCE = Object.freeze({
  /** what `npm install -g` is given */
  package: `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`,
  /** the package.json that install would get, read for its version */
  versionFile: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`,
});
export const hoprigSource = () => SOURCE;
/** The one-line installer for macOS and Linux. */
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh`;

/** `~/x` for display. */
export const tilde = (p) => (p === home() || p.startsWith(home() + path.sep) ? '~' + p.slice(home().length) : p);
