// An open chat's model menu (choicesOf with onModels, src/chat/tools.mjs) asks its provider at most once in ten
// minutes, whatever the last ask gave: a model the endpoint adds later reaches the menu and the check, and a provider
// that refuses the key is not asked again at every state the page is sent.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('chatask');
test.after(() => box.cleanup());
const { KEEP_MS, forgetModels } = await import('../../src/models/catalog.mjs');
const { choicesOf, modelOk } = await import('../../src/chat/tools.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');

/** A stand-in endpoint on a free port: its answer can change; every request is counted. */
async function standIn() {
  const s = { answer: { status: 200, body: {} }, hits: 0 };
  const srv = http.createServer((req, res) => {
    s.hits++;
    res.writeHead(s.answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(s.answer.body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${srv.address().port}`;
  s.close = () => new Promise((r) => srv.close(r));
  return s;
}
const list = (ids) => ({ data: ids.map((id) => ({ id })) });
const FIVE = ['relay-1', 'relay-2', 'relay-3', 'relay-4', 'relay-5'];
const settle = () => new Promise((r) => setTimeout(r, 150));
/** The menu's keeping is read from Date.now: a clock of the test's own, put back after it. */
function clock(t) {
  const real = Date.now;
  let now = 1_000_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = real; });
  return (ms) => { now += ms; };
}

test('a model the endpoint adds later reaches an open chat\'s menu after ten minutes, with one more ask', async (t) => {
  forgetModels();
  const later = clock(t);
  const s = await standIn();
  t.after(s.close);
  s.answer = { status: 200, body: list(FIVE) };
  writeProfile('relay', { label: 'Relay', env: { ANTHROPIC_BASE_URL: s.url, ANTHROPIC_AUTH_TOKEN: 'sk-relay-test-key-0123456789' } });
  let sent = 0;
  const open = () => choicesOf('claude', 'relay', () => [], () => sent++);
  open();
  await settle();
  assert.deepEqual([s.hits, sent], [1, 1], 'the first open asks once and sends the list');
  s.answer = { status: 200, body: list([...FIVE, 'relay-new']) };
  later(KEEP_MS - 1000);
  open();
  await settle();
  assert.equal(s.hits, 1, 'not asked again within ten minutes');
  assert.equal(modelOk('claude', 'relay-new', open()), false, 'within ten minutes the kept list decides');
  later(2000);
  open();
  await settle();
  assert.equal(s.hits, 2, 'asked once more after ten minutes');
  const ch = open();
  assert.ok(ch.models.includes('relay-new'), 'the new model is in the menu');
  assert.equal(modelOk('claude', 'relay-new', ch), true, 'and the check takes it');
  assert.equal(sent, 2, 'the page is sent the new list');
  await settle();
  assert.equal(s.hits, 2, 'no ask beyond that one');
});

test('an open chat on a provider that refuses the key: 120 state sends in an hour ask a few times only', async (t) => {
  forgetModels();
  const later = clock(t);
  const s = await standIn();
  t.after(s.close);
  s.answer = { status: 401, body: { error: { message: 'bad key' } } };
  writeProfile('badkey', { label: 'Bad', env: { ANTHROPIC_BASE_URL: s.url, ANTHROPIC_AUTH_TOKEN: 'sk-relay-wrong-key-000000' } });
  for (let i = 0; i < 120; i++) { // a chat that streams for an hour: a state send every 30 seconds
    choicesOf('claude', 'badkey', () => [], () => {});
    await new Promise((r) => setTimeout(r, 20));
    later(30_000);
  }
  await settle();
  // One ask in ten minutes (six in the hour), each a refused key tried once with the other header.
  assert.ok(s.hits >= 2 && s.hits <= 12, `requests in the hour: ${s.hits}`);
});
