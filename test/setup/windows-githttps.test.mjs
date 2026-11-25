// Windows: git over HTTPS that cannot check certificates (Git for Windows with an empty certificate folder) is named
// by doctor with the one line that makes git use Windows' own certificates, and its undo; Hoprig never runs it.
// Made-up answers of git: nothing real runs, and every argv asked is recorded.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GIT_HTTPS_PROBE, SSL_BACKEND_FIX, SSL_BACKEND_UNDO, gitHttpsCheck } from '../../src/setup/checks.mjs';

const win = (hasGit = true) => ({ platform: 'win32', env: { PATH: 'C:\\Windows' }, has: (b) => hasGit && b === 'git' });  // seal: facts handed to a pure check, no program is started

function recorder(answer) {
  const calls = [];
  const run = async (argv, opts) => {
    calls.push({ argv, opts });
    return answer;
  };
  return { calls, run };
}

const CERT = "fatal: unable to access 'https://github.com/git/git.git/': error setting certificate verify locations:  CAfile: C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt CApath: none\n";
const ISSUER = "fatal: unable to access 'https://github.com/git/git.git/': SSL certificate problem: unable to get local issuer certificate\n";
const OFFLINE = "fatal: unable to access 'https://github.com/git/git.git/': Could not resolve host: github.com\n";

test('Windows: git cannot check certificates: a warning naming the schannel line and its undo; nothing is set', async () => {
  for (const stderr of [CERT, ISSUER]) {
    const r = recorder({ ok: false, code: 128, stdout: '', stderr });
    const c = await gitHttpsCheck(win(), r.run);
    assert.equal(c.id, 'githttps');
    assert.equal(c.status, 'warn');
    assert.equal(c.fix, 'git config --global http.sslBackend schannel');
    assert.equal(SSL_BACKEND_FIX, c.fix);
    assert.ok(c.detail.includes('git config --global --unset http.sslBackend'), c.detail);
    assert.equal(SSL_BACKEND_UNDO, 'git config --global --unset http.sslBackend');
    assert.match(c.detail, /Hoprig changes nothing/);
    // One read of one repository's HEAD, no prompt, ten seconds at most; never a config line.
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].argv, ['git', 'ls-remote', 'https://github.com/git/git.git', 'HEAD']);
    assert.deepEqual(r.calls[0].argv, GIT_HTTPS_PROBE);
    assert.equal(r.calls[0].opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(r.calls[0].opts.env.PATH, 'C:\\Windows', 'the rest of the environment is kept');
    assert.equal(r.calls[0].opts.timeout, 10_000);
    assert.ok(r.calls.every((x) => !x.argv.includes('config')), 'git config is never run');
  }
});

test('Windows: git reads over HTTPS: ok', async () => {
  const r = recorder({ ok: true, code: 0, stdout: '0123abcd\tHEAD\n', stderr: '' });
  const c = await gitHttpsCheck(win(), r.run);
  assert.equal(c.status, 'ok');
  assert.equal(c.fix, '');
});

test('Windows: offline or a proxy: no word about certificates, no fix', async () => {
  for (const answer of [{ ok: false, code: 128, stdout: '', stderr: OFFLINE }, { ok: false, code: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }]) {
    const r = recorder(answer);
    const c = await gitHttpsCheck(win(), r.run);
    assert.equal(c.status, 'info');
    assert.equal(c.fix, '');
    assert.doesNotMatch(c.detail, /certificate|sslBackend/i);
  }
});

test('not checked without git, and never off Windows', async () => {
  const none = async () => assert.fail('nothing may be asked');
  assert.equal(await gitHttpsCheck(win(false), none), null);
  assert.equal(await gitHttpsCheck({ platform: 'linux', env: {}, has: () => true }, none), null);
  assert.equal(await gitHttpsCheck({ platform: 'darwin', env: {}, has: () => true }, none), null);
});
