// Windows: config.json being replaced by another dashboard at this moment (or held a moment by a virus scan) refuses a
// read or a replace with EPERM, EACCES or EBUSY until it lets go (src/config.mjs patiently): tried again there for up
// to a second; on other systems those errors stand as they are. Windows' answers are given here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { patiently } from '../src/config.mjs';

const busyFor = (n, code = 'EPERM') => {
  let left = n;
  const step = () => {
    if (left-- > 0) throw Object.assign(new Error(`${code}: operation not permitted`), { code });
    return 'read';
  };
  return step;
};

test('Windows: a settings file held for a moment is read or replaced once it is let go; elsewhere not tried again', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) assert.equal(patiently(busyFor(3, code), 'win32'), 'read', code);
  assert.throws(() => patiently(busyFor(3), 'linux'), { code: 'EPERM' }, 'elsewhere as before');
  assert.throws(() => patiently(busyFor(1, 'ENOENT'), 'win32'), { code: 'ENOENT' }, 'a file that is not there is no moment');
  const t = Date.now();
  assert.throws(() => patiently(busyFor(Infinity), 'win32'), { code: 'EPERM' }, 'one held for good: the error after a second');
  assert.ok(Date.now() - t < 3000);
});
