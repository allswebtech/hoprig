// Trusting a hub whose certificate it made itself (hubcert.mjs): the fingerprint's strict form, matching in constant
// time, establishing trust against real TLS servers signed by throwaway authorities (right, wrong and no fingerprint;
// a "public" authority via NODE_EXTRA_CA_CERTS in a child process), the stored pin on a later connection, a renewed
// certificate under the same authority, a changed authority, and what the hub finds out about itself.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAuthority } from './certs.mjs';

const hc = await import('../../src/machines/hubcert.mjs');
const HUBCERT = fileURLToPath(new URL('../../src/machines/hubcert.mjs', import.meta.url));

const A = makeAuthority('Hub A');
const B = makeAuthority('Hub B');
const pinA = hc.pinOf(A.root.cert);
const pinB = hc.pinOf(B.root.cert);

/** An HTTPS server like Caddy's: leaf + intermediate, and GET /api/link/ca answering `ca`. Counts requests. */
async function server({ auth = A, host = '127.0.0.1', withRoot = false, ca = auth.root.cert } = {}) {
  const leaf = auth.leaf(host);
  const seen = [];
  const s = https.createServer({ key: leaf.keyPem, cert: leaf.cert + auth.inter.cert + (withRoot ? auth.root.cert : '') }, (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/link/ca' ? { certificate: ca } : { ok: true }));
  });
  let handshakes = 0;
  s.on('secureConnection', () => handshakes++);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    ep: { protocol: 'https:', hostname: '127.0.0.1', port: s.address().port, basePath: '' },
    seen,
    get handshakes() {
      return handshakes;
    },
    renew: (a = auth) => {
      const l = a.leaf(host);
      s.setSecureContext({ key: l.keyPem, cert: l.cert + a.inter.cert });
    },
    close: () => new Promise((r) => {
      s.closeAllConnections?.();
      s.close(() => r());
    }),
  };
}

const get = (ep, trust) => new Promise((resolve, reject) => {
  const r = https.request({ hostname: ep.hostname, port: ep.port, path: '/x', agent: false, ...trust }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  r.on('error', reject);
  r.end();
});

test('the fingerprint: one strict form, anything else refused', () => {
  assert.match(pinA, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(hc.parsePin(pinA), pinA);
  for (const bad of [
    null, undefined, 42, '', pinA.slice(7), `SHA256:${pinA.slice(7)}`, `sha256/${pinA.slice(7)}`, `${pinA}=`, `${pinA}A`, pinA.slice(0, -1),
    ` ${pinA}`, `${pinA}\n`, `sha256:${'a'.repeat(64)}`, `sha256:${pinA.slice(7, -1)}+`, `sha256:${pinA.slice(7, -1)}/`,
  ]) assert.equal(hc.parsePin(bad), null, String(bad));
  // 43 characters carry 258 bits: the last one must leave the 2 spare bits empty, or it is not the canonical form.
  const raw = Buffer.from(pinA.slice(7), 'base64url');
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const canon = pinA.at(-1);
  const sibling = last[last.indexOf(canon) ^ 1];
  assert.equal(Buffer.from(`${pinA.slice(7, -1)}${sibling}`, 'base64url').equals(raw), true, 'decodes the same');
  assert.equal(hc.parsePin(`${pinA.slice(0, -1)}${sibling}`), null, 'but is refused');
});

test('pinOf is SHA-256 of the DER public key; pinMatches compares it, and nothing else matches', async () => {
  const crypto = await import('node:crypto');
  const spki = A.root.x509.publicKey.export({ type: 'spki', format: 'der' });
  assert.equal(pinA, `sha256:${crypto.createHash('sha256').update(spki).digest('base64url')}`);
  assert.equal(hc.pinMatches(pinA, A.root.cert), true);
  assert.equal(hc.pinMatches(pinA, A.root.x509.raw), true, 'DER too');
  assert.equal(hc.pinMatches(pinA, A.inter.cert), false);
  assert.equal(hc.pinMatches(pinA, B.root.cert), false);
  assert.equal(hc.pinMatches('sha256:nope', A.root.cert), false);
  assert.equal(hc.pinMatches(pinA, 'not a certificate'), false);
  assert.throws(() => hc.pinOf('junk'), /not a certificate/);
});

test('own authority: no fingerprint is refused with where to read the line; nothing is sent', async () => {
  const s = await server();
  try {
    await assert.rejects(hc.establishTrust(s.ep, null, { joinHint: 'the hub (hoprig machines invite)' }), (e) =>
      e.code === 'untrusted' && /made by the hub itself/.test(e.message) && /--fingerprint sha256:/.test(e.message) && /hoprig machines invite/.test(e.message) && /does not turn the check off/.test(e.message));
    assert.deepEqual(s.seen, [], 'no HTTP request at all');
  } finally {
    await s.close();
  }
});

test('own authority: the right fingerprint is accepted (the authority from /api/link/ca), then verified for real', async () => {
  const s = await server();
  try {
    const t = await hc.establishTrust(s.ep, pinA);
    assert.equal(t.pin, pinA);
    assert.equal(hc.pinMatches(pinA, t.ca), true);
    assert.deepEqual(s.seen, ['GET /api/link/ca'], 'only the public authority was asked for');
    // What the joined computer keeps verifies every later connection.
    assert.equal(await get(s.ep, hc.trustOptions(t, '127.0.0.1')), 200);
  } finally {
    await s.close();
  }
});

test('own authority sent in the chain: found there, /api/link/ca not needed', async () => {
  const s = await server({ withRoot: true, ca: null });
  try {
    const t = await hc.establishTrust(s.ep, pinA);
    assert.equal(t.pin, pinA);
    assert.deepEqual(s.seen, []);
  } finally {
    await s.close();
  }
});

test('a wrong fingerprint is refused before the code: also when the hub hands out a matching authority that did not sign it', async () => {
  const s = await server();
  try {
    await assert.rejects(hc.establishTrust(s.ep, pinB), (e) => e.code === 'fingerprint' && /does not match/.test(e.message) && /Nothing was sent/.test(e.message));
    assert.deepEqual(s.seen, ['GET /api/link/ca']);
  } finally {
    await s.close();
  }
  // A man in the middle that serves B's root at /api/link/ca but presents A's chain: B's key matches, the chain does not.
  const m = await server({ auth: A, ca: B.root.cert });
  try {
    await assert.rejects(hc.establishTrust(m.ep, pinB), (e) => e.code === 'fingerprint' && /not signed by the authority/.test(e.message));
  } finally {
    await m.close();
  }
});

test('a malformed fingerprint is refused before any connection', async () => {
  const s = await server();
  try {
    for (const bad of ['sha256:short', 'AB:CD:EF', pinA.slice(7)]) {
      await assert.rejects(hc.establishTrust(s.ep, bad), (e) => e.code === 'bad-fingerprint' && /sha256: followed by 43/.test(e.message));
    }
    assert.equal(s.handshakes, 0);
  } finally {
    await s.close();
  }
});

test('a renewed certificate (new leaf and intermediate, same root) keeps working; a new authority is refused plainly', async () => {
  const s = await server();
  try {
    const t = await hc.establishTrust(s.ep, pinA);
    const trust = hc.trustOptions(t, '127.0.0.1');
    // Renewal: Caddy issues a new intermediate and leaf under the same root. (New intermediate key: made here.)
    const { makeCert } = await import('./certs.mjs');
    const inter2 = makeCert({ cn: 'Hub A - Intermediate 2', issuer: A.root, ca: true, days: 7 });
    const leaf2 = makeCert({ cn: '127.0.0.1', issuer: inter2, ips: ['127.0.0.1'], days: 1 });
    s.renew({ leaf: () => leaf2, inter: inter2 });
    assert.equal(await get(s.ep, trust), 200, 'renewal does not break the join');
    // The hub's authority changed (reinstalled): refused, said plainly.
    s.renew(B);
    const e = await get(s.ep, trust).then(() => null, (x) => x);
    assert.ok(e, 'refused');
    assert.match(hc.explainTls(e, { host: '127.0.0.1', pin: pinA }), /no longer signed by the authority this computer pinned when it joined .*show the join line there again/);
    // Not even the stored authority helps a connection without the pin check: the trust is the pin AND the authority.
    assert.deepEqual(hc.trustOptions({}), {});
  } finally {
    await s.close();
  }
});

test('the host name is still checked with a pinned authority', async () => {
  const s = await server({ host: '192.0.2.7' }); // a certificate for another address
  try {
    await assert.rejects(hc.establishTrust(s.ep, pinA), (e) => e.code === 'tls' && /another name or address/.test(e.message));
  } finally {
    await s.close();
  }
});

// A "public" authority: Node trusts NODE_EXTRA_CA_CERTS like its built-in list, read once at start, so a child.
function inChild(pemFile, script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: pemFile }, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
}

test('a publicly trusted hub: works as before with no fingerprint, a right one is checked, a wrong one refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubcert-'));
  const pem = path.join(dir, 'public.pem');
  fs.writeFileSync(pem, A.root.cert);
  const s = await server({ ca: null });
  try {
    const run = (pin) => inChild(pem, `
      const hc = await import(${JSON.stringify(pathToFileURL(HUBCERT).href)});
      try { const t = await hc.establishTrust(${JSON.stringify(s.ep)}, ${JSON.stringify(pin)}); console.log(JSON.stringify({ ok: true, pin: t.pin, ca: t.ca })); }
      catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, message: e.message })); }`);
    assert.deepEqual(await run(null), { ok: true, pin: null, ca: null });
    assert.deepEqual(await run(pinA), { ok: true, pin: pinA, ca: null }, 'the root in the verified chain matches');
    const wrong = await run(pinB);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'fingerprint');
    assert.match(wrong.message, /publicly trusted certificate, but nothing in its chain matches/);
    assert.deepEqual(s.seen, [], 'nothing was asked of it');
    // What the hub says about itself: public, nothing to add to the line.
    const self = await inChild(pem, `
      const hc = await import(${JSON.stringify(pathToFileURL(HUBCERT).href)});
      console.log(JSON.stringify(await hc.hubCertificate('https://127.0.0.1:${s.ep.port}/', { root: async () => null })));`);
    assert.deepEqual(self, { kind: 'public' });
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hub finds out its own certificate: own authority (with the pin), unknown, plain', async () => {
  const s = await server();
  try {
    const base = `https://127.0.0.1:${s.ep.port}/`;
    hc.forgetHubCertificate();
    const own = await hc.hubCertificate(base, { root: async () => A.root.cert });
    assert.equal(own.kind, 'own');
    assert.equal(own.pin, pinA);
    hc.forgetHubCertificate();
    const none = await hc.hubCertificate(base, { root: async () => null });
    assert.equal(none.kind, 'unknown');
    assert.match(none.why, /could not be read/);
    hc.forgetHubCertificate();
    const other = await hc.hubCertificate(base, { root: async () => B.root.cert });
    assert.equal(other.kind, 'unknown');
    assert.match(other.why, /not signed by Caddy's own authority/);
    assert.deepEqual(await hc.hubCertificate('http://192.0.2.1:7433/'), { kind: 'plain' });
    hc.forgetHubCertificate();
    const closed = await hc.hubCertificate('https://127.0.0.1:1/', { root: async () => A.root.cert, timeoutMs: 1000 });
    assert.equal(closed.kind, 'unknown');
    assert.match(closed.why, /did not answer/);
  } finally {
    await s.close();
  }
});

test('Caddy\'s authority: from its admin API, else from its data folder, else null', async () => {
  const api = http.createServer((req, res) => {
    if (req.url === '/pki/ca/local') res.end(JSON.stringify({ id: 'local', root_certificate: A.root.cert, intermediate_certificate: A.inter.cert }));
    else res.writeHead(404).end();
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddydata-'));
  try {
    const admin = `http://127.0.0.1:${api.address().port}`;
    assert.equal(hc.pinOf(await hc.caddyRoot({ admin, files: [] })), pinA);
    const file = path.join(dir, 'root.crt');
    fs.writeFileSync(file, B.root.cert);
    assert.equal(hc.pinOf(await hc.caddyRoot({ admin: 'http://127.0.0.1:1', files: [path.join(dir, 'missing'), file] })), pinB);
    fs.writeFileSync(file, 'not a certificate');
    assert.equal(await hc.caddyRoot({ admin: 'http://127.0.0.1:1', files: [file] }), null);
    assert.ok(hc.caddyRootFiles({}, '/home/u').includes(path.join('/var/lib/caddy/.local/share', 'caddy', 'pki', 'authorities', 'local', 'root.crt')));
  } finally {
    api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the join line: the fingerprint for a hub with its own authority, a note when unknown, --insecure only for plain http', () => {
  const own = hc.joinCommand('https://192.168.1.5/', 'K7QM-4XP2', { kind: 'own', pin: pinA });
  assert.equal(own.line, `hoprig join https://192.168.1.5 K7QM-4XP2 --fingerprint ${pinA}`);
  assert.match(own.note, /stays the same when the certificate renews/);
  assert.deepEqual(hc.joinCommand('https://hub.example.com', 'K7QM-4XP2', { kind: 'public' }), { line: 'hoprig join https://hub.example.com K7QM-4XP2', note: null });
  const unknown = hc.joinCommand('https://10.0.0.2', 'K7QM-4XP2', { kind: 'unknown', why: 'x' });
  assert.equal(unknown.line, 'hoprig join https://10.0.0.2 K7QM-4XP2');
  assert.match(unknown.note, /hoprig machines fingerprint/);
  assert.equal(hc.joinCommand('http://192.168.1.5:7433', 'K7QM-4XP2', { kind: 'plain' }).line, 'hoprig join http://192.168.1.5:7433 K7QM-4XP2 --insecure');
  assert.equal(hc.joinCommand('http://127.0.0.1:7433', 'K7QM-4XP2', { kind: 'plain' }).line, 'hoprig join http://127.0.0.1:7433 K7QM-4XP2');
  assert.equal(hc.joinCommand('https://h', 'C', { kind: 'own', pin: pinA }, 'hop').line.startsWith('hop join'), true);
});
