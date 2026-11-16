// Claude Code as a coding-tool descriptor. It wraps what exists (src/claudecode.mjs: where it is, its versions,
// install, update; src/config.mjs: claudeBin) and changes nothing: a Claude Code launch is still built by
// src/launch.mjs and src/server/deck.mjs exactly as before. Claude Code updates itself through its own installer
// (`claude update`), so it is not one of the tools in Hoprig's tools folder.
import path from 'node:path';
import * as cc from '../claudecode.mjs';
import { loadConfig } from '../config.mjs';
import { claudeDir } from '../paths.mjs';
import { projectSlug } from '../sessions.mjs';

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
  /**
   * What Claude Code reads from the AI brain (src/workspace/link.mjs): its global rules file, its skills folder and
   * the memory of work started in the home folder. Ids stay the short ones older pages and computers know.
   */
  brainLinks: ({ base = claudeDir(), brain, home }) => [
    { id: 'rules', short: 'rules', what: 'the rules Claude gets everywhere', link: path.join(base, 'CLAUDE.md'), target: path.join(brain, 'claude', 'CLAUDE.md'), kind: 'file' },
    { id: 'skills', short: 'skills', what: 'your skills', link: path.join(base, 'skills'), target: path.join(brain, 'skills'), kind: 'dir' },
    { id: 'memory', short: 'home memory', what: 'the memory for work started in your home folder', link: path.join(base, 'projects', projectSlug(home), 'memory'), target: path.join(brain, 'claude-memory', 'home'), kind: 'dir' },
  ],
};
