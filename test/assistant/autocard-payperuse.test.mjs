// Auto mode with "also use pay-per-use providers" off spends nothing: the router leaves every paid key out of the order
// it uses (autoswitch.mjs usableOrder). So Tia's facts (spend.mjs paidName) do not call it paid, and her card for a
// start under Auto does not say that money can be spent. With it on, a paid key in the order is money, as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { paidName } from '../../src/assistant/spend.mjs';
import { decideLevel } from '../../src/assistant/policy.mjs';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const profiles = [{ name: 'sub', label: 'Plan', kind: 'subscription' }, { name: 'key', label: 'Shop key', kind: 'api', paid: true }];
const acc = (payPerUse) => ({ profiles, autoSwitch: { enabled: true, order: ['sub', 'key'], payPerUse } });

test('pay-per-use off: Auto mode is not paid, also with a paid key still in its order', () => {
  assert.equal(paidName('auto', acc(false)), false);
  assert.equal(paidName('auto', acc(true)), true);
  // A choice never made (older settings): the order decides, as the router does (getAutoSwitch's default).
  assert.equal(paidName('auto', { profiles, autoSwitch: { enabled: true, order: ['sub', 'key'] } }), true);
  // A key itself stays billed by use whatever Auto mode's switch says.
  assert.equal(paidName('key', acc(false)), true);
  // An API provider through a gateway is not marked paid: the router keeps it in the order, so it still counts.
  const gw = [profiles[0], { name: 'gw', label: 'Gateway key', kind: 'api' }];
  assert.equal(paidName('auto', { profiles: gw, autoSwitch: { enabled: true, order: ['sub', 'gw'], payPerUse: false } }), true);
  // A stored sign-in marked paid by its sign-in check (a Console account's key): the router leaves it out of the order
  // too (autoswitch.mjs usableOrder), so it does not count while the switch is off, and counts while it is on.
  const login = [profiles[0], { name: 'acct', label: 'Account', kind: 'login', paid: true }];
  assert.equal(paidName('auto', { profiles: login, autoSwitch: { enabled: true, order: ['sub', 'acct'], payPerUse: false } }), false);
  assert.equal(paidName('auto', { profiles: login, autoSwitch: { enabled: true, order: ['sub', 'acct'], payPerUse: true } }), true);
});

test('a provider billed by use that does not serve Claude Code never makes Auto mode paid', () => {
  // An OpenAI key straight to its vendor, paid by its own file: Auto mode moves Claude Code sessions only, so the
  // router never uses it (autoswitch.mjs usableOrder), whatever the switch says.
  const oai = [{ name: 'plan', label: 'Plan', kind: 'subscription', tools: ['claude'] }, { name: 'oai', label: 'Example OpenAI', kind: 'openai', paid: true, tools: ['codex', 'opencode'] }];
  for (const order of [['oai'], ['plan', 'oai']]) {
    for (const autoSwitch of [{ enabled: true, order, payPerUse: true }, { enabled: true, order }]) {
      assert.equal(paidName('auto', { profiles: oai, autoSwitch }), false, JSON.stringify(autoSwitch));
    }
  }
  assert.equal(paidName('oai', { profiles: oai }), true, 'the key itself stays billed by use');
  // A key billed by use that serves Claude Code still counts with the switch on, and one listed without tools too.
  const key = [...oai, { name: 'key', label: 'Shop key', kind: 'api', paid: true, tools: ['claude', 'opencode'] }];
  assert.equal(paidName('auto', { profiles: key, autoSwitch: { enabled: true, order: ['plan', 'oai', 'key'], payPerUse: true } }), true);
  assert.equal(paidName('auto', { profiles: [{ name: 'key', kind: 'api', paid: true }], autoSwitch: { enabled: true, order: ['key'], payPerUse: true } }), true);
});

test('pay-per-use off, a Console sign-in alone in the order: a start under Auto mode has no card that says money can be spent', () => {
  const tool = { name: 'start_session', level: 'L1' };
  const login = [{ name: 'acct', label: 'Account', kind: 'login', paid: true }];
  const acc = (payPerUse) => ({ profiles: login, autoSwitch: { enabled: true, order: ['acct'], payPerUse } });
  const account = (a) => ({ name: 'auto', kind: 'auto', paid: paidName('auto', a), allowed: true, order: { first: null, paid: ['Account'] } });
  const tia = { level: 'work', allowed: ['auto', 'acct'] };
  const off = decideLevel(tool, {}, { account: account(acc(false)) }, tia);
  assert.equal(off.level, 'L1', JSON.stringify(off));
  assert.doesNotMatch(String(off.why || ''), /money/);
  const on = decideLevel(tool, {}, { account: account(acc(true)) }, tia);
  assert.equal(on.level, 'L2');
  assert.match(on.why, /Auto mode runs this session on Account first, which costs money/);
});

test('pay-per-use off: a start under Auto mode at "Do the work" has no card that says money can be spent', () => {
  const tool = { name: 'start_session', level: 'L1' };
  const account = (a) => ({ name: 'auto', kind: 'auto', paid: paidName('auto', a), allowed: true, order: { first: 'Plan', paid: ['Shop key'] } });
  const tia = { level: 'work', allowed: ['auto', 'sub', 'key'] };
  const off = decideLevel(tool, {}, { account: account(acc(false)) }, tia);
  assert.equal(off.level, 'L1', JSON.stringify(off));
  assert.doesNotMatch(String(off.why || ''), /money/);
  const on = decideLevel(tool, {}, { account: account(acc(true)) }, tia);
  assert.equal(on.level, 'L2');
  assert.match(on.why, /Auto mode may move this session to Shop key, which costs money/);
});

test('the Auto card names the order the router really uses: a Console sign-in left out while pay-per-use is off is never "first"', async () => {
  const card = async (payPerUse) => {
    const s = baseState();
    s.profiles = [
      { name: 'acct', label: 'Account', kind: 'login', paid: true, inUse: 0, limited: null, usage: null },
      { name: 'gw', label: 'Gateway', kind: 'api', inUse: 0, limited: null, usage: null },
    ];
    s.assistant = { enabled: true, level: 'work', accounts: ['auto', 'acct', 'gw'] };
    Object.assign(s.autoSwitch, { enabled: true, order: ['acct', 'gw'], payPerUse });
    const now = Date.now;
    const core = createAssistantCore({ ops: new FakeOps(s), now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
    const r = await core.call('start_session', { folder: '/home/owner/projects/api', account: 'auto', message: 'fix the test' }, { conversation: 'c1' });
    assert.ok(r.card, r.text);
    return r.card.lines.join('\n');
  };
  // Off: the router serves through the gateway only (it is an API provider, paid per token), so that one runs it first.
  const off = await card(false);
  assert.doesNotMatch(off, /Account/);
  assert.match(off, /^Why a card: Auto mode runs this session on Gateway first, which costs money$/m);
  // On: the sign-in takes part and comes first, as before.
  assert.match(await card(true), /^Why a card: Auto mode runs this session on Account first, which costs money$/m);
});
