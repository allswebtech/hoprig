// The lines Hoprig prints on Windows for a person to paste, that move or delete (src/setup/system.mjs
// showFileCommand, showLinkRemoveCommand, showMergeCommand, showThen; the PATH line of src/workspace/grouptool.mjs), run
// as printed by Windows PowerShell 5.1 (powershell.exe, the one every Windows has) and by PowerShell 7 (pwsh) where it
// is on PATH. Each runs in a folder of the test's own whose name holds a space, a $, a backtick, a single quote and an
// &, beside a folder `outside` that a junction (made by mklink /J) and, where this account may make one, a folder
// symbolic link inside the folder point to. Every line must do what it says, end with exit code 0 and no error (but
// the two cases that check a refusal: a merge over a file there already, a showThen whose first command fails), ask
// nothing (no input, 60 s at most), and leave outside\keep.txt as it was: a line that goes into a link and deletes what
// it points to fails here. One PowerShell start per line (loading its commands costs seconds there).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { showFileCommand, showLinkRemoveCommand, showMergeCommand, showThen, which } from '../../src/setup/system.mjs';
import { pathAdvice } from '../../src/workspace/grouptool.mjs';

const W = 'win32';
const NAME = "it's a $b `c & d";
const KEEP = 'what the link points to: never touched\n';

if (process.platform !== 'win32') {
  test('the paste lines of Windows, run by PowerShell', { skip: 'these lines are run by Windows PowerShell' }, () => {});
} else {
  const shells = ['powershell.exe', ...(which('pwsh') ? ['pwsh'] : [])];
  const roots = [];
  test.after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

  /** A fresh folder: <root>/<NAME>/{outside/keep.txt, victim/{a.txt, ro.txt, hidden.txt, sub/, jlink, slink?}}. */
  const world = (tc) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-pastelines-'));
    roots.push(root);
    const base = path.join(root, NAME);
    const outside = path.join(base, 'outside');
    const victim = path.join(base, 'victim');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), KEEP);
    fs.mkdirSync(path.join(victim, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(victim, 'sub', 'deeper', 'b.txt'), 'b\n');
    for (const f of [path.join(victim, 'ro.txt'), path.join(victim, 'sub', 'ro.txt')]) {
      fs.writeFileSync(f, 'read-only\n');
      fs.chmodSync(f, 0o444); // the read-only mark on Windows (git's objects carry it)
    }
    const hidden = path.join(victim, 'hidden.txt');
    fs.writeFileSync(hidden, 'hidden\n');
    const h = spawnSync('attrib', ['+h', hidden], { encoding: 'utf8', windowsHide: true });
    assert.equal(h.status, 0, `attrib +h: ${h.stderr || h.stdout}`);
    const jlink = path.join(victim, 'jlink');
    const j = spawnSync('cmd', ['/d', '/c', 'mklink', '/J', jlink, outside], { encoding: 'utf8', windowsHide: true });
    assert.equal(j.status, 0, `mklink /J: ${j.stderr || j.stdout}`);
    assert.ok(fs.lstatSync(jlink).isSymbolicLink() && fs.existsSync(path.join(jlink, 'keep.txt')), 'the junction leads to outside');
    let slink = path.join(victim, 'slink');
    try {
      fs.symlinkSync(outside, slink, 'dir');
    } catch (e) {
      tc.diagnostic(`no folder symbolic link: this account may not make one (${e.code}); the junction is tested alone`);
      slink = null;
    }
    return { root, base, outside, victim, jlink, slink };
  };

  /** Run `text` exactly as printed (-EncodedCommand carries it unchanged), with no input and a limit. */
  const run = (shell, text) => {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(r.error, undefined, `${shell} did not end by itself within 60 s (it may have asked something): ${r.error}`);
    // Windows PowerShell writes its progress to stderr as CLIXML when the output is not a terminal; only an error counts.
    const err = String(r.stderr || '');
    const failed = err.startsWith('#< CLIXML') ? /S="Error"/.test(err) : err.trim() !== '';
    return { ...r, failed, said: `${shell} ran:\n${text}\nexit ${r.status}\n${r.stdout}\n${err}` };
  };
  const kept = (w) => {
    assert.ok(fs.statSync(w.outside).isDirectory(), 'outside is still there');
    assert.equal(fs.readFileSync(path.join(w.outside, 'keep.txt'), 'utf8'), KEEP, 'outside\\keep.txt is as it was');
  };
  const gone = (p) => assert.throws(() => fs.lstatSync(p), /ENOENT/, `${p} is gone`);
  const opts = { timeout: 180_000 };

  for (const shell of shells) {
    test(`${shell}: a folder with read-only and hidden files, a junction and a folder link in it is removed; what they point to stays`, opts, (tc) => {
      const w = world(tc);
      const r = run(shell, showFileCommand('rm -rf', [w.victim], W));
      assert.ok(r.status === 0 && !r.failed, r.said);
      gone(w.victim);
      kept(w);
    });

    test(`${shell}: a junction and a folder link removed alone, one after the other (showThen)`, opts, (tc) => {
      const w = world(tc);
      // Without a folder link (refused to this account) the second line is a move of a file, so showThen is still run.
      const second = w.slink ? showLinkRemoveCommand(w.slink, W) : showFileCommand('mv', [path.join(w.victim, 'a.txt'), path.join(w.victim, 'a2.txt')], W);
      const r = run(shell, showThen(showLinkRemoveCommand(w.jlink, W), second, W));
      assert.ok(r.status === 0 && !r.failed, r.said);
      gone(w.jlink);
      if (w.slink) gone(w.slink);
      else assert.ok(fs.existsSync(path.join(w.victim, 'a2.txt')), 'the second line ran');
      assert.ok(fs.existsSync(path.join(w.victim, 'sub')), 'the folder the links were in stays');
      kept(w);
    });

    test(`${shell}: when the first command fails, the second one of showThen does not run`, opts, (tc) => {
      const w = world(tc);
      const a = path.join(w.victim, 'a.txt');
      const moved = path.join(w.victim, 'a2.txt');
      // The first removes a link that is not there: it fails, so the move after it must not run.
      const r = run(shell, showThen(showLinkRemoveCommand(path.join(w.victim, 'no-such-link'), W), showFileCommand('mv', [a, moved], W), W));
      assert.ok(r.failed, `the first command failed and said so: ${r.said}`);
      assert.ok(fs.existsSync(a) && !fs.existsSync(moved), `the second did not run: ${r.said}`);
      kept(w);
    });

    test(`${shell}: a folder with a junction in it is moved; the junction moves as a link`, opts, (tc) => {
      const w = world(tc);
      const to = `${w.victim} moved`;
      const r = run(shell, showFileCommand('mv', [w.victim, to], W));
      assert.ok(r.status === 0 && !r.failed, r.said);
      gone(w.victim);
      assert.ok(fs.lstatSync(path.join(to, 'jlink')).isSymbolicLink(), 'still a link');
      assert.equal(fs.readFileSync(path.join(to, 'a.txt'), 'utf8'), 'a\n');
      kept(w);
    });

    test(`${shell}: a memory folder merged into the project's: every entry moved, the folder gone`, opts, (tc) => {
      const w = world(tc);
      const mem = path.join(w.base, 'memory');
      const into = path.join(w.base, "project's memory");
      fs.mkdirSync(mem);
      fs.mkdirSync(into);
      fs.writeFileSync(path.join(mem, 'x.md'), 'x\n');
      fs.writeFileSync(path.join(into, 'z.md'), 'z\n');
      const j = spawnSync('cmd', ['/d', '/c', 'mklink', '/J', path.join(mem, 'jlink'), w.outside], { encoding: 'utf8', windowsHide: true });
      assert.equal(j.status, 0, j.stderr || j.stdout);
      const r = run(shell, showMergeCommand(mem, into, W));
      assert.ok(r.status === 0 && !r.failed, r.said);
      gone(mem);
      assert.equal(fs.readFileSync(path.join(into, 'x.md'), 'utf8'), 'x\n');
      assert.equal(fs.readFileSync(path.join(into, 'z.md'), 'utf8'), 'z\n');
      assert.ok(fs.lstatSync(path.join(into, 'jlink')).isSymbolicLink(), 'the junction moved as a link');
      kept(w);
    });

    test(`${shell}: a merge with a file of the same name there overwrites nothing, and the folder stays`, opts, (tc) => {
      const w = world(tc);
      const mem = path.join(w.base, 'memory');
      const into = path.join(w.base, "project's memory");
      fs.mkdirSync(mem);
      fs.mkdirSync(into);
      fs.writeFileSync(path.join(mem, 'x.md'), 'x\n');
      fs.writeFileSync(path.join(mem, 'y.md'), 'mine\n');
      fs.writeFileSync(path.join(into, 'y.md'), 'theirs\n');
      const r = run(shell, showMergeCommand(mem, into, W));
      assert.notEqual(r.status, 0, `the line says that something stayed: ${r.said}`);
      assert.equal(fs.readFileSync(path.join(into, 'y.md'), 'utf8'), 'theirs\n', 'nothing overwritten');
      assert.equal(fs.readFileSync(path.join(mem, 'y.md'), 'utf8'), 'mine\n', 'the folder stays with the file it could not move');
      assert.equal(fs.readFileSync(path.join(into, 'x.md'), 'utf8'), 'x\n', 'the rest moved');
      kept(w);
    });

    test(`${shell}: the PATH line puts the folder first, its name as it is`, opts, (tc) => {
      const w = world(tc);
      const bin = path.join(w.base, 'bin');
      const line = pathAdvice(bin, W).split(':  ').slice(1).join(':  ');
      const r = run(shell, `${line}; Write-Output $env:Path`);
      assert.ok(r.status === 0 && !r.failed, r.said);
      assert.equal(r.stdout.trim().split(';')[0], bin);
      kept(w);
    });
  }
}
