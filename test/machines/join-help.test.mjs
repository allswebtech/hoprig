// `hoprig join --help` prints the lines of the machines usage that name hoprig join, each with the lines under it
// (src/helptext.mjs linesFor). A wrapped sentence whose next line starts with "hoprig …" is read as a new command,
// so the lines after it (--fingerprint, --insecure) were lost from join's help and a made-up "hoprig machines invite
// there" stood in machines' own.
import assert from 'node:assert/strict';
import test from 'node:test';
import { USAGE } from '../../src/machines/cli.mjs';
import { linesFor } from '../../src/helptext.mjs';

test("join's help keeps its options and the place the line comes from", () => {
  const join = linesFor(USAGE, 'join');
  assert.match(join, /\[--fingerprint sha256:…\]/);
  assert.match(join, /\[--insecure\]/);
  assert.match(join, /\("hoprig machines invite" there, or Computers → Add a computer/);
});

test('no wrapped line of the machines usage starts with a command', () => {
  const machines = linesFor(USAGE, 'machines');
  assert.doesNotMatch(machines, /^\s*hoprig machines invite there/m);
  assert.match(machines, /hoprig machines invite {2,}on the main computer/);
});
