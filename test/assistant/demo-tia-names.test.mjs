// The demo's stand-in for Tia names a waiting chat by its title, never by its inner id.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('demo Tia: the list of what waits names each session by its title, the name only where it has none', () => {
  const s = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'demo', 'tia.mjs'), 'utf8');
  const line = s.split('\n').find((l) => l.includes("['needs_ok', 'waiting', 'limit'].includes(x.status)"));
  assert.ok(line, 'the list of what waits');
  assert.match(line, /`\*\*\$\{nameOf\(x\)\}\*\*`/);
  // nameOf: the title first; without one a chat by its folder, else the session's name.
  assert.match(s, /const nameOf = \(x\) => x\.title \|\| \(x\.chat \|\| \/\^chat:\/\.test\(x\.session\) \? `a chat in [^`]*` : x\.session\);/);
});
