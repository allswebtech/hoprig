// What the demo's coding work needs on disk: the cart the chat fixes (src/demo/chat.mjs), and OpenCode as a second
// coding tool. Nothing here is downloaded and no model is asked.
import fs from 'node:fs';
import path from 'node:path';

// shop-frontend's cart: rounded per line before the discount (the bug the demo's chat fixes).
const CART = `// The cart: what the checkout page shows and charges.

export function cartTotal(items, discount = 0) {
  const sum = items.reduce((s, i) => s + Math.round(i.price * i.qty * 100) / 100, 0);
  return sum * (1 - discount);
}

export function itemCount(items) {
  return items.reduce((n, i) => n + i.qty, 0);
}
`;
const CART_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from './cart.js';

test('cart total with a discount', () => {
  assert.equal(cartTotal([{ price: 19.99, qty: 3 }], 0.15), 50.97);
});
`;

/** shop-frontend's cart and its test, in `dir`: the chat's diff is then also in the editor's Source Control. */
export function seedCart(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'cart.js'), CART);
  fs.writeFileSync(path.join(dir, 'src', 'cart.test.js'), CART_TEST);
}

/**
 * OpenCode "installed" in Hoprig's tools folder (src/codetools/npmtool.mjs reads the version from the package file),
 * so Settings → Coding tools, Updates and the new-chat picker show a second coding tool. Its program is a stand-in
 * that only says the demo does not run it: nothing is downloaded and no model is asked.
 */
export function demoOpenCode(root) {
  const mods = path.join(root, 'state', 'tools', 'opencode', 'node_modules');
  fs.mkdirSync(path.join(mods, '@opencode', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(mods, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(mods, '@opencode', 'cli', 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.0' }));
  const bin = path.join(mods, '.bin', 'opencode');
  fs.writeFileSync(bin, '#!/bin/sh\necho "(demo) OpenCode does not run in the demo: nothing is installed." >&2\nexit 1\n', { mode: 0o755 });
}
