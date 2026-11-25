// The checked download (src/pcsetup/fetchkit.mjs) against a stand-in vendor: a server of the test's own on 127.0.0.1,
// reached through the getter the module is handed. The addresses the module checks are the vendor's own https ones;
// the getter only carries each one to the local server, so a refusal is the module's, never the network's.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { vendor } from './vendor.mjs';
import { FetchError, checkAddress, chooseFlutter, download, readList, sizeWords } from '../../src/pcsetup/fetchkit.mjs';

const HOST = 'storage.googleapis.com';
const BASE = `https://${HOST}/flutter_infra_release/releases`;
const sha = (b, type = 'sha256') => crypto.createHash(type).update(b).digest('hex');

const tmp = (tc) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchkit-'));
  tc.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const refused = async (p, code) => {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof FetchError, e.stack);
    assert.equal(e.code, code, e.message);
    return true;
  });
};

test('a download whose size and checksum are right lands whole; its progress is heard', async (tc) => {
  const body = Buffer.from('a tiny archive\n'.repeat(100));
  const v = await vendor(tc, { '/a.tar.xz': { headers: { 'content-length': String(body.length) }, body } });
  const file = path.join(tmp(tc), 'a.tar.xz');
  const seen = [];
  const r = await download(`https://${HOST}/a.tar.xz`, { host: HOST, ceiling: 10_000, checksum: { type: 'sha256', hex: sha(body) }, file, get: v.get, onProgress: (n) => seen.push(n) });
  assert.equal(r.bytes, body.length);
  assert.deepEqual(fs.readFileSync(file), body);
  assert.equal(seen.at(-1), body.length);
  assert.deepEqual(v.asked, [`https://${HOST}/a.tar.xz`]);
});

test('sha1 (the only checksum Android\'s list gives) is checked the same way', async (tc) => {
  const body = Buffer.from('zip bytes');
  const v = await vendor(tc, { '/t.zip': { body } });
  const file = path.join(tmp(tc), 't.zip');
  await download(`https://${HOST}/t.zip`, { host: HOST, ceiling: 100, size: body.length, checksum: { type: 'sha1', hex: sha(body, 'sha1') }, file, get: v.get });
  const bad = path.join(path.dirname(file), 'bad.zip');
  await refused(download(`https://${HOST}/t.zip`, { host: HOST, ceiling: 100, size: body.length, checksum: { type: 'sha1', hex: sha(Buffer.from('x'), 'sha1') }, file: bad, get: v.get }), 'checksum');
});

test('refused: a wrong checksum, a size over the list or the ceiling, a false or missing Content-Length past the ceiling', async (tc) => {
  const body = Buffer.alloc(5000, 1);
  const v = await vendor(tc, {
    '/ok': { headers: { 'content-length': '5000' }, body },
    // Says (and sends) 100 bytes where the vendor's list gives 5000; says nothing and sends 5000.
    '/liar': { headers: { 'content-length': '100' }, body: body.subarray(0, 100) },
    '/silent': (req, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.end(body);
    },
  });
  const d = tmp(tc);
  const opts = (name, o = {}) => ({ host: HOST, ceiling: 10_000, checksum: { type: 'sha256', hex: sha(body) }, file: path.join(d, name), get: v.get, ...o });
  await refused(download(`https://${HOST}/ok`, opts('a', { checksum: { type: 'sha256', hex: sha(Buffer.from('other')) } })), 'checksum');
  await refused(download(`https://${HOST}/ok`, opts('b', { ceiling: 4999 })), 'size');
  await refused(download(`https://${HOST}/ok`, opts('c', { size: 4000 })), 'size');
  await refused(download(`https://${HOST}/ok`, opts('d', { size: 20_000 })), 'size');
  // No Content-Length: the bytes are counted and cut at the ceiling.
  await refused(download(`https://${HOST}/silent`, opts('e', { ceiling: 1000 })), 'size');
  await refused(download(`https://${HOST}/liar`, opts('f', { size: 5000 })), 'size');
  // No checksum to check: nothing is asked.
  const before = v.asked.length;
  await refused(download(`https://${HOST}/ok`, opts('g', { checksum: null })), 'checksum');
  assert.equal(v.asked.length, before);
});

test('refused: another host, http, a redirect to another host or to http; a redirect on the same host is followed', async (tc) => {
  const body = Buffer.from('ok');
  const v = await vendor(tc, {
    '/away': { status: 302, headers: { location: 'https://example.com/a' } },
    '/plain': { status: 301, headers: { location: `http://${HOST}/a` } },
    '/port': { status: 302, headers: { location: `https://${HOST}:8443/a` } },
    '/same': { status: 302, headers: { location: '/real' } },
    '/real': { body },
  });
  const d = tmp(tc);
  const o = (name) => ({ host: HOST, ceiling: 100, checksum: { type: 'sha256', hex: sha(body) }, file: path.join(d, name), get: v.get });
  await refused(download('https://example.com/a', o('1')), 'host');
  await refused(download(`https://${HOST}.example.com/a`, o('2')), 'host');
  await refused(download(`http://${HOST}/a`, o('3')), 'http');
  await refused(download(`https://user@${HOST}/a`, o('4')), 'host');
  assert.deepEqual(v.asked, [], 'nothing was asked of another host or over http');
  await refused(download(`https://${HOST}/away`, o('5')), 'redirect');
  await refused(download(`https://${HOST}/plain`, o('6')), 'redirect');
  await refused(download(`https://${HOST}/port`, o('7')), 'redirect');
  assert.ok(!v.asked.some((u) => !u.startsWith(`https://${HOST}/`)), v.asked.join('\n'));
  await download(`https://${HOST}/same`, o('8'));
  assert.equal(fs.readFileSync(path.join(d, '8'), 'utf8'), 'ok');
});

test('a stop in the middle ends the download as "stopped"', async (tc) => {
  const ac = new AbortController();
  const v = await vendor(tc, {
    '/slow': (req, res) => {
      res.writeHead(200, { 'content-length': '2000' });
      res.write(Buffer.alloc(1000));
      setTimeout(() => ac.abort(), 20);
    },
  });
  const p = download(`https://${HOST}/slow`, { host: HOST, ceiling: 5000, checksum: { type: 'sha256', hex: '00' }, file: path.join(tmp(tc), 's'), get: v.get, signal: ac.signal });
  await refused(p, 'stopped');
});

test('a file already at the download\'s place is never written over', async (tc) => {
  const v = await vendor(tc, { '/x': { body: 'x' } });
  const file = path.join(tmp(tc), 'x');
  fs.writeFileSync(file, 'mine');
  await assert.rejects(download(`https://${HOST}/x`, { host: HOST, ceiling: 10, checksum: { type: 'sha256', hex: sha(Buffer.from('x')) }, file, get: v.get }), /EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
});

test('Flutter\'s list: the current stable for Linux, and on macOS the archive for this CPU; a list that strays is refused', async (tc) => {
  const list = JSON.parse(fs.readFileSync(new URL('./fixtures/flutter-releases.json', import.meta.url), 'utf8'));
  const linux = chooseFlutter(JSON.stringify(list.linux), { platform: 'linux', arch: 'x64', host: HOST });
  assert.deepEqual(linux, { version: '3.50.1', url: `${BASE}/stable/linux/flutter_linux_3.50.1-stable.tar.xz`, sha256: list.linux.releases[0].sha256, kind: 'tar.xz' });
  assert.equal(chooseFlutter(JSON.stringify(list.macos), { platform: 'darwin', arch: 'arm64', host: HOST }).url, `${BASE}/stable/macos/flutter_macos_arm64_3.50.1-stable.zip`);
  assert.equal(chooseFlutter(JSON.stringify(list.macos), { platform: 'darwin', arch: 'x64', host: HOST }).url, `${BASE}/stable/macos/flutter_macos_3.50.1-stable.zip`);
  assert.throws(() => chooseFlutter(JSON.stringify(list.linux), { platform: 'linux', arch: 'arm64', host: HOST }), (e) => e.code === 'cpu');
  const stray = (f) => {
    const l = structuredClone(list.linux);
    f(l);
    return JSON.stringify(l);
  };
  assert.throws(() => chooseFlutter(stray((l) => (l.base_url = 'https://example.com/releases')), { platform: 'linux', arch: 'x64', host: HOST }), (e) => e.code === 'host');
  assert.throws(() => chooseFlutter(stray((l) => (l.base_url = `http://${HOST}/r`)), { platform: 'linux', arch: 'x64', host: HOST }), (e) => e.code === 'http');
  assert.throws(() => chooseFlutter(stray((l) => (l.releases[0].archive = 'stable/linux/../../x.tar.xz')), { platform: 'linux', arch: 'x64', host: HOST }), (e) => e.code === 'list');
  assert.throws(() => chooseFlutter(stray((l) => delete l.releases[0].sha256), { platform: 'linux', arch: 'x64', host: HOST }), (e) => e.code === 'checksum');
  assert.throws(() => chooseFlutter('{', { platform: 'linux', arch: 'x64', host: HOST }), (e) => e.code === 'list');
});

test('a list is read whole up to its ceiling, and refused past it', async (tc) => {
  const v = await vendor(tc, { '/l.json': { body: '{"a":1}' }, '/big.json': { body: 'x'.repeat(2000) } });
  assert.equal(await readList(`https://${HOST}/l.json`, { host: HOST, ceiling: 1000, get: v.get }), '{"a":1}');
  await refused(readList(`https://${HOST}/big.json`, { host: HOST, ceiling: 1000, get: v.get }), 'size');
  await refused(readList(`https://evil.example/l.json`, { host: HOST, ceiling: 1000, get: v.get }), 'host');
});

test('addresses and sizes in words', () => {
  assert.equal(checkAddress(`https://${HOST}/a`, HOST).pathname, '/a');
  assert.equal(sizeWords(1_518_418_752), 'about 1.5 GB');
  assert.equal(sizeWords(181_052_239), 'about 181 MB');
  assert.equal(sizeWords(3e9, false), '3 GB');
});
