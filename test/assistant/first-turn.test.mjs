// The size of her first request. A real model measured 10.8 thousand input tokens for her first request against the design
// target of 6.2 thousand. The parts of that request (measured by a capture against a stand-in, bytes): the tool array, her
// system text with the procedures index, the dashboard's server note, Claude Code's own wrapper. These tests hold what was cut.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { MCP_TOOLS, MCP_TOOLS_JSON } from '../../src/assistant/tools.mjs';
import { serveMcp } from '../../src/assistant/mcp.mjs';
import { Skills } from '../../src/assistant/skills.mjs';

const BUILTIN = fileURL('../../skills');
function fileURL(p) {
  return new URL(p, import.meta.url).pathname;
}

test('the procedures index of her first turn is short: a name and one clause each', () => {
  const index = new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }).index();
  assert.ok(fs.existsSync(BUILTIN));
  assert.ok(Buffer.byteLength(index) <= 700, `the index is ${Buffer.byteLength(index)} bytes`);
  for (const line of index.split('\n')) assert.match(line, /^- [a-z-]+: /);
});

test('her own engine gets no server note (her system text says it already); another client still does', async () => {
  const ask = async (own) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const done = serveMcp({ input, output, client: { call: async () => ({ text: '', isError: false }) }, own });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    const line = await new Promise((resolve) => output.once('data', (d) => resolve(String(d))));
    input.end();
    await done;
    return JSON.parse(line).result;
  };
  assert.equal((await ask(true)).instructions, undefined);
  assert.match((await ask(false)).instructions, /untrusted/);
});

test('the model-facing schema carries no pattern for an id it copies from a result', () => {
  for (const t of MCP_TOOLS) {
    for (const k of ['computer', 'target', 'folder', 'provider', 'job', 'conversation', 'session']) {
      const p = t.inputSchema.properties[k];
      if (p) assert.equal(p.pattern, undefined, `${t.name}.${k} shows a pattern`);
    }
  }
});

test('the tool array is under its ratcheted size', () => {
  assert.ok(Buffer.byteLength(MCP_TOOLS_JSON) <= 13_400, `the tool array is ${Buffer.byteLength(MCP_TOOLS_JSON)} bytes`);
});
