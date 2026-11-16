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
//   plugin catalogue   at its first start it clones a plugin marketplace (about 100 MB) into $CODEX_HOME/.tmp/plugins.
//                      That is not a self-update; only features.plugins=false stops it (remote_plugin=false does not),
//                      and that would also switch off every plugin the owner installed, so Hoprig leaves it on.
//   commands it runs   take the environment of the process that runs them, filtered by shell_environment_policy
//                      (no default filter in 0.169: a variable named *KEY* reaches them). keyFilter drops Hoprig's
//                      key variables there (checked with `codex sandbox -- env`, which applies the same policy). A -c
//                      value replaces the list at its path, so keyFilter repeats the owner's own exclude list from
//                      config.toml with Hoprig's names added: what the owner keeps from commands stays kept.
//   what it reads      rules: $CODEX_HOME/AGENTS.md (a link is followed), then the project's AGENTS.md files; never
//                      CLAUDE.md. Skills: ~/.agents/skills, $CODEX_HOME/skills (it keeps its own bundled ones in
//                      skills/.system there, so that folder is not linked), and the project's .agents/skills. Memory: none
//                      that can point at a folder (its own generated memories are off by default and left off).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmTool } from './npmtool.mjs';
import { parseToml, tomlString } from './toml.mjs';

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
   * Commands Codex runs for the model never see the provider keys Hoprig hands it (nor the server's token), and
   * still never see what the owner's config.toml (in `home`) keeps from them.
   */
  keyFilter: (home) => keyFilter(home),
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
  /** One line for the install, and how much it takes (measured on Linux x64). */
  about: 'OpenAI\'s coding tool',
  size: 'about 400 MB',
};

/** Hoprig's own variables, kept from the commands Codex runs. */
export const HOPRIG_EXCLUDES = Object.freeze(['HOPRIG_CODEX_KEY*', 'HOPRIG_CODEX_WS*']);

/**
 * The owner's shell_environment_policy.exclude from <home>/config.toml: [] when there is none. A file Hoprig cannot
 * read gives [] too; Codex reads that file itself, and refuses to start when it is broken.
 */
export function ownerExcludes(home = codex.home()) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  try {
    const p = parseToml(text).shell_environment_policy;
    const list = p && typeof p === 'object' ? p.exclude : null;
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function keyFilter(home = codex.home()) {
  const list = [...new Set([...ownerExcludes(home), ...HOPRIG_EXCLUDES])];
  return ['-c', `shell_environment_policy.exclude=[${list.map(tomlString).join(', ')}]`];
}

function flagsFor({ permissionMode = null, effort = null } = {}) {
  const out = [];
  if (permissionMode && !['default', 'readOnly', 'bypassPermissions'].includes(permissionMode)) throw new Error(`Codex's permission mode is one of: default, readOnly, bypassPermissions`);
  if (effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error(`Codex's effort is one of: low, medium, high, xhigh`);
  if (permissionMode === 'readOnly') out.push('-s', 'read-only', '-a', 'on-request');
  if (permissionMode === 'bypassPermissions') out.push('--dangerously-bypass-approvals-and-sandbox');
  if (effort) out.push('-c', `model_reasoning_effort="${effort}"`);
  return out;
}

/**
 * A question on Codex's screen that its server does not report, as the card's note; or null. Codex asks it before a
 * conversation exists: whether to trust a folder it has not seen (checked with 0.169: "Trust this folder? … 1. Trust
 * and continue"), and whether to trust new or changed hooks ("Trust all and continue").
 */
export function codexScreenQuestion(screen) {
  const s = String(screen || '');
  if (/Trust this folder\?/.test(s) && /Trust and continue/.test(s)) return 'Codex asks whether to trust this folder. Open the session to answer.';
  if (/hooks? (?:is|are) new or changed/i.test(s) && /Trust all and continue/.test(s)) return 'Codex asks whether to trust new hooks. Open the session to answer.';
  return null;
}
