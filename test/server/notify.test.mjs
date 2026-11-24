import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { EVENTS, buildRequest, cleanNotify, describe, sendNotification } from '../../src/server/notify.mjs';

test('settings validation', () => {
  assert.equal(cleanNotify(null), null);
  assert.deepEqual(cleanNotify({ url: 'https://ntfy.sh/topic', events: ['limit', 'limit'], headers: { Authorization: 'Bearer x' }, format: 'ntfy' }), {
    url: 'https://ntfy.sh/topic', events: ['limit'], headers: { Authorization: 'Bearer x' }, format: 'ntfy',
  });
  assert.throws(() => cleanNotify({ url: 'file:///etc/passwd' }), /https/);
  assert.throws(() => cleanNotify({ url: 'nope' }), /valid URL/);
  assert.throws(() => cleanNotify({ events: ['party'] }), /events/);
  assert.throws(() => cleanNotify({ headers: { Host: 'x' } }), /cannot be used/);
  assert.throws(() => cleanNotify({ headers: { 'X-A': 'a\r\nInjected: 1' } }), /not usable/);
  assert.throws(() => cleanNotify({ format: 'xml' }), /format/);
});

test('request shape: ntfy by host, json otherwise, ASCII headers', () => {
  const ev = { ...describe('limit', 'proj', 'You’ve hit your 5-hour limit'), status: 'limit', session: 'proj', url: 'https://pc/#/s/proj' };
  const n = buildRequest({ url: 'https://ntfy.sh/abc' }, ev);
  assert.equal(n.format, 'ntfy');
  assert.equal(n.body, 'You’ve hit your 5-hour limit');
  assert.equal(n.headers.Title, 'proj reached a usage limit');
  assert.equal(n.headers.Click, 'https://pc/#/s/proj');
  assert.equal(n.headers.Tags, 'warning');
  const j = buildRequest({ url: 'https://hooks.example/x', headers: { 'X-Key': 'k' } }, ev);
  assert.equal(j.format, 'json');
  assert.deepEqual(JSON.parse(j.body), { title: 'proj reached a usage limit', message: 'You’ve hit your 5-hour limit', session: 'proj', status: 'limit', url: 'https://pc/#/s/proj' });
  assert.equal(j.headers['X-Key'], 'k');
  assert.equal(buildRequest({ url: 'https://x' }, { title: 'Ünïcode ✓', status: 'waiting' }).headers.Title, '?n?code ?');
  assert.equal(buildRequest({ url: 'https://x' }, { message: 'm'.repeat(400) }).payload.message.length, 300);
  assert.deepEqual(EVENTS, ['waiting', 'attention', 'limit', 'ended', 'switched', 'automation']);
});

test('delivery to a local receiver; event filter; timeout; error answer', async () => {
  const got = [];
  let delay = 0;
  let status = 200;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(status);
        res.end();
      }, delay);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const logs = [];
  const log = (l) => logs.push(l);
  try {
    assert.deepEqual(await sendNotification({ url }, { status: 'waiting', title: 't', message: 'm', session: 's' }, { log }), { sent: true, status: 200 });
    assert.equal(got[0].headers['content-type'], 'application/json');
    assert.equal(JSON.parse(got[0].body).session, 's');
    assert.equal((await sendNotification({ url, events: ['limit'] }, { status: 'waiting' }, { log })).sent, false);
    assert.equal(got.length, 1, 'filtered event not sent');
    status = 500;
    assert.match((await sendNotification({ url }, { status: 'limit', session: 's' }, { log })).error, /500/);
    status = 200;
    delay = 500;
    const t0 = Date.now();
    const r = await sendNotification({ url }, { status: 'limit', session: 's' }, { log, timeoutMs: 100 });
    assert.equal(r.error, 'timed out');
    assert.ok(Date.now() - t0 < 450);
    assert.equal(logs.length, 2, 'one log line per failure');
    assert.equal((await sendNotification(null, { status: 'limit' })).sent, false);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('an ntfy title in another script goes as RFC 2047 encoded words; plain ASCII and JSON receivers as before', async () => {
  const { encodedWords } = await import('../../src/server/notify.mjs');
  const long = 'काम: 3 हो गए, 2 चल रहे हैं और 1 आपका इंतज़ार कर रहा है';
  const t = buildRequest({ url: 'https://ntfy.sh/abc' }, { title: long, status: 'automation' }).headers.Title;
  const words = t.split(' ');
  assert.ok(words.length > 1 && words.every((w) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w) && w.length <= 75), t);
  assert.equal(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''), long, 'no character cut in two');
  assert.equal(buildRequest({ url: 'https://ntfy.sh/abc' }, { title: 'Ünïcode ✓', status: 'waiting' }).headers.Title, encodedWords('Ünïcode ✓'));
  assert.equal(buildRequest({ url: 'https://ntfy.sh/abc' }, { title: 'proj is waiting', status: 'waiting' }).headers.Title, 'proj is waiting');
  assert.equal(buildRequest({ url: 'https://x' }, { title: 'Ünïcode ✓', status: 'waiting' }).headers.Title, '?n?code ?', 'a JSON receiver reads the body');
});
