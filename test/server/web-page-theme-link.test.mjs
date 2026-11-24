// The code editor's sentence about the page's colours opens Appearance at the Page colours control itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('the editor\'s "Settings → Appearance" opens the page at Page colours', () => {
  assert.match(read('web/editor/index.js'), /href: link\('#\/settings\/appearance\?show=page-theme'\) \}, 'Settings → Appearance'/);
  assert.match(read('web/settings.js'), /'Page colours': 'page-theme'/, 'the control has that id');
  assert.match(read('web/settings.js'), /h\('div\.fieldrow', ids\[label\] \? \{ id: ids\[label\] \} : \{\}/);
});
