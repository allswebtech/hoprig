// Claude Code as a coding-tool descriptor. It wraps what exists (src/claudecode.mjs: where it is, its versions,
// install, update; src/config.mjs: claudeBin) and changes nothing: a Claude Code launch is still built by
// src/launch.mjs and src/server/deck.mjs exactly as before. Claude Code updates itself through its own installer
// (`claude update`), so it is not one of the tools in Hoprig's tools folder.
import * as cc from '../claudecode.mjs';
import { loadConfig } from '../config.mjs';
import { claudeDir } from '../paths.mjs';

export const claude = {
  id: 'claude',
  name: 'Claude Code',
  managed: false, // installed by its official installer (or npm, Homebrew), not into Hoprig's tools folder
  home: () => claudeDir(),
  /** The program to start: config.json "claudeBin", as the launcher reads it. */
  bin: (cfg = loadConfig()) => cfg.claudeBin || 'claude',
  installedVersion: () => cc.claudeVersionQuick(),
  info: (o) => cc.claudeInfo(o),
  install: ({ version, onLine } = {}) => (version ? cc.claudeInstallVersion(version, { onLine }) : cc.claudeInstall({ onLine })),
  update: ({ onLine } = {}) => cc.claudeUpdate({ onLine }),
  /** A running Claude Code keeps the version it started with (its native install keeps versions side by side). */
  updateItem: { whenRunning: 'keeps-copy' },
};
