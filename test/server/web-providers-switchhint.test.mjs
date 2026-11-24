// At 390 px a Providers switch's sentence is not squeezed beside the floating button's room: the page has room at its
// bottom, so on Providers the switch row takes the card's width. Other pages keep the room.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/page-providers.css', import.meta.url), 'utf8');
const gw = fs.readFileSync(new URL('../../web/gateways.js', import.meta.url), 'utf8');

test('Providers: the switch row has no right room for the floating button on a phone', () => {
  assert.match(css, /@media \(max-width: 899px\) \{\s*body\.has-fab main\.page:has\(#gateways\) \.card \.switchrow \{ padding-right: 0; \}/);
  assert.match(gw, /return panel\(\{ id: 'gateways', icon: 'swap', title: 'Gateways on your computers'/, 'the mark is a panel only Providers draws');
});
