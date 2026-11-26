// The skill store's move of a folder (src/skillhub/store.mjs moveDir): a rename, else (across file systems, EXDEV)
// a copy by the names' bytes and the original removed. The rename is handed in, so the copy is run here for real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { moveDir } from '../../src/skillhub/store.mjs';
import { ODD_NAMES_SKIP, oddNamesWork } from '../oddnames.mjs';

const exdev = () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); };

test('across file systems: a copy with every name, link and mode, then the original is gone', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'movedir-'));
  try {
    const from = path.join(d, 'skill');
    fs.mkdirSync(path.join(from, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(from, 'SKILL.md'), '# s\n');
    fs.writeFileSync(path.join(from, 'scripts', 'run.sh'), 'echo\n', { mode: 0o755 });
    // The name that is not UTF-8 only where the disk takes it (APFS refuses it: ODD_NAMES_SKIP).
    const oddOk = process.platform !== 'win32' && oddNamesWork({ dir: d }); // Windows has no such name at all
    if (oddOk) fs.writeFileSync(Buffer.concat([Buffer.from(`${from}/odd`), Buffer.from([0xff]), Buffer.from('.md')]), 'odd\n');
    else t.diagnostic(`the name with the byte 0xFF is skipped: ${ODD_NAMES_SKIP}`);
    fs.symlinkSync('SKILL.md', path.join(from, 'link.md'));
    const to = path.join(d, 'kept', 'skill');
    moveDir(from, to, { rename: exdev });
    assert.equal(fs.existsSync(from), false, 'the original is removed');
    assert.equal(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8'), '# s\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(to, 'scripts', 'run.sh')).mode & 0o777, 0o755);
    if (oddOk) assert.equal(fs.readFileSync(Buffer.concat([Buffer.from(`${to}/odd`), Buffer.from([0xff]), Buffer.from('.md')]), 'utf8'), 'odd\n');
    assert.equal(fs.readlinkSync(path.join(to, 'link.md')), 'SKILL.md');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a rename that fails for another reason is thrown, and nothing is copied', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'movedir-'));
  try {
    fs.mkdirSync(path.join(d, 'skill'));
    const busy = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    assert.throws(() => moveDir(path.join(d, 'skill'), path.join(d, 'kept', 'skill'), { rename: busy }), (e) => e.code === 'EBUSY');
    assert.equal(fs.existsSync(path.join(d, 'kept', 'skill')), false);
    assert.equal(fs.existsSync(path.join(d, 'skill')), true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
