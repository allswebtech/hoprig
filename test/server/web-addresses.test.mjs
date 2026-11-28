// Addresses of the pages: the ones that exist only as a name for a part land on that part, and the old More address
// opens the More page (no page was merged away).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { queryAlias } = await import('../../web/addressalias.js');
const app = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');

test('a query that names a part sends the address to that part, and nothing else is sent on', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(queryAlias('/computer/advanced', q('show=service')), '/computer/health');
  assert.equal(queryAlias('/work/tasks', q('show=golive')), '/work/golive');
  assert.equal(queryAlias('/computer/advanced', q('')), null);
  assert.equal(queryAlias('/computer/advanced', q('show=ports')), null);
  assert.equal(queryAlias('/work/tasks', q('show=work-place')), null, 'a part of Tasks stays on Tasks');
  assert.equal(queryAlias('/settings', q('show=service')), null);
});

test('the router uses it, and #/work/today is Work\'s first part', () => {
  assert.match(app, /ALIASES\[path\] \|\| renamed\(path\) \|\| queryAlias\(path, query\)/);
  assert.match(app, /'\/work\/today': '\/work'/);
  assert.doesNotMatch(app, /'\/more': /, 'More is a page again, not an alias');
  assert.match(app, /function viewMore\(\)/);
  const list = /export const PAGE_ADDRESSES = \[([\s\S]*?)\];/.exec(app)[1];
  for (const a of ['#/more', '#/work/today', '#/providers/trouteai']) assert.ok(list.includes(`'${a}'`), `${a} is in PAGE_ADDRESSES`);
});
