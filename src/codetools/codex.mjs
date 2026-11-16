// Codex (OpenAI's coding tool), installed by Hoprig into its own tools folder (./npmtool.mjs).
//
// Facts this rests on, checked against Codex 0.169.0:
//   package            npm @openai/codex: a small wrapper plus one native program per OS in an optional dependency
//   version            `codex --version` prints "codex-cli 0.169.0"
//   its folder         $CODEX_HOME, else ~/.codex (config.toml, sign-in, sessions)
//   its own updates    an update check when it starts (config key check_for_update_on_startup, on by default), and
//                      a background copy of its app server that it downloads into $CODEX_HOME/packages and keeps
//                      current by itself (feature daemon_auto_start, on by default), and an update offer inside its
//                      screen (feature in_app_updates, on by default). Hoprig updates Codex itself, at a moment the
//                      owner chose, so every start Hoprig makes switches all three off (noSelfUpdate; `codex features
//                      list` with these -c values shows both features false).
import os from 'node:os';
import path from 'node:path';
import { npmTool } from './npmtool.mjs';

/** The version this Hoprig is tested with: what it installs first. */
export const CODEX_PIN = '0.169.0';

const tool = npmTool({
  id: 'codex',
  name: 'Codex',
  pkg: '@openai/codex',
  pin: CODEX_PIN,
  binName: 'codex',
  parseVersion: (text) => (/codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text)) || [])[1] || null,
  isolate: (dir) => ({ CODEX_HOME: path.join(dir, 'codex-home'), TMPDIR: path.join(dir, 'tmp') }),
});

export const codex = {
  ...tool,
  home: (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  /** Added to every start of Codex that Hoprig makes (terminal and app server). */
  noSelfUpdate: { args: ['-c', 'check_for_update_on_startup=false', '-c', 'features.daemon_auto_start=false', '-c', 'features.in_app_updates=false'], env: {} },
  /** npm replaces the program's files: an update waits until no Codex session is open. */
  updateItem: { whenRunning: 'wait-until-none' },
};
