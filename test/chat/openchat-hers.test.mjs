// openChat marks a chat hers when the call says `hers` or `byTia`, so the guard for a coding tool Hoprig cannot hold
// (Codex, OpenCode: no hook, so her administrator-rights level cannot hold a command there) asks the same value. A
// caller inside the dashboard that passes only byTia: true gets the same refusal below Full as one that passes hers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

test('a chat marked hers by byTia alone is refused on OpenCode below Full, as one marked by hers is', async (t) => {
  const box = sandbox('openchat-hers');
  const proj = path.join(box.root, 'proj', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  saveConfig({ codingTools: ['claude', 'opencode'], server: { roots: [path.dirname(proj)] } });
  // A stand-in for the installed OpenCode (never run: no message is sent), where Hoprig looks for its install.
  const { toolsDir } = await import('../../src/paths.mjs');
  const bin = path.join(toolsDir(), 'opencode', 'node_modules', '.bin', 'opencode');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  writeProfile('gw', { label: 'Gateway', api: ['messages', 'models'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-token-of-the-test' } });
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const { chatFeature } = await import('../../src/chat/feature.mjs');
  const f = chatFeature({ HttpError, config: () => loadConfig(), readJson: async () => ({}) }, { file: path.join(box.root, 'chats.json') });
  t.after(async () => {
    await f.close();
    box.cleanup();
  });
  for (const mark of [{ hers: true }, { byTia: true }]) {
    await assert.rejects(f.open({ dir: proj, tool: 'opencode', profile: 'gw', defaults: true, ...mark }), (e) => {
      assert.match(e.message, /only when her administrator-rights level is Full/, `the refusal names Full (${JSON.stringify(mark)})`);
      return true;
    }, `a chat marked hers by ${Object.keys(mark)[0]} is refused below Full`);
  }
  // His own chat on OpenCode is not refused for her level.
  const his = await f.open({ dir: proj, tool: 'opencode', profile: 'gw', defaults: true });
  assert.ok(his.id, 'his own OpenCode chat opens');
});
