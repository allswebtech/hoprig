// The minute limit of a Work token (src/work/tokenfeature.mjs) when this computer's clock is set back: requests made
// "in the future" of the new time are not the last minute's, so the token is not refused for as long as the clock went back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-token-clock');
const { tokenDoor } = await import('../../src/work/tokenfeature.mjs');
const access = await import('../../src/work/access.mjs');

test('a clock set back an hour does not hold a token back for an hour', async () => {
  access.setWorkLimits({ perMinute: 2 });
  const { token } = access.createWorkToken('Clock script');
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const door = tokenDoor({ place: () => ({ file: '/nonexistent', settings: {} }), store: () => null, readJson: async () => ({}), resume: async () => {}, log: () => {}, clientIp: () => '127.0.0.1', now: () => clock });
  const ask = async () => {
    let status = 0;
    const res = { writeHead: (s) => (status = s), end: () => {} };
    await door.handle({ method: 'DELETE', url: '/api/work/token/tasks', headers: { authorization: `Bearer ${token}` } }, res);
    return status;
  };
  assert.equal(await ask(), 405, 'counted, then refused for its method');
  assert.equal(await ask(), 405);
  assert.equal(await ask(), 429, 'the limit holds');
  clock -= 3_600_000; // the clock is set back an hour
  assert.equal(await ask(), 405, 'the requests of an hour "later" are not the last minute\'s');
});

test.after(() => t.cleanup());
