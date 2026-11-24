// A test that leaves an entry in the repository root (what the stray "\tmp\..." folders were: a Windows-style path
// built on POSIX). The runner's root guard must fail the run and name it. It does not clean up: the leftover is the
// point; the runner test that drives this fixture removes it.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('leaves an entry in the repository root', () => {
  // The runner starts every test child with the repository root as its working folder.
  fs.writeFileSync(path.join(process.cwd(), 'hoprig-root-guard-probe.tmp'), '');
});
