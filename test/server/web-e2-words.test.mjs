// Seven words a newcomer does not know are no longer on the page (the old word gone, plain words in its place):
// quarantine, "your own webhook", the server.backend config line, the tunnel helper, the worktree, Compacting, and
// Webhooks / token said once in plain words beside the heading.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
// What a person reads: the quoted strings of the file (comments are left out above).
const strings = (f) => read(f).match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];

test('words: the old words are gone from what the page shows', () => {
  const gone = {
    'skillhub.js': /quarantine|pinned to one exact version/i,
    'settings.js': /your own webhook|server\.backend|in the config and restart/i,
    'updates.js': /tunnel helper/i,
    'workdo.js': /worktree/i,
    'chat/statusline.js': /Compacting/,
  };
  for (const [f, re] of Object.entries(gone)) for (const s of strings(f)) assert.doesNotMatch(s, re, `${f}: ${s}`);
});

test('words: the plain words stand in their place', () => {
  assert.match(read('skillhub.js'), /'Each skill is first downloaded to a place apart, kept at the exact version you saw, and shown in full before you install it\.'/);
  assert.doesNotMatch(read('settings.js'), /For a program of your own \(JSON\)/, 'the push format is no choice on the page any more; an old value stays');
  assert.match(read('settings.js'), /'Hoprig picks tmux when it is installed, else its own terminals\.'/);
  assert.match(read('updates.js'), /the helper for the public link \(cloudflared\)/);
  assert.match(read('workdo.js'), /'Done with it: remove its copy of the project'/);
  assert.match(read('chat/statusline.js'), /'Shortening the conversation to make room'/);
  const access = read('workaccess.js');
  assert.match(access, /h\('h3\.wk-sub-head', 'Webhooks'\),\n\s+h\('p\.hint', 'A webhook is a web address of another program: Hoprig sends it a message/, 'the heading keeps the word, said once beside it');
  assert.match(access, /A token is the key that program uses to reach Hoprig/);
  assert.doesNotMatch(access, /'A webhook belongs to a token: make a token first\.'/);
});
