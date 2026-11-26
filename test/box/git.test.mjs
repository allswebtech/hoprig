// The box (docs/BOX.md): nothing written inside runs later outside by the product's own hand. The `.git` of a write
// folder is read-only inside (no hook, no configuration can be written), and so are a worktree's git folder and its
// common folder when they lie inside a named folder. A link in a write folder that points outside leads nowhere.
// Repositories are made here, in a temporary folder; nothing is pushed or fetched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boxCheck, planRun, runBoxed } from '../../src/box/box.mjs';
import { gitGuards } from '../../src/box/gitguard.mjs';
import { bwrapArgs } from '../../src/box/linux.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-git-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A project "shop" with a commit, and a worktree of it beside it in the same named folder.
const repos = path.join(tmp, 'repos');
const shop = path.join(repos, 'shop');
fs.mkdirSync(shop, { recursive: true });
git(shop, 'init', '-q');
fs.writeFileSync(path.join(shop, 'a.txt'), 'a');
git(shop, 'add', 'a.txt');
git(shop, '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');
const tree = path.join(repos, 'shop-task');
git(shop, 'worktree', 'add', '-q', '-b', 'task', tree);
const plain = path.join(tmp, 'plain');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(plain);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'made-up secret');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(plain, 'link-to-secret'));
fs.symlinkSync(outside, path.join(plain, 'link-to-outside'));
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

const noBox = process.platform === 'win32' && 'the box is made for Linux and macOS: Windows has none (means.mjs)';

test('the guards: a .git folder; a worktree\'s .git file with its git folder and common folder; nothing without .git', { skip: noBox }, () => {
  assert.deepEqual(gitGuards([shop], [shop]), [path.join(shop, '.git')]);
  const wt = gitGuards([tree], [repos]);
  assert.equal(wt[0], path.join(tree, '.git'));
  assert.ok(wt.includes(path.join(shop, '.git', 'worktrees', 'shop-task')), wt.join(' '));
  assert.ok(wt.includes(path.join(shop, '.git')), 'the common folder');
  assert.deepEqual(gitGuards([tree], [tree]), [path.join(tree, '.git')], 'a git folder outside every named folder is not there at all');
  assert.deepEqual(gitGuards([plain], [plain]), []);
  assert.deepEqual(gitGuards([tree, shop], [tree, shop]), [path.join(tree, '.git'), path.join(shop, '.git', 'worktrees', 'shop-task'), path.join(shop, '.git')], 'each once');
  // Not covered, on purpose (docs/BOX.md): a .git deeper inside a write folder than its top.
  assert.deepEqual(gitGuards([repos], [repos]), []);
});

test('the arguments bind each guard read-only after the write folders', { skip: noBox }, () => {
  const { args } = bwrapArgs(planRun(['/bin/true'], { cwd: tree, write: [tree], read: [shop], timeoutMs: 1000 }));
  const lastWrite = args.lastIndexOf('--bind');
  const ro = args.flatMap((a, i) => (a === '--ro-bind' && i > lastWrite ? [args[i + 1]] : []));
  assert.ok(ro.includes(path.join(tree, '.git')));
  assert.ok(ro.includes(path.join(shop, '.git')));
});

/** Runs a script in the box that tries each write and read; → { name: 'written' | error code } */
async function tries(opts, attempts) {
  const script = `
    const fs = require('fs');
    const out = {};
    for (const [name, [how, p]] of Object.entries(${JSON.stringify(attempts)})) {
      try {
        if (how === 'write') fs.writeFileSync(p, '#!/bin/sh\\necho made-up hook\\n', { mode: 0o755 });
        else if (how === 'append') fs.appendFileSync(p, '\\n[core]\\n\\thooksPath = /tmp\\n');
        else if (how === 'rename') fs.renameSync(p, p + '.gone');
        else out[name] = fs.readFileSync(p, 'utf8');
        out[name] = out[name] ?? 'written';
      } catch (e) { out[name] = e.code; }
    }
    console.log(JSON.stringify(out));`;
  const r = await runBoxed([process.execPath, '-e', script], { timeoutMs: 20_000, ...opts });
  assert.equal(r.ok, true, r.why + r.out);
  return JSON.parse(r.out.trim().split('\n').pop());
}

test('in the real box: a hook and the configuration of a write folder\'s .git cannot be written; the files can', { skip }, async () => {
  const s = await tries({ cwd: shop, write: [shop] }, {
    hook: ['write', path.join(shop, '.git', 'hooks', 'post-checkout')],
    config: ['append', path.join(shop, '.git', 'config')],
    moveGit: ['rename', path.join(shop, '.git')],
    file: ['write', path.join(shop, 'b.txt')],
  });
  assert.deepEqual(s, { hook: 'EROFS', config: 'EROFS', moveGit: 'EBUSY', file: 'written' });
  assert.ok(!fs.existsSync(path.join(shop, '.git', 'hooks', 'post-checkout')));
  assert.doesNotMatch(fs.readFileSync(path.join(shop, '.git', 'config'), 'utf8'), /hooksPath/);
});

test('in the real box: a worktree\'s .git file, its git folder and the common folder are read-only', { skip }, async () => {
  // The parent `repos` has no .git of its own: only the worktree's .git file leads to the git folders inside it.
  const s = await tries({ cwd: tree, write: [repos, tree] }, {
    dotgit: ['append', path.join(tree, '.git')],
    hook: ['write', path.join(shop, '.git', 'hooks', 'pre-commit')],
    wtConfig: ['write', path.join(shop, '.git', 'worktrees', 'shop-task', 'config.worktree')],
    config: ['append', path.join(shop, '.git', 'config')],
    file: ['write', path.join(tree, 'b.txt')],
  });
  assert.deepEqual(s, { dotgit: 'EROFS', hook: 'EROFS', wtConfig: 'EROFS', config: 'EROFS', file: 'written' });
});

test('in the real box: a link in a write folder that points outside leads nowhere', { skip }, async () => {
  const s = await tries({ cwd: plain, write: [plain] }, {
    viaFileLink: ['read', path.join(plain, 'link-to-secret')],
    viaDirLink: ['read', path.join(plain, 'link-to-outside', 'secret.txt')],
    writeViaLink: ['write', path.join(plain, 'link-to-outside', 'new.txt')],
  });
  assert.deepEqual(s, { viaFileLink: 'ENOENT', viaDirLink: 'ENOENT', writeViaLink: 'ENOENT' });
  assert.ok(!fs.existsSync(path.join(outside, 'new.txt')));
});
