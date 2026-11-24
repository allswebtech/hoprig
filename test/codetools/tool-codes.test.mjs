// The refusals about a coding tool or a provider send a code beside the error, so the page adds one button to the
// place the sentence names (web/errorways.js): Providers, or Settings → Coding tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-codes-'));
Object.assign(process.env, { HOPRIG_STATE_DIR: path.join(tmp, 'state'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg') });
delete process.env.HOPRIG_TOOLS_DIR;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const T = await import('../../src/codetools/index.mjs');
const { assertServes } = await import('../../src/profiles.mjs');
const { opencode } = await import('../../src/chat/engines/opencode.mjs');
const codeOf = (e) => e && e.details && e.details.code;

test('a provider that does not serve the coding tool: provider-not-served (Providers)', () => {
  assert.throws(() => assertServes({ name: 'max', label: 'Max', kind: 'login', env: {} }, 'opencode'),
    (e) => e.status === 400 && codeOf(e) === 'provider-not-served' && /Claude subscription is for Claude Code only/.test(e.message));
});

test('Codex sign-in while Codex is not installed: tool-not-installed (Coding tools)', async () => {
  const { codetoolsFeature } = await import('../../src/codetools/feature.mjs');
  class HttpError extends Error { constructor(status, m) { super(m); this.status = status; } }
  const ctx = { config: () => ({}), saveConfig: () => {}, readJson: async (req) => req.body, HttpError, deck: { runLauncher: async () => assert.fail('nothing starts') } };
  const f = codetoolsFeature(ctx, { profiles: () => [], signedIn: async () => false, find: T.anyTool });
  const route = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/codetools/codex/signin'))[2];
  const { codex } = await import('../../src/codetools/codex.mjs');
  const was = codex.installedVersion;
  codex.installedVersion = () => null;
  try {
    await assert.rejects(route({ body: {} }), (e) => e.status === 409 && codeOf(e) === 'tool-not-installed');
  } finally {
    codex.installedVersion = was;
  }
});

test('an OpenCode chat while OpenCode is off: tool-off; its server did not start: tool-not-started (Coding tools)', async () => {
  await assert.rejects(opencode.history('/tmp', { enabled: () => false }), (e) => e.status === 409 && codeOf(e) === 'tool-off' && e.message === 'OpenCode is off on this computer: turn it on under Settings → Coding tools to go on with this chat.');
  const ensure = async () => ({ ok: false, code: 'tool-not-started', why: 'OpenCode\'s server did not start. Check under Settings → Coding tools that it is installed and up to date' });
  await assert.rejects(opencode.history('/tmp', { enabled: () => true, ensure }), (e) => e.status === 409 && codeOf(e) === 'tool-not-started');
  // ensureServer's own answer when the server never answered carries that code (read from its source: starting a real
  // server process is not done in a test).
  const src = fs.readFileSync(new URL('../../src/codetools/servers.mjs', import.meta.url), 'utf8');
  assert.match(src, /return \{ ok: false, code: 'tool-not-started', why: `\$\{DESCRIPTOR\[tool\]\.name\}'s server did not start\. Check under Settings → Coding tools/);
});
