// The shipped gateway is installed with the options its own README names (--allow-scripts for the two parts that
// build a helper, --loglevel=error), kept as data of its definition; the Install confirmation says so in one line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-installflags-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// A stand-in npm first on PATH, before the runner's traps: it writes down its arguments and installs nothing.
const bin = path.join(tmp, 'bin');
const calls = path.join(tmp, 'npm-calls.txt');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 });
// Windows starts npm through cmd.exe (setup/system.mjs npmArgv), which finds an npm.cmd, never a file without an extension.
if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'npm.cmd'), `@echo %*>>"${calls}"\r\n`);
// Its own gateway program too, so no real one of this computer is ever asked (status asks its version).
fs.writeFileSync(path.join(bin, 'trouteai'), '#!/bin/sh\necho "TRouteAI 1.0.0"\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
// A free port of its own: an update asks the gateway's port whether it runs, never the default one.
const net = await import('node:net');
const port = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
(await import('../../src/config.mjs')).saveConfig({ addons: { trouteai: { port } } });

const { SHIPPED } = await import('../../src/addons/gateways.mjs');
const { buildsLine, installArgv, installFlags, localGateway } = await import('../../src/addons/localgateway.mjs');
const { runsLines } = await import('../../src/addons/gatewaycli.mjs');
const { listAddons } = await import('../../src/addons/index.mjs');
const def = SHIPPED.find((d) => d.npm);

test('install and update pass the README\'s options, from the definition', async () => {
  assert.deepEqual(def.allowScripts, ['tls-client-node', 'koffi']);
  const g = localGateway(def, { shipped: true });
  await g.install();
  await g.update();
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/), [
    `install -g --allow-scripts=tls-client-node,koffi --loglevel=error ${def.npm}`,
    `install -g --allow-scripts=tls-client-node,koffi --loglevel=error ${def.npm}@latest`,
  ]);
});

test('the part names are checked strictly: anything else installs nothing', async () => {
  assert.deepEqual(installFlags({ npm: 'x' }), [], 'none named: no flags');
  for (const bad of [['--global'], ['a b'], ['../x'], ['x@1.0.0'], ['x', '-g'], 'koffi', [''], [7]]) {
    assert.equal(installFlags({ npm: 'x', allowScripts: bad }), null, JSON.stringify(bad));
    assert.equal(installArgv({ npm: 'x', allowScripts: bad }), null, JSON.stringify(bad));
  }
  assert.deepEqual(installFlags({ npm: 'x', allowScripts: ['@scope/part', 'plain.name'] }), ['--allow-scripts=@scope/part,plain.name', '--loglevel=error']);
  fs.rmSync(calls, { force: true });
  const r = await localGateway({ ...def, allowScripts: ['--prefix=/'] }, { shipped: true }).install();
  assert.equal(r.ok, false);
  assert.match(r.error, /not a package name, so it is not installed/);
  assert.equal(fs.existsSync(calls), false, 'npm was never started');
});

test('the Install confirmation says in one line that two parts build a helper: the page\'s list and the command', async () => {
  const line = 'Two of its parts (tls-client-node, koffi) build a helper program each on this computer while it installs.';
  assert.equal(buildsLine(def), line);
  assert.equal(buildsLine({ npm: 'x' }), null);
  const a = (await listAddons()).find((x) => x.id === def.id);
  assert.equal(a.builds, line);
  assert.equal(a.installCommand, `npm install -g --allow-scripts=tls-client-node,koffi --loglevel=error ${def.npm}`);
  const lines = runsLines({ ...def, args: def.args });
  assert.equal(lines[0], `Hoprig installs and updates it with: npm install -g --allow-scripts=tls-client-node,koffi --loglevel=error ${def.npm}`);
  assert.equal(lines[1], line);
  const page = fs.readFileSync(new URL('../../web/addons.js', import.meta.url), 'utf8');
  // A gateway's Install asks naming the computer, with the same line and the command (the server checks that name).
  assert.match(page, /if \(a\.gateway && !\(await confirmSheet\(\{ title: `Install \$\{a\.title\} on \$\{computer\}\?`, text: `\$\{a\.builds \? `\$\{a\.builds\} ` : ''\}\$\{a\.installCommand \? `This runs on \$\{computer\}: \$\{a\.installCommand\}`/);
  assert.match(page, /if \(!a\.gateway && a\.builds && !\(await confirmSheet\(\{ title: `Install \$\{a\.title\}\?`, text: `\$\{a\.builds\} This runs: \$\{a\.installCommand\}`/);
});
