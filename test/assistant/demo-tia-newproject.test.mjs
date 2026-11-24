// The demo's Tia (src/demo/tia.mjs) answers her own example "Start a new project" with the card that opens the New
// project page, never with the session list. She runs here against a stand-in MCP server that only records calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TIA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'demo', 'tia.mjs');
const STANDIN = `import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const result = m.method === 'tools/list' ? { tools: [] } : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'done' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

async function ask(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tia-'));
  fs.writeFileSync(path.join(dir, 'standin.mjs'), STANDIN);
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { hoprig: { command: process.execPath, args: [path.join(dir, 'standin.mjs')], env: {} } } }));
  const child = spawn(process.execPath, [TIA, '--mcp-config', cfg, '--session-id', 'made-up'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const seen = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no result in 10 s')), 10_000);
      readline.createInterface({ input: child.stdout }).on('line', (l) => {
        const m = JSON.parse(l);
        seen.push(m);
        if (m.type === 'system') child.stdin.write(JSON.stringify({ message: { content: [{ type: 'text', text }] } }) + '\n');
        if (m.type === 'result') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    child.stdin.end();
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const parts = seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content);
  return { tools: parts.filter((p) => p.type === 'tool_use'), words: parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ') };
}

test('demo Tia: "Start a new project" gets the New project card, not the session list', async () => {
  const { tools, words } = await ask('Start a new project');
  assert.deepEqual(tools.map((t) => [t.name, t.input]), [['mcp__hoprig__open_screen', { screen: 'new-project' }]]);
  assert.doesNotMatch(words, /You have \d+ session/);
  assert.match(words, /Open New project/, 'names the card\'s button as the card labels it');
});
