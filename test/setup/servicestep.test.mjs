// Set-up's service step asks the running dashboard (src/setup/running.mjs) instead of a probe of 127.0.0.1: "restart to
// apply" whenever it listens wider than its settings (also on a second run), a version that differs is restarted and
// said, never when sessions of its built-in terminals would end without a word, and never "running in the background"
// when an earlier dashboard kept the port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const calls = path.join(s.tmp, 'systemctl.txt');
const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude(), systemctl: `printf '%s\\n' "$*" >> '${calls}'` });
const mine = K.appVersion();

function sys(running, over = {}) {
  const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
  const S = K.sysInfo({ env, platform: 'linux', pm: null, root: false, serviceSupported: true, ...over });
  S.probe = async () => 200;
  S.running = typeof running === 'function' ? running : async () => running;
  return S;
}
const ui = (o = {}) => {
  const rec = recorder();
  return { rec, ui: makeUi({ interactive: false, write: rec.write, askLine: async () => '', ...o }) };
};
await SU.stepPassword(ui({ yes: true }).ui, {}, {});

test('a second run: the dashboard still listens on every address while its settings say this computer only: said, and restarted', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const { ui: u, rec } = ui({ yes: true });
  // --no-service: said, with the way to apply it (set-up does not restart what it does not manage)
  await SU.stepService(u, sys({ version: mine, pid: 11, host: '0.0.0.0', port: 7433, backend: 'tmux', terminals: [] }), { service: false }, { changed: false });
  assert.match(rec.text, /! Dashboard running with the setting it started with: it listens on every address \(open to the network\), its settings say on this computer only; who may open it changes when it restarts/);
  // with the service: restarted, though nothing changed in this run
  fs.rmSync(calls, { force: true });
  let n = 0;
  const r = ui({ yes: true });
  const ok = await SU.stepService(r.ui, sys(async () => (n++ ? { version: mine, pid: 12, host: '127.0.0.1', port: 7433, backend: 'tmux', terminals: [] } : { version: mine, pid: 11, host: '0.0.0.0', port: 7433, backend: 'tmux', terminals: [] })), { service: true }, { changed: false });
  assert.equal(ok, true, r.rec.text);
  assert.match(fs.readFileSync(calls, 'utf8'), /--user restart hoprig\.service/);
  assert.match(r.rec.text, /✓ Dashboard running in the background/);
});

test('another version runs: restarted and said "it ran X, now Y"; with sessions in its built-in terminals --yes does not restart and names them', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  let n = 0;
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepService(u, sys(async () => (n++ ? { version: mine, pid: 22, host: '127.0.0.1', port: 7433, backend: 'tmux', terminals: [] } : { version: '0.0.1', pid: 21, host: '127.0.0.1', port: 7433, backend: 'tmux', terminals: [] })), { service: true }, { changed: false });
  assert.match(rec.text, new RegExp(`✓ The dashboard ran 0\\.0\\.1, now ${mine.replace(/\./g, '\\.')}`), rec.text);
  assert.doesNotMatch(rec.text, /running now is version/, 'said once, by the result');
  fs.rmSync(calls, { force: true });
  const p = ui({ yes: true });
  await SU.stepService(p.ui, sys({ version: '0.0.1', pid: 21, host: '127.0.0.1', port: 7433, backend: 'pty', terminals: ['shop', 'alpha'] }), { service: true }, { changed: false });
  assert.match(p.rec.text, /! A restart of the dashboard ends the sessions in its built-in terminals: shop, alpha/);
  assert.match(p.rec.text, /Not restarted: version 0\.0\.1 runs on\. Restart it when those sessions are done: hoprig service install/);
  assert.match(p.rec.text, /· The dashboard running now is version 0\.0\.1; this is /, 'not restarted: which version runs is said');
  assert.equal(fs.existsSync(calls), false, 'systemctl was never asked');
});

test('an earlier "hoprig serve" keeps the port open to the network: said, and never "running in the background"', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const { ui: u, rec } = ui({ yes: true });
  const old = { version: mine, pid: 31, host: '0.0.0.0', port: 7433, backend: 'tmux', terminals: [] };
  assert.equal(await SU.stepService(u, sys(old), { service: true }, { changed: true }), false);
  assert.match(rec.text, /✗ An earlier dashboard \(pid 31, not the background service\) still holds port 7433 open to the network, so the service could not take it/);
  assert.doesNotMatch(rec.text, /running in the background/);
});

// An update from a version before /api/local/facts: its dashboard.json has { pid, host, port } and no key. The step asks
// the real running.mjs (no `sys.running`), which falls back to that file.
async function earlier(t, host) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'dashboard.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, host, port: 7433, at: Date.now() }) + '\n');
  t.after(() => fs.rmSync(file, { force: true }));
  return { pid: child.pid, file };
}
function sysReal(over = {}, onRestart = '') {
  const env = { ...process.env, PATH: pathWith(s.tmp, fakeBin(path.join(s.tmp, 'bin-earlier'), { claude: fakeClaude(), systemctl: `printf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *restart*) ${onRestart || ':'} ;; esac` }), bin) };
  const S = K.sysInfo({ env, platform: 'linux', pm: null, root: false, serviceSupported: true, ...over });
  S.probe = async () => 200;
  return S;
}

test('an earlier version runs (no key, no route) on every address: restarted, said, and the new one checked', async (t) => {
  saveConfig({ server: { host: '127.0.0.1', backend: 'tmux' } });
  fs.rmSync(calls, { force: true });
  await earlier(t, '0.0.0.0');
  // The service's new dashboard: this process, answering the route with the key of its file.
  const http = await import('node:http');
  const key = 'k'.repeat(43);
  const srv = http.createServer((q, r) => r.end(JSON.stringify(q.headers['x-hoprig-local-key'] === key ? { version: mine, pid: process.pid, host: '127.0.0.1', port: 7433, backend: 'tmux', terminals: [] } : {}))).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  // The stand-in systemctl's restart writes its dashboard.json (with the shell's own printf: no cp on this PATH).
  const next = JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: srv.address().port, at: Date.now(), key });
  const { ui: u, rec } = ui({ yes: true });
  const ok = await SU.stepService(u, sysReal({}, `printf '%s\\n' '${next}' > '${path.join(process.env.HOPRIG_STATE_DIR, 'dashboard.json')}'`), { service: true }, { changed: false });
  assert.equal(ok, true, rec.text);
  assert.match(fs.readFileSync(calls, 'utf8'), /--user restart hoprig\.service/, rec.text);
  assert.match(rec.text, /! The dashboard running now listens on every address \(open to the network\); its settings say on this computer only/);
  assert.match(rec.text, new RegExp(`✓ The dashboard ran an earlier version, now ${mine.replace(/\./g, '\\.')}`));
});

test('an earlier version that a "hoprig serve" started by hand keeps on the port: ✗, never "running in the background"', async (t) => {
  saveConfig({ server: { host: '127.0.0.1', backend: 'tmux' } });
  fs.rmSync(calls, { force: true });
  const { pid } = await earlier(t, '0.0.0.0');
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await SU.stepService(u, sysReal(), { service: true }, { changed: true, hostChanged: true }), false, rec.text);
  assert.match(fs.readFileSync(calls, 'utf8'), /--user restart hoprig\.service/);
  assert.match(rec.text, new RegExp(`✗ An earlier dashboard \\(pid ${pid}.*\\) still holds port 7433 open to the network`));
  assert.doesNotMatch(rec.text, /running in the background/);
});

test('an earlier version on the built-in terminals cannot name its sessions: said, and --yes does not restart it', async (t) => {
  saveConfig({ server: { host: '127.0.0.1', backend: 'pty' } });
  fs.rmSync(calls, { force: true });
  await earlier(t, '127.0.0.1');
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepService(u, sysReal(), { service: true }, { changed: false });
  assert.match(rec.text, /! A restart of the dashboard ends the sessions in its built-in terminals, if it has any/);
  assert.match(rec.text, /Not restarted: an earlier version runs on\. Restart it when those sessions are done: hoprig service install/);
  assert.equal(fs.existsSync(calls), false, 'systemctl was never asked');
});

test('not restarted for sessions: the line keeps its mark, and the restart is in the closing list', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  fs.rmSync(calls, { force: true });
  const { collectTodo, closingList } = await import('../../src/setup/ui.mjs');
  const { ui: u, rec } = ui({ yes: true });
  collectTodo(u);
  await SU.stepService(u, sys({ version: '0.0.1', pid: 21, host: '127.0.0.1', port: 7433, backend: 'pty', terminals: ['shop'] }), { service: true }, { changed: false });
  closingList(u);
  const at = rec.text.indexOf('Still yours to do:');
  assert.ok(at > 0, rec.text);
  assert.match(rec.text.slice(0, at), /^ {2}· Not restarted: version 0\.0\.1 runs on$/m);
  assert.doesNotMatch(rec.text.slice(0, at), /hoprig service install/, 'nothing of the list earlier');
  assert.match(rec.text.slice(at), /· Restart the dashboard, so it runs this version and its settings: hoprig service install, once the session shop is done/);
});

// A whole set-up (--only base) on a cloud server, with the running dashboard answered by the test.
async function onServer(running, args = [], over = {}) {
  const { fakeFetch } = await import('./helpers.mjs');
  const fetchWas = globalThis.fetch;
  globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });
  try {
    saveConfig({ server: { host: '127.0.0.1' } });
    fs.rmSync(calls, { force: true });
    const { ui: u, rec } = ui({ yes: true });
    const S = sys(running, { publicIps: [], dmi: { vendor: 'Amazon EC2', product: 'm5.large' }, localDisplay: false, savedServer: null, ...over });
    const code = await SU.setup(['--yes', ...args, '--only', 'base'], { ui: u, sys: S });
    return { code, text: rec.text };
  } finally {
    globalThis.fetch = fetchWas;
  }
}

test('on a server, an earlier "hoprig serve" keeps the port open to the network: "not ready" at the end, and exit 1', async () => {
  const r = await onServer({ version: mine, pid: 41, host: '0.0.0.0', port: 7433, backend: 'tmux', terminals: [] });
  assert.match(r.text, /✗ An earlier dashboard \(pid 41, not the background service\)/);
  assert.match(r.text, /hoprig is not ready: an earlier dashboard still holds its port, open to the network/);
  assert.doesNotMatch(r.text, /hoprig is ready\./);
  assert.equal(r.code, 1, r.text);
});

test('on a server, --yes leaves a dashboard open to the network for its sessions: "not ready", the restart listed, exit 1', async () => {
  const r = await onServer({ version: mine, pid: 51, host: '0.0.0.0', port: 7433, backend: 'pty', terminals: ['shop'] });
  assert.match(r.text, /Not restarted: it runs on with the setting it started with/);
  assert.match(r.text, /hoprig is not ready: the dashboard running now is still open to the network, and this computer is a server/);
  assert.doesNotMatch(r.text, /hoprig is ready\./);
  assert.match(r.text, /Still yours to do:\n(?:.*\n)*? {4}· Restart the dashboard, so it runs this version and its settings: hoprig service install, once the session shop is done/);
  assert.equal(r.code, 1, r.text);
});

test('on a server, --no-service or no service manager leaves a dashboard open to the network: "not ready", how to restart it, exit 1', async () => {
  const wide = { version: mine, pid: 61, host: '0.0.0.0', port: 7433, backend: 'tmux', terminals: [] };
  for (const [args, over, how] of [[['--no-service'], {}, 'hoprig service install, or stop "hoprig serve" and start it again'], [[], { serviceSupported: false }, 'stop "hoprig serve" and start it again']]) {
    const r = await onServer(wide, args, over);
    const at = JSON.stringify(args.length ? args : over);
    assert.match(r.text, /! Dashboard running with the setting it started with: it listens on every address/, at);
    assert.ok(r.text.includes(`hoprig is not ready: the dashboard running now is still open to the network, and this computer is a server: restart it (${how}).`), `${at}\n${r.text}`);
    assert.doesNotMatch(r.text, /hoprig is ready\./, at);
    assert.equal(r.code, 1, r.text);
  }
  // Running on this computer only, as its settings say: ready as before.
  const r = await onServer({ ...wide, host: '127.0.0.1' }, ['--no-service']);
  assert.match(r.text, /hoprig is ready\./);
  assert.equal(r.code, 0, r.text);
});

test('on a server, the settings were just closed but the running dashboard cannot say where it listens: not ready', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const { ui: u, rec } = ui({ yes: true });
  const state = { changed: true, hostChanged: true, server: { kind: 'ssh' } };
  // sys.running answers null (a dashboard with no local facts here), sys.probe answers 200: it runs, this run closed
  // its open setting, and it started with that setting, so it is open until it restarts.
  const ok = await SU.stepService(u, sys(null), { service: false }, state);
  assert.equal(ok, false, rec.text);
  assert.equal(state.serviceLeft, 'open');
});

test('on a server, a dashboard that answers but cannot say where it listens is never "✓ Dashboard running": said, with the restart, whether or not this run changed the setting', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const SAY = /! Dashboard running, but set-up cannot read where it listens \(it says nothing about itself here\), and this computer is a server: restart it so it runs with its settings \((.+)\)\n/;
  const server = { kind: 'ssh' };
  // --no-service, no service manager, and an installed service with nothing changed: the setting was closed by an
  // EARLIER run (hostChanged false), the port still answers, nothing describes itself.
  const unit = path.join(s.env.HOME, '.config', 'systemd', 'user', 'hoprig.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, '# stand-in\n');
  for (const [opts, over, how] of [[{ service: false }, {}, 'hoprig service install, or stop "hoprig serve" and start it again'], [{ service: true }, { serviceSupported: false }, 'stop "hoprig serve" and start it again'], [{ service: true }, {}, 'hoprig service install']]) {
    const { ui: u, rec } = ui({ yes: true });
    await SU.stepService(u, sys(null, { home: s.env.HOME, ...over }), opts, { changed: false, hostChanged: false, server });
    const at = JSON.stringify([opts, over]);
    assert.match(rec.text, SAY, `${at}\n${rec.text}`);
    assert.equal(SAY.exec(rec.text)[1], how, at);
    assert.doesNotMatch(rec.text, /✓ Dashboard running/, at);
  }
  // Restarted by this run, and still nothing says where it listens: said too.
  fs.rmSync(calls, { force: true });
  const r = ui({ yes: true });
  await SU.stepService(r.ui, sys(null, { home: s.env.HOME }), { service: true }, { changed: true, hostChanged: false, server });
  assert.match(fs.readFileSync(calls, 'utf8'), /--user restart hoprig\.service/);
  assert.match(r.rec.text, /! Dashboard restarted, but set-up cannot read where it listens \(nothing on port 7433 says it is this Hoprig\), and this computer is a server: hoprig service status/);
  assert.doesNotMatch(r.rec.text, /✓ Dashboard running/);
  // Not a server: as before.
  const home = ui({ yes: true });
  await SU.stepService(home.ui, sys(null, { home: s.env.HOME }), { service: false }, { changed: false, server: null });
  assert.match(home.rec.text, /✓ Dashboard running\n/);
  fs.rmSync(unit, { force: true });
});

test('"Restart it now anyway?" is asked when sessions in the built-in terminals would end: its default is no, a "y" restarts', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const old = { version: '0.0.1', pid: 71, host: '127.0.0.1', port: 7433, backend: 'pty', terminals: ['shop'] };
  const answered = async (answer) => {
    fs.rmSync(calls, { force: true });
    const asked = [];
    const rec = recorder();
    const u = makeUi({ interactive: true, write: rec.write, askLine: async (q) => { asked.push(q); return answer; } });
    let n = 0;
    const ok = await SU.stepService(u, sys(async () => (n++ ? { ...old, version: mine, pid: 72, terminals: [] } : old)), { service: true }, { changed: false });
    return { ok, asked, text: rec.text, restarted: fs.existsSync(calls) && /--user restart hoprig\.service/.test(fs.readFileSync(calls, 'utf8')) };
  };
  // Enter alone takes the default: no. Nothing restarted, the sessions named, the restart left for later.
  const enter = await answered('');
  assert.deepEqual(enter.asked, ['  Restart it now anyway? (y/N) '], 'asked once, default no');
  assert.equal(enter.restarted, false, enter.text);
  assert.match(enter.text, /! A restart of the dashboard ends the session in its built-in terminals: shop\n/);
  assert.match(enter.text, /Not restarted: version 0\.0\.1 runs on/);
  // "n" the same.
  assert.equal((await answered('n')).restarted, false);
  // "y": restarted, and the new version said.
  const yes = await answered('y');
  assert.equal(yes.restarted, true, yes.text);
  assert.match(yes.text, new RegExp(`✓ The dashboard ran 0\\.0\\.1, now ${mine.replace(/\./g, '\\.')}`));
  assert.equal(yes.ok, true);
  // --yes takes the default (no) without putting the question, and says it was not restarted.
  fs.rmSync(calls, { force: true });
  const y = ui({ yes: true });
  await SU.stepService(y.ui, sys(old), { service: true }, { changed: false });
  assert.doesNotMatch(y.rec.text, /Restart it now anyway/);
  assert.match(y.rec.text, /Not restarted: version 0\.0\.1 runs on/);
  assert.equal(fs.existsSync(calls), false, 'not restarted under --yes');
});

test('on a server, what cannot say where it listens leaves the run "not ready": after a restart, and with nothing changed', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const { stepSummary } = SU;
  const server = { kind: 'ssh' };
  // A restart by this run, and still nothing on the port says it is this Hoprig (another program may hold it).
  fs.rmSync(calls, { force: true });
  const r = ui({ yes: true });
  const st = { changed: true, hostChanged: true, server };
  const ok = await SU.stepService(r.ui, sys(null, { home: s.env.HOME }), { service: true }, st);
  assert.equal(ok, false, r.rec.text);
  assert.equal(st.serviceLeft, 'unread');
  await stepSummary(r.ui, st, sys(null));
  assert.match(r.rec.text, /hoprig is not ready: set-up cannot read where the dashboard running now listens, and this computer is a server: see what holds port 7433: hoprig service status\./);
  assert.doesNotMatch(r.rec.text, /hoprig is ready/);
  // Nothing changed in this run (closed by an earlier one), an installed service, nothing that describes itself.
  const unit = path.join(s.env.HOME, '.config', 'systemd', 'user', 'hoprig.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, '# stand-in\n');
  for (const opts of [{ service: true }, { service: false }]) {
    const n = ui({ yes: true });
    const st2 = { changed: false, hostChanged: false, server };
    assert.equal(await SU.stepService(n.ui, sys(null, { home: s.env.HOME }), opts, st2), false, JSON.stringify(opts));
    await stepSummary(n.ui, st2, sys(null));
    assert.match(n.rec.text, /hoprig is not ready: set-up cannot read where the dashboard running now listens, and this computer is a server: restart it so it runs with its settings \(hoprig service install/, JSON.stringify(opts));
  }
  fs.rmSync(unit, { force: true });
  // At home the same facts are ready, as before.
  const home = ui({ yes: true });
  assert.equal(await SU.stepService(home.ui, sys(null, { home: s.env.HOME }), { service: false }, { changed: false, server: null }), true);
});

test('set-up on a server fills its field report\'s summary: a server, its steps, and a dashboard left open as its class', async () => {
  const { fakeFetch } = await import('./helpers.mjs');
  const fetchWas = globalThis.fetch;
  globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });
  try {
    saveConfig({ server: { host: '127.0.0.1' } });
    const { ui: u } = ui({ yes: true });
    const summary = {};
    const S = sys({ version: mine, pid: 41, host: '0.0.0.0', port: 7433, backend: 'tmux', terminals: [] }, { publicIps: [], dmi: { vendor: 'Amazon EC2', product: 'm5.large' }, localDisplay: false, savedServer: null });
    const code = await SU.setup(['--yes', '--only', 'base'], { ui: u, sys: S, summary });
    assert.equal(code, 1);
    assert.equal(summary.server, true);
    assert.equal(summary.error, 'open-to-network');
    assert.ok(summary.steps.some((x) => x.id === 'service' && x.end === 'failed'), JSON.stringify(summary.steps));
    assert.ok(summary.steps.every((x) => typeof x.id === 'string' && ['ok', 'failed'].includes(x.end)));
  } finally {
    globalThis.fetch = fetchWas;
  }
});

// The move installs Hoprig for the user while root's dashboard still holds the port: that set-up must not look at it.
test('--no-dashboard: a dashboard on the port that is not this Hoprig\'s is none of its business; no service, nothing asked', async () => {
  saveConfig({ server: { host: '127.0.0.1' } });
  const o = SU.parseSetupArgs(['--yes', '--no-dashboard']);
  assert.equal(o.noDashboard, true);
  assert.equal(o.service, false);
  fs.rmSync(calls, { force: true });
  const { ui: u, rec } = ui({ yes: true });
  const state = { changed: true, hostChanged: true, server: { kind: 'ssh' } };
  const ok = await SU.stepService(u, sys(null, { home: s.env.HOME }), o, state);
  assert.equal(ok, true, rec.text);
  assert.equal(state.serviceLeft, undefined, rec.text);
  assert.doesNotMatch(rec.text, /cannot read where it listens|is not ready/);
  assert.match(rec.text, /Dashboard: not started by this set-up \(--no-dashboard\)/);
  assert.equal(fs.existsSync(calls), false, 'systemctl was not asked');
});
