// SSH command construction and the order remote commands are tried in, with a fake ssh on PATH and a fake remote
// user whose hoprig is on PATH only in the login shell (as with nvm loaded from ~/.bashrc).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeRemote } from './harness.mjs';

const box = sandbox('machines-ssh');
test.after(() => box.cleanup());

const ssh = await import('../../src/machines/ssh.mjs');
const skip = process.platform === 'win32' && 'POSIX shell scripts';

let n = 0;
const remote = (o) => fakeRemote(path.join(box.root, `r${n++}`), o);

test('arguments: batch mode, keep-alive, forward failure is fatal, -- before the target', () => {
  const a = ssh.tunnelArgs({ target: 'alex@box2', localPort: 40001, remoteHost: '127.0.0.1', remotePort: 7433 });
  for (const o of ['BatchMode=yes', 'ServerAliveInterval=15', 'ExitOnForwardFailure=yes', 'ConnectTimeout=10']) assert.ok(a.includes(o), o);
  assert.deepEqual(a.slice(-5), ['-N', '-L', '127.0.0.1:40001:127.0.0.1:7433', '--', 'alex@box2']);
  assert.ok(ssh.tunnelArgs({ target: 'h', localPort: 1, remoteHost: '::1', remotePort: 2 }).includes('127.0.0.1:1:[::1]:2'));
  const c = ssh.commandArgs('box2', 'hoprig pair --json');
  assert.deepEqual(c.slice(-4), ['-T', '--', 'box2', 'hoprig pair --json']);
  assert.ok(c.includes('BatchMode=yes'));
  assert.deepEqual(ssh.remoteVariants(['pair', '--json', '--name', 'my hub']), [
    "hoprig pair --json --name 'my hub'",
    `$SHELL -lic 'hoprig pair --json --name '\\''my hub'\\'''`,
  ]);
});

test('hoprig on the plain PATH: one try', { skip }, async () => {
  const r = remote({ plain: true });
  const out = await ssh.runHoprig('box2', ['tokens'], { env: r.sshEnv });
  assert.equal(out.ok, true);
  assert.equal(out.variant, 'hoprig tokens');
  assert.equal(r.calls().length, 1);
});

test('hoprig only in the login shell: plain first, then $SHELL -lic, and the greeting is skipped', { skip }, async () => {
  const r = remote({ script: `echo '{"hoprig":"pair","api":1,"host":"127.0.0.1","port":7433,"token":"hop_x","tokenId":"0123456789ab","hostname":"box2"}'` });
  const out = await ssh.pairOverSsh('alex@box2', 'mac', { env: r.sshEnv });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.info.hostname, 'box2');
  const calls = r.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].at(-1), 'hoprig pair --json --name mac');
  assert.equal(calls[1].at(-1), `$SHELL -lic 'hoprig pair --json --name mac'`);
  for (const c of calls) assert.ok(c.includes('BatchMode=yes') && c.at(-2) === 'alex@box2' && c.at(-3) === '--');
});

test('not installed anywhere: a clear answer after both tries', { skip }, async () => {
  const r = remote({ installed: false });
  const out = await ssh.pairOverSsh('box2', 'mac', { env: r.sshEnv });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not-installed');
  assert.match(out.message, /^box2 has no Hoprig/);
  assert.equal(r.calls().length, 2);
  assert.match(ssh.installHint(ssh.installSource('https://example.com/install.sh')), /^curl -fsSL https:\/\/example.com\/install.sh \| sh$/);
  assert.equal(ssh.installHint(null), 'curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh');
});

test('ssh refusing the key or the host key: stop at once, with what to do', { skip }, async () => {
  for (const [mode, code, text] of [['auth', 'ssh-auth', /ssh-copy-id box2/], ['hostkey', 'ssh-hostkey', /ssh box2/]]) {
    const r = remote({ plain: true, mode });
    const out = await ssh.pairOverSsh('box2', 'mac', { env: r.sshEnv });
    assert.equal(out.code, code);
    assert.match(out.message, text);
    assert.equal(r.calls().length, 1, 'no second try after an ssh failure');
  }
});

test('an old hoprig without pair is named as too old; a garbled answer as such', { skip }, async () => {
  const old = remote({ plain: true, script: `echo 'hoprig: "pair" is neither a command nor a profile.' >&2; exit 2` });
  assert.equal((await ssh.pairOverSsh('box2', 'mac', { env: old.sshEnv })).code, 'too-old');
  const garbled = remote({ plain: true, script: 'echo hello' });
  assert.equal((await ssh.pairOverSsh('box2', 'mac', { env: garbled.sshEnv })).code, 'failed');
});

test('a hanging command times out', { skip }, async () => {
  const r = remote({ plain: true, script: 'sleep 30' });
  const t = Date.now();
  const out = await ssh.runHoprig('box2', ['pair'], { env: r.sshEnv, timeoutMs: 500 });
  assert.equal(out.code, 'timeout');
  assert.ok(Date.now() - t < 5000);
});

test('install: the script goes over the connection with --yes in the login shell, output line by line', { skip }, async () => {
  const r = remote({});
  const script = path.join(box.root, 'install.sh');
  fs.writeFileSync(script, 'echo "installing for $1 $2"\necho step two\n');
  const lines = [];
  const res = await ssh.installOverSsh('box2', ssh.installSource(script), { env: r.sshEnv, onLine: (l) => lines.push(l) });
  assert.equal(res.code, 0);
  assert.ok(lines.includes('installing for -- --yes') || lines.includes('installing for --yes '), lines.join('|'));
  assert.ok(lines.includes('step two'));
  assert.match(r.calls()[0].at(-1), /^\$SHELL -lic "sh -s -- --yes"$/);
  assert.equal(ssh.installSource('https://x.example/install.sh?v=1').kind, 'url');
  assert.equal(ssh.installSource('https://x.example/$(id)'), null, 'nothing a shell would expand');
  assert.equal(ssh.installSource('http://x.example/i.sh'), null, 'https only');
  assert.equal(ssh.installSource('/no/such/file'), null);
});
