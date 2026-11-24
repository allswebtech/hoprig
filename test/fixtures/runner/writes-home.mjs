// A test file that writes where it must not: into the "real" home the runner of test/homeguard.test.mjs was given
// (GUARD_FIXTURE_HOME, a made-up folder), as a test does that hands a child an environment without USERPROFILE.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('writes into the real home', () => {
  if (process.env.GUARD_FIXTURE_HOME) fs.writeFileSync(path.join(process.env.GUARD_FIXTURE_HOME, '.claude', 'settings.json'), '{}');
});
