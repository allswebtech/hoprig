// How soon each provider starts its answers, and its refusals, as the router sees them (no request of its own), and
// the verdict made of them: fast, slow (median first byte of streamed answers over 5 s, the last 5 minutes),
// refusing (3 refusals in 5 minutes) or not known.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-router-speed-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;

// A stand-in gateway: waits `delay` ms before its first byte, answers `status`, streamed while `stream`.
let delay = 0;
let status = 200;
let stream = true;
const gw = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => setTimeout(() => {
    if (status === 200 && stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('event: message_start\ndata: {"type":"message_start"}\n\n');
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { id: 'msg_1' } : { type: 'error', error: { type: 'rate_limit_error', message: 'too many' } }));
  }, delay));
});
const gPort = await new Promise((r) => gw.listen(0, '127.0.0.1', () => r(gw.address().port)));
process.env.HOPRIG_ANTHROPIC_URL = `http://127.0.0.1:${gPort}`;

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
  fs.rmSync(tmp, { recursive: true, force: true });
});
const ask = () => fetch(`http://127.0.0.1:${rPort}/${key}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
}).then(async (r) => (await r.text(), r.status));

test('the router keeps the time to the first byte of each answer and every short refusal, per provider', async () => {
  delay = 150;
  status = 200;
  assert.equal(await ask(), 200);
  stream = false; // an answer that is not streamed (a title): its first byte comes with the whole answer, not timed
  delay = 400;
  assert.equal(await ask(), 200);
  delay = 0;
  status = 429; // no Retry-After, no reset: Auto mode forgets it as a limit, the speed record keeps it
  assert.equal(await ask(), 429);
  status = 529;
  assert.equal(await ask(), 529);
  await new Promise((r) => setTimeout(r, 2300)); // written with the router's flush, every two seconds
  const rec = S.routerSpeed().gw;
  assert.equal(rec.answers.length, 1);
  assert.ok(rec.answers[0].ms >= 140 && rec.answers[0].ms < 3000, `first byte after ${rec.answers[0].ms} ms`);
  assert.equal(rec.refusals.length, 2);
  assert.equal(A.limitedProfiles().gw, undefined, 'a short refusal still marks no limit');
});

test('the verdict: fast or slow by the median first byte, refusing at 3 refusals in 5 minutes, else not known', () => {
  const now = Date.now();
  const ans = (...ms) => ms.map((m, i) => ({ at: now - 1000 * (i + 1), ms: m }));
  assert.equal(S.speedVerdict(null, now), null);
  assert.equal(S.speedVerdict({ answers: ans(9000, 9000) }, now), null, 'fewer than 3 answers: not known');
  assert.deepEqual(S.speedVerdict({ answers: ans(1500, 2500, 2000) }, now), { verdict: 'fast', seconds: 2 });
  assert.deepEqual(S.speedVerdict({ answers: ans(6000, 11000, 9000, 1000) }, now), { verdict: 'slow', seconds: 7.5 });
  assert.equal(S.speedVerdict({ answers: ans(9000, 9000, 9000).map((a) => ({ ...a, at: now - 6 * 60_000 })) }, now), null, 'older than 5 minutes: gone');
  // A burst of three slow answers: slow for 5 minutes, not for the next half hour while new sessions go elsewhere.
  let burst = null;
  for (let i = 0; i < 3; i++) burst = S.noteSpeed(burst, { ms: 6000 }, now + i * 1000);
  assert.deepEqual(S.speedVerdict(burst, now + 4 * 60_000), { verdict: 'slow', seconds: 6 });
  assert.equal(S.speedVerdict(burst, now + 6 * 60_000), null);
  const refused = (...ago) => ago.map((m) => ({ at: now - m * 60_000 }));
  assert.deepEqual(S.speedVerdict({ answers: ans(1000, 1000, 1000), refusals: refused(1, 2, 4) }, now), { verdict: 'refusing' });
  assert.deepEqual(S.speedVerdict({ answers: ans(1000, 1000, 1000), refusals: refused(1, 2, 6) }, now), { verdict: 'fast', seconds: 1 });
  // Only the last 20 of each are kept.
  let rec = null;
  for (let i = 0; i < 25; i++) rec = S.noteSpeed(rec, { ms: 100 + i }, now);
  for (let i = 0; i < 25; i++) rec = S.noteSpeed(rec, { refused: true }, now);
  assert.equal(rec.answers.length, 20);
  assert.equal(rec.answers[0].ms, 105);
  assert.equal(rec.refusals.length, 20);
});
