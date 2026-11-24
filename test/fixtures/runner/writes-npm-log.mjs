// A test file whose npm got past the npm trap: it leaves a debug log in the "real" home's ~/.npm/_logs (a made-up
// folder test/seal.test.mjs hands the runner as HOME), naming this run's temporary folder, as such a log does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('leaves an npm debug log in the real home', () => {
  const logs = path.join(process.env.SEAL_REAL_HOME, '.npm', '_logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, '2026-01-01T00_00_00_000Z-debug-0.log'), `0 verbose cwd ${os.tmpdir()}\n`);
});
