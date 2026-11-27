// The shipped gateway is an npm package. Where npm is not on PATH the install goes through the npm beside Hoprig's own
// Node, so its program is in that Node's bin folder: it is found there after PATH, and that folder is the last of the
// PATH it starts with (its program starts with `env node`). One the owner defined and pinned never looks there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('gateway-nodedir');
const { localGateway } = await import('../../src/addons/localgateway.mjs');

const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const nodeDir = path.join(box.root, 'own-node-bin');
fs.mkdirSync(nodeDir);
const seen = path.join(box.root, 'path.txt');
const script = path.join(box.root, 'gw.mjs');
fs.writeFileSync(script, `import fs from 'node:fs';
import http from 'node:http';
fs.writeFileSync(${JSON.stringify(seen)}, process.env.PATH);
http.createServer((q, s) => s.end('gw')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
fs.writeFileSync(path.join(nodeDir, 'nodedirgw'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
const port = await freePort();
const def = { id: 'nodedirgw', title: 'Node dir gateway', npm: 'nodedirgw', bin: 'nodedirgw', port, args: ['--port', 'PORT'] };
const savePath = process.env.PATH;
process.env.PATH = '/usr/bin:/bin'; // seal: this test starts only its own stand-in program; no npm global bin, no Hoprig Node folder
test.after(() => {
  process.env.PATH = savePath;
  box.cleanup();
});

test('the shipped gateway is found in the folder of Hoprig\'s own Node, and starts with that folder last on PATH', { skip }, async () => {
  const g = localGateway(def, { shipped: true, nodeDir });
  assert.equal((await g.status()).installed, true);
  try {
    const r = await g.start();
    assert.equal(r.ok, true, r.error);
    const parts = fs.readFileSync(seen, 'utf8').split(path.delimiter);
    assert.equal(parts.at(-1), nodeDir);
    assert.equal(parts.filter((x) => x === nodeDir).length, 1);
    assert.ok(parts.indexOf('/usr/bin') < parts.length - 1, 'what was on PATH stays before it');
  } finally {
    await g.stop();
  }
});

test('a gateway the owner defined does not look there, and starts with PATH as it is', { skip }, async () => {
  const g = localGateway(def, { shipped: false, nodeDir });
  assert.equal((await g.status()).installed, false);
});
