// Set up and the panel under it use ONE data folder: the folder the key command is given (--data-dir) is the folder the
// management client reads the command token from. The real seam file with the folder named by DATA_DIR; the gateway is
// the fake one; the key command a stand-in that asks it the way the real command does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeGateway } from './fakegateway.mjs';

const box = sandbox('trouteai-join');
test.after(() => box.cleanup());
const TOKEN = 'b'.repeat(64);
const FOLDER = path.join(box.root, 'join-data');
fs.mkdirSync(FOLDER, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(FOLDER, 'cli-token'), `${TOKEN}\n`, { mode: 0o600 });
process.env.DATA_DIR = FOLDER;
const { setupShippedGateway } = await import('../../src/gateway/trouteai.mjs');
const { callGateway } = await import('../../src/gateway/trouteaimanage.mjs');

test('the folder Set up starts the key command with is the folder the panel reads the token from', async () => {
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    const calls = [];
    const addon = {
      id: 'trouteai', title: 'TRouteAI', installHint: () => 'x', gateway: { port: () => gw.port },
      status: async () => ({ installed: true, running: true }), install: async () => ({ ok: true }), start: async () => ({ ok: true }),
      command: () => ['/opt/t/bin/t.mjs', '--port', String(gw.port)],
      profile: () => ({ name: 'api', label: 'API', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}` }, prerun: 'p', tokenVar: 'ANTHROPIC_AUTH_TOKEN' }),
    };
    const run = async (argv) => {
      calls.push(argv);
      const r = await fetch(`http://127.0.0.1:${gw.port}/api/keys`, { method: 'POST', headers: { 'x-trouteai-cli-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ name: argv[argv.indexOf('key') + 2] }) });
      return { ok: r.status === 201, stdout: `${(await r.json()).key}\n`, stderr: '' };
    };
    const r = await setupShippedGateway({ addon, computer: 'box9', deps: { run, firstCheck: () => {}, pollMs: 10, waitMs: 300 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls[0].at(-1), FOLDER, 'the key command got the folder');
    const keys = await callGateway('GET', '/api/keys', { port: gw.port });
    assert.ok(JSON.stringify(keys).includes('Hoprig sessions (box9)'), 'the panel sees the key Set up made, with the token of that folder');
  } finally {
    await gw.close();
  }
});
