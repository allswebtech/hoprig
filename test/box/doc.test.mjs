// The box (docs/BOX.md), the words: docs/BOX.md says what the box hides and, plainly, what it does NOT promise, and its
// lists stay those of the code (a name added to the code's closed list of /etc is added to the page too).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ETC, TOP } from '../../src/box/linux.mjs';
import { MAC_MEANS, LINUX_MEANS } from '../../src/box/means.mjs';

const DOC = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'BOX.md'), 'utf8');

test('BOX.md names every entry of the code\'s closed lists and the paths of the means', () => {
  for (const n of [...ETC, ...TOP.map((t) => `/${t}`), ...LINUX_MEANS, ...MAC_MEANS.map((m) => path.basename(m))]) assert.ok(DOC.includes(`\`${n}\``), n);
});

test('BOX.md says plainly what the box does not promise', () => {
  const part = DOC.slice(DOC.indexOf('## What the box does NOT promise'));
  assert.ok(part.length > 100, 'the section is there');
  for (const words of [/not a virtual machine/i, /fault in the kernel/i, /processor/i, /fill its `--write` folders/, /listed system folders/, /deeper inside/]) assert.match(part, words);
  assert.match(DOC, /has not yet been run on a Mac/);
  assert.match(DOC, /NoNewPrivs/);
  assert.match(DOC, /`node_modules` is a link/);
});

test('BOX.md gives the measured cost of a small command with and without the box', () => {
  assert.match(DOC, /\| `\/bin\/true` \| [\d.]+ \/ [\d.]+ ms \| [\d.]+ \/ [\d.]+ ms \|/);
  assert.match(DOC, /\| `node -e 0` \| [\d.]+ \/ [\d.]+ ms \| [\d.]+ \/ [\d.]+ ms \|/);
});

test('BOX.md says the whole runtime folder is readable, with global packages, and that its etc is hidden', () => {
  assert.match(DOC, /whole folder of the Node\.js that runs Hoprig/i);
  assert.match(DOC, /globally installed npm packages/i);
  assert.match(DOC, /npmrc/);
});

test('BOX.md names the git-inside-a-write-folder gap: a .git made inside where none existed is not read-only', () => {
  assert.match(DOC, /a command makes inside a `--write` folder that had none/);
});

test('BOX.md gives a person the actual AppArmor step, and the real cost of a command-line run', () => {
  assert.match(DOC, /apparmor\.d\/bwrap-userns-restrict/);
  assert.match(DOC, /aa-status/);
  assert.match(DOC, /quarter of a second/);
  assert.match(DOC, /when ten minutes have passed/);
});
