// A dashboard (on the home the test's environment names) that opens an App session, then deletes it (op "delete")
// or deletes it and puts it back (op "restore"), and kills itself (SIGKILL) at step `at` of that last operation.
// Prints {"id": <the session>} first. argv: op, at, project folder, fake-claude, fake-session.
import http from 'node:http';
// Only on the test's own home (sandbox()): without its own HOPRIG_WORKSPACE_DIR a dashboard rewrites the real workspace.
if (!process.env.HOPRIG_WORKSPACE_DIR || !process.env.HOPRIG_STATE_DIR) throw new Error('run me with the test sandbox\'s environment');
const [op, at, proj, fakeClaude] = process.argv.slice(2);
let armed = op === 'delete';
const { createServer } = await import('../../../src/server/server.mjs');
const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [fakeClaude] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000, trashStep: (s) => armed && s === at && process.kill(process.pid, 'SIGKILL') } });
const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
const call = (method, p, body, cookie) => new Promise((resolve, reject) => {
  const req = http.request(new URL(p, base), { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let t = '';
    res.on('data', (c) => (t += c));
    res.on('end', () => resolve({ headers: res.headers, json: t ? JSON.parse(t) : null }));
  });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});
const cookie = (await call('POST', '/api/login', { password: 'pw-for-tests' })).headers['set-cookie'][0].split(';')[0];
const id = (await call('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'fix the cart' }, cookie)).json.id;
for (;;) {
  const v = (await call('GET', `/api/chats/${id}`, undefined, cookie)).json;
  if (v.status === 'waiting' && v.events.some((e) => e.kind === 'turn-end')) break;
  await new Promise((r) => setTimeout(r, 50));
}
process.stdout.write(`${JSON.stringify({ id })}\n`);
const r = await call('POST', '/api/chats/delete', { chats: [id] }, cookie);
if (op === 'restore') {
  armed = true;
  await call('POST', `/api/chats/trash/${r.json.deleted[0].trash}/restore`, {}, cookie);
}
process.exit(0);
