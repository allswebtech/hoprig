// Windows: a stand-in taskkill for the tests that end a child of their own through the product. The runner's seal traps
// the real taskkill (it ends programs by name), so the end goes to this one: first on PATH, a #!/usr/bin/env node file
// the seal starts through Node. It does what `taskkill /PID <pid> /F` does (Node's process.kill ends a process at once
// on Windows), refuses a plain end of a program with no window as taskkill does, and writes down each call.
import fs from 'node:fs';
import path from 'node:path';

/** Put the stand-in first on PATH (Windows only; elsewhere nothing). → { calls(): [argv…] } */
export function taskkillStandIn(dir) {
  const log = path.join(dir, 'taskkill-calls.log');
  if (process.platform !== 'win32') return { calls: () => [] };
  const bin = path.join(dir, 'taskkill-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'taskkill'), `#!/usr/bin/env node
const a = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const pid = Number(a[a.indexOf('/PID') + 1]);
if (!a.includes('/F')) { console.error('ERROR: This process can only be terminated forcefully (with /F option).'); process.exit(1); }
try { process.kill(pid); console.log('SUCCESS: The process with PID ' + pid + ' has been terminated.'); } catch { console.error('ERROR: The process "' + pid + '" not found.'); process.exit(128); }
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
