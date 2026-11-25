#!/usr/bin/env node
// The tool server of a mission's session (boxtool.mjs): started by the coding tool for that one session, from the
// inline tool-server list in the session's own start arguments (never a file in the worktree, never .mcp.json), with
// the Node that runs Hoprig. It is a RELAY and nothing more: it offers the tools of the session's role (run_tests, and
// run_build and run_script where its list has them), checks only the sizes and types of what the session sends, and
// sends it as JSON strings to this dashboard's own route with the token of
// this one session. It never touches the disk with them, starts no program and evaluates nothing: every check of a
// path, and the run itself, is the dashboard's. Its two settings come from its environment, set in that same list:
//   HOPRIG_TOOL_URL    this dashboard's own address (where it really listens)
//   HOPRIG_TOOL_TOKEN  the token of this one session and this one act
// One JSON-RPC message per line on stdin and stdout (the tool protocol's stdio transport); nothing else on stdout.
const URL_ = process.env.HOPRIG_TOOL_URL || '';
const TOKEN = process.env.HOPRIG_TOOL_TOKEN || '';
//   HOPRIG_TOOL_KINDS  what the session's role may run, from the closed set tests, build, scripts (left out: the tests)
// Each kind is one tool with one route of the dashboard; a name outside the closed set offers nothing.
const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 64 * 1024;
const PATHS_MAX = 20;
const PATH_CHARS = 400;
const NAME_CHARS = 50;
// One run may take ten minutes in the box; the answer is waited for a little longer than that.
const CALL_MS = 11 * 60_000;
const ALL = Object.freeze({
  tests: {
    route: '/api/mission-tool/run-tests', field: 'paths',
    tool: {
      name: 'run_tests',
      description: 'Run this project\'s own test command in a box (no network, only this folder) and read its last lines. Give "paths" (files or folders inside this folder) to run only those; leave it out to run them all. It runs nothing else.',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', maxItems: PATHS_MAX, items: { type: 'string', maxLength: PATH_CHARS }, description: 'test files or folders inside this folder, from its top' } },
        additionalProperties: false,
      },
    },
  },
  build: {
    route: '/api/mission-tool/run-build', field: null,
    tool: {
      name: 'run_build',
      description: 'Run this project\'s own build command (the owner set it) in a box (no network, only this folder) and read its last lines. It takes nothing and runs nothing else.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  scripts: {
    route: '/api/mission-tool/run-script', field: 'name',
    tool: {
      name: 'run_script',
      description: 'Run one script of this project\'s package.json by its name (as npm run <name>) in a box (no network, only this folder) and read its last lines. Hoprig reads the script first; one that is the owner\'s (a deploy, a release, an administrator command) is not run.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', maxLength: NAME_CHARS, description: 'the script\'s name, as package.json names it' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
});
const asked = String(process.env.HOPRIG_TOOL_KINDS ?? 'tests').split(',').map((x) => x.trim());
const KINDS = Object.keys(ALL).filter((k) => asked.includes(k));
const TOOLS_JSON = JSON.stringify(KINDS.map((k) => ALL[k].tool));

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const answer = (id, text, isError) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text).slice(0, 8000) }], isError: !!isError } });

/** The body for the dashboard from what the session sent, sizes and types only. → { body } or { why } */
function bodyOf(kind, args) {
  if (args === undefined) args = {};
  const only = (k) => args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every((x) => x === k);
  if (kind === 'build') return only(null) ? { body: {} } : { why: 'Refused: the tool takes nothing; nothing ran.' };
  if (kind === 'scripts') {
    if (!only('name') || typeof args.name !== 'string' || !args.name || args.name.length > NAME_CHARS) return { why: `Refused: the tool takes only "name", a script's name of at most ${NAME_CHARS} characters; nothing ran.` };
    return { body: { name: args.name } };
  }
  if (!only('paths')) return { why: 'Refused: the tool takes only "paths", a list of paths inside this folder; nothing ran.' };
  const paths = args.paths === undefined ? [] : args.paths;
  if (!Array.isArray(paths) || paths.length > PATHS_MAX || !paths.every((p) => typeof p === 'string' && p.length > 0 && p.length <= PATH_CHARS)) return { why: `Refused: "paths" is a list of at most ${PATHS_MAX} paths of at most ${PATH_CHARS} characters; nothing ran.` };
  return { body: { paths: [...paths] } };
}

async function call(id, kind, args) {
  const b0 = bodyOf(kind, args);
  if (b0.why) return answer(id, b0.why, true);
  if (!/^http:\/\/[^/\s]+$/.test(URL_) || !TOKEN) return answer(id, 'Nothing ran: this tool was not given its dashboard. Go on without it; the tests run after you end.', true);
  try {
    const r = await fetch(`${URL_}${ALL[kind].route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(b0.body), signal: AbortSignal.timeout(CALL_MS) });
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
    const kind = KINDS.find((k) => ALL[k].tool.name === params.name);
    if (!kind) return error(m.id, -32602, 'unknown tool');
    return call(m.id, kind, params.arguments);
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
