// A release's notes are refused while the changelog's heading still says "(not released yet)" (RELEASING.md step 1).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../tools/release-notes.mjs';

const base = { tag: 'v1.2.3', version: '1.2.3', skillVersion: '1.2.3' };

test('a heading that still says "(not released yet)" is refused, with one line that names RELEASING.md step 1', () => {
  const changelog = '# Changelog\n\n## 1.2.3 (not released yet)\n\n- Something new.\n\n## 1.2.2 (1 May 2027)\n\nolder\n';
  assert.throws(() => releaseNotes({ ...base, changelog }), (e) => {
    assert.match(e.message, /^the changelog's heading for 1\.2\.3 still says "\(not released yet\)": write the release date in its place \(RELEASING\.md step 1\)$/);
    assert.doesNotMatch(e.message, /\n/, 'one line');
    return true;
  });
  // The same section with its date is taken.
  assert.equal(releaseNotes({ ...base, changelog: changelog.replace('(not released yet)', '(2 June 2027)') }).notes, '- Something new.\n');
});

test('RELEASING.md step 1 says the release check refuses the undated heading', () => {
  const steps = fs.readFileSync(fileURLToPath(new URL('../RELEASING.md', import.meta.url)), 'utf8');
  const one = steps.slice(steps.indexOf('\n1. '), steps.indexOf('\n2. ')).replace(/\s+/g, ' ');
  assert.match(one, /`tools\/release-notes\.mjs` refuses a release whose heading still says "\(not released yet\)"/);
});
