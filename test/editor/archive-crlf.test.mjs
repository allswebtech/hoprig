// Windows' tar ends its lines with \r\n. Files reads every listing line by line without that \r (archive.mjs
// linesOf): a kept \r hid a last part named ".git" (a gitfile that points git at a folder of the archive's, whose
// settings can run programs) or a private name from badEntries. A stand-in tar first on PATH answers with \r\n.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealedPath } from '../seal.mjs';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-crlf-')));
test.after(() => fs.rmSync(box, { recursive: true, force: true }));
const bin = path.join(box, 'bin');
const listing = path.join(box, 'listing.json');
const extracted = path.join(box, 'extracted');
fs.mkdirSync(bin);
// No extension: a #!/usr/bin/env node file. It answers -tf and -tvf from listing.json with \r\n line ends, and notes
// an unpacking.
fs.writeFileSync(path.join(bin, 'tar'), `#!/usr/bin/env node
const fs = process.getBuiltinModule('node:fs');
const a = process.argv.slice(2);
const names = JSON.parse(fs.readFileSync(${JSON.stringify(listing)}, 'utf8'));
if (a[0] === '-tf') process.stdout.write(names.map((n) => n + '\\r\\n').join(''));
else if (a[0] === '-tvf') process.stdout.write(names.map((n) => '-rw-r--r--  0 0 0 12 Jan  1  2026 ' + n + '\\r\\n').join(''));
else fs.writeFileSync(${JSON.stringify(extracted)}, a.join(' '));
`, { mode: 0o755 });
process.env.PATH = sealedPath([bin, ...String(process.env.PATH).split(path.delimiter)]); // seal: the test's own folder first, through sealedPath
const { linesOf, sameListing, unpack } = await import('../../src/editor/archive.mjs');

const skip = { skip: process.platform === 'win32' && 'Files starts the system tar by its full path there, which no stand-in takes the place of' };

test('a listing with \\r\\n line ends: a file named .git, or a private name, as the last part is refused before anything is unpacked', skip, async () => {
  for (const [names, why] of [[['proj/', 'proj/.git', 'g/HEAD'], /"proj\/\.git" is in git's own folder/], [['proj/', 'proj/no-ai'], /"proj\/no-ai" is in a private folder/]]) {
    fs.writeFileSync(listing, JSON.stringify(names));
    fs.rmSync(extracted, { force: true });
    const dir = fs.mkdtempSync(path.join(box, 'case-'));
    fs.writeFileSync(path.join(dir, 'a.tar.gz'), 'stand-in');
    await assert.rejects(unpack(path.join(dir, 'a.tar.gz'), [box]), (e) => e.status === 409 && why.test(e.message), names.join(' '));
    assert.equal(fs.existsSync(extracted), false, 'tar was never asked to unpack it');
    assert.deepEqual(fs.readdirSync(dir), ['a.tar.gz']);
  }
});

test('lines are read without their \\r; a listing with \\r\\n matches the own reader\'s names', () => {
  assert.deepEqual(linesOf('a\r\nb\nc\r\n'), ['a', 'b', 'c', '']);
  assert.equal(sameListing('Why?.mp3\r\nb/\r\n', ['Why?.mp3', 'b']), true);
});
