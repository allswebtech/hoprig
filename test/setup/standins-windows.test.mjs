// The forms of stand-ins the set-up tests give their children, as the test seal answers them on Windows
// (tools/test-seal.cjs windowsStart: a stand-in of the test's own, else the trap), with Windows' answers handed in on
// any system. A Node stand-in (`#!/usr/bin/env node`) on a PATH of the test's own folders runs with this Node, where
// a `#!/bin/sh` one finds no sh on such a PATH and meets the trap (what doctor.test.mjs and rootsetup.test.mjs met);
// a .cmd of the test's own, which which() picks over a trap .cmd later on PATH, runs through cmd.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsStart } from '../../tools/test-seal.mjs';

const OWN = 'C:\\Users\\dev\\AppData\\Local\\Temp\\hoprig-setup-test-x\\bin';
const NODE_BIN = 'C:\\Users\\dev\\AppData\\Local\\Temp\\hoprig-setup-test-x\\node-bin';
const TRAPS = 'C:\\Users\\dev\\AppData\\Local\\Temp\\hoprig-traps';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const files = new Set([`${OWN}\\systemctl`, `${OWN}\\claude`, `${OWN}\\old-systemctl`, `${OWN}\\tailscale`, `${OWN}\\tailscale.cmd`, `${TRAPS}\\systemctl.cmd`, `${TRAPS}\\tailscale.cmd`]);
const lines = { [`${OWN}\\systemctl`]: '#!/usr/bin/env node', [`${OWN}\\claude`]: '#!/usr/bin/env node', [`${OWN}\\old-systemctl`]: '#!/bin/sh', [`${OWN}\\tailscale`]: '#!/bin/sh' };
const isOwn = (f) => f.toLowerCase().startsWith('c:\\users\\dev\\appdata\\local\\temp\\hoprig-setup-test-x');
const win = (PATH) => ({ env: { Path: PATH }, traps: TRAPS, platform: 'win32', exists: (f) => files.has(f), isOwn, firstLine: (f) => lines[f] || '', node: NODE, processPath: PATH, comspec: 'C:\\Windows\\system32\\cmd.exe' }); // seal: a made-up Windows PATH handed to a pure function

test('Windows: a Node stand-in on a PATH of the test\'s own folders runs with this Node, never the trap', () => {
  const PATH = `${OWN};${NODE_BIN}`; // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(windowsStart('systemctl', ['--user', 'daemon-reload'], win(PATH)), { command: NODE, args: [`${OWN}\\systemctl`, '--user', 'daemon-reload'], log: null, verbatim: false });
  assert.deepEqual(windowsStart(`${OWN}\\claude`, ['--version'], win(PATH)), { command: NODE, args: [`${OWN}\\claude`, '--version'], log: null, verbatim: false });
  // The sh form on the same PATH: no sh there, so it is the trap (a mark that fails the run).
  const old = windowsStart(`${OWN}\\old-systemctl`, ['--user', 'daemon-reload'], win(PATH));
  assert.equal(old, null, 'a full path the seal cannot start is left to Node, which cannot start it either');
  const bySh = windowsStart('systemctl', ['--user', 'daemon-reload'], { ...win(PATH), firstLine: () => '#!/bin/sh' });
  assert.deepEqual(bySh.log, ['systemctl', '--user daemon-reload'], 'a #!/bin/sh stand-in without an sh meets the trap');
});

test('Windows: a .cmd stand-in of the test\'s own, by the full path which() gives, runs through cmd, never the trap', () => {
  const PATH = `${OWN};${TRAPS};C:\\Windows\\System32`; // seal: a made-up Windows PATH handed to a pure function
  const r = windowsStart(`${OWN}\\tailscale.cmd`, ['status', '--json'], win(PATH));
  assert.equal(r.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(r.log, null);
  assert.equal(r.verbatim, true);
  // The trap's own .cmd, which which() would have taken over a bare stand-in: the trap, with its mark.
  assert.deepEqual(windowsStart(`${TRAPS}\\tailscale.cmd`, ['status', '--json'], win(PATH)).log, ['tailscale', 'status --json']);
});

test('Windows: the system whoami by its full path is refused unless the test names it; with the facts it is never asked', async () => {
  const { systemAlong } = await import('../../tools/test-seal.mjs');
  const { realByFullPath } = await import('../../tools/seal-core.mjs');
  const W = await import('../../src/setup/winowner.mjs');
  const { windowsFacts } = await import('./helpers.mjs');
  const whoami = 'C:\\Windows\\System32\\whoami.exe';
  const computer = { isOwn: () => false, readlink: () => { throw new Error('a file'); } };
  assert.equal(systemAlong(whoami, { ...computer, allow: new Set() }), whoami, 'by its full path: refused');
  assert.equal(systemAlong(whoami, { ...computer, allow: new Set(realByFullPath('whoami')) }), null, 'named by the test as the system\'s own it starts: let through');
  // The in-process set-up tests hand the answers in (sys.run): not elevated, this account's SID, nothing started.
  assert.equal(await W.runsElevated(windowsFacts(), whoami), false);
  assert.equal(await W.mySid(windowsFacts(), whoami), 'S-1-5-21-1-2-3-1001');
});
