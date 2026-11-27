// Not in step: several rows each have a Show button. One door per act (the easy guard): no button label twice on the
// first screen, so each row's button names its project (also what a screen reader says).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('../../web/instep.js', import.meta.url), 'utf8');

test('the Show link and the Get it button of a Not in step row name their project', () => {
  assert.match(src, /const named = \(r\) => \(r\.project \? `\$\{r\.button\} \$\{r\.project\}` : r\.button\);/);
  assert.match(src, /'aria-label': named\(r\) \}, r\.button\)/);
  assert.match(src, /label: r\.button, 'aria-label': named\(r\), onclick/);
});
