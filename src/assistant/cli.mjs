// Commands of the assistant, dispatched by bin/hoprig.mjs.
//
//   hoprig mcp            hoprig's tools as an MCP server on stdin/stdout. The dashboard address and token
//                            come from HOPRIG_DASHBOARD_URL / HOPRIG_ASSISTANT_TOKEN, else from the config
//                            and <stateDir>/assistant-token. Add it to Claude Code with:
//                              claude mcp add hoprig -- hoprig mcp
import { clientSettings, httpClient } from './client.mjs';
import { serveMcp } from './mcp.mjs';

export const USAGE = 'usage: hoprig mcp     (an MCP server on stdio; started by an MCP client, not by hand)';

export async function main(command, args = []) {
  if (command !== 'mcp' || args.includes('-h') || args.includes('--help')) {
    console.error(USAGE);
    return command === 'mcp' ? 0 : 2;
  }
  if (args.length === 1 && args[0] === '--parts') {
    // A Lead session's one tool (src/models/partmcp.mjs), started by Claude Code from that session's --mcp-config.
    const { PART_CATALOG, partClient } = await import('../models/partmcp.mjs');
    await serveMcp({ client: partClient(), catalog: PART_CATALOG });
    return 0;
  }
  if (args.length) {
    console.error(`hoprig mcp takes no arguments.\n${USAGE}`);
    return 2;
  }
  // The dashboard's own Tia (her engine's config says so): the tool descriptions the owner accepted, where they apply.
  const toolsJson = process.env.HOPRIG_ASSISTANT_ACCEPTED === '1' ? (await import('./accepted.mjs')).tiaToolsJson() : null;
  await serveMcp({ client: httpClient(clientSettings()), toolsJson, own: process.env.HOPRIG_ASSISTANT_ACCEPTED === '1' });
  return 0;
}
