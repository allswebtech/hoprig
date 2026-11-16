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
//   what it reads      rules: $CODEX_HOME/AGENTS.md (a link is followed), then the project's AGENTS.md files; never
//                      CLAUDE.md. Skills: ~/.agents/skills, $CODEX_HOME/skills (it keeps its own bundled ones in
//                      skills/.system there, so that folder is not linked), and the project's .agents/skills. Memory: none
//                      that can point at a folder (its own generated memories are off by default and left off).
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
  /**
   * The choices of a terminal session (the launcher's --permission-mode and --effort, src/codetools/terminal.mjs).
   * readOnly: Codex may read, and asks before anything else; bypassPermissions: it never asks and runs unsandboxed.
   */
  options: { permissionModes: ['default', 'readOnly', 'bypassPermissions'], efforts: ['low', 'medium', 'high', 'xhigh'] },
  flagsFor: (o = {}) => flagsFor(o),
  /** npm replaces the program's files: an update waits until no Codex session is open. */
  updateItem: { whenRunning: 'wait-until-none' },
  /** What Codex reads from the AI brain: the same rules file as Claude Code, the same skills folder. */
  brainLinks: ({ brain, home, toolHome }) => [
    { id: 'rules', what: 'the rules Codex gets everywhere', link: path.join(toolHome, 'AGENTS.md'), target: path.join(brain, 'claude', 'CLAUDE.md'), kind: 'file' },
    { id: 'skills', what: 'your skills, for Codex', link: path.join(home, '.agents', 'skills'), target: path.join(brain, 'skills'), kind: 'dir' },
  ],
  /** No memory of its own: the shared rules carry a section that tells it where each project's memory is. */
  ownMemory: false,
};

function flagsFor({ permissionMode = null, effort = null } = {}) {
  const out = [];
  if (permissionMode && !['default', 'readOnly', 'bypassPermissions'].includes(permissionMode)) throw new Error(`Codex's permission mode is one of: default, readOnly, bypassPermissions`);
  if (effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error(`Codex's effort is one of: low, medium, high, xhigh`);
  if (permissionMode === 'readOnly') out.push('-s', 'read-only', '-a', 'on-request');
  if (permissionMode === 'bypassPermissions') out.push('--dangerously-bypass-approvals-and-sandbox');
  if (effort) out.push('-c', `model_reasoning_effort="${effort}"`);
  return out;
}
