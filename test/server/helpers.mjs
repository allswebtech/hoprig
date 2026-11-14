// Test isolation: every test file gets its own config, state and profiles folders under the OS temp folder, and
// its own Claude folder, so nothing of the real user's setup is read or written.
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
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  process.env.HOPRIG_CONFIG_DIR = dirs.config;
  process.env.HOPRIG_STATE_DIR = dirs.state;
  process.env.HOPRIG_PROFILES_DIR = dirs.profiles;
  process.env.CLAUDE_CONFIG_DIR = dirs.claude;
  dirs.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return dirs;
}

/** A minimal stand-in for an http.IncomingMessage with headers and a socket. */
export function fakeReq(headers = {}, socket = { remoteAddress: '10.0.0.5' }) {
  return { headers, socket };
}
