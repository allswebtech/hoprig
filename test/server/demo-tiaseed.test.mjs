// The demo's seed of Tia (src/demo/index.mjs, the background block) shows her as she is meant to be seen: she starts the
// landing-page session on the subscription the owner names (no provider billed by use, so it is hers to make at "Do the
// work"), its job finishes, and the one card that waits for the owner is the move of docs-site onto the API provider.
// Auto mode keeps the order the README recommends: one subscription, then an API provider, so the Providers page draws
// no note about going from one subscription to another.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

test('demo: after the seed exactly one card waits (docs-site to the API provider) and the started job is done', { timeout: 120_000, skip: process.platform === 'win32' && 'the demo sessions run through a POSIX shell' }, async () => {
  const box = sandbox('demo-tiaseed');
  const { main } = await import('../../src/demo/index.mjs');
  const hooks = { onReady: (i) => (hooks.info = i) };
  try {
    assert.equal(await main(['--no-open', '--quiet'], hooks), null);
    await hooks.background;
    const { url, link } = hooks.info;
    const token = link.split('#link=')[1];
    const r = await fetch(`${url}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const get = async (p) => (await fetch(`${url}${p}`, { headers: { Cookie: cookie } })).json();
    const cards = (await get('/api/assistant/cards')).cards || [];
    assert.deepEqual(cards.map((c) => [c.tool, c.input && c.input.session]), [['switch_account', 'docs-site']], 'one card waits: the move of docs-site');
    const jobs = (await get('/api/assistant/jobs')).jobs || [];
    assert.deepEqual(jobs.map((j) => j.state), ['done'], 'the seed\'s start ran and its job finished');

    // Auto mode's order, as the Providers page reads it (web/accounts.js load: /api/accounts and /api/settings).
    const accounts = (await get('/api/accounts')).accounts || [];
    const auto = (await get('/api/settings')).autoSwitch;
    const kindOf = (n) => (accounts.find((p) => p.name === n) || {}).kind;
    // The note "Going from one subscription to another restarts Claude …" (web/lib.js subscriptionsNote) is drawn
    // when manySubscriptions holds for the rows of the order (web/accounts.js limitPanel: the order's names among the
    // providers that serve Claude Code, each mapped to its provider).
    const { manySubscriptions, servesClaude } = await import('../../web/lib.js');
    const served = accounts.filter(servesClaude);
    const rows = (auto.order || []).filter((n) => served.some((p) => p.name === n));
    assert.deepEqual(
      { order: auto.order.map(kindOf), note: manySubscriptions(rows.map((n) => served.find((p) => p.name === n))) },
      { order: ['subscription', 'api'], note: false },
      'one subscription, then an API provider; the Providers page draws no note about several subscriptions');
  } finally {
    await hooks.stop?.();
    box.cleanup();
  }
});
