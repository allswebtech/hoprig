// The line the Operator page shows while the master switch is off names that switch as the page labels it: "Tia acts
// by herself", never a shorter name the page does not show. A made-up world: nothing here acts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-acts-name');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');

test('with "Tia acts by herself" off, the line names the switch by the page\'s own label', () => {
  saveConfig({ assistant: { enabled: true }, operator: { acts: false, rules: {} } });
  const ctx = { HttpError: Error, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: () => () => {} };
  const f = operatorFeature(ctx, {
    sources: { sessions: () => [], gateways: () => [], live: () => null, leftovers: () => [], machine: () => null },
    cacheMs: 0,
    accounts: async () => ({ profiles: [] }),
    turn: async () => ({ ok: false }),
    session: { move: async () => {} },
    acts: {},
  });
  try {
    const v = f.reflex.view();
    assert.equal(v.acts, false);
    assert.equal(v.said, '"Tia acts by herself" is off: she follows none of the Operator\'s rules on her own and decides nothing by herself. Work you ask of her is not affected.');
    // The page's switch carries that very label.
    const page = fs.readFileSync(new URL('../../web/operator-tia.js', import.meta.url), 'utf8');
    const label = page.match(/sw\('([^']+)', v\.acts,/)?.[1];
    assert.equal(label, 'Tia acts by herself');
    assert.ok(v.said.includes(`"${label}"`));
  } finally {
    f.close();
  }
});
