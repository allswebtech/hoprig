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

test('hoprig on the plain PATH: one try', { skip }, async () => { // seal: a title
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
  assert.equal(calls[0].at(-1), 'hoprig pair --json --name mac --hub');
  assert.equal(calls[1].at(-1), `$SHELL -lic 'hoprig pair --json --name mac --hub'`);
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

test('a computer\'s own options (a kept key) come before -- in a tunnel and a command; none by default', () => {
  const extra = ['-i', '/k/box2', '-o', 'StrictHostKeyChecking=yes'];
  for (const a of [ssh.tunnelArgs({ target: 'alex@box2', localPort: 1, remoteHost: '127.0.0.1', remotePort: 2, extra }), ssh.commandArgs('alex@box2', 'true', extra)]) {
    const dd = a.indexOf('--');
    assert.ok(a.indexOf('-i') >= 0 && a.indexOf('-i') < dd);
    assert.ok(a.indexOf('StrictHostKeyChecking=yes') < dd);
    assert.equal(a[dd + 1], 'alex@box2');
  }
  assert.ok(!ssh.commandArgs('box2', 'true').includes('-i'));
  assert.ok(!ssh.tunnelArgs({ target: 'box2', localPort: 1, remoteHost: '127.0.0.1', remotePort: 2 }).includes('-i'));
});

test('a changed host key has its own code and never tells to accept it by hand', () => {
  const f = ssh.sshFailure('box2', '@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n');
  assert.equal(f.code, 'ssh-hostkey-changed');
  assert.match(f.message, /compare the two prints/);
  assert.doesNotMatch(f.message, /Connect once by hand/);
  assert.equal(ssh.sshFailure('box2', 'Host key verification failed.').code, 'ssh-hostkey');
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
  // The stand-in for the far side goes on after the local ssh is ended (a real far side ends with its connection),
  // so its wait is short and the test waits for it: nothing of the test is alive when its box is removed.
  const r = remote({ plain: true, script: 'sleep 2' });
  const t = Date.now();
  const out = await ssh.runHoprig('box2', ['pair'], { env: r.sshEnv, timeoutMs: 500 });
  assert.equal(out.code, 'timeout');
  assert.ok(Date.now() - t < 1900, 'ended by the timeout, not by the command');
  await new Promise((done) => setTimeout(done, Math.max(0, 2400 - (Date.now() - t))));
});

test('install: the script goes over the connection with --yes in the login shell, output line by line', { skip }, async () => {
  const r = remote({});
  const script = path.join(box.root, 'install.sh');
  fs.writeFileSync(script, 'echo "installing for $1 $2"\necho step two\n');
  const lines = [];
  const res = await ssh.installOverSsh('box2', ssh.installSource(script), { env: r.sshEnv, onLine: (l) => lines.push(l) });
  assert.equal(res.code, 0);
  assert.ok(lines.includes('installing for --yes --no-work-user'), lines.join('|'));
  assert.ok(lines.includes('step two'));
  assert.match(r.calls()[0].at(-1), /^\$SHELL -lic "sh -s -- --yes --no-work-user"$/);
  // After his confirmation that a root login makes the work user there: --yes alone, the yes of install.sh as root.
  await ssh.installOverSsh('box2', ssh.installSource(script), { env: r.sshEnv, workUser: true, onLine: () => {} });
  assert.match(r.calls()[1].at(-1), /^\$SHELL -lic "sh -s -- --yes"$/);
  assert.equal(ssh.installSource('https://x.example/install.sh?v=1').kind, 'url');
  assert.equal(ssh.installSource('https://x.example/$(id)'), null, 'nothing a shell would expand');
  assert.equal(ssh.installSource('http://x.example/i.sh'), null, 'https only');
  assert.equal(ssh.installSource('/no/such/file'), null);
});

// Removing a computer revokes this dashboard's token there with "hoprig tokens revoke", which waits for a yes without
// a terminal: the removal here is the owner's yes, so --yes goes along; a Hoprig there from before --yes refuses that
// word and is asked again without it.
test('revoke over SSH says --yes; an older Hoprig that does not know it is asked again without it', { skip }, async () => {
  const now = remote({ plain: true, script: `case "$*" in *--yes*) echo revoked;; *) echo 'hoprig tokens revoke: nothing was revoked.' >&2; exit 2;; esac` });
  const out = await ssh.revokeOverSsh('box2', '0123456789ab', { env: now.sshEnv });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(now.calls().map((c) => c.at(-1)), ['hoprig tokens revoke 0123456789ab --yes']);
  const old = remote({ plain: true, script: `case "$*" in *--yes*) echo 'hoprig tokens: unknown option --yes' >&2; exit 2;; *) echo revoked;; esac` });
  const again = await ssh.revokeOverSsh('box2', '0123456789ab', { env: old.sshEnv });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(old.calls().map((c) => c.at(-1)), ['hoprig tokens revoke 0123456789ab --yes', 'hoprig tokens revoke 0123456789ab']);
  const broken = remote({ plain: true, script: `echo 'hoprig tokens: no such thing' >&2; exit 1` });
  assert.equal((await ssh.revokeOverSsh('box2', '0123456789ab', { env: broken.sshEnv })).code, 'failed');
  assert.equal(broken.calls().length, 1, 'another failure is not tried again');
});

test('a Hoprig there from before --hub: asked again without it', { skip }, async () => {
  const r = remote({ plain: true, script: `case "$*" in *--hub*) echo 'unknown option --hub' >&2; exit 1;; esac; echo '{"hoprig":"pair","api":1,"host":"127.0.0.1","port":7433,"token":"hop_x","tokenId":"0123456789ab","hostname":"box2"}'` });
  const out = await ssh.pairOverSsh('box2', 'mac', { env: r.sshEnv });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(r.calls().map((c) => c.at(-1)), ['hoprig pair --json --name mac --hub', 'hoprig pair --json --name mac']);
});
