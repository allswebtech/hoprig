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
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), { trustProxy: true }), '1.1.1.1');
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
