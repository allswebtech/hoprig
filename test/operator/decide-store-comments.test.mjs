import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// Each doc comment of the decisions' store sits right over the thing it describes: two blocks stacked over one
// declaration put the first one's words on the wrong thing for every reader and every editor.
test('the decisions store has no two doc comments stacked over one declaration', () => {
  const lines = fs.readFileSync(new URL('../../src/operator/decide-store.mjs', import.meta.url), 'utf8').split('\n');
  const stacked = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*\/\*\*.*\*\/\s*$/.test(lines[i]) && /\*\/\s*$/.test(lines[i - 1])) stacked.push(i + 1);
  }
  assert.deepEqual(stacked, [], `stacked doc comments at line(s) ${stacked.join(', ')}`);
  const tick = lines.findIndex((l) => l.includes('His tick for project'));
  assert.match(lines[tick + 1], /export function mayEndFor\(/, 'the tick\'s comment is over mayEndFor');
  const line = lines.findIndex((l) => l.includes("The item's line when stop needs his tick"));
  assert.match(lines[line + 1], /export const TICK_LINE =/, 'the line\'s comment is over TICK_LINE');
});
