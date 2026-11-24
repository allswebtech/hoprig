// A webhook delivery over https (src/work/hooks.mjs deliverOnce), with no real network: receivers on this computer's
// own addresses with certificates made for the test. The certificate is checked against the NAME of the webhook's
// address while the connection goes to the address that was checked and pinned; a certificate for another name, or
// from an authority nobody trusts, is refused; a name that answers with an address on this computer when the
// delivery checks it again is refused before any connection.
import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';
import { tempWork } from './helpers.mjs';
import { makeCert } from '../machines/certs.mjs';

const t = tempWork('work-hooks-tls');
const { deliverOnce } = await import('../../src/work/hooks.mjs');
const { resolveHook } = await import('../../src/work/hookaddr.mjs');

const NAME = 'hooks.example.com';
const root = makeCert({ cn: 'Test Webhook Authority', ca: true });
const SECRET = 'd'.repeat(64);
const linuxOnly = { skip: process.platform !== 'linux' && 'only Linux answers on all of 127/8' };

/** An https receiver on `host` whose certificate names `names` (DNS names only), signed by `issuer`. */
async function tlsReceiver(host, names, issuer = root) {
  const leaf = makeCert({ cn: names[0], issuer, dns: names });
  const got = [];
  const srv = https.createServer({ key: leaf.keyPem, cert: leaf.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ host: req.headers.host, servername: req.socket.servername, address: req.socket.localAddress, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  srv.on('tlsClientError', () => {}); // a client that refuses the certificate is the case under test
  await new Promise((r) => srv.listen(0, host, r));
  return { got, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const hookAt = (port, ownNetwork = true) => ({ url: `https://${NAME}:${port}/in`, ownNetwork, secret: SECRET });

test('the certificate is checked against the name while the connection goes to the pinned address', linuxOnly, async () => {
  const rx = await tlsReceiver('127.0.0.4', [NAME]); // no IP address in it: it passes only when the NAME is checked
  const other = await tlsReceiver('127.0.0.5', [NAME]);
  try {
    let asked = 0;
    // Checked: 127.0.0.4; any later answer of the name would lead to 127.0.0.5.
    const lookup = async () => (asked++ === 0 ? [{ address: '127.0.0.4', family: 4 }] : [{ address: '127.0.0.5', family: 4 }]);
    const r = await deliverOnce(hookAt(rx.port), '{"event":"result"}', { lookup, ca: root.cert });
    assert.deepEqual(r, { ok: true, status: 200 });
    assert.equal(asked, 1, 'the name is resolved once, by the check');
    assert.equal(rx.got.length, 1);
    assert.equal(rx.got[0].servername, NAME, 'the certificate is asked for by the name');
    assert.equal(rx.got[0].host, `${NAME}:${rx.port}`);
    assert.equal(rx.got[0].address, '127.0.0.4');
    assert.equal(rx.got[0].body, '{"event":"result"}');
    assert.equal(other.got.length, 0, 'nothing went to what the name answered later');
  } finally {
    await rx.close();
    await other.close();
  }
});

test('a certificate for another name, or from an authority nobody trusts, is refused', linuxOnly, async () => {
  const wrongName = await tlsReceiver('127.0.0.4', ['other.example.com']);
  const stranger = makeCert({ cn: 'Some Other Authority', ca: true });
  const wrongAuthority = await tlsReceiver('127.0.0.4', [NAME], stranger);
  try {
    const lookup = async () => [{ address: '127.0.0.4', family: 4 }];
    assert.deepEqual(await deliverOnce(hookAt(wrongName.port), '{}', { lookup, ca: root.cert }), { ok: false, status: null });
    assert.equal(wrongName.got.length, 0, 'no request reached a receiver whose certificate names another computer');
    assert.deepEqual(await deliverOnce(hookAt(wrongAuthority.port), '{}', { lookup, ca: root.cert }), { ok: false, status: null });
    assert.equal(wrongAuthority.got.length, 0);
    // And without the test's authority the system's authorities decide: the test's own certificate is not one of theirs.
    const good = await tlsReceiver('127.0.0.4', [NAME]);
    try {
      assert.deepEqual(await deliverOnce(hookAt(good.port), '{}', { lookup }), { ok: false, status: null });
      assert.equal(good.got.length, 0);
    } finally {
      await good.close();
    }
  } finally {
    await wrongName.close();
    await wrongAuthority.close();
  }
});

test('a name that answered with a public address when it was saved and answers with this computer\'s now is refused before any connection', linuxOnly, async () => {
  const rx = await tlsReceiver('127.0.0.4', [NAME]);
  try {
    let asked = 0;
    const lookup = async () => (asked++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.4', family: 4 }]);
    // The check when the owner saves it (not marked "on my own network"): a public address, accepted.
    const saved = await resolveHook(`https://${NAME}:${rx.port}/in`, { lookup });
    assert.equal(saved.address, '93.184.216.34');
    // The delivery checks again: the name now leads here, and it is refused; nothing connects.
    const r = await deliverOnce(hookAt(rx.port, false), '{}', { lookup, ca: root.cert });
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.equal(rx.got.length, 0, 'no connection to the address the name answered after the check');
    assert.equal(asked, 2);
  } finally {
    await rx.close();
  }
});

test.after(() => t.cleanup());
