// `hoprig demo`: it starts on a free port on 127.0.0.1, keeps everything in its own temp folder (the configured
// folders stay untouched), signs a browser in through a link that works once, shows its sample sessions, and
// removes everything when it stops.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

test('demo: free port, own temp folder, one-time sign-in link, sample data, clean exit', { timeout: 120_000, skip: process.platform === 'win32' && 'the demo sessions run through a POSIX shell' }, async () => {
  const box = sandbox('demo-guard'); // stands for the owner's real folders: the demo must not touch them
  const marker = path.join(box.config, 'config.json');
  fs.writeFileSync(marker, '{"server":{"port":7433}}\n');
  const before = fs.readFileSync(marker, 'utf8');
  const listing = () => JSON.stringify([box.config, box.state, box.profiles, box.claude].map((d) => fs.readdirSync(d).sort()));
  const was = listing();
  const { main } = await import('../../src/demo/index.mjs');
  const hooks = { onReady: (i) => (hooks.info = i) };
  try {
    assert.equal(await main(['--no-open', '--quiet'], hooks), null);
    const { url, link, root, port } = hooks.info;
    assert.ok(port > 0 && port !== 7433, 'a free port, never the service port');
    assert.ok(url.startsWith('http://127.0.0.1:'), 'loopback only');
    assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())), 'everything under the OS temp folder');
    assert.equal(process.env.HOPRIG_CONFIG_DIR, path.join(root, 'config'));
    assert.ok(!Object.keys(process.env).some((k) => /^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(k)), 'no credential from the environment');
    assert.equal((await fetch(`${url}/api/state`)).status, 401, 'not open without signing in');

    const token = link.split('#link=')[1];
    const use = () => fetch(`${url}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token }) });
    const first = await use();
    assert.equal(first.status, 200);
    assert.equal((await use()).status, 401, 'the link works once');
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(`${url}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(state.demo, true);
    assert.equal(state.autoSwitch.enabled, true);
    assert.deepEqual(state.autoSwitch.order, ['max', 'api'], 'one subscription, then the API account');
    assert.ok(state.profiles.some((p) => p.name === 'team'), 'the second subscription is an account of its own');
    const by = Object.fromEntries(state.sessions.map((s) => [s.name, s]));
    assert.equal(by['shop-frontend'].status, 'working');
    assert.equal(by['api-server'].status, 'waiting');
    assert.match(by['api-server'].lastMessage, /rate limiting/);
    assert.equal(by['mobile-app'].status, 'attention');
    assert.ok(by['docs-site'].runLimit || by['docs-site'].limit, 'a session at its limit');
    assert.match(by['api-server'].short, /^~\/Workspace\/projects\/api-server$/, 'folders read ~/Workspace/projects/…, no real path');
    const usage = Object.fromEntries(state.profiles.map((p) => [p.name, p.usage && p.usage.fiveHour && p.usage.fiveHour.pct]));
    assert.equal(usage.max, 96);
    assert.equal(usage.team, null, 'a Team plan reports no usage');
    const facts = Object.fromEntries(state.profiles.map((p) => [p.name, [p.kind, p.signedIn, p.usageReported]]));
    assert.deepEqual(facts.team, ['subscription', true, false]);
    assert.deepEqual(facts.pro, ['login', false, null], 'one provider not signed in');
    assert.equal(facts.api[1], undefined, 'an API key has no sign-in');
    // The Computer tab shows sample processes, never this computer's, and stops nothing.
    const auth = { Cookie: cookie, 'Content-Type': 'application/json', Origin: url };
    const pc = await (await fetch(`${url}/api/pc`, { headers: auth })).json();
    assert.equal(pc.host, 'workstation');
    assert.ok(!pc.topCpu.some((p) => p.pid === process.pid), 'not the real process list');
    const kill = await fetch(`${url}/api/pc/kill`, { method: 'POST', headers: auth, body: JSON.stringify({ pid: pc.topCpu[0].pid }) });
    assert.equal(kill.status, 409);
    const off = await fetch(`${url}/api/pc/power`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'reboot', confirm: 'reboot' }) });
    assert.equal(off.status, 409);
    const pj = await (await fetch(`${url}/api/pcsetup/projects`, { headers: auth })).json();
    assert.ok(pj.repos.some((r) => r.rel === 'shop-frontend' && r.ok && r.branch === 'main'), 'the sample projects are real git repositories');
    // The join line as a hub with its own certificate gives it: a documentation address and a made-up fingerprint.
    const code = await (await fetch(`${url}/api/links/code`, { method: 'POST', headers: auth, body: '{}' })).json();
    assert.equal(code.certificate, 'own');
    assert.match(code.command, new RegExp(`^hoprig join https://203\\.0\\.113\\.10 ${code.code} --fingerprint sha256:[A-Za-z0-9_-]{43}$`));
    assert.match(code.note, /fingerprint/);
    // A chat (src/demo/chat.mjs): it edits a file with a diff and waits for the OK to run the tests; the file really
    // changed, so the editor's Source Control has it too.
    const get = async (p) => (await fetch(`${url}${p}`, { headers: auth })).json();
    let chat = null;
    for (let i = 0; i < 80 && !(chat && chat.status === 'attention'); i++) {
      chat = (await get('/api/chats')).chats.find((c) => c.title === 'Fix the cart total with a discount') || null;
      if (!chat || chat.status !== 'attention') await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(chat && chat.status, 'attention', `the chat waits for an OK: ${JSON.stringify(chat)}`);
    assert.match(chat.short, /^~\/Workspace\/projects\/shop-frontend$/);
    const events = (await get(`/api/chats/${chat.chatId}?from=0`)).events;
    assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'Edit'), 'an edit');
    assert.ok(events.some((e) => e.kind === 'ask' && /npm test/.test(JSON.stringify(e))), 'the OK it waits for: npm test');
    const cart = fs.readFileSync(path.join(root, 'home', 'Workspace', 'projects', 'shop-frontend', 'src', 'cart.js'), 'utf8');
    assert.match(cart, /return Math\.round\(sum \* \(1 - discount\) \* 100\) \/ 100;/, 'the file changed on disk');
    // OpenCode as a second coding tool: on, its version from the package file; its program runs nothing.
    const tools = await get('/api/codetools');
    const oc = (tools.tools || tools).find((t) => t.id === 'opencode');
    assert.equal(oc.on, true);
    assert.equal(oc.installed, '2.3.0');

    await hooks.stop();
    assert.equal(fs.existsSync(root), false, 'its folder is removed');
    await assert.rejects(fetch(`${url}/api/me`), 'the server is gone');
    assert.equal(fs.readFileSync(marker, 'utf8'), before, 'the real config is untouched');
    assert.equal(listing(), was, 'nothing written to the real folders');
  } finally {
    await hooks.stop?.();
    box.cleanup();
  }
});

test('demo: a folder left by a demo that was killed hard is removed by the next one; a live one is kept', async () => {
  const { sweepStale } = await import('../../src/demo/index.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  try {
    const dead = path.join(tmp, 'hoprig-demo-dead');
    const live = path.join(tmp, 'hoprig-demo-live');
    const foreign = path.join(tmp, 'hoprig-demo-nopid');
    for (const d of [dead, live, foreign]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(dead, 'demo.pid'), '999999');
    fs.writeFileSync(path.join(live, 'demo.pid'), String(process.pid));
    sweepStale(tmp);
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(foreign), true, 'without a pid file it is left alone');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('demo: every coding tool\'s own folder is inside the demo, so its brain links never reach the real ones', async () => {
  const { isolate } = await import('../../src/demo/index.mjs');
  const { toolHomes } = await import('../../src/workspace/link.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-iso-'));
  try {
    const env = { HOME: '/real/home', XDG_CONFIG_HOME: '/real/home/.config', OPENCODE_CONFIG_DIR: '/real/oc', CODEX_HOME: '/real/codex', PATH: '/usr/bin', HOPRIG_RUN_FILE: '/real/run', GH_TOKEN: 'x', GITHUB_TOKEN: 'x' };
    const home = isolate(root, env);
    const homes = toolHomes(env.HOME, env);
    for (const dir of Object.values(homes)) assert.ok(dir.startsWith(home + path.sep), dir);
    assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
    // Nothing of the session that started the demo, and no real GitHub sign-in.
    assert.deepEqual([env.HOPRIG_RUN_FILE, env.GH_TOKEN, env.GITHUB_TOKEN], [undefined, undefined, undefined]);
    assert.ok(env.GH_CONFIG_DIR.startsWith(home + path.sep));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
