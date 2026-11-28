// The tool array a model gets: at most 24 tools for her one role (the owner's), the same bytes on every turn, and
// pinned by its hash. A new act is an action of a tool she has (or of a domain loaded when asked), never a 26th tool;
// a change to a description or a schema changes the hash and must change it here too, on purpose.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleMessage } from '../../src/assistant/mcp.mjs';
import { MCP_TOOLS_JSON, TOOLS } from '../../src/assistant/tools.mjs';

// Her roles and their tool arrays: Hoprig has one owner, one door, one role.
const ROLES = { owner: { count: 24, sha256: 'a019e8113ad43cbc57e55ec4a0c136afb374ef64e9f172a27bf9d9c098fb76bc' } };

test('the owner\'s role gets at most 24 tools, the same bytes over three turns, with the pinned hash', async () => {
  const client = { call: async () => ({ text: '', isError: false }) };
  const turns = [];
  for (let i = 0; i < 3; i++) turns.push(JSON.stringify((await handleMessage({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }, client)).result.tools));
  assert.equal(new Set(turns).size, 1, 'tools/list changed between turns');
  assert.equal(turns[0], MCP_TOOLS_JSON);
  assert.ok(TOOLS.length <= 24, String(TOOLS.length));
  assert.equal(TOOLS.length, ROLES.owner.count);
  const hash = crypto.createHash('sha256').update(MCP_TOOLS_JSON).digest('hex');
  assert.equal(hash, ROLES.owner.sha256, `the tool array changed (${MCP_TOOLS_JSON.length} bytes, sha256 ${hash}): if on purpose, put its new hash here`);
});
