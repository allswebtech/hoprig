// A ?show= part inside a closed fold ("Advanced" on Notifications holds the page-address field): showPart opens every
// fold around it before it scrolls and focuses, so the link of an error lands on the field and not on a closed fold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { showPart, openFoldsAround } = await import('../../web/showpart.js');

// Just enough of the page: a node knows its parent, a <details> its open state, closest('details') walks up.
function node(tag, parent = null, extra = {}) {
  const n = { tag, parentElement: parent, open: false, calls: [], ...extra };
  n.closest = (sel) => {
    assert.equal(sel, 'details');
    for (let x = n; x; x = x.parentElement) if (x.tag === 'details') return x;
    return null;
  };
  n.querySelector = () => null;
  n.focus = () => n.calls.push(['focus', outer.open, inner.open]);
  n.scrollIntoView = () => n.calls.push(['scroll', outer.open, inner.open]);
  return n;
}
let outer;
let inner;

test('a part inside two closed folds: both are open before it is focused and scrolled to', async () => {
  const page = node('section');
  outer = node('details', page);
  const body = node('div', outer);
  inner = node('details', body);
  const field = node('input', inner);
  const el = await showPart('page-address', { find: (id) => (id === 'page-address' ? field : null), every: 1 });
  assert.equal(el, field);
  assert.equal(outer.open, true, 'the outer fold is open');
  assert.equal(inner.open, true, 'the inner fold is open');
  assert.deepEqual(field.calls, [['focus', true, true], ['scroll', true, true]], 'opened first, then focus and scroll');
});

test('a part in no fold, or in an open one, is left as it is', () => {
  outer = node('details', null, { open: true });
  inner = node('details', null, { open: true });
  const plain = node('input', node('section'));
  openFoldsAround(plain);
  const inOpen = node('input', outer);
  openFoldsAround(inOpen);
  assert.equal(outer.open, true);
  openFoldsAround(null); // nothing found: nothing happens
});

test('the Notifications page keeps page-address inside its Advanced fold, and the error way names it', () => {
  const s = fs.readFileSync(new URL('../../web/settings.js', import.meta.url), 'utf8');
  const fold = s.slice(s.indexOf("fold('settings-notify'"), s.indexOf("h('div.savebar'", s.indexOf("fold('settings-notify'")));
  assert.match(fold, /id: 'page-address'/, 'the field is inside the fold showPart now opens');
  const w = fs.readFileSync(new URL('../../web/errorways.js', import.meta.url), 'utf8');
  assert.match(w, /'notify-address': \{ label: 'Notifications', href: '#\/settings\/notifications\?show=page-address' \}/);
});
