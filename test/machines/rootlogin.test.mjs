// The hub's "Install Hoprig on <server>" when the SSH login there is root (`id -u` there is 0): nothing is installed
// under root by itself, and the answer says why and what to do. The sentence typed on the page keeps Hoprig on root
// there on purpose (install.sh then gets --stay-root). An ordinary login installs as before. The remote is the fake
// ssh with a stand-in `id` first on its PATH; the installer is a stand-in that writes what it was asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { asBrowser, fakeRemote, miniDashboard } from './harness.mjs';

const box = sandbox('machines-rootlogin');
const { createMachines } = await import('../../src/machines/index.mjs');
const { ROOT_LOGIN_WHY } = await import('../../src/setup/rootfacts.mjs');
const skip = process.platform === 'win32' && 'POSIX scripts';

const asked = path.join(box.root, 'installer-asked.log');
const script = path.join(box.root, 'fake-install.sh');
fs.writeFileSync(script, `echo "installer $*" >> '${asked}'\necho done\n`);

/** A fake remote whose login has user id `uid` (a number, or null: `id` says nothing and fails). */
function remoteAs(name, uid) {
  const r = fakeRemote(path.join(box.root, name), { installed: false });
  fs.writeFileSync(path.join(r.bin, 'id'), uid === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\n[ "$1" = "-u" ] && echo ${uid}\n`, { mode: 0o755 });
  return r;
}

async function hubFor(r, fn) {
  const opts = { claudeVersion: async () => null, hub: { probeTimeoutMs: 600, tunnelWaitMs: 5000, hubName: 'test-hub', ssh: { env: r.sshEnv }, installer: () => ({ kind: 'file', value: script }) } };
  const hub = await miniDashboard({ createMachines, opts }).listen();
  try {
    await fn(asBrowser(hub.base));
  } finally {
    await hub.close();
  }
}

async function finished(browser) {
  let st;
  for (let i = 0; i < 100; i++) {
    st = (await browser('/api/machines/install?from=0')).json;
    if (!st.running && st.result) return st;
    await new Promise((res) => setTimeout(res, 50));
  }
  return st;
}
const installerCalls = () => (fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8').split('\n').filter(Boolean) : []);

test('a root login: nothing is installed, and the answer says it is root, why, and what to do', { skip }, async () => {
  const r = remoteAs('root-login', 0);
  await hubFor(r, async (browser) => {
    const res = await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2' } });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, 'root-login');
    assert.equal(res.json.error, `The login root@box2 is root, so nothing was installed there yet. ${ROOT_LOGIN_WHY}`);
    assert.match(res.json.error, /This page can make an ordinary user there for the work/);
    assert.match(res.json.error, /an ordinary login that has sudo/);
    assert.match(res.json.error, /keep Hoprig on root there on purpose/);
    assert.deepEqual(installerCalls(), [], 'the installer never ran');
    // ssh was asked only for the user id: nothing else was sent there.
    const calls = r.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].at(-1), 'id -u');
    assert.equal((await browser('/api/machines/install?from=0')).json.running, false);
    // A sentence that is not the one: refused, and still nothing runs.
    const wrong = await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2', stayRoot: { sentence: 'yes' } } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, 'stay-root');
    assert.deepEqual(installerCalls(), []);
  });
});

test('a root login with the sentence typed: installed on root on purpose, with --stay-root', { skip }, async () => {
  const r = remoteAs('root-stay', 0);
  await hubFor(r, async (browser) => {
    const res = await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2', stayRoot: { sentence: 'keep Hoprig on root' } } });
    assert.equal(res.status, 200, res.text);
    const st = await finished(browser);
    assert.equal(st.result.ok, true);
    assert.deepEqual(installerCalls(), ['installer --yes --stay-root']);
    assert.ok(!r.calls().some((c) => c.at(-1) === 'id -u'), 'the root look is not needed when the choice is made');
  });
  fs.rmSync(asked, { force: true });
});

test('an ordinary login, or one whose user id cannot be told: the install goes on as before (install.sh still refuses root itself)', { skip }, async () => {
  for (const [name, uid] of [['plain-login', 1000], ['unknown-login', null]]) {
    const r = remoteAs(name, uid);
    await hubFor(r, async (browser) => {
      const res = await browser('/api/machines/install', { body: { target: 'alex@box2', confirm: 'alex@box2' } });
      assert.equal(res.status, 200, res.text);
      const st = await finished(browser);
      assert.equal(st.result.ok, true, name);
    });
    // As root the installer would make nothing without the confirmation: --no-work-user (an ordinary login ignores it).
    assert.deepEqual(installerCalls(), ['installer --yes --no-work-user'], name);
    fs.rmSync(asked, { force: true });
  }
});

// After the page's confirmation (workUser): the installer there makes the work user (install.sh --yes as root, played
// by a stand-in that says what the real one says at its end). The hub names that user's login only after a real login
// as it worked; a login that does not work leaves nothing added and says what to do.
function workInstaller(name, { works }) {
  const r = remoteAs(name, 0);
  const file = path.join(box.root, `${name}-install.sh`);
  const shim = works ? `printf '#!/bin/sh\\necho hoprig 0.0.0-made-up\\n' > '${r.shim}/hoprig'; chmod +x '${r.shim}/hoprig'\n` : '';
  fs.writeFileSync(file, `echo "installer $*" >> '${asked}'\n${shim}echo "Hoprig is set up for the user hoprig, and works as hoprig from now on."\n`);
  return { r, file };
}
async function hubWith(r, file, fn) {
  const opts = { claudeVersion: async () => null, hub: { probeTimeoutMs: 600, tunnelWaitMs: 5000, hubName: 'test-hub', ssh: { env: r.sshEnv }, installer: () => ({ kind: 'file', value: file }) } };
  const hub = await miniDashboard({ createMachines, opts }).listen();
  try {
    await fn(asBrowser(hub.base));
  } finally {
    await hub.close();
  }
}

test('a root login with the confirmation: the work user is made there, and the hub names its login only after a login as it worked', { skip }, async () => {
  const { r, file } = workInstaller('work-yes', { works: true });
  await hubWith(r, file, async (browser) => {
    const res = await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2', workUser: true } });
    assert.equal(res.status, 200, res.text);
    const st = await finished(browser);
    assert.deepEqual(st.result, { ok: true, code: 0, user: 'hoprig', switched: true, target: 'hoprig@box2' });
    assert.deepEqual(installerCalls(), ['installer --yes'], 'the yes of install.sh as root, nothing more');
    const logins = r.calls().map((c) => c.find((a) => /@box2$/.test(a)));
    assert.deepEqual(logins.filter((t) => t === 'hoprig@box2').length > 0, true, 'a real login as the user was tried');
    assert.match(st.lines.join('\n'), /A login as hoprig@box2 worked: this main computer reaches the server as hoprig\./);
  });
  fs.rmSync(asked, { force: true });
});

test('a root login with the confirmation whose user login does not work: nothing is added, and the page is told what to do', { skip }, async () => {
  const { r, file } = workInstaller('work-nologin', { works: false });
  await hubWith(r, file, async (browser) => {
    await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2', workUser: true } });
    const st = await finished(browser);
    assert.equal(st.result.ok, false);
    assert.equal(st.result.switched, false);
    assert.equal(st.result.user, 'hoprig');
    assert.match(st.result.error, /Hoprig is set up for hoprig there, but a login as hoprig@box2 did not work/);
    assert.match(st.lines.join('\n'), /Put your SSH key into hoprig's ~\/\.ssh\/authorized_keys there, then add hoprig@box2\./);
    assert.deepEqual((await browser('/api/machines')).json.machines || [], [], 'no computer was added');
  });
  fs.rmSync(asked, { force: true });
});

test.after(() => box.cleanup());

test('a root login with his choices: install.sh there gets --user and --no-admin; a bad name is refused before anything', { skip }, async () => {
  const { r, file } = workInstaller('work-choice', { works: false });
  await hubWith(r, file, async (browser) => {
    const bad = await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2', workUser: { name: 'x;rm -rf ~', noAdmin: true } } });
    assert.equal(bad.status, 400, bad.text);
    assert.deepEqual(installerCalls(), [], 'nothing was run there');
    const res = await browser('/api/machines/install', { body: { target: 'root@box2', confirm: 'root@box2', workUser: { name: 'alex', noAdmin: true } } });
    assert.equal(res.status, 200, res.text);
    await finished(browser);
    assert.deepEqual(installerCalls(), ['installer --yes --user alex --no-admin']);
  });
  fs.rmSync(asked, { force: true });
});
