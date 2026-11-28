// The router keeps an answer of 401 as a refused sign-in (not only the ten-minute pause), and a later good answer of
// the same provider takes it away. A stand-in upstream answers 401 and then 200.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('router-refused');
let status = 401;
const gw = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { id: 'msg_1' } : { type: 'error', error: { type: 'authentication_error', message: 'invalid' } }));
  });
});
const gPort = await new Promise((r) => gw.listen(0, '127.0.0.1', () => r(gw.address().port)));

const P = await import('../src/profiles.mjs');
const A = await import('../src/autoswitch.mjs');
const R = await import('../src/router.mjs');
const S = await import('../src/routerstate.mjs');

P.writeProfile('gw', { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gPort}/`, ANTHROPIC_AUTH_TOKEN: 'made-up-token' } });
A.setAutoSwitch({ enabled: true, order: ['gw'] });
const key = 'k'.repeat(48);
const router = R.createRouter({ key });
const rPort = await new Promise((r) => router.listen(0, '127.0.0.1', () => r(router.address().port)));
test.after(() => {
  router.close(); gw.close(); router.closeAllConnections(); gw.closeAllConnections();
  box.cleanup();
});
const ask = () => fetch(`http://127.0.0.1:${rPort}/${key}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
}).then(async (r) => (await r.text(), r.status));

test('401 is kept as a refused sign-in, and a good answer clears it', async () => {
  status = 401;
  await ask();
  assert.ok(S.refusedOf('gw'), 'the refusal is kept');
  assert.equal(A.limitedProfiles().gw.reason, 'auth');
  A.clearLimited('gw');
  status = 200;
  assert.equal(await ask(), 200);
  assert.equal(S.refusedOf('gw'), null, 'cleared by the good answer');
});
