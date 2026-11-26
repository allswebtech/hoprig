// Packing hands tar a temporary name of plain letters only: the tar of Windows reads its arguments in the system's
// code page, where a letter beyond it becomes "?" and the archive cannot be made. A stand-in tar first on PATH writes
// down what it was given.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealedPath } from '../seal.mjs';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tmpname-')));
test.after(() => fs.rmSync(box, { recursive: true, force: true }));
const bin = path.join(box, 'bin');
const said = path.join(box, 'tar-args.json');
fs.mkdirSync(bin);
// No extension: a #!/usr/bin/env node file the test seal starts with Node on Windows too.
fs.writeFileSync(path.join(bin, 'tar'), `#!/usr/bin/env node\nprocess.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(said)}, JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write('stand-in tar');\nprocess.exit(2);\n`, { mode: 0o755 });
process.env.PATH = sealedPath([bin, ...String(process.env.PATH).split(path.delimiter)]);
const { pack } = await import('../../src/editor/archive.mjs');

// Windows: Files starts the system's own tar by its full path (src/pcsetup/unpack.mjs tarCommand), so no stand-in on
// PATH takes its place there; test/desktop/files.test.mjs packs a name in another script with that tar itself.
test('a name in any script: the archive tar is asked to write has a plain temporary name in the same folder', { skip: process.platform === 'win32' && 'Files starts the system tar by its full path there, which no stand-in on PATH replaces' }, async () => {
  const dir = path.join(box, 'files');
  const name = `${'क'.repeat(20)}.txt`;
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, name), 'x\n');
  await assert.rejects(pack([path.join(dir, name)], [dir]), (e) => e.status === 409 && /stand-in tar/.test(e.message));
  const args = JSON.parse(fs.readFileSync(said, 'utf8'));
  const out = args[args.indexOf('-czf') + 1];
  assert.equal(path.dirname(out), dir);
  assert.match(path.basename(out), /^[\x21-\x7e]+$/, out);
  assert.deepEqual(fs.readdirSync(dir), [name], 'nothing of the failed pack is left');
});
