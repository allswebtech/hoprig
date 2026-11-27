// Shared by the setup tests: a scratch home with every hoprig and Claude folder inside it, and fake programs
// (claude, tmux) on a PATH that holds nothing else but node, so no test sees or touches the real machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Point every location at a fresh scratch folder. Call BEFORE importing the modules under test. */
/** `fresh`: no settings file yet, which makes `hoprig setup` the quiet first run; else one is there (today's full run). */
export function scratch({ fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-setup-test-'));
  const env = {
    HOME: path.join(tmp, 'home'),
    USERPROFILE: path.join(tmp, 'home'), // Windows takes the home from here
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
  if (!fresh) {
    fs.mkdirSync(env.HOPRIG_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'config.json'), '{}\n');
  }
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
 * A folder of fake programs written as Node scripts (`#!/usr/bin/env node`). Linux and macOS start them through the
 * `node` on the test's PATH (pathWith puts one there); on Windows the test seal starts such a stand-in with this Node
 * (tools/test-seal.cjs windowsStandIn), so it needs no sh on the child's PATH. `programs` maps a name to Node code.
 */
export function fakeNodeBin(dir, programs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(programs)) {
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}

/** fakeClaude as Node code for fakeNodeBin: the same answers. */
export const fakeClaudeNode = ({ version = '2.1.300', loggedIn = true } = {}) => `const a = process.argv.slice(2);
if (a[0] === '--version') console.log(${JSON.stringify(`${version} (Claude Code)`)});
else if (a[0] === 'auth') {
  console.log(${JSON.stringify(JSON.stringify(loggedIn ? { loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com' } : { loggedIn: false, authMethod: 'none' }))});
  process.exitCode = ${loggedIn ? 0 : 1};
}`;

/**
 * A folder of harmless stand-ins for the programs a doctor/workspace check probes on PATH — gh (installed, not signed
 * in), docker (installed), tailscale (not running) — so a test that reads the computer's state never reaches the
 * owner's own GitHub, container daemon or private network. Put it first on PATH. Returns the folder.
 */
export function fakeTools(dir) {
  return fakeBin(dir, {
    gh: 'case "$1" in --version) echo "gh version 2.0.0 (2024-01-01)";; *) exit 1;; esac',
    docker: 'case "$1" in --version) echo "Docker version 24.0.0, build abc0123";; info|ps) exit 1;; *) exit 0;; esac',
    tailscale: 'exit 1',
  });
}

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

/**
 * `sys.run` for set-up and doctor on Windows (setup/winowner.mjs winRun): who this account is and that it does not run
 * elevated are facts the test hands in, so Windows' own whoami (started by its full path) is never asked. Every other
 * program runs as it would without it (capture, in `env`). Linux and macOS never ask these.
 */
export function windowsFacts(env = process.env) {
  return async (argv, opts = {}) => {
    if (/(^|[\\/])whoami(\.exe)?$/i.test(String(argv[0]))) {
      const out = argv.includes('/groups') ? '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""\r\n' : '"pc-example\\dev","S-1-5-21-1-2-3-1001"\r\n';
      return { ok: true, code: 0, stdout: out, stderr: '' };
    }
    const { capture } = await import('../../src/setup/system.mjs');
    return capture(argv, { env, ...opts });
  };
}
