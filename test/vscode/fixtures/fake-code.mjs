// A stand-in for `code serve-web`: reads the same flags, listens on the socket (refusing to run with a connection
// token, which the dashboard does not use) and answers with what it was sent, so a test can see what got through.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
if (args[0] !== 'serve-web') process.exit(2);
if (!args.includes('--without-connection-token')) process.exit(3);
const sock = flag('--socket-path');
const log = process.env.FAKE_CODE_LOG;
const note = (o) => log && fs.appendFileSync(log, JSON.stringify(o) + '\n');
note({ started: true, args, umask: process.umask(), env: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|HOPRIG_PROFILE$|HOPRIG_RUN_FILE$|CLAUDE_CODE_)/.test(k)) });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  note({ url: req.url, cookie: req.headers.cookie || '', host: req.headers.host, auth: req.headers.authorization || null, apiKey: req.headers['x-api-key'] || null, link: req.headers['x-hoprig-link'] || null });
  // A project file, typed by its extension and WITHOUT a sandbox of its own (as a VS Code version may serve it).
  if (u.pathname.endsWith('/vscode-remote-resource')) {
    const f = u.searchParams.get('path') || '';
    const type = { '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript' }[path.extname(f)] || 'application/octet-stream';
    try {
      const body = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    } catch {
      return res.writeHead(404).end();
    }
  }
  // Cookies VS Code might set, the dashboard's own login among them.
  if (u.pathname === '/vscode/cookies') return res.writeHead(200, { 'Set-Cookie': ['sid=evil; Path=/', 'SID=evil2; Path=/', ' sid =evil3; Path=/', 'vscode-other=1; Path=/'] }).end('ok');
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "script-src 'self' 'unsafe-eval'",
    'Set-Cookie': ['vscode-other=1; Path=/'],
  });
  res.end(`<p>workbench ${u.pathname} folder=${u.searchParams.get('folder') || ''}</p>`);
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  note({ upgrade: req.url, cookie: req.headers.cookie || '', origin: req.headers.origin || null });
  wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
});
fs.rmSync(sock, { force: true });
server.listen(sock, () => console.log(`Web UI available on ${sock}`));
process.on('SIGTERM', () => {
  note({ stopped: true });
  process.exit(0);
});
