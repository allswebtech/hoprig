// Tia's administrator-rights level: the reader and validator (src/assistant/herrights.mjs), the owner-only route that
// sets it (src/server/herrights.mjs), and that the level can never be changed through Tia's door — it is no key of
// change_setting, no key her /api/settings door may send, and /api/herrights is no route of her door.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HER_RIGHTS_DEFAULT, HER_RIGHTS_LEVELS, cleanHerRightsLevel, fullConfirmSentence, herRightsLevel } from '../../src/assistant/herrights.mjs';
import { herRightsFeature } from '../../src/server/herrights.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { tokenMayReach } from '../../src/machines/index.mjs';
import { SETTINGS } from '../../src/assistant/owner-tools.mjs';

test('the level is off by default and reads only a level we know', () => {
  assert.equal(HER_RIGHTS_DEFAULT, 'off');
  assert.deepEqual(HER_RIGHTS_LEVELS, ['off', 'ask', 'full']);
  assert.equal(herRightsLevel(undefined), 'off');
  assert.equal(herRightsLevel({}), 'off');
  assert.equal(herRightsLevel({ server: {} }), 'off');
  assert.equal(herRightsLevel({ server: { herRights: { level: 'ask' } } }), 'ask');
  assert.equal(herRightsLevel({ server: { herRights: { level: 'full', version: 'v1' } } }, 'v1'), 'full');
  // Junk reads as off, never as a right she does not have.
  assert.equal(herRightsLevel({ server: { herRights: { level: 'root' } } }), 'off');
  assert.equal(herRightsLevel({ server: { herRights: { level: true } } }), 'off');
  assert.equal(herRightsLevel({ server: { herRights: {} } }), 'off');
});

test('cleanHerRightsLevel takes off/ask/full and throws on anything else', () => {
  for (const l of HER_RIGHTS_LEVELS) assert.equal(cleanHerRightsLevel(l), l);
  for (const bad of ['', 'root', 'ADMIN', 'on', true, 1, null, undefined, {}]) {
    assert.throws(() => cleanHerRightsLevel(bad), /administrator-rights level is one of/);
  }
});

test('Full reads as Ask under another Hoprig version, so an update never silently keeps no-card rights', () => {
  const full = (version) => ({ server: { herRights: { level: 'full', version } } });
  assert.equal(herRightsLevel(full('v1'), 'v1'), 'full'); // chosen under the running version: Full
  assert.equal(herRightsLevel(full('v1'), 'v2'), 'ask'); // chosen under another version: reads as Ask
  assert.equal(herRightsLevel(full(undefined), 'v2'), 'ask'); // no version stamp (an old config): reads as Ask
  // Off and Ask do not depend on the version it was chosen under.
  assert.equal(herRightsLevel({ server: { herRights: { level: 'ask', version: 'v1' } } }, 'v2'), 'ask');
  assert.equal(herRightsLevel({ server: { herRights: { level: 'off', version: 'v1' } } }, 'v2'), 'off');
  assert.equal(herRightsLevel({ server: { herRights: { level: 'ask' } } }, 'v2'), 'ask');
});

// A fake ctx that keeps config in memory and merges `server` one level deep, as src/config.mjs saveConfig does.
function fakeCtx(initial = {}) {
  let cfg = { ...initial, server: { ...(initial.server || {}) } };
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  return {
    config: () => cfg,
    saveConfig(patch) {
      const next = { ...cfg, ...patch };
      if (patch.server) next.server = { ...(cfg.server || {}), ...patch.server };
      cfg = next;
      return cfg;
    },
    readJson: async (req) => req, // the test passes the body object itself as `req`
    HttpError,
  };
}

test('the owner route reads and sets the level, keeps other settings, and refuses a bad level', async () => {
  const ctx = fakeCtx({ server: { roots: ['/home/alex/projects'] } });
  // sudo needs no password here, so Full is offered; the test never reaches the real sudo.
  const f = herRightsFeature(ctx, { version: 'test-1', sudoAsksPassword: async () => false });
  const get = f.routes.find(([m]) => m === 'GET')[2];
  const post = f.routes.find(([m]) => m === 'POST')[2];
  assert.equal((await get()).level, 'off');
  assert.deepEqual(await post({ level: 'ask' }), { level: 'ask' });
  assert.equal(herRightsLevel(ctx.config()), 'ask');
  assert.equal(ctx.config().server.herRights.version, 'test-1');
  assert.ok(Number.isInteger(ctx.config().server.herRights.at));
  assert.deepEqual(ctx.config().server.roots, ['/home/alex/projects']); // another server setting survives the change
  assert.equal((await get()).level, 'ask');
  // Full needs the typed sentence that names the computer; an unlabelled computer reads as "this computer".
  assert.deepEqual(await post({ level: 'full', confirm: fullConfirmSentence('this computer') }), { level: 'full' });
  await assert.rejects(() => post({ level: 'root' }), (e) => e.status === 400 && /administrator-rights level is one of/.test(e.message));
  await assert.rejects(() => post({}), (e) => e.status === 400);
  assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'full'); // a refused request changed nothing; read under the version it was set
});

test('turning on Full needs the exact sentence that names the computer, typed on his page (decision 5)', async () => {
  const ctx = fakeCtx({ computer: { label: 'alpha' }, server: {} });
  const f = herRightsFeature(ctx, { version: 'test-1', sudoAsksPassword: async () => false });
  const post = f.routes.find(([m]) => m === 'POST')[2];
  const sentence = fullConfirmSentence('alpha');
  assert.match(sentence, /alpha/, 'the sentence names the computer');
  // No sentence, a wrong one, or one for another computer: Full is refused and the level is unchanged.
  for (const confirm of [undefined, '', 'turn it on', fullConfirmSentence('beta'), `${sentence} please`]) {
    await assert.rejects(() => post({ level: 'full', confirm }), (e) => e.status === 400 && e.message.includes(sentence), JSON.stringify(confirm));
  }
  assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'off', 'a refused Full turn-on left the level off');
  // The exact sentence (trimmed) turns it on.
  assert.deepEqual(await post({ level: 'full', confirm: `  ${sentence}  ` }), { level: 'full' });
  assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'full');
  // Off and Ask need no sentence.
  assert.deepEqual(await post({ level: 'ask' }), { level: 'ask' });
  assert.deepEqual(await post({ level: 'off' }), { level: 'off' });
});

test('Full is offered only where sudo needs no password: on a password computer it is refused and nothing is kept (decision 5)', async () => {
  const ctx = fakeCtx({ computer: { label: 'alpha' }, server: {} });
  const f = herRightsFeature(ctx, { version: 'test-1', sudoAsksPassword: async () => true });
  const post = f.routes.find(([m]) => m === 'POST')[2];
  // Even with the right sentence, Full is refused where sudo asks a password (Hoprig never keeps one to make Full work).
  await assert.rejects(
    () => post({ level: 'full', confirm: fullConfirmSentence('alpha') }),
    (e) => e.status === 400 && /needs no password/i.test(e.message),
  );
  assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'off', 'the level stayed off');
  // Off and Ask are still allowed on a password computer.
  assert.deepEqual(await post({ level: 'ask' }), { level: 'ask' });
});

test('the owner route reports Full as Ask, and says it was held back, when it was chosen under another Hoprig version', async () => {
  const ctx = fakeCtx({ server: { herRights: { level: 'full', version: 'old-version', at: 1 } } });
  const get = herRightsFeature(ctx, { version: 'new-version', sudoInfo: async () => ({ present: true, needsPassword: false }) }).routes.find(([m]) => m === 'GET')[2];
  const r = await get();
  assert.equal(r.level, 'ask'); // the page shows Ask (and says why), so an update never keeps no-card rights
  assert.equal(r.heldFromFull, true, 'the page is told Full was turned off by the version change, so it can say why');
  // When the running version matches the stored one, Full is on and nothing was held back.
  const on = herRightsFeature(fakeCtx({ server: { herRights: { level: 'full', version: 'new-version', at: 1 } } }), { version: 'new-version', sudoInfo: async () => ({ present: true, needsPassword: false }) }).routes.find(([m]) => m === 'GET')[2];
  const ro = await on();
  assert.equal(ro.level, 'full');
  assert.equal(ro.heldFromFull, false);
});

test('the GET route carries what the page shows: the level, the Full sentence, and this computer\'s sudo (decisions 3, 5, 8)', async () => {
  const ctx = fakeCtx({ computer: { label: 'alpha' }, server: {} });
  const getWith = (s) => herRightsFeature(ctx, { version: 'test-1', sudoInfo: async () => s }).routes.find(([m]) => m === 'GET')[2];
  // sudo present and asks no password: Full is offered, and the sentence names the computer.
  assert.deepEqual(await getWith({ present: true, needsPassword: false })(), { level: 'off', sentence: fullConfirmSentence('alpha'), sudoPresent: true, needsPassword: false, fullOffered: true, heldFromFull: false });
  // sudo asks a password: Full is not offered, but the computer still has sudo (the Ask card asks for a password).
  assert.deepEqual(await getWith({ present: true, needsPassword: true })(), { level: 'off', sentence: fullConfirmSentence('alpha'), sudoPresent: true, needsPassword: true, fullOffered: false, heldFromFull: false });
  // no sudo at all (a Windows box): the page says so and offers only Off.
  assert.deepEqual(await getWith({ present: false, needsPassword: false })(), { level: 'off', sentence: fullConfirmSentence('alpha'), sudoPresent: false, needsPassword: false, fullOffered: false, heldFromFull: false });
});

test('the level cannot be changed through Tia\'s door', () => {
  // change_setting has no key for administrator rights: she cannot propose it as a dashboard setting.
  const keys = Object.keys(SETTINGS);
  assert.ok(!keys.some((k) => /right|admin|sudo/i.test(k)), keys.join(','));

  const refused = (method, p, body = {}) => {
    try {
      checkRoute(method, p, body, { config: () => ({}) });
      return false;
    } catch (e) {
      return e.status === 403 && e.code === 'tia-route';
    }
  };
  // /api/herrights is no route of her door — this computer's, or behind a computer's prefix.
  assert.ok(refused('POST', '/api/herrights'));
  assert.ok(refused('GET', '/api/herrights'));
  assert.ok(refused('POST', '/m/alpha/api/herrights'));
  // Her /api/settings door will not carry the level either (settingsBody: it is the owner's setting).
  assert.ok(refused('POST', '/api/settings', { server: { herRights: { level: 'full' } } }));
  assert.ok(refused('POST', '/api/settings', { server: { herRights: 'full' } }));
});

test('the level is set only from the owner\'s own page: a token or another computer is refused, the level unchanged (decision 1)', async () => {
  // ctx.caller(req): 'page' (the owner's own signed-in page), 'computer' (another dashboard's bearer token, also a
  // request relayed from a paired hub) or 'self' (Tia's door). Only 'page' may set the level — the same owner-page
  // guard accounts.mjs and adopt use — so a change can never raise her own rights.
  for (const who of ['computer', 'self']) {
    const ctx = fakeCtx({ server: {} });
    ctx.caller = () => who;
    const post = herRightsFeature(ctx, { version: 'test-1', sudoAsksPassword: async () => false }).routes.find(([m]) => m === 'POST')[2];
    // Even level 'ask' (no sentence needed) and a full turn-on with the right sentence are refused with no change.
    await assert.rejects(() => post({ level: 'ask' }), (e) => e.status === 403, who);
    await assert.rejects(() => post({ level: 'full', confirm: fullConfirmSentence('this computer') }), (e) => e.status === 403, who);
    assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'off', `the level is unchanged from ${who}`);
  }
  // The owner's own page ('page') still sets it.
  const ctx = fakeCtx({ server: {} });
  ctx.caller = () => 'page';
  const post = herRightsFeature(ctx, { version: 'test-1', sudoAsksPassword: async () => false }).routes.find(([m]) => m === 'POST')[2];
  assert.deepEqual(await post({ level: 'ask' }), { level: 'ask' });
  assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'ask');
});

test('a machine token cannot reach the level route (nor the git sign-in route): both are forbidden at the gate (decision 1)', () => {
  // The machines gate refuses a token and a relayed request before the route is reached: /api/herrights and the git
  // sign-in /api/hersignin are in TOKEN_FORBIDDEN, like /api/accounts and /api/settings/password.
  assert.equal(tokenMayReach('/api/herrights'), false, 'the level route is forbidden to a token');
  assert.equal(tokenMayReach('/api/hersignin'), false, 'the git sign-in route is forbidden to a token');
  assert.equal(tokenMayReach('/api/hersignin/check'), false, 'the git sign-in check is forbidden to a token');
  // The list is not blanket: an ordinary read route a hub needs is still reachable.
  assert.equal(tokenMayReach('/api/machine'), true);
});
