// Test isolation: every test file gets its own config, state and profiles folders under the OS temp folder, its
// own Claude folder and its own (empty) workspace, so nothing of the real user's setup is read or written. The
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
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  process.env.HOPRIG_CONFIG_DIR = dirs.config;
  process.env.HOPRIG_STATE_DIR = dirs.state;
  process.env.HOPRIG_PROFILES_DIR = dirs.profiles;
  process.env.CLAUDE_CONFIG_DIR = dirs.claude;
  process.env.HOPRIG_WORKSPACE_DIR = dirs.workspace;
  dirs.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return dirs;
}

/** A minimal stand-in for an http.IncomingMessage with headers and a socket. */
export function fakeReq(headers = {}, socket = { remoteAddress: '10.0.0.5' }) {
  return { headers, socket };
}
