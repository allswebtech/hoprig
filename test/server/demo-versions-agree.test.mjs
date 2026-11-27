// The demo's made-up versions agree everywhere: src/demo/versions.mjs holds them, and every demo answer that names a
// version names that one. The Overview's Claude Code line ("The newest version" or "Version … is out") follows the
// same answer as Settings → Version and updates, so the Overview never calls a version the newest while Updates offers a newer one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { GATEWAY, HOPRIG, KITS, TOOLS, newer } from '../../src/demo/versions.mjs';

// As in demo-versions.test.mjs: a connection to the shipped gateway's port is sent to a closed port instead.
const { SHIPPED } = await import('../../src/addons/gateways.mjs');
const shippedPort = SHIPPED[0].port;
const closedPort = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const connect = net.connect;
net.connect = function (...a) {
  const o = a[0] && typeof a[0] === 'object' ? a[0] : null;
  const port = Number(o ? o.port : a[0]);
  if (port === shippedPort) return connect.call(this, { ...o, host: '127.0.0.1', port: closedPort }, ...a.slice(1));
  return connect.apply(this, a);
};
test.after(() => { net.connect = connect; });

const DEMO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'demo');

/** The first output of a demo stand-in program until `done(text)` says enough; the program is ended then. */
function firstOutput(file, args, env, input, done) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DEMO, file), ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let text = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${file}: no answer: ${text.slice(0, 200)}`)); }, 20_000);
    child.stdout.on('data', (d) => {
      text += d;
      if (done(text)) {
        clearTimeout(timer);
        child.kill();
        resolve(text);
      }
    });
    child.on('error', reject);
    if (input) child.stdin.write(input);
  });
}

test('the one place: every tool has an installed and a newest version, and the newest is never older', () => {
  assert.match(HOPRIG, /^\d+\.\d+\.\d+/);
  for (const [id, v] of Object.entries(TOOLS)) {
    assert.match(v.installed, /^\d+\.\d+\.\d+$/, id);
    assert.match(v.latest, /^\d+\.\d+\.\d+$/, id);
    assert.ok(!newer(v.installed, v.latest), `${id}: the newest is not older than the installed one`);
  }
  assert.ok(newer(TOOLS.claude.latest, TOOLS.claude.installed), 'the demo shows a Claude Code update, as Updates always has');
  assert.equal(newer('2.1.332', '2.1.330'), true);
  assert.equal(newer('2.1.330', '2.1.330'), false);
  assert.equal(newer('2.10.0', '2.9.9'), true);
});

test("the Overview decides its Claude Code line from the answer of /api/claude (what this test checks against Updates)", () => {
  const src = fs.readFileSync(new URL('../../web/pc.js', import.meta.url), 'utf8');
  assert.match(src, /cl\.updateAvailable \? `Version \$\{cl\.latest\} is out` : cl\.latest \? 'The newest version' : 'Installed'/);
});

test('demo: every answer that names a version names the one in versions.mjs', { timeout: 120_000, skip: process.platform === 'win32' && 'the demo sessions run through a POSIX shell' }, async () => {
  sandbox('demo-versions-agree');
  const { main } = await import('../../src/demo/index.mjs');
  const hooks = { onReady: (i) => (hooks.info = i) };
  try {
    assert.equal(await main(['--no-open', '--quiet'], hooks), null);
    const { url, link } = hooks.info;
    const token = link.split('#link=')[1];
    const first = await fetch(`${url}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token }) });
    assert.equal(first.status, 200);
    const auth = { Cookie: first.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', Origin: url };
    const get = async (p) => {
      const r = await fetch(`${url}${p}`, { headers: auth });
      assert.equal(r.status, 200, p);
      return r.json();
    };

    // Settings → Version and updates: each row's installed and newest version, and whether an update is offered.
    const updates = await get('/api/updates');
    const rows = Object.fromEntries(updates.items.map((i) => [i.id, i]));
    assert.ok(rows.hoprig && rows.claude && rows.opencode && rows.cloudflared, Object.keys(rows).join(', '));
    assert.deepEqual([rows.hoprig.installed, rows.hoprig.latest, rows.hoprig.updateAvailable], [HOPRIG, HOPRIG, false]);
    for (const id of ['claude', 'codex', 'opencode', 'cloudflared']) {
      if (!rows[id]) continue; // Codex only while this version offers it
      const v = TOOLS[id];
      assert.deepEqual([rows[id].installed, rows[id].latest, rows[id].updateAvailable], [v.installed, v.latest, newer(v.latest, v.installed)], id);
    }

    // The Overview's Claude Code line: the same versions and the same "update available" as Updates.
    const claude = await get('/api/claude');
    assert.equal(claude.installed, TOOLS.claude.installed);
    assert.equal(claude.latest, TOOLS.claude.latest, 'the Overview names the newest version Updates names');
    assert.equal(claude.updateAvailable, rows.claude.updateAvailable, 'the Overview offers the update Updates offers');
    const line = claude.updateAvailable ? `Version ${claude.latest} is out` : claude.latest ? 'The newest version' : 'Installed';
    if (rows.claude.updateAvailable) assert.equal(line, `Version ${TOOLS.claude.latest} is out`);

    // Health, the Computers page, Setup and the other computer's file in the brain.
    const health = await get('/api/health');
    assert.deepEqual([health.versions.hoprig, health.versions.claude, health.versions.opencode], [HOPRIG, TOOLS.claude.installed, TOOLS.opencode.installed]);
    const machines = await get('/api/machines');
    assert.equal(machines.self.claude, TOOLS.claude.installed);
    assert.equal(machines.self.version, HOPRIG);
    const setup = await get('/api/pcsetup/status');
    const detail = (id) => (setup.checks.find((c) => c.id === id) || {}).detail;
    assert.deepEqual(
      ['claude.code', 'basics.git', 'basics.ripgrep', 'node.node', 'python.python', 'github.gh', 'python.uv'].map(detail),
      [TOOLS.claude.installed, KITS.git, KITS.ripgrep, KITS.node, KITS.python, KITS.gh, `${KITS.uv.installed} is old; ${KITS.uv.latest} is out`]);
    for (const c of health.checks.filter((x) => x.id === 'claude.code')) assert.equal(c.detail, TOOLS.claude.installed);
    const computers = await get('/api/workspace/computers');
    for (const c of computers.computers || []) if (c.hoprig) assert.equal(c.hoprig, HOPRIG, `${c.label}'s Hoprig`);

    // Coding tools: OpenCode's installed version (its package file in the demo's tools folder).
    const tools = await get('/api/codetools');
    const oc = tools.tools.find((t) => t.id === 'opencode');
    assert.ok(oc, 'OpenCode is a coding tool of the demo');
    assert.equal(oc.installed, TOOLS.opencode.installed);
    const cc = tools.tools.find((t) => t.id === 'claude');
    if (cc && cc.installed) assert.equal(cc.installed, TOOLS.claude.installed);

    // The gateway add-on, once "installed" (as the demo's Add-ons page installs it).
    const { computer } = await get('/api/addons');
    const inst = await fetch(`${url}/api/addons/${SHIPPED[0].id}/install`, { method: 'POST', headers: auth, body: JSON.stringify({ confirm: computer }) });
    assert.ok(inst.status < 300, `install: ${inst.status}`);
    let gw = null;
    for (let i = 0; i < 40 && !(gw && gw.version); i++) {
      await new Promise((r) => setTimeout(r, 250));
      gw = ((await get('/api/addons')).addons || []).find((a) => a.id === SHIPPED[0].id);
    }
    assert.equal(gw && gw.version, GATEWAY);
  } finally {
    await hooks.stop?.();
  }
});

test("demo: the chat's and the sign-in's Claude Code name the installed version", { timeout: 60_000, skip: process.platform === 'win32' && 'a POSIX demo' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-versions-chat-'));
  try {
    const chat = await firstOutput('chat.mjs', ['--session-id', 'a1b2c3d4-0000-4000-8000-000000000001'], { CLAUDE_CONFIG_DIR: dir },
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`, (t) => t.includes('"subtype":"init"'));
    const init = JSON.parse(chat.split('\n').find((l) => l.includes('"subtype":"init"')));
    assert.equal(init.claude_code_version, TOOLS.claude.installed);
    const signin = await firstOutput('signin.mjs', ['setup-token'], {}, '', (t) => t.includes('Welcome'));
    assert.ok(signin.includes(`v${TOOLS.claude.installed}`), signin.slice(0, 200));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
