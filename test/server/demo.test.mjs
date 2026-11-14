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
