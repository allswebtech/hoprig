// Test isolation: every test file gets its own config, state and profiles folders under the OS temp folder, its
// own Claude folder, its own GitHub sign-in folder (empty) and its own (empty) workspace, so nothing of the real user's setup is read or written. The
// workspace matters as much as the rest: a server that runs for a second looks after the workspace's map
// (src/automation/workspacesync.mjs), and without a workspace of its own that is the real one and its brain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandbox(name = 'dash') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-test-`));
  const dirs = {
    root,
    config: path.join(root, 'config'),
    state: path.join(root, 'state'),
    profiles: path.join(root, 'profiles'),
    claude: path.join(root, 'claude'),
    home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'),
    gh: path.join(root, 'gh'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  process.env.HOPRIG_CONFIG_DIR = dirs.config;
  process.env.HOPRIG_STATE_DIR = dirs.state;
  process.env.HOPRIG_PROFILES_DIR = dirs.profiles;
  process.env.CLAUDE_CONFIG_DIR = dirs.claude;
  process.env.HOPRIG_WORKSPACE_DIR = dirs.workspace;
  // GitHub's command reads its sign-in from here (else from the real config folder, shown on a test's Setup).
  process.env.GH_CONFIG_DIR = dirs.gh;
  // What a session of the person running the tests carries: a test dashboard is never part of that session (its
  // hooks would write the real session's run record).
  for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[k];
  dirs.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return dirs;
}

/** A minimal stand-in for an http.IncomingMessage with headers and a socket. */
export function fakeReq(headers = {}, socket = { remoteAddress: '10.0.0.5' }) {
  return { headers, socket };
}
