// A start under Auto mode whose order holds a provider billed by use waits for his tap; the card says why in his own
// providers' labels: which one the session starts on, and which paid one it may move to at a limit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function cardLines(label = (s) => s) {
  const s = label(baseState());
  s.assistant = { enabled: true, level: 'work', accounts: ['auto', 'sub', 'api'] };
  Object.assign(s.autoSwitch, { enabled: true, order: ['sub', 'api'] });
  const ops = new FakeOps(s);
  const now = Date.now;
  const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
  return core.call('start_session', { folder: '/home/owner/projects/api', account: 'auto', message: 'fix the test' }, { conversation: 'c1' })
    .then((r) => { assert.ok(r.card, r.text); return r.card.lines.join('\n'); });
}

test('the card names the providers by their labels: "when Main reaches its limit, Auto mode may move this session to API key"', async () => {
  assert.match(await cardLines(), /Why a card: when Main reaches its limit, Auto mode may move this session to API key, which costs money$/m);
});

test('other labels, other words: never fixed names', async () => {
  const lines = await cardLines((s) => {
    s.profiles.find((p) => p.name === 'sub').label = 'Team plan';
    s.profiles.find((p) => p.name === 'api').label = 'Pay as you go key';
    return s;
  });
  assert.match(lines, /Why a card: when Team plan reaches its limit, Auto mode may move this session to Pay as you go key, which costs money$/m);
  assert.doesNotMatch(lines, /\bMain\b|API key/);
});
