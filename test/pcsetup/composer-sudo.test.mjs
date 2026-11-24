// Composer runs `sudo -K` before every command it is given, `--version` too (its sudo check: it forgets the person's
// sudo sign-in), unless COMPOSER_ALLOW_SUPERUSER is set. A status asks Composer its version, so without that it would
// make the person type the sudo password again for nothing. The stand-in here does what Composer does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectItem, sysFacts } from '../../src/pcsetup/detect.mjs';
import { KITS } from '../../src/pcsetup/kits.mjs';

const posix = process.platform !== 'win32';

test('a status asks Composer its version without Composer asking sudo anything', { skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-sudo-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'sudo.log');
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh\necho "sudo $*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'composer'), '#!/bin/sh\n[ -n "$COMPOSER_ALLOW_SUPERUSER" ] || sudo -K > /dev/null 2>&1\necho "Composer version 2.8.4 2024-12-11 11:57:47"\n', { mode: 0o755 });
  const sys = await sysFacts({ platform: 'linux', pm: 'apt', env: { PATH: bin, HOME: bin }, root: false, user: 'dev', home: bin });  // seal: a PATH of the test's own folder alone (its Composer stand-in), nothing of this computer is on it
  const item = KITS.find((k) => k.id === 'php').items.find((i) => i.id === 'composer');
  const found = await detectItem(item, sys);
  assert.equal(found.state, 'ok');
  assert.equal(found.version, '2.8.4');
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'sudo was asked nothing');
});
