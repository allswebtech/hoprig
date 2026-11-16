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
//   what it reads      rules: <config>/AGENTS.md and the project's AGENTS.md (never CLAUDE.md, unlike OpenCode 1), plus
//                      every file named in "instructions" of its config (a "~" path and a glob work; a relative path
//                      is looked up in the project). Skills: ~/.claude/skills, ~/.agents/skills, the project's
//                      .claude/skills and its own folders. Memory: none of its own.
import os from 'node:os';
import path from 'node:path';
import { claudeDir, tilde } from '../paths.mjs';
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
  /**
   * The choices of a terminal session (src/codetools/terminal.mjs). OpenCode's own defaults already allow almost
   * everything; "ask" adds rules that make it ask before it edits, runs a command, fetches a page or leaves the
   * folder; bypassPermissions approves whatever is not explicitly denied (its --auto). The effort is the model's
   * variant.
   */
  options: { permissionModes: ['default', 'ask', 'bypassPermissions'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  flagsFor: ({ permissionMode = null, effort = null } = {}) => {
    if (permissionMode && !['default', 'ask', 'bypassPermissions'].includes(permissionMode)) throw new Error(`OpenCode's permission mode is one of: default, ask, bypassPermissions`);
    if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`OpenCode's effort is one of: low, medium, high, xhigh, max`);
    return permissionMode === 'bypassPermissions' ? ['--auto'] : [];
  },
  /** The rules a new conversation gets (POST /api/session "permissions"), for the "ask" mode. */
  sessionPermissions: ({ permissionMode = null } = {}) => (permissionMode === 'ask' ? { permissions: askRules() } : {}),
  /**
   * The rules a conversation that is continued gets (PATCH /api/session/<id> "permissions", which replaces them;
   * checked with 2.3: a shell step of a default conversation is allowed, asked after the "ask" rules are set, and
   * allowed again after []): the "ask" rules for "ask", none for another mode, so a conversation continued in another
   * mode stops asking; null (left as it is) when no mode was chosen.
   */
  resumePermissions: ({ permissionMode = null } = {}) => (permissionMode ? (permissionMode === 'ask' ? askRules() : []) : null),
  /** npm replaces the program's files: an update waits until no OpenCode session is open. */
  updateItem: { whenRunning: 'wait-until-none' },
  /**
   * What OpenCode reads from the AI brain: the same rules file (as its global AGENTS.md), and, named in its
   * settings, Claude Code's rules folder and each project's memory index. Its skills come from the folders Claude
   * Code and Codex read already, so the skills link is the same one as Codex's (link.mjs keeps one of the two).
   */
  brainLinks: ({ base = claudeDir(), brain, home, toolHome }) => [
    { id: 'rules', what: 'the rules OpenCode gets everywhere', link: path.join(toolHome, 'AGENTS.md'), target: path.join(brain, 'claude', 'CLAUDE.md'), kind: 'file' },
    { id: 'skills', what: 'your skills, for OpenCode', link: path.join(home, '.agents', 'skills'), target: path.join(brain, 'skills'), kind: 'dir' },
    {
      id: 'instructions', what: 'Claude Code\'s rules folder and each project\'s memory index, named in OpenCode\'s settings', kind: 'json',
      link: path.join(toolHome, 'opencode.json'), key: 'instructions',
      values: [`${tilde(path.join(base, 'rules')).split(path.sep).join('/')}/*.md`, MEMORY_INDEX],
    },
  ],
  ownMemory: false,
  /** One line for the install, and how much it takes (measured on Linux x64). */
  about: 'an open-source coding tool that works with many providers',
  size: 'about 240 MB',
};

/** The rules of the "ask" mode: OpenCode asks before it edits, runs a command, fetches a page or leaves the folder. */
export const askRules = () => ['edit', 'shell', 'webfetch', 'external_directory'].map((action) => ({ action, resource: '*', effect: 'ask' }));

/**
 * The same rules in OpenCode's config, for a start without Hoprig's server (no conversation rules to set there). They
 * go to the agents that do the work: an agent's own rules come after the global ones, and the built-in "build" agent
 * allows everything, so a global rule would never ask (checked with 2.3: global rules allowed a shell step, rules of
 * "build" and "general" asked; "plan" and "explore" stay read-only by their own rules).
 */
export const askAgents = () => ({ build: { permissions: askRules() }, general: { permissions: askRules() } });

/** Where a project keeps its memory index, from the project's folder (the layout of src/pcsetup/workspace.mjs). */
export const MEMORY_INDEX = 'ai_brain/claude-memory/MEMORY.md';
