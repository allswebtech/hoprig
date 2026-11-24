// A made-up npm for test/seal.test.mjs, started by the npm trap in place of the real one (SEAL_NEXT_NPM). It says, into
// the file SEAL_NPM_SAID, where npm would keep its cache and debug log and which registry it would ask, as the real npm
// reads them from its environment. It writes a log only under the temporary folder and asks a registry only on this
// computer: with a piece of the seal taken away it says "elsewhere" and asks nothing, so nothing real is reached.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const said = [];
const own = (p) => [os.tmpdir(), fs.realpathSync(os.tmpdir())].some((t) => path.resolve(p).startsWith(t + path.sep));
const cache = process.env.npm_config_cache || path.join(process.env.HOME || os.homedir(), '.npm');
const logs = process.env.npm_config_logs_dir || path.join(cache, '_logs');
if (own(logs)) {
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'seal-made-up-debug-0.log'), `argv ${process.argv.slice(2).join(' ')}\n`);
  said.push('log: the test\'s own folder');
} else said.push('log: elsewhere (not written)');
const registry = process.env.npm_config_registry || 'https://registry.npmjs.org/';
const host = new URL(registry).hostname;
if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
  const status = await new Promise((resolve) => http.get(new URL(`seal-made-up-package`, registry), (res) => { res.resume(); resolve(res.statusCode); }).on('error', (e) => resolve(e.code)));
  said.push(`registry: on this computer, answered ${status}`);
} else said.push(`registry: ${host} (not asked)`);
fs.writeFileSync(process.env.SEAL_NPM_SAID, `${said.join('\n')}\n`);
