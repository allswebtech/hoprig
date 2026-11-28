// The byte limits of the design are tests: the tool array a model gets at most 16,000 bytes, her system text at most
// 5,500 bytes, and the array is the ten tools of her closed list, in order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_PROMPT } from '../../src/assistant/prompt.mjs';
import { MCP_TOOLS, MCP_TOOLS_JSON } from '../../src/assistant/tools.mjs';

const ARRAY_BYTES = Buffer.byteLength(MCP_TOOLS_JSON);
const PROMPT_BYTES = Buffer.byteLength(BASE_PROMPT);

test('the tool array and her system text stay under the design limits', () => {
  console.log(`BYTES tool array ${ARRAY_BYTES} (${MCP_TOOLS.length} tools), system text ${PROMPT_BYTES}`);
  assert.ok(ARRAY_BYTES <= 16_000, `the tool array is ${ARRAY_BYTES} bytes, the limit is 16000`);
  assert.ok(PROMPT_BYTES <= 5_500, `her system text is ${PROMPT_BYTES} bytes, the limit is 5500`);
});

test('the array is the ten tools of the closed list, in order', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name), ['look', 'find_acts', 'do_act', 'plan_acts', 'start_work', 'steer_work', 'watch_work', 'notify_owner', 'open_screen', 'run_command']);
});
