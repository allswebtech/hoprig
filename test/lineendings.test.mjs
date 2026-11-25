// Every text file of the repository is checked out with LF line endings, on Windows too (.gitattributes). Git for
// Windows turns LF into CRLF by default (core.autocrlf), and on the first Windows run of the suite the product then
// read its own pages, data files and templates with a CR at the end of every line: hundreds of tests failed there
// for no other reason. Asked of git itself, so a rule that is taken out or overridden for a kind of file is seen.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

test('every kind of text file the product reads is checked out with LF, whatever core.autocrlf says', () => {
  const files = ['README.md', 'docs/INSTALL.md', 'site/content/changelog.md', 'src/wall.mjs', 'web/registry.js', 'test/hands-off-examples.txt', 'templates', 'install.ps1', 'install.sh', 'package.json', '.github/workflows/test.yml']
    .flatMap((f) => (f === 'templates' ? git('ls-files', 'templates').split('\n').filter(Boolean).slice(0, 3) : [f]));
  assert.ok(files.length >= 11, files.join(', '));
  const out = git('check-attr', 'text', 'eol', '--', ...files);
  for (const f of files) {
    assert.match(out, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: eol: lf$`, 'm'), `${f} is checked out with LF`);
    assert.doesNotMatch(out, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: text: unset$`, 'm'), `${f} is treated as text`);
  }
});

test('a picture is never treated as text: its bytes are checked out as they are', () => {
  const pic = git('ls-files', '*.webp').split('\n').filter(Boolean)[0];
  assert.ok(pic, 'the repository holds a .webp picture');
  // text=auto leaves a file git finds binary alone: no line ending is ever changed in it.
  assert.match(git('check-attr', 'text', '--', pic), /: text: auto$/m);
  assert.match(git('ls-files', '--eol', '--', pic), /^i\/-text\b/);
});
