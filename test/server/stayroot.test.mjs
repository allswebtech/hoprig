// Staying root on purpose (Settings → Runs as root): the page's view of root, the typed sentence that keeps Hoprig on
// root (kept as `stayRoot`, after which the doctor's and Health's line is information with no step), taking it back,
// and a container that needs no sentence. Root is a fact handed in (`root`): nothing here runs as root.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('stayroot');
delete process.env.container;
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const R = await import('../../src/setup/rootfacts.mjs');

saveConfig({ launcher: ['L'], server: { roots: [box.root], passwordHash: await hashPassword('right-password') } });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name, id: 'pty-1' }), respawn: async () => {} };

async function dashboard(opts, fn) {
  const app = createServer({ backend, watch: false, workUser: null, rootExists: () => false, ...opts });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (p, body) => {
      const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: JSON.parse((await r.text()) || '{}') };
    };
    await fn(call);
  } finally {
    await app.close();
  }
}

// The doctor's and Health's line, from the settings as they are now (checks.mjs reads them the same way).
const doctorLine = () => R.rootCheck({ ...R.rootFacts({ cfg: loadConfig(), exists: () => false, env: {} }), root: true });

test('as root: the page sees root not on purpose; only the sentence typed as it is keeps it, and then the line is information', async () => {
  await dashboard({ root: true }, async (call) => {
    let r = await call('/api/settings');
    assert.deepEqual(r.json.root, { container: [], stay: false, onPurpose: false, sentence: 'keep Hoprig on root', limits: R.ROOT_LIMITS });
    assert.equal(doctorLine().status, 'warn');
    // Anything but the sentence is refused and nothing is kept.
    for (const wrong of [true, 'keep Hoprig on root', { sentence: 'keep hoprig' }, { sentence: '' }, {}]) {
      r = await call('/api/settings', { stayRoot: wrong });
      assert.equal(r.status, 400, JSON.stringify(wrong));
      assert.match(r.json.error, /type the sentence "keep Hoprig on root"/i);
      assert.equal(loadConfig().stayRoot, undefined);
    }
    // The sentence (case and spaces at its ends aside) keeps it in the settings.
    r = await call('/api/settings', { stayRoot: { sentence: '  Keep Hoprig on root ' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(loadConfig().stayRoot, true);
    assert.equal(r.json.root.stay, true);
    assert.equal(r.json.root.onPurpose, true);
    const line = doctorLine();
    assert.deepEqual([line.status, line.fix], ['info', '']);
    assert.match(line.detail, /kept on root by your choice/);
    // Bypass is still not offered: staying root does not make Claude Code accept it.
    assert.ok(!r.json.sessionChoices.permissionModes.includes('bypassPermissions'));
    // Taken back: the line is a suggestion again.
    r = await call('/api/settings', { stayRoot: false });
    assert.equal(r.status, 200);
    assert.equal(loadConfig().stayRoot, false);
    assert.equal(r.json.root.onPurpose, false);
    assert.equal(doctorLine().status, 'warn');
  });
});

test('as root inside a container: on purpose with the fact named, and no sentence is needed', async () => {
  await dashboard({ root: true, rootExists: (f) => f === '/.dockerenv' }, async (call) => {
    const r = await call('/api/settings');
    assert.deepEqual(r.json.root.container, ['/.dockerenv']);
    assert.equal(r.json.root.onPurpose, true);
    assert.equal(r.json.root.stay, false);
  });
});

test('not as root: nothing about root on the page, and the choice cannot be kept', async () => {
  await dashboard({ root: false }, async (call) => {
    let r = await call('/api/settings');
    assert.equal(r.json.root, null);
    r = await call('/api/settings', { stayRoot: { sentence: 'keep Hoprig on root' } });
    assert.equal(r.status, 400);
    assert.equal(loadConfig().stayRoot, false, 'unchanged from the test before');
  });
});

test.after(() => box.cleanup());
