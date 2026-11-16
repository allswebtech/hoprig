// OpenCode 2 (npm @opencode/cli), installed by Hoprig into its own tools folder (./npmtool.mjs). OpenCode 1 (the
// package opencode-ai) is not used: its documentation is gone and its server API is the old one.
//
// Facts this rests on, checked against OpenCode 2.3.0:
//   package            npm @opencode/cli: a native program per OS in an optional dependency (about 180 MB)
//   version            `opencode --version` prints "opencode v2.3.0"
//   its folders        XDG style: $XDG_CONFIG_HOME/opencode (or $OPENCODE_CONFIG_DIR), $XDG_DATA_HOME/opencode
//                      (its database, credentials included), $XDG_STATE_HOME/opencode, $XDG_CACHE_HOME/opencode,
//                      $TMPDIR/opencode. The install script runs `opencode --version`, which creates them: npmtool
//                      points them into a throwaway folder while npm runs.
//   one program only   the package lists a native program for every OS, processor, C library and CPU level as an
//                      optional dependency, and npm installs all four Linux x64 ones (about 180 MB each). With
//                      optional dependencies left out, its install script picks the one this computer needs and
//                      installs only that one (its own fallback: postinstall.mjs, installPackage).
//   its own updates    config key "update" ("disable" | "notify" | "auto", default notify) and the variable
//                      OPENCODE_DISABLE_AUTOUPDATE. Hoprig updates it itself, so both are switched off.
//   free cloud models  without any setup it offers free models of its own cloud service ("opencode" provider);
//                      code must never go there unasked, so OPENCODE_DISABLE_FREE_MODELS and disabled_providers.
import os from 'node:os';
import path from 'node:path';
import { npmTool } from './npmtool.mjs';

/** The version this Hoprig is tested with: what it installs first. */
export const OPENCODE_PIN = '2.3.0';

/** What every start of OpenCode by Hoprig carries (env), and what its config written by Hoprig says (config). */
export const NO_SELF_UPDATE = Object.freeze({
  env: Object.freeze({ OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_FREE_MODELS: '1' }),
  config: Object.freeze({ update: 'disable', disabled_providers: Object.freeze(['opencode']) }),
});

const tool = npmTool({
  id: 'opencode',
  name: 'OpenCode',
  pkg: '@opencode/cli',
  pin: OPENCODE_PIN,
  binName: 'opencode',
  npmFlags: ['--omit=optional'],
  allowScript: true, // its install script fetches the one native program (see the header)
  parseVersion: (text) => (/opencode\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text)) || [])[1] || null,
  isolate: (dir) => ({
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    OPENCODE_CONFIG_DIR: path.join(dir, 'config', 'opencode'),
    TMPDIR: path.join(dir, 'tmp'),
    ...NO_SELF_UPDATE.env,
  }),
});

export const opencode = {
  ...tool,
  home: (env = process.env) => env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'),
  noSelfUpdate: { args: [], env: NO_SELF_UPDATE.env, config: NO_SELF_UPDATE.config },
  /** npm replaces the program's files: an update waits until no OpenCode session is open. */
  updateItem: { whenRunning: 'wait-until-none' },
};
