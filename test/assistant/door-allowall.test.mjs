// Tia's door and "Allow everything" (src/assistant/door.mjs): she can neither accept it, nor turn the switch it hangs on,
// nor start anything in it. A start of hers carries no permission mode at all, and she may carry a default of it along
// unchanged but never change it to it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('door-all');
test.after(() => box.cleanup());
const { checkRoute } = await import('../../src/assistant/door.mjs');

const ctx = (sessionDefaults = {}) => ({ config: () => ({ sessionDefaults }) });
const refused = (method, url, body, c = ctx()) => assert.throws(() => checkRoute(method, url, body, c), (e) => e.status === 403, `${method} ${url}`);

test('the switch and the acknowledgement are the owner\'s own steps', () => {
  refused('POST', '/api/settings/bypass', { allow: true, confirm: true });
  refused('POST', '/api/settings/bypass/everything', { confirm: true });
  refused('GET', '/api/settings/bypass');
  refused('POST', '/m/laptop/api/settings/bypass/everything', { confirm: true });
});

test('a start of hers names no permission mode, so it cannot name this one', () => {
  refused('POST', '/api/chats', { dir: '/x', defaults: true, permissionMode: 'allowEverything' });
  refused('POST', '/api/chats', { dir: '/x', permissionMode: 'allowEverything' });
  assert.ok(checkRoute('POST', '/api/chats', { dir: '/x', defaults: true }, ctx()), 'a plain start of hers is fine (it takes Bypass where the default is this mode)');
  refused('POST', '/api/chats/11111111-1111-4111-8111-111111111111/mode', { mode: 'allowEverything' });
  refused('POST', '/api/chats/11111111-1111-4111-8111-111111111111/answer', { request: 'r', allow: true, mode: 'allowEverything' });
});

test('change_setting carries a default of it along unchanged, and never changes it', () => {
  const cur = ctx({ permissionMode: 'allowEverything' });
  assert.ok(checkRoute('POST', '/api/settings', { sessionDefaults: { permissionMode: 'allowEverything' } }, cur));
  refused('POST', '/api/settings', { sessionDefaults: { permissionMode: 'manual' } }, cur);
  refused('POST', '/api/settings', { sessionDefaults: { permissionMode: 'allowEverything' } }, ctx({ permissionMode: 'manual' }));
  refused('POST', '/api/settings', { sessionDefaults: { permissionMode: 'allowEverything' } }, ctx({}));
});
