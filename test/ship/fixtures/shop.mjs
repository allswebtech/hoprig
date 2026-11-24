// The made-up project "shop" of the go-live tests: a tiny web server on a loopback port that answers 500 when its tree
// holds broken.txt, and a deploy script that checks out a commit and restarts the server (its pid in run/server.pid).
// SHOP_SLOW=<seconds>: the deploy waits that long after the restart (a slow update, to be cut off).
export const SERVER = `import http from 'node:http';
import fs from 'node:fs';
const broken = fs.existsSync('broken.txt');
http.createServer((q, s) => { s.writeHead(broken ? 500 : 200); s.end(broken ? 'broken' : 'ok'); }).listen(Number(fs.readFileSync('port.txt', 'utf8')), '127.0.0.1');
`;

export const DEPLOY = `import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
fs.mkdirSync('run', { recursive: true });
fs.writeFileSync('run/deploy.pid', String(process.pid));
execFileSync('git', ['checkout', '-q', '--detach', process.argv[2]]);
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
let old = 0;
try { old = Number(fs.readFileSync('run/server.pid', 'utf8')); process.kill(old, 'SIGTERM'); } catch {}
for (let i = 0; old && alive(old) && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
const s = spawn(process.execPath, ['server.mjs'], { detached: true, stdio: 'ignore' });
s.unref();
fs.writeFileSync('run/server.pid', String(s.pid));
const slow = Number(process.env.SHOP_SLOW || 0);
if (slow) await new Promise((r) => setTimeout(r, slow * 1000));
`;

/** The project.json of shop with its check and live blocks, the server on `port`. */
export const manifest = (port) => JSON.stringify({
  check: [{ run: ['node', '-e', 'process.exit(0)'], minutes: 1 }],
  live: {
    update: [{ run: ['node', 'deploy.mjs', '{commit}'], minutes: 2 }],
    verify: [{ url: `http://127.0.0.1:${port}/`, status: 200, seconds: 4 }],
    back: [{ run: ['node', 'deploy.mjs', '{before}'], minutes: 2 }],
    keep: ['data'],
  },
}, null, 2);
