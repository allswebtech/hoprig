// The GitHub sign-in without a terminal (src/workspace/ghsignin.mjs) with a fake gh: the one-time code read from
// what gh prints without a terminal, gh's browser turned off, then `gh auth setup-git`; failures, running out and
// stopping. The real gh is never started here (its output was read once with a throwaway GH_CONFIG_DIR).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DEVICE_URL, SIGNIN_ARGV, githubSignin, parseDeviceCode, signinEnv } from '../../src/workspace/ghsignin.mjs';

// What gh 2.x prints on its error output when it has no terminal (no clipboard tool on that computer).
const GH_SAYS = '\n! Failed to copy one-time code to clipboard\n  No clipboard utilities available.\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n';

function fakeGh() {
  const started = [];
  let child;
  const spawnImpl = (cmd, args, o) => {
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => child.emit('close', null) });
    started.push({ argv: [cmd, ...args], env: o.env });
    return child;
  };
  const runs = [];
  const run = async (argv) => {
    runs.push(argv);
    if (argv[2] === 'status') return { ok: true, stdout: '', stderr: 'github.com\n  ✓ Logged in to github.com account alex (keyring)\n  - Token: gho_************\n' };
    return { ok: true, stdout: '', stderr: '' };
  };
  return { spawnImpl, run, started, runs, child: () => child };
}

test('the code from gh\'s own words; gh opens no browser and gets no token variable', () => {
  assert.equal(parseDeviceCode(GH_SAYS), 'AB12-CD34');
  assert.equal(parseDeviceCode('nothing here'), null);
  const e = signinEnv({ PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y' }, 'linux'); // seal: a value no program is started with
  assert.deepEqual([e.GH_BROWSER, 'GH_TOKEN' in e, 'GITHUB_TOKEN' in e, e.PATH], ['true', false, false, '/bin']);
});

test('sign in: the code at once, then gh finishes by itself; git is told to use it; only the account name kept', async () => {
  const g = fakeGh();
  const s = githubSignin({ spawnImpl: g.spawnImpl, run: g.run, env: { PATH: '/bin', GH_TOKEN: 'old' } }); // seal: its runner is a stand-in
  assert.equal(s.state().state, 'idle');
  const p = s.start();
  g.child().stderr.write(GH_SAYS);
  assert.deepEqual(await p, { state: 'code', code: 'AB12-CD34', url: DEVICE_URL, account: null, error: null });
  assert.deepEqual(g.started[0].argv, SIGNIN_ARGV);
  // gh opens no browser: a program that does nothing, as this system has one (true; on Windows cmd /c rem).
  assert.equal(g.started[0].env.GH_BROWSER, process.platform === 'win32' ? 'cmd /c rem' : 'true');
  assert.equal((await s.start()).code, 'AB12-CD34', 'a second start while waiting: the same sign-in');
  assert.equal(g.started.length, 1);
  g.child().emit('close', 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.state(), { state: 'done', code: null, url: null, account: 'alex', error: null });
  assert.deepEqual(g.runs[0], ['gh', 'auth', 'setup-git', '--hostname', 'github.com']);
  assert.ok(!JSON.stringify(s.state()).includes('gho_'));
});

test('a failure says gh\'s last plain line (never a token); running out and stopping are said too', async () => {
  let g = fakeGh();
  let s = githubSignin({ spawnImpl: g.spawnImpl, run: g.run });
  let p = s.start();
  g.child().stderr.write(GH_SAYS);
  await p;
  g.child().stderr.write('error: authorization was denied for gho_abcdefghijklmnop\n');
  g.child().emit('close', 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().state, 'failed');
  assert.equal(s.state().error, 'error: authorization was denied for ••••');

  g = fakeGh();
  s = githubSignin({ spawnImpl: g.spawnImpl, run: g.run, waitMs: 20 });
  p = s.start();
  g.child().stderr.write(GH_SAYS);
  await p;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.state().state, 'expired');

  g = fakeGh();
  s = githubSignin({ spawnImpl: g.spawnImpl, run: g.run });
  p = s.start();
  g.child().stderr.write(GH_SAYS);
  await p;
  assert.equal(s.cancel().state, 'cancelled');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().state, 'cancelled');
  assert.equal(s.state().code, null);
});
