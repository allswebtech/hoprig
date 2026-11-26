// Windows only: the desktop pages' and the take-over's PowerShell scripts run for real, and answer in the shapes their
// readers take, well inside the time a module's first cmdlet cost there (Get-CimInstance and the like: 17 to 19 s in
// a fresh PowerShell, measured on the runner; these load no module). Read only: nothing is changed or ended.
import assert from 'node:assert/strict';
import test from 'node:test';

const WINDOWS = { skip: process.platform !== 'win32' && 'it runs Windows PowerShell itself: the real scripts, on Windows only', timeout: 60_000 };
// Inside what one module's first cmdlet alone cost (17 s); a script without one answered in about a quarter second.
const BOUND_MS = 10_000;

const W = await import('../../src/server/platform/win32-system.mjs');
const T = await import('../../src/server/takeover.mjs');
const { run } = await import('../../src/server/platform/common.mjs');
const io = { run };
const timed = async (what, fn) => {
  const t = Date.now();
  const v = await fn();
  const ms = Date.now() - t;
  assert.ok(ms < BOUND_MS, `${what} took ${ms} ms`);
  return v;
};

test('the disks of this computer: each fixed drive with its size', WINDOWS, async () => {
  const d = await timed('disks', () => W.disks(io));
  assert.ok(d.length >= 1, 'the system drive at least');
  for (const x of d) {
    assert.match(x.fs, /^[A-Z]:$/);
    assert.equal(x.mount, `${x.fs}\\`);
    assert.ok(x.size > 0 && x.avail >= 0 && x.used >= 0, JSON.stringify(x));
  }
});

test('the listening ports, with their programs', WINDOWS, async () => {
  const p = await timed('ports', () => W.ports(io));
  assert.ok(Array.isArray(p));
  for (const x of p) assert.ok(typeof x.addr === 'string' && Number.isInteger(x.port) && x.port > 0 && typeof x.process === 'string', JSON.stringify(x));
  assert.ok(p.some((x) => x.port === 135 || x.port === 445), 'Windows\' own listeners are seen');
});

test('the network adapters\' counters', WINDOWS, async () => {
  const n = await timed('network', () => W.net(io));
  assert.ok(Array.isArray(n));
  for (const x of n) assert.ok(typeof x.name === 'string' && x.name && Number.isFinite(x.rx) && Number.isFinite(x.tx), JSON.stringify(x));
});

test('the services, read only', WINDOWS, async () => {
  const s = await timed('services', () => W.services.list(io));
  assert.equal(s.available, true, s.note);
  assert.ok(s.services.length > 10);
  for (const x of s.services) assert.ok(x.name && ['active', 'inactive', 'activating', 'deactivating'].includes(x.active), JSON.stringify(x));
  assert.ok(s.services.some((x) => x.name.toLowerCase() === 'eventlog' && x.active === 'active'), 'the event log service runs');
});

test('the take-over\'s facts of a process and the table of parents', WINDOWS, async () => {
  const f = await timed('the facts of this process', () => T.processFacts(process.pid, { me: { sid: null } }));
  assert.ok(f, 'told');
  assert.match(f.cmd, /node/i);
  assert.match(f.proc, /^T:\d+$/);
  const chain = await timed('the parents', () => T.parentChain(process.pid));
  assert.ok(Array.isArray(chain) && chain[0] === process.ppid, JSON.stringify(chain));
});
