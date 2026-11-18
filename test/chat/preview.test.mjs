// A card's preview of a reply (src/chat/events.mjs previewText): plain words in one line, read in a moment whatever
// the reply holds, since the reply is the model's text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { previewText } from '../../src/chat/events.mjs';

test('a reply\'s preview: plain words, no Markdown marks, a table as its cells', () => {
  const md = '# Done\n\nThe **tests** pass and `npm test` is _green_; see [the log](https://x.example/l).\n\n| a | b |\n| --- | :---: |\n| 1 | 2 |\n\n---\n- [x] one';
  assert.equal(previewText(md), 'Done The tests pass and npm test is green; see the log. a · b 1 · 2 one');
  assert.equal(previewText('  |  ---  |  ---  |  \nafter'), 'after', 'a table\'s rule with blanks around it is no text');
  assert.equal(previewText('word '.repeat(200), 30).length, 30);
});

test('a reply\'s preview takes a moment, also for a reply of long lines', () => {
  // Each of these took the server seconds: blanks before a table rule's end, and many bold or italic marks that do
  // not close.
  const replies = {
    blanks: `${' '.repeat(50_000)}x`,
    rule: `---${' '.repeat(50_000)}x`,
    gap: `a${' '.repeat(50_000)}b`,
    bold: '**a '.repeat(12_500),
    italic: ' *a'.repeat(16_000),
    lines: 'a line of the reply\n'.repeat(50_000),
  };
  for (const [name, md] of Object.entries(replies)) {
    const t = performance.now();
    const out = previewText(md);
    const ms = performance.now() - t;
    assert.ok(out.length > 0 && out.length <= 300, name);
    assert.ok(ms < 150, `${name}: ${ms.toFixed(0)} ms`);
  }
  assert.equal(previewText(`${' '.repeat(50_000)}after the blanks`), 'after the blanks', 'blanks do not use up what is read of a line');
  assert.equal(previewText(`---${' '.repeat(50_000)}x`), '--- x');
  assert.equal(previewText(`one${' '.repeat(50_000)}two`), 'one two');
  assert.equal(previewText('    # not a heading: indented'), '# not a heading: indented');
});
