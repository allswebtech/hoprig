// Tia's own start of a session or a coding chat with no provider named, under an Auto mode whose order holds nothing
// it may use (a key billed by use while "Also use pay-per-use providers" is off): she does not start on Auto mode (the
// router would answer every request with its 503). She goes on to another provider she may use; with none, she says
// why in the router's words and starts nothing. With a usable order, Auto mode is chosen as before.
// Made-up providers on the suite's fake dashboard; no router, no files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import * as T from '../../src/assistant/tia.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const { chooseAccount, resolveTia } = T;
// Read at the call: a test of the rule itself fails as a test, never the whole file at its import.
const autoLeftOut = (acc) => T.autoLeftOut(acc);

const BILLED = 'Auto mode has nothing it may use, because Shop key in its order is billed by use and "Also use pay-per-use providers" is off';

function stateWith(autoSwitch, allowed) {
  const s = baseState();
  s.profiles = [
    { name: 'sub', label: 'Main', kind: 'subscription', inUse: 0, limited: null, usage: null },
    { name: 'key', label: 'Shop key', kind: 'api', paid: true, inUse: 0, limited: null, usage: null },
  ];
  s.assistant = { enabled: true, level: 'work', accounts: allowed };
  Object.assign(s.autoSwitch, { enabled: true, ...autoSwitch });
  return s;
}

async function start(tool, autoSwitch, allowed) {
  const now = Date.now;
  const ops = new FakeOps(stateWith(autoSwitch, allowed));
  const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
  const r = await core.call(tool, { folder: '/home/owner/projects/api', message: 'fix the test' }, { conversation: 'c1' });
  const started = ops.calls.filter((c) => c.op === 'startSession' || c.op === 'startChat').map((c) => c.args.profile);
  return { r, started };
}

for (const tool of ['start_session', 'start_chat']) {
  test(`${tool}: Auto mode with nothing it may use and a subscription allowed: she starts on the subscription and says why not Auto mode`, async () => {
    const { r, started } = await start(tool, { order: ['key'], payPerUse: false }, ['auto', 'sub']);
    assert.deepEqual(started, ['sub']);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /picked by Tia: the only provider Tia may use; its usage is not reported; Auto mode has nothing it may use, because Shop key in its order is billed by use and "Also use pay-per-use providers" is off/);
  });

  test(`${tool}: Auto mode with nothing it may use and no other provider: the router's reason, nothing started`, async () => {
    const { r, started } = await start(tool, { order: ['key'], payPerUse: false }, ['auto']);
    assert.deepEqual(started, []);
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith(`Error: ${BILLED}.`), r.text);
    assert.doesNotMatch(r.text, /the router moves the session/);
  });

  test(`${tool}: Auto mode with nothing it may use: the Next line names Auto mode's way out, not a reset`, async () => {
    const { r } = await start(tool, { order: ['key'], payPerUse: false }, ['auto']);
    assert.ok(r.text.includes('Next: tell the owner; he can turn that switch on on the Providers page, or put a subscription into the order, or allow more providers in Settings → Tia (open_screen "settings/tia").'), r.text);
    assert.doesNotMatch(r.text, /wait for a reset/);
  });

  test(`${tool}: every provider at its limit: the Next line still says to wait for a reset`, async () => {
    const now = Date.now;
    const s = stateWith({ order: ['key'], payPerUse: false }, ['auto', 'sub']);
    s.profiles = s.profiles.map((p) => (p.name === 'sub' ? { ...p, limited: { until: null } } : p));
    const ops = new FakeOps(s);
    const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
    const r = await core.call(tool, { folder: '/home/owner/projects/api', message: 'fix the test' }, { conversation: 'c1' });
    assert.equal(r.isError, true);
    assert.ok(r.text.includes('Next: tell the owner; he can turn that switch on on the Providers page, or put a subscription into the order, or allow more providers in Settings → Tia (open_screen "settings/tia"), or wait for a reset.'), r.text);
  });

  test(`${tool}: a usable order: Auto mode is chosen as before`, async () => {
    const { r, started } = await start(tool, { order: ['sub', 'key'], payPerUse: false }, ['auto', 'sub']);
    assert.deepEqual(started, ['auto']);
    assert.match(r.text, /picked by Tia: Auto mode is on and allowed: the router moves the session to the next provider at a limit/);
  });
}

test('chooseAccount and autoLeftOut: one rule for each state of the order', () => {
  const acc = (as, profiles = stateWith({}, null).profiles) => ({ profiles, autoSwitch: { enabled: true, ...as } });
  // Billed by use, switch off: left out; switch on: usable.
  assert.equal(autoLeftOut(acc({ order: ['key'], payPerUse: false })), BILLED);
  assert.equal(autoLeftOut(acc({ order: ['key'], payPerUse: true })), null);
  // An empty order, and one of a provider that is gone or does not serve Claude Code.
  assert.equal(autoLeftOut(acc({ order: [] })), 'Auto mode has no providers in its order');
  assert.equal(autoLeftOut(acc({ order: ['ghost'] })), 'Auto mode has nothing it may use, because ghost in its order does not exist any more');
  const oai = [{ name: 'oai', kind: 'api', tools: ['codex'], usage: null }, { name: 'sub', kind: 'subscription', usage: null }];
  assert.equal(autoLeftOut(acc({ order: ['oai'] }, oai)), 'Auto mode has nothing it may use, because oai in its order does not serve Claude Code');
  // One usable provider is enough.
  assert.equal(autoLeftOut(acc({ order: ['ghost', 'sub'] })), null);
  // The pick: the next provider by the rules of before; with none, the reason; another coding tool never asks Auto mode.
  const a = acc({ order: ['key'], payPerUse: false });
  assert.equal(chooseAccount(resolveTia({ accounts: ['auto', 'sub'] }, a), a).account, 'sub');
  assert.deepEqual(chooseAccount(resolveTia({ accounts: ['auto'] }, a), a), { error: BILLED });
  const limited = { ...a, profiles: a.profiles.map((p) => (p.name === 'sub' ? { ...p, limited: { until: null } } : p)) };
  assert.equal(chooseAccount(resolveTia({ accounts: ['auto', 'sub'] }, limited), limited).error, `every provider Tia may use is at its limit; ${BILLED}`);
  const ok = acc({ order: ['sub'] });
  assert.equal(chooseAccount(resolveTia({ accounts: ['auto', 'sub'] }, ok), ok).account, 'auto');
});
