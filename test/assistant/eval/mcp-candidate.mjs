#!/usr/bin/env node
// The eval's MCP server for a run with changed tool descriptions: Hoprig's own server (serveMcp) with those texts in
// its tool list, and everything else as `hoprig mcp` does it (the schemas, every call through the dashboard).
//   node test/assistant/eval/mcp-candidate.mjs <descriptions.json>     { "<tool>": "<description>" }
import fs from 'node:fs';
import { clientSettings, httpClient } from '../../../src/assistant/client.mjs';
import { serveMcp } from '../../../src/assistant/mcp.mjs';
import { mcpToolsJson } from '../../../src/assistant/tools.mjs';

const map = new Map(Object.entries(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
await serveMcp({ client: httpClient(clientSettings()), toolsJson: mcpToolsJson(map) });
