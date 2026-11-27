// At 390 px a Providers switch's sentence is not squeezed beside the floating button's room: the page has room at its
// bottom, so on Providers the switch row takes the card's width. Other pages keep the room.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/page-providers.css', import.meta.url), 'utf8');

test('TRouteAI page: the switch row has no right room for the floating button on a phone', () => {
  assert.match(css, /@media \(max-width: 899px\) \{\s*body\.has-fab main\.page:has\(\.tr-page\) \.card \.switchrow \{ padding-right: 0; \}/);
  const page = fs.readFileSync(new URL('../../web/trouteaipage.js', import.meta.url), 'utf8');
  assert.match(page, /h\('div\.tr-page'/, 'the mark is the page the rule names');
});
