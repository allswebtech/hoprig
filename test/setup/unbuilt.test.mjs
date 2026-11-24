// The state npm 12 leaves after `npm install -g`: the terminal module is installed and was never built, so it throws
// while it loads. A copy of hoprig with such a node-pty is run for real, in its own processes: doctor has to name
// the cause and its fix, and the dashboard's modules have to load. Before backends/nodepty.mjs both ended with a
// stack trace (Node reports a second import of a package that threw as loaded, then dies with the first error).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeBin, fakeClaude, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
// The doctor asks the dashboard's port whether a dashboard answers: a free port, never the default one, where the
// computer running the tests may have its own dashboard.
(await import('../../src/config.mjs')).saveConfig({ server: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } });
// doctor asks systemd whether user services run here: a stand-in says no, before the runner's traps.
const standIns = fakeBin(path.join(s.tmp, 'stand-ins'), {
  systemctl: 'exit 1', loginctl: 'exit 1',
  // doctor also probes these on PATH; harmless stand-ins answer so the owner's real gh, docker, tailscale, tmux and
  // Claude Code are never reached (this test is about node-pty, not any of them).
  gh: 'case "$1" in --version) echo "gh version 2.0.0 (2024-01-01)";; *) exit 1;; esac',
  docker: 'case "$1" in --version) echo "Docker version 24.0.0, build abc0123";; *) exit 1;; esac',
  tailscale: 'exit 1',
  tmux: '[ "$1" = "-V" ] && echo "tmux 3.4" || exit 1',
  claude: fakeClaude({ loggedIn: false }),
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A copy of hoprig whose node-pty is there but throws on load; every other dependency is the real one. */
function copyWithUnbuiltPty() {
  const app = path.join(s.tmp, 'app');
  for (const part of ['bin', 'src', 'package.json']) fs.cpSync(path.join(ROOT, part), path.join(app, part), { recursive: true });
  const modules = path.join(app, 'node_modules');
  fs.mkdirSync(modules);
  for (const name of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
    if (name.startsWith('.') || name === 'node-pty') continue;
    fs.symlinkSync(path.join(ROOT, 'node_modules', name), path.join(modules, name), 'junction');
  }
  const pty = path.join(modules, 'node-pty');
  fs.mkdirSync(path.join(pty, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0', main: './lib/index.js' }));
  fs.writeFileSync(path.join(pty, 'lib', 'index.js'), 'throw new Error("Failed to load native module: pty.node, checked: build/Release, build/Debug");\n');
  return app;
}

const run = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, args, { env: { ...process.env, ...s.env, PATH: `${standIns}${path.delimiter}${process.env.PATH}` }, timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });

test('a terminal module that was never built: doctor names the cause and the fix, the dashboard still loads', async () => {
  const app = copyWithUnbuiltPty();

  const d = await run([path.join(app, 'bin', 'hoprig.mjs'), 'doctor', '--offline', '--json']);
  assert.doesNotMatch(d.stderr, /Failed to load native module/, 'no stack trace');
  const checks = JSON.parse(d.stdout).groups.flatMap((g) => g.checks);
  const pty = checks.find((c) => c.id === 'pty');
  const tmux = checks.find((c) => c.id === 'terminal').detail.startsWith('tmux');
  assert.equal(pty.status, tmux ? 'warn' : 'fail');
  assert.match(pty.detail, /it was installed but never built: (npm \d+ does not run the install script of a dependency until it is allowed|its install script did not run)$/);
  assert.match(pty.fix, /cd '?[^"]*app'? && npm rebuild node-pty$/);

  const load = `await import(${JSON.stringify(pathToFileURL(path.join(app, 'src', 'server', 'server.mjs')).href)});
    const b = await import(${JSON.stringify(pathToFileURL(path.join(app, 'src', 'server', 'backends', 'index.mjs')).href)});
    try { b.createBackend({ kind: 'pty' }); } catch (e) { console.log('PTY: ' + e.message); }
    await new Promise((r) => setTimeout(r, 200));
    console.log('LOADED');`;
  const m = await run(['--input-type=module', '-e', load]);
  assert.equal(m.code, 0, m.stderr);
  assert.match(m.stdout, /PTY: the built-in terminal is not available here: Failed to load native module: pty\.node/);
  assert.match(m.stdout, /LOADED/);
});
