// A new project's first message is Hoprig's, written for the AI: the chat shows it folded, his brief under it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { START_MARK } = await import('../../src/pcsetup/newprojectstart.mjs');
const { firstMessage } = await import('../../src/pcsetup/newproject.mjs');
const { startFold } = await import('../../web/chat/words.js');
const web = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'chat', f), 'utf8');

test('the start message carries the mark on a line of its own; the chat folds it and keeps his brief as written', () => {
  const brief = 'A small site for a bakery.\n\nThree pages: home, menu, contact.';
  const sent = `${START_MARK}\n${firstMessage({ brief, kind: 'web-app', scope: 'setup' })}`;
  const f = startFold(sent);
  assert.ok(f, 'folded');
  assert.equal(f.brief, brief, 'his brief byte for byte');
  assert.match(f.full, /^Use the new-project skill/);
  assert.equal(startFold('Use the new-project skill … my own words'), null, 'a message he wrote is never folded');
  assert.equal(startFold(`hi\n${START_MARK}`), null, 'only at the start');
});

test('the folded bubble says who asked and opens the full message on a press', () => {
  const s = web('timeline.js');
  assert.match(s, /`Hoprig asked the AI to set up \$\{name\} from your brief`/);
  assert.match(s, /h\('summary', 'Show the full message'\)/);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'pcsetup', 'newprojectstart.mjs'), 'utf8'), /const text = `\$\{startMark\(path\.basename\(p\.root\)\)\}\\n\$\{firstMessage\(/);
});
