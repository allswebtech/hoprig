// The tool array a model gets: the ten tools of the closed list for her one role (the owner's), the same bytes on every turn, and
// pinned by its hash. A new act is an action of a tool she has (or of a domain loaded when asked), never a 26th tool;
// a change to a description or a schema changes the hash and must change it here too, on purpose.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleMessage } from '../../src/assistant/mcp.mjs';
import { EAGER_TOOLS, MCP_TOOLS_JSON } from '../../src/assistant/tools.mjs';

// Her roles and their tool arrays: Hoprig has one owner, one door, one role.
const ROLES = { owner: { count: 10, sha256: '5f05b1f853e82bdb749b4f0281bbf3fff2dc2c4dfae8230d7cf1ee2bae194fef' } };

test('the owner\'s role gets the ten tools of the closed list, the same bytes over three turns, with the pinned hash', async () => {
  const client = { call: async () => ({ text: '', isError: false }) };
  const turns = [];
  for (let i = 0; i < 3; i++) turns.push(JSON.stringify((await handleMessage({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }, client)).result.tools));
  assert.equal(new Set(turns).size, 1, 'tools/list changed between turns');
  assert.equal(turns[0], MCP_TOOLS_JSON);
  assert.equal(EAGER_TOOLS.length, ROLES.owner.count);
  const hash = crypto.createHash('sha256').update(MCP_TOOLS_JSON).digest('hex');
  assert.equal(hash, ROLES.owner.sha256, `the tool array changed (${MCP_TOOLS_JSON.length} bytes, sha256 ${hash}): if on purpose, put its new hash here`);
});
