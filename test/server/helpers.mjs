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

/**
 * The arguments a terminal's launcher is started with, read back: the dashboard types `<launcher> --launch <file>`
 * and the file (src/launchfile.mjs) holds the rest. Returns the launcher's own words and then the file's, as they
 * were before launch files; the file stays where it is. Any other argv comes back unchanged.
 */
export function launched(argv) {
  const i = Array.isArray(argv) ? argv.indexOf('--launch') : -1;
  if (i < 0) return argv;
  return [...argv.slice(0, i), ...JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')).argv];
}

/**
 * The identity (src/procid.mjs) of a process that had a pid before the process whose identity is `id`: the same pid,
 * an earlier start. An hour earlier where a start is a time (well outside what counts as one process there), one tick
 * where it is the kernel's own number.
 */
export function earlierIdentity(id) {
  const i = id.lastIndexOf(':');
  return id.startsWith('T:') ? `T:${Number(id.slice(2)) - 3_600_000}` : `${id.slice(0, i + 1)}${Number(id.slice(i + 1)) - 1}`;
}
