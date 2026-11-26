// Names, SSH targets and addresses as the user types them, and the machine store (machines.json, mode 600).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('machines-store');
test.after(() => box.cleanup());

const { dashboardUrl, label, machineName, slug, sshHost, sshTarget, tokenName, uniqueSlug } = await import('../../src/machines/names.mjs');
const store = await import('../../src/machines/store.mjs');

test('machine names', () => {
  for (const ok of ['box2', 'a', 'mac-mini', 'srv_01', 'x'.repeat(32)]) assert.equal(machineName(ok), ok);
  for (const bad of ['', '-pc', '_pc', 'PC', 'pc 2', 'pc/2', '../x', 'x'.repeat(33), 'pc.local', null, 7]) assert.equal(machineName(bad), null, String(bad));
  assert.equal(slug('Alexs-MacBook-Pro.local'), 'alexs-macbook-pro');
  assert.equal(slug('My dev PC'), 'my-dev-pc');
  assert.equal(slug('---'), 'computer');
  assert.equal(uniqueSlug('pc', ['pc', 'pc-2']), 'pc-3');
  assert.equal(label('  Linux PC '), 'Linux PC');
  assert.equal(label('a\nb'), null);
  assert.equal(tokenName('mac (hub)'), 'mac (hub)');
  assert.equal(tokenName("x'; rm -rf /"), null);
});

test('SSH targets: what ssh accepts, never an option or shell text', () => {
  for (const ok of ['devbox', 'alex@192.168.1.20', 'user@host.example.com', 'ssh://alex@host:2222', 'root@[::1]', 'my_box']) assert.equal(sshTarget(ok), ok, ok);
  for (const bad of ['-oProxyCommand=evil', 'user@-host', 'host; rm -rf /', 'host name', '$(id)', 'a@b@c', '', 'host:22', 'ssh://host:99999', '`x`', "o'neil@host"]) {
    assert.equal(sshTarget(bad), null, bad);
  }
  assert.equal(sshHost('ssh://alex@box2:2222'), 'box2');
  assert.equal(sshHost('alex@box2'), 'box2');
});

test('dashboard addresses', () => {
  assert.equal(dashboardUrl('https://pc.tail1234.ts.net/'), 'https://pc.tail1234.ts.net');
  assert.equal(dashboardUrl('http://192.168.1.20:7433'), 'http://192.168.1.20:7433');
  assert.equal(dashboardUrl('https://deck.example/hop/'), 'https://deck.example/hop');
  for (const bad of ['ftp://x', 'https://user:pw@x', 'https://x/?a=1', 'not a url', 'javascript:alert(1)', 'https://x/#h']) assert.equal(dashboardUrl(bad), null, bad);
});

test('the store: mode 600, replace by name, rename, remove, and the token never in the public view', () => {
  assert.deepEqual(store.loadMachines(), []);
  const m = { name: 'box2', label: 'Linux PC', via: 'ssh', target: 'devbox', remoteHost: '127.0.0.1', remotePort: 7433, token: 'hop_secret', tokenId: 'abcdefabcdef', added: 1 };
  store.putMachine(m);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.machinesFile()).mode & 0o777, 0o600);
  store.putMachine({ name: 'web', via: 'url', url: 'https://pc.example', token: 'hop_other' });
  store.putMachine({ ...m, token: 'hop_new' }); // paired again: replaced, not doubled
  assert.deepEqual(store.loadMachines().map((x) => [x.name, x.token]), [['web', 'hop_other'], ['box2', 'hop_new']]);
  assert.throws(() => store.putMachine({ name: 'bad name', via: 'url', url: 'https://x', token: 't' }));
  assert.throws(() => store.putMachine({ name: 'x', via: 'ssh', target: '-oProxyCommand=x', remoteHost: 'h', remotePort: 1, token: 't' }));

  assert.throws(() => store.renameMachine('box2', { name: 'web' }), /taken/);
  assert.throws(() => store.renameMachine('box2', { name: 'Bad' }), /lower-case/);
  assert.throws(() => store.renameMachine('nope', { name: 'x' }), /no such/);
  store.renameMachine('box2', { name: 'linux', label: 'The Linux PC' });
  assert.equal(store.getMachine('linux').label, 'The Linux PC');

  const pub = JSON.stringify(store.loadMachines().map(store.publicMachine));
  assert.equal(pub.includes('hop_'), false, 'no token in the public view');
  assert.ok(store.removeMachine('linux'));
  assert.equal(store.removeMachine('linux'), null);
  assert.deepEqual(store.loadMachines().map((x) => x.name), ['web']);

  // A hand-edited entry that does not validate is ignored, never trusted.
  fs.writeFileSync(store.machinesFile(), JSON.stringify({ machines: [{ name: '../../x', via: 'url', url: 'https://x', token: 't' }, { name: 'ok', via: 'url', url: 'https://ok', token: 't' }] }));
  assert.deepEqual(store.loadMachines().map((x) => x.name), ['ok']);
});
