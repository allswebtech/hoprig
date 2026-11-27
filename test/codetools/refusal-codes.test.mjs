// A coding tool that is off, or on but not installed, is refused with the code of the place its sentence names
// (web/errorways.js): the page draws the button to Coding tools or to Updates from it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-toolcodes-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_PROFILES_DIR = path.join(tmp, 'profiles');
process.env.HOPRIG_TOOLS_DIR = path.join(tmp, 'tools');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { assertToolReady } = await import('../../src/codetools/start.mjs');
const { WAYS } = await import('../../web/errorways.js');

test('OpenCode off: a 400 with the code tool-off; on but not installed: a 409 with the code tool-install', () => {
  assert.throws(() => assertToolReady('opencode', { codingTools: ['claude'] }), (e) => e.status === 400 && /OpenCode is off on this computer/.test(e.message) && e.details && e.details.code === 'tool-off');
  assert.throws(() => assertToolReady('opencode', { codingTools: ['claude', 'opencode'] }), (e) => e.status === 409 && /OpenCode is not installed/.test(e.message) && e.details && e.details.code === 'tool-install');
  assert.ok(WAYS['tool-off'] && WAYS['tool-install'], 'both codes are in the table');
  // Both sentences name Settings → New sessions → Coding tools (its Install button installs a tool), and both buttons open it.
  assert.equal(WAYS['tool-install'].href, '#/settings/new-sessions?show=coding-tools', 'the sentence says Settings → New sessions → Coding tools');
  assert.equal(WAYS['tool-off'].href, '#/settings/new-sessions?show=coding-tools');
  assert.throws(() => assertToolReady('opencode', { codingTools: ['claude'] }), (e) => /Turn it on in Settings → New sessions → Coding tools\.$/.test(e.message) && !/Updates/.test(e.message));
  assert.throws(() => assertToolReady('opencode', { codingTools: ['claude', 'opencode'] }), (e) => /Install it in Settings → New sessions → Coding tools\.$/.test(e.message));
});
