// The shipped gateway starts with no shell (Node's DEP0190 warns when arguments go with shell: true): on Windows an npm
// .cmd shim goes to cmd.exe with every argument escaped, an .exe starts directly; elsewhere the program itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startPlan } from '../../src/addons/localgateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Windows: a .cmd shim through cmd.exe as an argument list, an .exe directly; never a shell', () => {
  const env = { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' };
  const shim = startPlan('C:\\Users\\alex\\AppData\\Roaming\\npm\\gateway.cmd', ['--port', '8271'], 'win32', env);
  assert.equal(shim.command, 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
  // Each argument quoted for the program and escaped for cmd.exe twice (a .cmd shim passes it through cmd.exe again).
  assert.equal(shim.args[3], '"C:\\Users\\alex\\AppData\\Roaming\\npm\\gateway.cmd ^^^"--port^^^" ^^^"8271^^^""');
  assert.deepEqual(shim.options, { windowsVerbatimArguments: true });
  const exe = startPlan('C:\\Program Files\\gw\\gw.exe', ['--port', '8271'], 'win32', env);
  assert.deepEqual(exe, { command: 'C:\\Program Files\\gw\\gw.exe', args: ['--port', '8271'], options: {} });
  assert.deepEqual(startPlan('/usr/local/bin/gw', ['--port', '8271'], 'linux'), { command: '/usr/local/bin/gw', args: ['--port', '8271'], options: {} });
  for (const p of [shim, exe]) assert.equal('shell' in p.options, false);
});

test('no add-on starts a program with shell: true', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'addons'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'addons', f), 'utf8');
    assert.doesNotMatch(text, /shell:\s*(true|viaShell)\s*[,}]/, f); // an option, not words in a comment
  }
});
