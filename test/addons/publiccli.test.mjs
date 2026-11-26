// `hoprig public` (src/addons/publiccli.mjs) as a person types it: the refusals with what to do, a generated strong
// password in one step, the choice kept while no dashboard runs, and against a running switch (this test process
// plays the dashboard, with a stand-in cloudflared) the address once it is on. The old words still lead here.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { REPO } from '../machines/harness.mjs';
import { sandbox } from '../server/helpers.mjs';

// The stand-in cloudflared is a Node script with no extension, started by name through its #! line: Windows starts
// only an .exe or .com by name, so a test that runs it is skipped there.
const STANDIN = { skip: process.platform === 'win32' && 'the stand-in is started through its #! line' };

const box = sandbox('publiccli');
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('cloudflared version 2026.10.1 (built 2026-10-15-1724 UTC)'); process.exit(0); }
process.on('SIGTERM', () => process.exit(0));
process.stderr.write('2026-11-14T04:52:43Z INF |  https://cli-' + process.pid + '-words.trycloudflare.com   |\\n');
setTimeout(() => process.stderr.write('2026-11-14T04:52:45Z INF Registered tunnel connection connIndex=0\\n'), 100);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { hashTag } = await import('../../src/server/strength.mjs');
const { validName } = await import('../../src/profiles.mjs');
const S = await import('../../src/addons/linkswitch.mjs');
const { install, installPlan } = await import('../../src/addons/publiclink.mjs');
// A missing cloudflared is downloaded (fetch is the test's): never Homebrew, which would install on the computer itself.
const installFn = (o) => install({ ...o, plan: installPlan({ hasBrew: false }) });
test.after(async () => {
  await S.resetForTests();
  box.cleanup();
});

const run = async (args, input) => {
  const p = promisify(execFile)(process.execPath, [path.join(REPO, 'bin', 'hoprig.mjs'), ...args], { env: process.env, encoding: 'utf8', timeout: 60_000 });
  if (input !== undefined) {
    p.child.stdin.end(input);
  } else p.child.stdin.end();
  try {
    const { stdout, stderr } = await p;
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code, out: (e.stdout || '') + (e.stderr || '') };
  }
};

test('refusals say what to do; a strong password in one step; with no dashboard the choice waits for it', async () => {
  assert.equal(validName('public'), false, 'a command word, never a profile name');
  let r = await run(['public']);
  assert.deepEqual([r.code, r.out.trim()], [0, 'The public link is off (kind: Temporary). Turn it on: hoprig public on']);
  r = await run(['public', 'on', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.out, /Set a dashboard password first/);
  assert.match(r.out, /hoprig public on --new-password FILE/);
  const weak = await hashPassword('weakpass1');
  saveConfig({ server: { passwordHash: weak, passwordCheck: { tag: hashTag(weak), strong: false, why: 'it has fewer than 12 characters' } } });
  r = await run(['public', 'on', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.out, /too weak for a public link: it has fewer than 12 characters/);
  assert.equal(loadConfig().publicLink, undefined, 'nothing switched');
  r = await run(['public', 'on', '--custom', '--yes', '--new-password', path.join(box.root, 'pw.txt')]);
  assert.equal(r.code, 1, 'the password is strong now, but Custom is not set up');
  assert.match(r.out, /Settings → Public link → Custom → Set up/);
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(box.root, 'pw.txt')).mode & 0o777).toString(8), '600');
  assert.equal(loadConfig().server.passwordCheck.strong, true);
  r = await run(['public', 'on']);
  assert.equal(r.code, 1);
  assert.match(r.out, /Add --yes to turn it on without a question/, 'no terminal: no silent turn-on');
  r = await run(['public', 'on', '--temporary', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Anyone|sign-in page/);
  assert.match(r.out, /Saved: it turns on when the dashboard runs/);
  assert.deepEqual([loadConfig().publicLink.on, loadConfig().publicLink.kind], [true, 'temporary']);
  r = await run(['public', 'status', '--json']);
  assert.deepEqual(JSON.parse(r.out), { hoprig: 'public-link', on: true, kind: 'temporary', state: 'waiting for the dashboard', url: null, error: null, dashboard: false });
  // While it is on, the password cannot become a weak one.
  r = await run(['passwd'], 'shortpw1\n');
  assert.equal(r.code, 1);
  assert.match(r.out, /public link is on, so the password must be strong/);
  r = await run(['public', 'off']);
  assert.deepEqual([r.code, r.out.trim()], [0, 'The public link is off.']);
});

test('with the dashboard running: on waits for the address and shows it with a sign-in QR; the old words lead here', STANDIN, async () => {
  // This process is "the dashboard": its address file, and the switch attached as the dashboard does.
  fs.writeFileSync(path.join(box.state, 'dashboard.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 7666, at: Date.now() }));
  await S.attach({ installFn, notifyFn: async () => ({ sent: false }), everyMs: 100 });
  let r = await run(['public', 'on', '--yes']);
  assert.equal(r.code, 0, r.out);
  const url = /The public link: (https:\/\/cli-\d+-words\.trycloudflare\.com)/.exec(r.out)?.[1];
  assert.ok(url, r.out);
  assert.ok(r.out.includes(`${url}/login#link=`), 'a one-time sign-in link for that address');
  r = await run(['public', 'status']);
  assert.equal(r.out.trim(), `The public link is on (Temporary): ${url}`);
  // `hoprig addons status|stop public-link` (a profile's PRERUN may still use the old words).
  r = await run(['addons', 'status', 'public-link']);
  assert.match(r.out, /The public link is on \(Temporary\)/);
  r = await run(['addons', 'stop', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.ok(await (async () => { for (let i = 0; i < 100 && S.status().state !== 'off'; i++) await new Promise((x) => setTimeout(x, 50)); return S.status().state === 'off'; })());
  // The old start, as a PRERUN runs it (no terminal): it turns the link on without a question, as it always did,
  // and at the next launch, with the link on already, it only says where it is.
  r = await run(['addons', 'start', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The public link: https:\/\/cli-\d+-words\.trycloudflare\.com/);
  const pid = S.readRecord().pid;
  r = await run(['addons', 'start', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Add --yes|Turn it on\?|makes this dashboard reachable/, 'no question when it is on already');
  assert.match(r.out, /The public link: https:/);
  assert.equal(S.readRecord().pid, pid, 'the running tunnel was left alone');
  await S.detach();
});

test('a start that failed is tried again by the next `hoprig public on`, and its old error is not this one\'s answer', STANDIN, async () => {
  fs.writeFileSync(path.join(box.state, 'dashboard.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 7666, at: Date.now() }));
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
  await S.attach({ installFn, notifyFn: async () => ({ sent: false }), everyMs: 100 });
  // cloudflared cannot be found or installed (the network is down at boot): the start fails, the switch stays on.
  const hidden = path.join(box.root, 'hidden');
  fs.renameSync(bin, hidden);
  // Not installed: no cloudflared on PATH at all. The runner's trap comes first on the PATH, and the product would
  // take it for an installed cloudflared and start it; a PATH of the test's own empty folder is a computer without one.
  const was = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(box.root, 'nobin-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); };
  try {
    saveConfig({ publicLink: { on: true, kind: 'temporary', at: Date.now() } });
    for (let i = 0; i < 100 && S.status().state !== 'error'; i++) await new Promise((x) => setTimeout(x, 50));
    assert.equal(S.status().state, 'error', JSON.stringify(S.status()));
    assert.equal(S.status().on, true, 'a start that failed by itself keeps the switch on');
    assert.match(S.readRecord().error, /could not be installed/);
  } finally {
    process.env.PATH = was;
    globalThis.fetch = realFetch;
    fs.renameSync(hidden, bin);
  }
  // Now it can run. `hoprig public on` again: a new request, started again at once, and the old error is ignored.
  const r = await run(['public', 'on', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The public link: https:\/\/cli-\d+-words\.trycloudflare\.com/);
  assert.equal(S.status().state, 'on');
  await S.detach();
});

test('the old start in a PRERUN (no terminal): a password not good enough for the link is said, and the session still starts', async () => {
  try { fs.rmSync(path.join(box.state, 'dashboard.json')); } catch { /* none */ }
  saveConfig({ publicLink: undefined });
  const hash = await hashPassword('a-long-enough-password-2026');
  // After an update: the password was never judged (no passwordCheck yet).
  saveConfig({ server: { passwordHash: hash, passwordCheck: undefined } });
  let r = await run(['addons', 'start', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The public link was not turned on: Type your dashboard password once/);
  assert.match(r.out, /Settings → Public link asks for it in place/);
  assert.doesNotMatch(r.out, /Your dashboard password \(to check/, 'no hidden prompt');
  assert.equal(loadConfig().publicLink, undefined, 'nothing switched');
  // Judged weak, and none at all: the same.
  saveConfig({ server: { passwordCheck: { tag: hashTag(hash), strong: false, why: 'it is one of the passwords people try first' } } });
  r = await run(['addons', 'start', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /was not turned on: Your dashboard password is too weak/);
  // On already but held back (from another computer's page, or a file): it says that it waits.
  saveConfig({ publicLink: { on: true, kind: 'temporary' } });
  r = await run(['addons', 'start', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The public link is on but waits: Your dashboard password is too weak/);
  saveConfig({ publicLink: undefined, server: { passwordHash: undefined, passwordCheck: undefined } });
  r = await run(['addons', 'start', 'public-link']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /was not turned on: Set a dashboard password first/);
  // The new words typed by a person still fail, so a script sees it did not turn on.
  r = await run(['public', 'on', '--yes']);
  assert.equal(r.code, 1);
});
