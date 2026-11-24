// `workspace sync --with` a computer added with a key file (src/workspace/peer.mjs): the status call over ssh and the
// git fetch both use that computer's kept key and kept host key only (IdentitiesOnly, its own known-hosts file,
// StrictHostKeyChecking=yes), never the owner's own ssh keys or ~/.ssh/known_hosts. The ssh is the stand-in, with
// traps for the real programs behind it; the fetch is recorded, not run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeRemote } from '../machines/harness.mjs';
import { traps } from '../machines/traps.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('workspace-peerkey');
const remote = fakeRemote(path.join(box.root, 'ssh'));
const trap = traps(box.root);
Object.assign(process.env, { FAKE_SSH_LOG: remote.sshEnv.FAKE_SSH_LOG, FAKE_SSH_SHELL: remote.sshEnv.FAKE_SSH_SHELL, PATH: trap.path(remote.bin) });
const { putMachine } = await import('../../src/machines/store.mjs');
const { keyFile, knownHostsFile } = await import('../../src/machines/keys.mjs');
const { peerInfo, pullFrom } = await import('../../src/workspace/peer.mjs');
const { capture } = await import('../../src/setup/system.mjs');
putMachine({ name: 'box2', label: 'Box 2', via: 'ssh', target: 'alex@203.0.113.7', remoteHost: '127.0.0.1', remotePort: 7433, key: true, token: 'hop_x', tokenId: null, added: 1 });
test.after(() => box.cleanup());

const kept = (words) => {
  const a = words.join(' ');
  return a.includes(`-i ${keyFile('box2')}`) && a.includes('IdentitiesOnly=yes') && a.includes(`UserKnownHostsFile=${knownHostsFile('box2')}`) && a.includes('StrictHostKeyChecking=yes');
};

test('the status call there uses the kept key and host key', { skip }, async () => {
  await peerInfo('box2').catch(() => null); // the stand-in answers no workspace: only the call is looked at
  const calls = remote.calls().filter((c) => c.join(' ').includes('workspace status'));
  assert.ok(calls.length, 'it asked there');
  for (const c of calls) assert.ok(kept(c), c.join(' '));
  // What syncWith hands each fetch: the same options, from the computer's own entry.
  const said = await peerInfo('box2', { remote: async (target, sshExtra) => ({ ok: kept(sshExtra), result: { stdout: JSON.stringify({ dir: '/srv/ws', projectsDir: '/srv/projects' }) } }) });
  assert.ok(kept(said.sshExtra), 'the fetches get them too');
  trap.check();
});

test('the git fetch from there uses the kept key and host key too', { skip }, async () => {
  const repo = path.join(box.root, 'shop');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '--allow-empty', '-m', 'one']);
  let fetchEnv = null;
  const run = (argv, opts = {}) => {
    if (argv.includes('fetch')) {
      fetchEnv = opts.env;
      return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'stand-in: not fetched' });
    }
    return capture(argv, opts);
  };
  const extra = (await import('../../src/machines/keys.mjs')).sshExtraOf({ name: 'box2', key: true });
  await pullFrom(repo, 'ssh://alex@203.0.113.7/srv/shop', 'box2', run, { sshExtra: extra });
  assert.ok(fetchEnv, 'it fetched');
  const cmd = fetchEnv.GIT_SSH_COMMAND;
  assert.ok(kept(cmd.split(' ').map((w) => w.replace(/^'|'$/g, ''))), cmd);
  trap.check();
});
