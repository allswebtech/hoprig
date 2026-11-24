// The ssh line on a server's page: in a made-up home (the demo, whose HOME is its own temporary folder) it never
// names this computer's login, only a placeholder; at the login's own home it names that login as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardLine } from '../../src/setup/server.mjs';

const standIn = () => ({ username: 'stand-in-login', homedir: '/home/stand-in-login' });

test('the forward line never shows the login name in a made-up home', () => {
  const env = { HOME: '/tmp/hoprig-demo-x/home', SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 22' };
  const line = forwardLine(7433, { env, publicIps: [], userInfo: standIn });
  assert.doesNotMatch(line, /stand-in-login/);
  assert.equal(line, 'ssh -N -L 17433:127.0.0.1:7433 <you>@203.0.114.7');
});

test('the forward line names the login at its own home', () => {
  const env = { HOME: '/home/stand-in-login', SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 22' };
  assert.equal(forwardLine(7433, { env, publicIps: [], userInfo: standIn }), 'ssh -N -L 17433:127.0.0.1:7433 stand-in-login@203.0.114.7');
});
