// The settings list's line for Security and sign-in names what a person looks for there: the password and his phone.
import assert from 'node:assert/strict';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const { securitySummary } = await import('../../web/settings.js');

test('Security and sign-in: "Password · sign in your phone" on this computer; another computer\'s says where it is open', () => {
  const s = (host) => ({ network: { host, port: 7433 } });
  assert.equal(securitySummary({ settings: s('127.0.0.1'), here: true }), 'Password · sign in your phone');
  assert.equal(securitySummary({ settings: s('127.0.0.1'), here: false }), 'this computer only');
  assert.equal(securitySummary({ settings: s('0.0.0.0'), here: false }), 'open to the network');
});
