// Drives the real `hoprig mcp` over stdio, against the fake dashboard (the real core behind the same HTTP route
// the dashboard will serve).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NO_ADDRESS, httpClient } from '../../src/assistant/client.mjs';
import { PROTOCOL_VERSIONS, handleMessage } from '../../src/assistant/mcp.mjs';
import { MCP_TOOLS_JSON } from '../../src/assistant/tools.mjs';
import { startFakeDashboard } from './fake-dashboard.mjs';

const BIN = fileURLToPath(new URL('../../bin/hoprig.mjs', import.meta.url));

function mcpProcess(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-mcp-'));
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: { ...process.env, HOPRIG_CONFIG_DIR: path.join(tmp, 'c'), HOPRIG_STATE_DIR: path.join(tmp, 's'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const raw = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      raw.push(line);
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w({ msg, line });
      }
    }
  });
  let n = 0;
  return {
    raw,
    send: (method, params, id = ++n) =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
      }),
    notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    sendRaw: (text, id) =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(text + '\n');
      }),
    // After a failed assertion: the process is ended, so the run does not wait for it.
    end: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(tmp, { recursive: true, force: true });
    },
    close: () =>
      new Promise((resolve) => {
        child.on('exit', (code) => {
          fs.rmSync(tmp, { recursive: true, force: true });
          resolve(code);
        });
        child.stdin.end();
      }),
  };
}

test('MCP over stdio: initialize, byte-stable tools/list, calls, validation errors, L2 staging', async (t) => {
  const dash = await startFakeDashboard();
  const mcp = mcpProcess({ HOPRIG_DASHBOARD_URL: dash.url, HOPRIG_ASSISTANT_TOKEN: dash.token, HOPRIG_ASSISTANT_CONVERSATION: 'conv-1' });
  t.after(() => { mcp.end(); return dash.close(); });

  const init = (await mcp.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).msg;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'hoprig');
  mcp.notify('notifications/initialized');

  const l1 = await mcp.send('tools/list', {});
  const l2 = await mcp.send('tools/list', {});
  const bytes = (line) => line.replace(/"id":\d+/, '"id":0');
  assert.equal(bytes(l1.line), bytes(l2.line), 'tools/list is byte-identical across calls');
  assert.ok(l1.msg.result.tools.length <= 25);
  assert.equal(JSON.stringify(l1.msg.result.tools), MCP_TOOLS_JSON);
  for (const tool of l1.msg.result.tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);

  const list = (await mcp.send('tools/call', { name: 'list_sessions', arguments: {} })).msg.result;
  assert.equal(list.isError, false);
  assert.match(list.content[0].text, /^3 session\(s\) on all computers/);
  assert.match(list.content[0].text, /<untrusted_data tool="list_sessions">/);

  // A program outside that still calls the old name gets the providers, and is told the new name.
  assert.ok(!l1.msg.result.tools.some((t) => t.name === 'get_accounts'));
  const old = (await mcp.send('tools/call', { name: 'get_accounts', arguments: {} })).msg.result;
  assert.equal(old.isError, false, old.content[0].text);
  assert.match(old.content[0].text, /get_accounts is an old name: call get_computer_status \{"providers":true\}/);

  const bad = (await mcp.send('tools/call', { name: 'read_session', arguments: { session: 'api-fix', extra: 1 } })).msg.result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unknown field "extra"/);

  const notShown = (await mcp.send('tools/call', { name: 'read_session', arguments: { session: 'never-listed' } })).msg.result;
  assert.match(notShown.content[0].text, /was not shown/);

  const staged = (await mcp.send('tools/call', { name: 'stop_session', arguments: { session: 'api-fix' } })).msg.result;
  assert.equal(staged.isError, false);
  assert.match(staged.content[0].text, /Waiting for the owner's OK \(card c_/);
  assert.equal(dash.ops.calls.length, 0, 'nothing was stopped');
  assert.equal(dash.core.cards.pending()[0].conversation, 'conv-1', 'the conversation header reached the core');

  assert.equal((await mcp.send('tools/call', { name: 'nope', arguments: {} })).msg.error.code, -32602);
  assert.equal((await mcp.send('resources/list', {})).msg.error.code, -32601);
  assert.deepEqual((await mcp.send('ping')).msg.result, {});
  const parse = await mcp.sendRaw('{not json', null);
  assert.equal(parse.msg.error.code, -32700);
  assert.equal(await mcp.close(), 0);
  for (const line of mcp.raw) assert.doesNotThrow(() => JSON.parse(line), 'stdout carries only JSON-RPC lines');
});

test('initialize: an unknown protocol version gets our newest', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, {});
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}), null);
  assert.equal((await handleMessage({ id: 1, method: 'x' }, {})).error.code, -32600);
});

test('httpClient: no token, wrong token and an unreachable dashboard are plain errors with a next step', async (t) => {
  const dash = await startFakeDashboard();
  t.after(() => dash.close());
  assert.match((await httpClient({ url: dash.url, token: '' }).call('list_sessions', {})).text, /no token.*Next:/);
  assert.match((await httpClient({ url: dash.url, token: 'wrong' }).call('list_sessions', {})).text, /refused the assistant token/);
  const down = await httpClient({ url: 'http://127.0.0.1:9', token: 'x', timeoutMs: 2000 }).call('list_sessions', {});
  assert.equal(down.isError, true);
  assert.match(down.text, /not reachable.*hoprig serve/);
  assert.equal((await httpClient({ url: dash.url, token: dash.token }).call('list_sessions', {})).isError, false);
});

test('without its dashboard\'s address the MCP server answers every call with one plain error and connects nowhere', async (t) => {
  // A server on the port the config names, counting every connection: the old code fell back to that port (and else
  // to the default one), where another dashboard than its own may listen.
  let connections = 0;
  const srv = http.createServer((req, res) => res.end('{}'));
  srv.on('connection', () => connections++);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-mcp-noaddr-'));
  fs.mkdirSync(path.join(home, 'c'), { recursive: true });
  fs.writeFileSync(path.join(home, 'c', 'config.json'), JSON.stringify({ server: { port } }));
  const env = { ...process.env, HOPRIG_ASSISTANT_TOKEN: 'tia_' + 'x'.repeat(40), HOPRIG_CONFIG_DIR: path.join(home, 'c'), HOPRIG_DASHBOARD_URL: '' };
  const mcp = mcpProcess(env);
  t.after(() => { mcp.end(); srv.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await mcp.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  mcp.notify('notifications/initialized');
  for (const name of ['list_sessions', 'read_attention']) {
    const r = (await mcp.send('tools/call', { name, arguments: {} })).msg.result;
    assert.equal(r.isError, true, name);
    assert.equal(r.content[0].text, NO_ADDRESS, name);
  }
  assert.equal(connections, 0, 'no connection to the config\'s port');
  // The client itself: no address, no request at all.
  let asked = 0;
  const c = httpClient({ url: '', token: 'tia_x', fetchImpl: async () => { asked++; return new Response('{}'); } });
  assert.deepEqual(await c.call('list_sessions', {}), { isError: true, text: NO_ADDRESS });
  assert.equal(asked, 0);
});
