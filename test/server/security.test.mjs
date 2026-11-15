import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeReq } from './helpers.mjs';
import { clientIp, isHttps, isLoopback, originOk, requestHost, securityHeaders } from '../../src/server/security.mjs';

test('Origin must match Host', () => {
  const ok = (h, o = {}) => originOk(fakeReq(h), o);
  assert.equal(ok({ host: 'pc:7433', origin: 'http://pc:7433' }), true);
  assert.equal(ok({ host: 'PC:7433', origin: 'http://pc:7433' }), true);
  assert.equal(ok({ host: 'pc:7433', origin: 'https://pc:7433' }), true, 'scheme may differ behind TLS termination');
  assert.equal(ok({ host: 'pc:7433', origin: 'http://evil.example' }), false);
  assert.equal(ok({ host: 'pc:7433', origin: 'http://pc:7434' }), false);
  assert.equal(ok({ host: 'pc:7433' }), false, 'missing Origin');
  assert.equal(ok({ host: 'pc:7433', origin: 'null' }), false);
  assert.equal(ok({ host: 'pc:7433', origin: 'file://pc:7433' }), false);
  assert.equal(ok({ host: 'pc:7433', origin: 'not a url' }), false);
  assert.equal(ok({ origin: 'http://pc:7433' }), false, 'missing Host');
  assert.equal(ok({ host: 'pc:7433', origin: 'https://deck.example' }, { allowed: ['https://deck.example'] }), true);
  // X-Forwarded-Host only counts behind a trusted proxy
  const fwd = { host: '127.0.0.1:7433', 'x-forwarded-host': 'deck.example', origin: 'https://deck.example' };
  assert.equal(ok(fwd), false);
  assert.equal(ok(fwd, { trustProxy: true }), true);
});

test('HTTPS detection and client address', () => {
  assert.equal(isHttps(fakeReq({ 'x-forwarded-proto': 'https' })), false);
  assert.equal(isHttps(fakeReq({ 'x-forwarded-proto': 'https' }), { trustProxy: true }), true);
  assert.equal(isHttps(fakeReq({}, { encrypted: true })), true);
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '1.1.1.1' })), '10.0.0.5');
});

test('client address: X-Forwarded-For only from a proxy on this computer, never from a peer on the network', () => {
  const lan = (h) => fakeReq(h, { remoteAddress: '192.168.1.50' });
  const local = (addr, h) => fakeReq(h, { remoteAddress: addr });
  // A computer on the network with a header it made up: its own address, whatever it claims, try after try.
  for (const forged of ['1.1.1.1', '6.6.6.6, 2.2.2.2', '127.0.0.1']) {
    assert.equal(clientIp(lan({ 'x-forwarded-for': forged }), { trustProxy: true }), '192.168.1.50', forged);
  }
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), { trustProxy: true }), '10.0.0.5');
  assert.equal(clientIp(local('::ffff:192.168.1.50', { 'x-forwarded-for': '1.1.1.1' }), { trustProxy: true }), '::ffff:192.168.1.50');
  // cloudflared or Caddy on this computer: the entry it added (the last one).
  assert.equal(clientIp(local('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), { trustProxy: true }), '203.0.113.9');
  assert.equal(clientIp(local('::1', { 'x-forwarded-for': '203.0.113.9' }), { trustProxy: true }), '203.0.113.9');
  assert.equal(clientIp(local('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), { trustProxy: true }), '203.0.113.9');
  // From this computer but trustProxy off, or no header: the connection's own address.
  assert.equal(clientIp(local('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), '127.0.0.1');
  assert.equal(clientIp(local('127.0.0.1', {}), { trustProxy: true }), '127.0.0.1');
  assert.equal(clientIp({ headers: {}, socket: {} }, { trustProxy: true }), 'unknown');
});

test('Host header validation and headers', () => {
  assert.equal(requestHost(fakeReq({ host: 'pc:7433' })), 'pc:7433');
  assert.equal(requestHost(fakeReq({ host: 'pc:7433"><script>' })), null);
  const h = securityHeaders('pc:7433');
  assert.match(h['Content-Security-Policy'], /script-src 'self';/);
  assert.match(h['Content-Security-Policy'], /connect-src 'self' ws:\/\/pc:7433 wss:\/\/pc:7433/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(securityHeaders(null)['Content-Security-Policy'], /ws:/);
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('0.0.0.0'), false);
});
