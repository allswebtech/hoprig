// The helper of a restart asked for on the dashboard's own page is started as a command of the real program
// (`<app> __service-restart <pid>`, selfrestart.mjs). This runs that very command line. When the real program did not
// know the word, the helper printed the usage and ended, and a dashboard that had stopped itself stayed down.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed, sealedPath } from '../seal.mjs';
import { spawnServiceRestart } from '../../src/server/selfrestart.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hoprig.mjs');
const GONE = 999999999; // no process has this id

test('the command line the dashboard starts its restart helper with is a command of the real program, and restarts the service', { skip: process.platform !== 'linux' && 'the service manager of this test is systemd' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-selfrestart-'));
  try {
    const home = path.join(tmp, 'home');
    const standIns = path.join(tmp, 'bin');
    const log = path.join(tmp, 'systemctl.log');
    fs.mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'hoprig.service'), '[Service]\n');
    fs.mkdirSync(standIns);
    fs.writeFileSync(path.join(standIns, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
    // The words the dashboard really starts, taken from the product itself (the stand-in spawn only keeps them).
    let argv = null;
    spawnServiceRestart({ node: process.execPath, bin: BIN, pid: GONE, spawnImpl: (cmd, args) => ((argv = [cmd, ...args]), { pid: 1, unref() {} }) });
    assert.deepEqual(argv, [process.execPath, BIN, '__service-restart', String(GONE)]);
    const env = sealed({
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      HOPRIG_CONFIG_DIR: path.join(home, 'config'), HOPRIG_STATE_DIR: path.join(home, 'state'), HOPRIG_WORKSPACE_DIR: path.join(home, 'ws'),
      PATH: sealedPath([standIns, process.env.PATH]),
    });
    const r = spawnSync(argv[0], argv.slice(1), { env, cwd: tmp, encoding: 'utf8', timeout: 60_000, input: '' });
    assert.equal(r.status, 0, `the helper ended with ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /service was restarted/);
    assert.match(fs.readFileSync(log, 'utf8').trim(), /^--user restart hoprig(\.service)?$/, 'the service manager was asked once, to restart the dashboard');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
