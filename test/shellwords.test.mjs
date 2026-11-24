// The ONE reader of which folder a word of a command names (src/shellwords.mjs): the wall and the list of
// administrator forms refused at every level both ask it, so neither keeps spellings of its own. It fills in what is
// certain (`~`, `$HOME`, `${HOME}`, quotes) and says where a word's value cannot be told from the line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathTexts, shellWords } from '../src/shellwords.mjs';

const H = '/home/alex';
const words = (t) => shellWords(t, { home: H });
const values = (t) => words(t).map((w) => w.value);

test('the home folder is one folder however it is written', () => {
  for (const t of ['~', '$HOME', '${HOME}', '"$HOME"', '"${HOME}"']) {
    const [w] = words(t);
    assert.equal(w.value, H, t);
    assert.equal(w.unsure, false, t);
    assert.equal(w.home, true, t);
  }
  assert.deepEqual(values('rm -rf ~/x $HOME/x ${HOME}//x "$HOME"/x ~/./x'), ['rm', '-rf', `${H}/x`, `${H}/x`, `${H}//x`, `${H}/x`, `${H}/./x`]);
});

test('quotes are taken off as the shell does', () => {
  assert.deepEqual(values(`a'b c'd "e f" g\\ h 'it''s'`), ['ab cd', 'e f', 'g h', 'its']);
  // Single quotes keep a `$` and a `~` as they are: nothing is filled in, and nothing is unknown.
  const [w] = words("'$HOME/x'");
  assert.deepEqual([w.value, w.unsure, w.vars, w.home], ['$HOME/x', false, false, false]);
  assert.equal(words("'~'")[0].value, '~');
  assert.equal(words('a~b')[0].value, 'a~b', 'a tilde inside a word is itself');
});

test('a word whose value cannot be told from the line says so', () => {
  for (const t of ['${HOME:?}', '${HOME%/}', '$OTHER/x', '"$OTHER"', '~alex', '~+', '~-/x', 'a{b,c}', 'x{1..3}', '`pwd`/x', '"`pwd`"', '$?', '"unclosed', "'unclosed"]) {
    assert.equal(words(t)[0].unsure, true, t);
  }
  // find's own `{}` and a lone dollar are themselves.
  assert.deepEqual(words('find . -exec ls {} ;').map((w) => [w.value, w.unsure]), [['find', false], ['.', false], ['-exec', false], ['ls', false], ['{}', false]]);
  assert.deepEqual([words('a$')[0].value, words('a$')[0].unsure], ['a$', false]);
  // With no home folder given, `~` and `$HOME` cannot be told either.
  assert.equal(shellWords('~/x')[0].unsure, true);
  assert.equal(shellWords('$HOME/x', { home: 'relative' })[0].unsure, true);
});

test('a pattern keeps the text before its first *, ? or [', () => {
  const [a, b, c, d] = words('~/* /etc/sudoers* *.txt /var/log/[a-c]?.log');
  assert.deepEqual([a.glob, a.fixed], [true, `${H}/`]);
  assert.deepEqual([b.glob, b.fixed], [true, '/etc/sudoers']);
  assert.deepEqual([c.glob, c.fixed], [true, '']);
  assert.deepEqual([d.glob, d.fixed], [true, '/var/log/']);
  // Quoted or escaped, it is no pattern.
  for (const t of ["'*.txt'", '"*.txt"', '\\*.txt']) assert.equal(words(t)[0].glob, false, t);
});

test('a ~ after the = of a word shaped like an assignment is the home folder too, as bash reads it', () => {
  assert.deepEqual(values('dd if=/dev/zero of=~/x'), ['dd', 'if=/dev/zero', `of=${H}/x`]);
  assert.deepEqual(values('DIRS=/a:~/b cmd'), [`DIRS=/a:${H}/b`, 'cmd']);
  // An option is not shaped like an assignment: bash leaves its tilde alone.
  assert.deepEqual(values('cp a --target=~/x'), ['cp', 'a', '--target=~/x']);
});

test('operators part words', () => {
  assert.deepEqual(values('a;b|c&&d>e<f(g)'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('pathTexts: what a caller asks the place of', () => {
  const texts = (t) => pathTexts(words(t)).map((x) => (x.unsure ? '?' : x.text));
  assert.deepEqual(texts('rm -rf ~//'), ['rm', `${H}//`], 'an option is not a path');
  assert.deepEqual(texts('cp --target-directory=/srv/x a'), ['cp', '/srv/x', 'a'], 'the value after an option\'s =');
  assert.deepEqual(texts('dd if=/dev/zero of=/dev/sda'), ['dd', '/dev/zero', '/dev/sda']);
  assert.deepEqual(texts('chown u $WHERE'), ['chown', 'u', '?']);
  // A pattern gives the folder it is matched in, and keeps its fixed text.
  const g = pathTexts(words('ls ~/* /etc/sudoers* *.txt /*'));
  assert.deepEqual(g.map((x) => x.text), ['ls', H, '/etc', '.', '/']);
  assert.deepEqual(g.slice(1).map((x) => x.fixed), [`${H}/`, '/etc/sudoers', '', '/']);
});
