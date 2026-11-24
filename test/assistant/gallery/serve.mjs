#!/usr/bin/env node
// For tests and screenshots only (not in the package, not in the menu): serves web/ and this folder's gallery page,
// which draws every kind of Tia's cards in every state from fixtures (web/tiacards.js, web/tiamsg.js).
//   node test/assistant/gallery/serve.mjs <port>     then open http://127.0.0.1:<port>/gallery/
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../../web');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };
const port = Number(process.argv[2]) || 0;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [root, rel] = p.startsWith('/gallery/') ? [HERE, p.slice(9) || 'gallery.html'] : [WEB, p.slice(1)];
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`gallery on http://127.0.0.1:${server.address().port}/gallery/`));
