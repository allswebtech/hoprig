// Shared by the setup tests: a scratch home with every hoprig and Claude folder inside it, and fake programs
// (claude, tmux) on a PATH that holds nothing else but node, so no test sees or touches the real machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Point every location at a fresh scratch folder. Call BEFORE importing the modules under test. */
export function scratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-setup-test-'));
  const env = {
    HOME: path.join(tmp, 'home'),
    HOPRIG_CONFIG_DIR: path.join(tmp, 'config'),
    HOPRIG_STATE_DIR: path.join(tmp, 'state'),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
    // A dashboard started from here looks after its workspace's map: never the real one (not made: tests see a
    // computer whose workspace is not set up yet).
    HOPRIG_WORKSPACE_DIR: path.join(tmp, 'workspace'),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  Object.assign(process.env, env);
  delete process.env.HOPRIG_PROFILES_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  return { tmp, env, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** A folder of fake programs. `programs` maps a name to the body of a POSIX sh script. */
export function fakeBin(dir, programs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(programs)) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}

/** A fake Claude Code: --version prints `version`; `auth status` answers like the real one. */
export const fakeClaude = ({ version = '2.1.300', loggedIn = true } = {}) => `
case "$1" in
  --version) echo "${version} (Claude Code)" ;;
  auth) ${loggedIn ? `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com"}'` : `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`} ;;
  *) exit 0 ;;
esac`;

/**
 * PATH with only the fake programs and node (a link to the running node in a folder of its own: the real node's
 * folder may also hold brew, tmux or claude). The fake scripts start through /bin/sh by their first line.
 */
export function pathWith(tmp, ...dirs) {
  const nodeDir = path.join(tmp, 'node-bin');
  if (!fs.existsSync(nodeDir)) {
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  }
  return [...dirs, nodeDir].join(path.delimiter);
}

/** A fetch that answers from a table of url -> text (anything else: network down). */
export function fakeFetch(table, calls = []) {
  return async (url) => {
    calls.push(url);
    if (!(url in table)) throw new Error('offline');
    const body = table[url];
    return { ok: true, status: 200, url, text: async () => body };
  };
}

/** Collects what a setup ui writes, and answers its questions from a list. */
export function recorder() {
  let text = '';
  return { write: (s) => { text += s; }, get text() { return text; } };
}

/** Every file below `dir` with its content, for "nothing changed" comparisons. */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let names;
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = path.join(d, n);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
    }
  };
  walk(dir);
  return out;
}
