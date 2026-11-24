// Once Hoprig has made a work user, the closing advice names that user, never root@. The work user is
// found by `getent passwd` (a stand-in here, handed in as `run`) and by the mark of "made by Hoprig" (a file of root's in its home). Nothing runs as
// root and no real getent is asked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const R = await import('../../src/setup/rootfacts.mjs');
const SV = await import('../../src/setup/server.mjs');

// A getent of the test's own: the users of a made-up computer, one passwd line each.
const getent = (users) => async (argv) => {
  assert.deepEqual(argv.slice(0, 2), ['getent', 'passwd']);
  const line = users[argv[2]];
  return line ? { ok: true, code: 0, stdout: `${line}\n`, stderr: '' } : { ok: false, code: 2, stdout: '', stderr: '' };
};
const noFile = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

test('the forward line names the work user when there is one, never root@', () => {
  const sys = { env: { SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 22' }, publicIps: [], user: 'root' };
  assert.equal(SV.forwardLine(7433, sys), 'ssh -N -L 17433:127.0.0.1:7433 root@203.0.114.7', 'today, as root, with no work user');
  assert.equal(SV.forwardLine(7433, { ...sys, workUser: { name: 'hoprig', uid: 1001, home: '/home/hoprig' } }), 'ssh -N -L 17433:127.0.0.1:7433 hoprig@203.0.114.7');
  assert.equal(SV.forwardLine(7433, { ...sys, user: 'alex', workUser: null }), 'ssh -N -L 17433:127.0.0.1:7433 alex@203.0.114.7', 'an ordinary user: as before');
});

test('the work user: the first name that carries the mark; a user of the name without one is someone else\'s', async () => {
  const mark = (name, uid = 0) => ({ isFile: () => true, uid, nlink: 1, size: R.markText(name).length });
  const users = { hoprig: 'hoprig:x:1001:1001:Hoprig work user:/home/hoprig:/bin/bash', hoprig2: 'hoprig2:x:1002:1002::/home/hoprig2:/bin/bash' };
  // The comment field alone is not the mark.
  assert.equal(await R.findWorkUser({ run: getent({ hoprig: users.hoprig }), lstat: noFile }), null);
  // someone else's hoprig, then Hoprig's own hoprig2 (its mark, root's, in its home)
  const lstat = (p) => (p === `/home/hoprig2/${R.MOVE_MARK_FILE}` ? mark('hoprig2') : noFile());
  const readFile = (p) => (p === `/home/hoprig2/${R.MOVE_MARK_FILE}` ? R.markText('hoprig2') : noFile());
  assert.equal((await R.findWorkUser({ run: getent(users), lstat, readFile })).name, 'hoprig2');
  // a mark file the user owns (it wrote it itself) does not count
  assert.equal(await R.findWorkUser({ run: getent(users), lstat: (p) => ({ ...mark('x', 1002) }), readFile }), null);
  // no such user at all
  assert.equal(await R.findWorkUser({ run: getent({}), lstat: noFile }), null);
});
