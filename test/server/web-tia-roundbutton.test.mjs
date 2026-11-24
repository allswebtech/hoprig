// Tia's round button on a desktop stands in its lane beside the cards' column at every width (page-automations.css):
// the lane (92 px of the page's right padding) holds from 900 px on, not only up to 1499 px, and the button keeps
// 16 px from the column's edge (sidebar 232 + at most 1200 = 1432, so its right edge at 1416) instead of drifting to
// the window's edge on a wide window. It covers nothing: the content stops at the lane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'page-automations.css'), 'utf8');
const block = (() => {
  const at = css.indexOf('@media (min-width: 900px) {\n  body.tia-fab');
  return at < 0 ? '' : css.slice(at, css.indexOf('}\n}', at) + 3);
})();

test('the lane holds at every desktop width, not only below 1500 px', () => {
  assert.ok(block, 'the lane is not kept at every desktop width');
  assert.doesNotMatch(css, /@media \(min-width: 900px\) and \(max-width: 1499px\) \{\s*body\.tia-fab/);
  assert.match(block, /body\.tia-fab:not\(\.term-mode\):not\(\.chat-mode\) \.page \{ padding-right: 92px; \}/);
  assert.match(block, /body\.tia-fab:not\(\.term-mode\):not\(\.chat-mode\) \.pagehead \{ margin-right: -92px; \}/);
});

test('the button keeps to the column\'s edge: 24 px from the window up to 1440 px, then 16 px from the column', () => {
  assert.match(block, /body\.tia-fab:not\(\.term-mode\):not\(\.chat-mode\) \.tia-boxroot \{ right: max\(24px, calc\(100vw - 1416px\)\); \}/);
  // The arithmetic of that rule: its right edge, and the lane it stands in, at a few widths.
  for (const w of [1024, 1440, 1600, 1920, 2560]) {
    const right = w - Math.max(24, w - 1416);
    const pageRight = 232 + Math.min(1200, w - 232);
    const contentRight = pageRight - 92;
    assert.ok(right - 52 >= contentRight, `${w}: the button covers the column`);
    // Up to 1440 px the column ends at the window: 24 px as before; wider, 16 px from the column's edge.
    assert.equal(pageRight - right, w < 1440 ? 24 : 16, `${w}: the button is ${pageRight - right} px from the column`);
  }
});
