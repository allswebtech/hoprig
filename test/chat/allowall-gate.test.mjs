// "Allow everything" (src/bypassgate.mjs ALL): offered only where Bypass permissions is allowed (never as root), usable
// only after the owner accepted it once; the lists nobody but the owner reaches never hold it; a default of it starts
// every launch in Bypass permissions, and root refuses a default of it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('allgate');
test.after(() => box.cleanup());
const G = await import('../../src/bypassgate.mjs');
const C = await import('../../src/config.mjs');

const MODES = ['manual', 'plan', 'bypassPermissions'];

test('allAllowed: Bypass allowed and the acknowledgement made, never as root', () => {
  assert.equal(G.ALL, 'allowEverything');
  assert.equal(G.allAllowed({ allowBypass: true, allowEverythingAt: 5 }, false), true);
  assert.equal(G.allAllowed({ allowBypass: true }, false), false, 'not yet accepted');
  assert.equal(G.allAllowed({ allowEverythingAt: 5 }, false), false, 'the switch is off');
  assert.equal(G.allAllowed({ allowBypass: false, allowEverythingAt: 5 }, false), false);
  assert.equal(G.allAllowed({ allowBypass: true, allowEverythingAt: 5 }, true), false, 'root');
  assert.equal(G.allAllowed(null, false), false);
  assert.equal(G.allAllowed({ allowBypass: true, allowEverythingAt: 'x' }, false), false);
});

test('ownerModes puts it right after Bypass, and only while Bypass is allowed', () => {
  assert.deepEqual(G.ownerModes(MODES, { allowBypass: true }, false), ['manual', 'plan', 'bypassPermissions', 'allowEverything']);
  assert.deepEqual(G.ownerModes(['manual', 'bypassPermissions', 'dontAsk'], { allowBypass: true }, false), ['manual', 'bypassPermissions', 'allowEverything', 'dontAsk']);
  assert.deepEqual(G.ownerModes(MODES, {}, false), ['manual', 'plan']);
  assert.deepEqual(G.ownerModes(MODES, { allowBypass: true }, true), ['manual', 'plan']);
  assert.deepEqual(G.ownerModes(['manual', 'plan'], { allowBypass: true }, false), ['manual', 'plan'], 'a tool without bypass has none');
  assert.deepEqual(G.gateModes(MODES, { allowBypass: true }, false), MODES, 'the plain gate never adds it');
});

test('root refuses a default of it with the sentence', () => {
  assert.equal(G.rootRefusal({ cfg: { sessionDefaults: { permissionMode: 'allowEverything' } }, root: true }), G.ALL_ROOT_LINE);
  assert.equal(G.rootRefusal({ cfg: { sessionDefaults: { permissionMode: 'allowEverything' } }, root: false }), null);
  assert.match(G.ALL_ROOT_LINE, /refuses bypass permissions mode as root, and Allow everything runs on top of it/);
});

test('defaults accept it; no other list has it; every launch starts in Bypass', () => {
  assert.deepEqual(C.cleanSessionDefaults({ permissionMode: 'allowEverything' }), { permissionMode: 'allowEverything' });
  assert.throws(() => C.cleanSessionDefaults({ permissionMode: 'bogus' }), /must be one of/);
  assert.ok(!C.PERMISSION_MODES.includes('allowEverything'));
  assert.ok(C.OWNER_MODES.includes('allowEverything'));
  assert.deepEqual(C.sessionArgs({ sessionDefaults: { permissionMode: 'allowEverything', effort: 'high' } }), ['--permission-mode', 'bypassPermissions', '--effort', 'high']);
  assert.deepEqual(C.sessionArgs({ sessionDefaults: { permissionMode: 'plan' } }), ['--permission-mode', 'plan']);
});
