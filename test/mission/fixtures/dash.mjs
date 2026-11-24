#!/usr/bin/env node
// A dashboard of its own process for the mission tests (createServer, the real box): the test that starts it gives it
// the settings, state and workspace folders of its own temporary home through the environment, ends it by the pid it
// kept, and reads the port it listens on from the first line this prints.
// Never without a workspace of its own: a dashboard maps its workspace a second after it starts.
if (!process.env.HOPRIG_WORKSPACE_DIR || !process.env.HOPRIG_STATE_DIR || !process.env.HOPRIG_CONFIG_DIR) {
  process.stderr.write('dash.mjs: HOPRIG_WORKSPACE_DIR, HOPRIG_STATE_DIR and HOPRIG_CONFIG_DIR must name the test\'s own folders\n');
  process.exit(2);
}
const { createServer } = await import('../../../src/server/server.mjs');
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
const { port } = await app.listen(0, '127.0.0.1');
process.stdout.write(`${JSON.stringify({ port, pid: process.pid })}\n`);
process.on('SIGTERM', () => app.close().finally(() => process.exit(0)));
