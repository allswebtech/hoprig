// For test/runner.test.mjs: a test file whose run's own temporary folder is removed under it, as another run that
// empties the shared temporary folder once did. It removes only the folder of the runner that started it (the parent
// of its trap folder, a hoprig-tests- folder in the temporary folder), never anything else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('its run\'s own temporary folder goes', () => {
  const sandbox = path.dirname(process.env.HOPRIG_TEST_TRAPS || '');
  if (path.basename(sandbox).startsWith('hoprig-tests-') && sandbox.startsWith(os.tmpdir() + path.sep)) fs.rmSync(sandbox, { recursive: true, force: true });
});
