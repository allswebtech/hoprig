// "Settings → Work" and "Settings → Coding tools" are not places any more: Work's settings are the fold at the foot of
// Work → Tasks, the coding tools are a card of Settings → New sessions. No sentence of the program, the page or the
// guides sends a person to a Settings row that is not there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : [path.join(dir, d.name)]));

test('no sentence names Settings → Work or Settings → Coding tools', () => {
  const bad = [];
  for (const d of ['src', 'web', 'templates', 'docs']) {
    for (const f of walk(path.join(root, d))) {
      if (!/\.(mjs|js|md|css|json)$/.test(f)) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
        if (/Settings → (Work(?!space)|Coding tools)/.test(l)) bad.push(`${path.relative(root, f)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(bad, []);
});
