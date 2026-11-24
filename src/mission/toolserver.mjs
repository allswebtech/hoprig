#!/usr/bin/env node
// The tool server of a mission's session (boxtool.mjs): started by the coding tool for that one session, from the
// inline tool-server list in the session's own start arguments (never a file in the worktree, never .mcp.json), with
// the Node that runs Hoprig. It is a RELAY and nothing more: it offers one tool, run_tests, checks only the sizes and
// types of what the session sends, and sends the paths as JSON strings to this dashboard's own route with the token of
// this one session. It never touches the disk with them, starts no program and evaluates nothing: every check of a
// path, and the run itself, is the dashboard's. Its two settings come from its environment, set in that same list:
//   HOPRIG_TOOL_URL    this dashboard's own address (where it really listens)
//   HOPRIG_TOOL_TOKEN  the token of this one session and this one act
// One JSON-RPC message per line on stdin and stdout (the tool protocol's stdio transport); nothing else on stdout.
const URL_ = process.env.HOPRIG_TOOL_URL || '';
const TOKEN = process.env.HOPRIG_TOOL_TOKEN || '';
const ROUTE = '/api/mission-tool/run-tests';
const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 64 * 1024;
const PATHS_MAX = 20;
const PATH_CHARS = 400;
// One run may take ten minutes in the box; the answer is waited for a little longer than that.
const CALL_MS = 11 * 60_000;
const TOOL = Object.freeze({
  name: 'run_tests',
  description: 'Run this project\'s own test command in a box (no network, only this folder) and read its last lines. Give "paths" (files or folders inside this folder) to run only those; leave it out to run them all. It runs nothing else.',
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array', maxItems: PATHS_MAX, items: { type: 'string', maxLength: PATH_CHARS }, description: 'test files or folders inside this folder, from its top' } },
    additionalProperties: false,
  },
});
const TOOLS_JSON = JSON.stringify([TOOL]);

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const answer = (id, text, isError) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text).slice(0, 8000) }], isError: !!isError } });

async function call(id, args) {
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((k) => k !== 'paths')) return answer(id, 'Refused: the tool takes only "paths", a list of paths inside this folder; nothing ran.', true);
  const paths = args.paths === undefined ? [] : args.paths;
  if (!Array.isArray(paths) || paths.length > PATHS_MAX || !paths.every((p) => typeof p === 'string' && p.length > 0 && p.length <= PATH_CHARS)) return answer(id, `Refused: "paths" is a list of at most ${PATHS_MAX} paths of at most ${PATH_CHARS} characters; nothing ran.`, true);
  if (!/^http:\/\/[^/\s]+$/.test(URL_) || !TOKEN) return answer(id, 'Nothing ran: this tool was not given its dashboard. Go on without it; the tests run after you end.', true);
  try {
    const r = await fetch(`${URL_}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ paths: [...paths] }), signal: AbortSignal.timeout(CALL_MS) });
    const b = await r.json().catch(() => ({}));
    if (r.ok && b && typeof b.text === 'string') return answer(id, b.text, b.isError);
    return answer(id, `Nothing ran: the dashboard refused (${typeof b.error === 'string' ? b.error.slice(0, 200) : r.status}). Go on without the tool; the tests run after you end.`, true);
  } catch {
    return answer(id, 'Nothing ran: the dashboard did not answer. Go on without the tool; the tests run after you end.', true);
  }
}

function onLine(line) {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return error(null, -32700, 'parse error');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return error(m && m.id, -32600, 'invalid request');
  if (!('id' in m)) return; // a notification: nothing to answer
  const params = m.params && typeof m.params === 'object' ? m.params : {};
  if (m.method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'hoprig', version: '1' } } });
  }
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: JSON.parse(TOOLS_JSON) } });
  if (m.method === 'tools/call') {
    if (params.name !== TOOL.name) return error(m.id, -32602, 'unknown tool');
    return call(m.id, params.arguments);
  }
  return error(m.id, -32601, 'method not found');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (buf.length > MAX_LINE && !buf.includes('\n')) {
    buf = '';
    return error(null, -32700, 'message too large');
  }
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.length > MAX_LINE) error(null, -32700, 'message too large');
    else onLine(line);
  }
});
