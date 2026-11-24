// The lead's part tool waits longer for the dashboard's answer than the dashboard holds a "result" call for the
// owner's card: otherwise the tool gives up first and the lead reads "the dashboard does not answer" instead of the
// owner's answer (seen with the real Claude Code). Through a real dashboard and the tool's own client.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('partcall');
test.after(() => box.cleanup());
const { ASK_WAIT_MS } = await import('../../src/models/partdoor.mjs');
const { CALL_LIMIT_MS, partClient } = await import('../../src/models/partmcp.mjs');

test('the tool\'s own limit is longer than the dashboard\'s hold of a result call, with room to spare', () => {
  assert.ok(CALL_LIMIT_MS >= ASK_WAIT_MS + 10_000, `${CALL_LIMIT_MS} ms against a hold of ${ASK_WAIT_MS} ms`);
});

test('a call the dashboard holds is answered, not given up: the client waits past the hold', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const hold = 400;
  const srv = http.createServer((req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'Part p_1 on paid: the owner said no: do the part yourself and say so.' })), hold));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const tokenFile = path.join(box.root, 'part.token');
    fs.writeFileSync(tokenFile, 'hpt_test\n');
    const env = { HOPRIG_DASHBOARD_URL: `http://127.0.0.1:${srv.address().port}`, HOPRIG_PART_TOKEN_FILE: tokenFile };
    // The default relation, scaled down: a limit as long as the hold gives up; one past it gets the answer.
    const same = await partClient(env, fetch, { limitMs: hold }).call('hand_part', { action: 'result', part: 'p_1' });
    assert.match(same.text, /does not answer/);
    const longer = await partClient(env, fetch, { limitMs: Math.round(hold * CALL_LIMIT_MS / ASK_WAIT_MS) }).call('hand_part', { action: 'result', part: 'p_1' });
    assert.equal(longer.isError, false, longer.text);
    assert.match(longer.text, /owner said no/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
