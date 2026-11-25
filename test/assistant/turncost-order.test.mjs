// A turn of Tia on a provider billed by use: its cost is written into the spending record first and on its own
// (src/assistant/feature.mjs). A usage list that cannot be written must not skip the cost, and a record that cannot
// be written is said in the log instead of being passed over in silence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('../../src/assistant/feature.mjs', import.meta.url), 'utf8');

test('a turn\'s cost is recorded before the usage list, each in a try of its own, and a failed record is logged', () => {
  const cost = src.indexOf("spend.spent(d.costUsd, 'her own turn', hold);");
  const usage = src.indexOf('recordUsage(turnUsage(d, { conversation: c.id }));');
  assert.ok(cost > 0 && usage > 0, 'both writes are there');
  assert.ok(cost < usage, 'the cost first');
  const between = src.slice(cost, usage);
  assert.match(between, /\} catch \(e\) \{\n\s*console\.error\(`\$\{ASSISTANT_NAME\}: the cost of a turn could not be written into the spending record/, 'a failed record is said in the log');
  assert.match(between, /\}\n\s*try \{\n\s*$/, 'the usage list has a try of its own');
  assert.doesNotMatch(src, /recordUsage\(turnUsage\(d, \{ conversation: c\.id \}\)\);\n\s*if \(ready\.paid/, 'never the cost behind the usage list in one try');
});
