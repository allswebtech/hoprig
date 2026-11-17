// The chat's branch is read from .git/HEAD as a file, synchronously. A folder the dashboard did not make can put a
// FIFO (or a device) where HEAD is: a blocking read there would stop the whole dashboard. The read runs in a child
// process here, so a hang fails the test instead of the test runner.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILES = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/chat/files.mjs')).href;

function branchIn(dir) {
  const code = `import(${JSON.stringify(FILES)}).then((m) => { process.stdout.write(JSON.stringify(m.gitBranch(${JSON.stringify(dir)}))); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.signal, null, `gitBranch(${dir}) did not return within 5 s`);
  return JSON.parse(r.stdout);
}

test('the branch: a plain HEAD, a worktree\'s .git file, and a FIFO or a device in their place', { skip: process.platform === 'win32' && 'mkfifo' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-branch-'));
  try {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
    fs.writeFileSync(path.join(plain, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(branchIn(plain), 'main');

    const linked = path.join(root, 'linked');
    fs.mkdirSync(path.join(linked, 'g'), { recursive: true });
    fs.writeFileSync(path.join(linked, '.git'), 'gitdir: g\n');
    fs.writeFileSync(path.join(linked, 'g', 'HEAD'), 'ref: refs/heads/work\n');
    assert.equal(branchIn(linked), 'work');

    // HEAD a FIFO with no writer: a blocking read never returns.
    fs.rmSync(path.join(linked, 'g', 'HEAD'));
    execFileSync('mkfifo', [path.join(linked, 'g', 'HEAD')]);
    assert.equal(branchIn(linked), null);

    // The .git file itself a FIFO.
    const piped = path.join(root, 'piped');
    fs.mkdirSync(piped);
    execFileSync('mkfifo', [path.join(piped, '.git')]);
    assert.equal(branchIn(piped), null);

    // HEAD a link to an endless device: no read of it.
    const dev = path.join(root, 'dev');
    fs.mkdirSync(path.join(dev, '.git'), { recursive: true });
    fs.symlinkSync('/dev/zero', path.join(dev, '.git', 'HEAD'));
    assert.equal(branchIn(dev), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
