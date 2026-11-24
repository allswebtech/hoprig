// A gateway's first password: Hoprig keeps none it does not need. Where the gateway's definition names the line it is
// printed on (firstPassword), a start hands its first lines to the page ONCE (in memory, ten minutes at most) and that
// line never reaches the gateway's log; without it the log is as the gateway prints it, mode 600, and the page says so
// before the start. A failed start's answer shows the lines the same way. The gateway is a made-up program of the
// owner's own; nothing of the real system is reached (stand-ins first, the test's traps and the runner's behind them).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('first-password');
const { saveConfig } = await import('../../src/config.mjs');
const { gatewayAddons, checkDefinition } = await import('../../src/addons/gateways.mjs');
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { addonsFeature } = await import('../../src/addons/feature.mjs');
const { FirstLines, holdsMarker } = await import('../../src/addons/firstlines.mjs');
const { traps } = await import('../machines/traps.mjs');

const PW = 'Q9made-up-first-pw';
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const script = path.join(box.root, 'relay.mjs');
fs.writeFileSync(script, `import fs from 'node:fs';
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
console.log('Relay 1.0 starting');
console.log('Relay first password: ${PW}');
if (fs.existsSync(${JSON.stringify(path.join(box.root, 'fail'))})) {
  console.error('Relay: cannot open its database');
  process.exit(3);
}
http.createServer((q, s) => s.end('relay')).listen(port, '127.0.0.1', () => console.log('Relay listens'));
`);
const program = path.join(box.root, 'relay');
fs.writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(program)).digest('hex');
const standins = path.join(box.root, 'standins');
fs.mkdirSync(standins);
const trap = traps(box.root);
process.env.PATH = trap.path(standins);
const [marked, plain] = [await freePort(), await freePort()];
saveConfig({ gateways: { defined: [
  { id: 'relay', title: 'Relay', bin: program, sha256, port: marked, args: ['--port', 'PORT'], firstPassword: 'first password' },
  { id: 'plainrelay', title: 'Plain relay', bin: program, sha256, port: plain, args: ['--port', 'PORT'] },
] } });
const byId = (id) => gatewayAddons().find((a) => a.id === id);
const logOf = (id) => path.join(box.state, 'addons', `${id}.log`);
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const health = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { addons: () => gatewayAddons(), computer: () => 'box2', run: async () => ({ ok: false, stdout: '', stderr: '' }) });
const route = (m0, p) => {
  const [, re, fn] = health.routes.find(([m, r]) => m === m0 && r.test(p));
  return (body) => fn({ body, headers: {} }, re.exec(p));
};
test.after(async () => {
  await byId('relay').stop().catch(() => {});
  await byId('plainrelay').stop().catch(() => {});
  box.cleanup();
});

test('named in its definition: the first lines come once with the start, the password line never reaches the log', { skip, timeout: 60_000 }, async () => {
  try {
    const list = await route('GET', '/api/gatewayhost')();
    assert.equal(list.gateways.find((g) => g.id === 'relay').marksFirst, true);
    const r = await route('POST', '/api/gatewayhost/relay/start')({ confirm: 'box2' });
    assert.equal(r.ok, true);
    assert.ok(r.first.includes(`Relay first password: ${PW}`), JSON.stringify(r.first));
    assert.ok(r.first.includes('Relay 1.0 starting'));
    const log = fs.readFileSync(logOf('relay'), 'utf8');
    assert.ok(!log.includes(PW), `the log holds the password: ${log}`);
    assert.match(log, /Relay 1\.0 starting/, 'the rest is logged as it printed it');
    assert.equal(fs.statSync(logOf('relay')).mode & 0o777, 0o600);
    // Once: a second ask gives nothing, and nothing is left to show.
    assert.deepEqual((await route('POST', '/api/gatewayhost/relay/first')({ confirm: 'box2' })).first, []);
    assert.equal((await route('GET', '/api/gatewayhost')()).gateways.find((g) => g.id === 'relay').firstWaiting, false);
    // Nothing of it was written anywhere Hoprig keeps state.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of [...walk(box.state), ...walk(box.config)]) assert.ok(!fs.readFileSync(f, 'latin1').includes(PW), `${f} holds it`);
  } finally {
    assert.equal((await byId('relay').stop()).ok, true, 'Stop ends the gateway behind the filter too');
    trap.check();
  }
});

test('a start made elsewhere (Settings → Add-ons) hands its first lines to that job\'s first reader, once', { skip, timeout: 60_000 }, async () => {
  const f = addonsFeature({ HttpError, readJson: async () => ({}), config: () => ({ server: {} }) }, { addons: [byId('relay')] });
  const call = (m0, p) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === m0 && r.test(p));
    return fn({ headers: {} }, re.exec(p), new URLSearchParams('from=0'));
  };
  try {
    assert.deepEqual(await call('POST', '/api/addons/relay/start'), { started: true });
    let j;
    for (let i = 0; i < 200; i++) {
      j = await call('GET', '/api/addons/relay/job');
      if (!j.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(j.result.ok, true, j.result.error);
    assert.ok(j.first && j.first.some((l) => l.includes(PW)), JSON.stringify(j));
    assert.equal((await call('GET', '/api/addons/relay/job')).first, undefined, 'never again');
  } finally {
    await byId('relay').stop();
  }
});

test('a failed start shows its first lines once in its answer, and its error text never holds the password', { skip, timeout: 60_000 }, async () => {
  fs.writeFileSync(path.join(box.root, 'fail'), '');
  try {
    await assert.rejects(route('POST', '/api/gatewayhost/relay/start')({ confirm: 'box2' }), (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /Relay stopped at once/);
      assert.ok(!e.message.includes(PW), e.message);
      assert.ok(e.details.first.some((l) => l.includes(PW)), JSON.stringify(e.details));
      return true;
    });
    assert.ok(!fs.readFileSync(logOf('relay'), 'utf8').includes(PW));
  } finally {
    fs.rmSync(path.join(box.root, 'fail'), { force: true });
    trap.check();
  }
});

test('not named: the log is as the gateway prints it, mode 600, nothing is handed to the page, and the page says so first', { skip, timeout: 60_000 }, async () => {
  fs.writeFileSync(logOf('plainrelay'), 'from an older version\n', { mode: 0o644 });
  try {
    const r = await route('POST', '/api/gatewayhost/plainrelay/start')({ confirm: 'box2' });
    assert.equal(r.ok, true);
    assert.equal(r.first, undefined);
    for (let i = 0; i < 20 && !fs.readFileSync(logOf('plainrelay'), 'utf8').includes(PW); i++) await new Promise((x) => setTimeout(x, 100));
    assert.ok(fs.readFileSync(logOf('plainrelay'), 'utf8').includes(`Relay first password: ${PW}`), 'as it printed it');
    assert.equal(fs.statSync(logOf('plainrelay')).mode & 0o777, 0o600, 'a wider log of an older version is closed too');
    assert.equal((await route('GET', '/api/gatewayhost')()).gateways.find((g) => g.id === 'plainrelay').marksFirst, false);
    const page = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'health.js'), 'utf8');
    assert.match(page, /What it prints goes to its log on \$\{d\.computer\} as it prints it, in a file only your user there can read\./);
  } finally {
    await byId('plainrelay').stop();
    trap.check();
  }
});

test('held in memory for ten minutes at most, and given out once', () => {
  let t = 0;
  const held = new FirstLines({ now: () => t });
  held.keep(['a', 'b']);
  assert.equal(held.waiting(), true);
  t = 10 * 60_000 + 1;
  assert.deepEqual(held.take(), [], 'gone after ten minutes');
  t = 0;
  held.keep(['a']);
  assert.deepEqual(held.take(), ['a']);
  assert.deepEqual(held.take(), [], 'once');
  assert.equal(holdsMarker('Your First Password: x', 'first password'), true);
  assert.equal(holdsMarker('listening', 'first password'), false);
});

test('the definition names the line by a word of it: 3 to 60 plain characters', () => {
  const base = { id: 'relayx', title: 'Relay x', bin: program, sha256, port: 20999, args: ['--port', 'PORT'] };
  assert.equal(checkDefinition({ ...base, firstPassword: 'password' }, { cfg: { server: {} } }).def.firstPassword, 'password');
  assert.equal(checkDefinition(base, { cfg: { server: {} } }).def.firstPassword, undefined);
  for (const bad of ['pw', 'x'.repeat(61), 'line\nbreak', 42]) assert.match(checkDefinition({ ...base, firstPassword: bad }, { cfg: { server: {} } }).error || '', /firstPassword/, String(bad));
});
