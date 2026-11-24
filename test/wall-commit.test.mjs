// Claude Code writes a commit as `git commit -m "$(cat <<'EOF' … EOF)"`. A QUOTED heredoc
// delimiter means the body is literal text (no expansion, no command runs), so this is a commit with a literal
// message, not an unreadable line: it reads as an ordinary `git commit` and goes through. A Hands-off session must
// not stop at every commit. The unquoted form, a smuggled command, and every other substitution stay held.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { wallKind, wallHeld } = await import('../src/wall.mjs');

const places = { hoprig: ['/x/.config/hoprig', '/x/.local/state/hoprig'], home: '/x', own: '/x/shop' };
const held = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: '/x/shop', places });
const H = (delim, body, tail = ')') => `git commit -m "$(cat <<${delim}\n${body}\n${tail}"`;

test('the quoted-heredoc commit form reads as an ordinary commit and goes through', () => {
  assert.equal(wallKind(H("'EOF'", 'fix: a plain message\nEOF')), null);
  assert.equal(held(H("'EOF'", 'fix: a plain message\nEOF')), null);
  // Even a message whose literal text mentions held kinds is still just a message.
  assert.equal(held(H("'EOF'", 'fix: call sudo and npm publish in deploy; rm -rf build\nmore lines\nEOF')), null);
  assert.equal(held(H('"MSG"', 'subject\n\nbody\nMSG')), null); // a double-quoted delimiter is quoted too
});

test('the unquoted form, a smuggled command, and other substitutions stay held', () => {
  assert.equal(wallKind(H('EOF', 'msg\nEOF')), 'unreadable'); // unquoted delimiter: the body would expand
  assert.equal(wallKind(H("'EOF'", 'msg\nEOF\n; sudo rm -rf /')), 'unreadable'); // a command after the delimiter
  assert.equal(wallKind('echo $(id)'), 'unreadable');
  assert.equal(wallKind('echo `id`'), 'unreadable');
});

test('a real held command is unaffected by the commit-form reader', () => {
  assert.equal(wallKind('sudo true'), 'admin');
  assert.equal(wallKind('npm publish'), 'release');
  assert.equal(wallKind('gh pr create --fill'), 'pr');
});
