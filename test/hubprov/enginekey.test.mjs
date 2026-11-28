// A hub row's session key ends with the process it was made for, also when it was made by the dashboard for a chat or for Tia:
// it works while that tool process runs and is refused after it ended. The tool is a stand-in process that waits for a file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { until } from './helpers.mjs';

const box = sandbox('hubprov-enginekey');
const { keyRow, mintKey } = await import('../../src/hubprov/localkeys.mjs');
const { claude } = await import('../../src/chat/engines/claude.mjs');
const { Engine } = await import('../../src/assistant/engine.mjs');

const go = path.join(box.root, 'go');
const script = path.join(box.root, 'tool.mjs');
fs.writeFileSync(script, `import fs from 'node:fs';\nconst t = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) process.exit(0); }, 50);\nprocess.stdin.resume();\n`);
const command = { command: process.execPath, args: [script] };
const rowEnv = () => {
  const key = mintKey({ row: 'mykey' }); // made in this process, as the dashboard makes it for a chat
  return { key, env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/hub/p/mykey', ANTHROPIC_AUTH_TOKEN: key } };
};
const finish = async () => {
  fs.writeFileSync(go, '1');
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(go, { force: true });
};

test('a chat: the key works while the chat\'s tool process runs and is refused when it has ended', async () => {
  const { key, env } = rowEnv();
  const seen = [];
  const session = claude.open({ cwd: box.root, env, profile: { name: 'x' }, sessionId: '11111111-1111-4111-8111-111111111111', mode: 'default', emit: (e) => seen.push(e), command, version: null, termMs: 100, killMs: 200 });
  assert.equal(keyRow(key), 'mykey', 'while it runs');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(keyRow(key), 'mykey', 'still, a moment later');
  await finish();
  await until('the key refused after the tool ended', () => keyRow(key) === null);
  session.close?.();
});

test('Tia: the key works while her tool process runs and is refused when it has ended', async () => {
  const { key, env } = rowEnv();
  const engine = new Engine({ profile: 'x', systemPrompt: 'x', url: 'http://127.0.0.1:1', tokenFile: path.join(box.root, 'tok'), conversation: 'enginekey', dir: path.join(box.root, 'tia'), resolveEnv: async () => env, command, mcpCommand: { command: process.execPath, args: ['-e', '0'] } });
  engine.send('hello', { timeoutMs: 200 }).catch(() => {});
  await until('her process started', () => !!engine.child);
  assert.equal(keyRow(key), 'mykey', 'while it runs');
  await finish();
  await until('the key refused after her process ended', () => keyRow(key) === null);
  engine.stop?.();
});
