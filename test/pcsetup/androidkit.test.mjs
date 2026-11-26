// The Android kit end to end in a temporary home with a workspace, against a stand-in vendor (vendor.mjs: a server on
// 127.0.0.1 handed in as the getter; a trimmed copy of the list sdkmanager reads, with the size and sha1 of a tiny
// archive made here). The command-line tools land at development/sdk/android-sdk/cmdline-tools/latest, the shell block
// appears once, a second run does nothing; every refusal leaves the home exactly as it was; Google's licence is never
// accepted (no command runs, the plan shows the one the owner types); an SDK or an Android Studio found elsewhere is
// used where it is, through a link only for a kit the owner named, and not one byte of it changes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipOf } from './archives.mjs';
import { quietUi } from './dryrun-fixture.mjs';
import { vendor } from './vendor.mjs';

const { sysFacts, detectKits } = await import('../../src/pcsetup/detect.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { ANDROID, buildPlan, kitById } = await import('../../src/pcsetup/kits.mjs');
const { runInside } = await import('../../src/pcsetup/devinstall.mjs');
const { chooseAndroid } = await import('../../src/pcsetup/fetchkit.mjs');
const { yourSteps, kitInfo } = await import('../../src/pcsetup/kitinfo.mjs');
const { BLOCK_BEGIN } = await import('../../src/setup/localbin.mjs');

const LIST = '/android/repository/repository2-3.xml';
const ARCHIVE = '/android/repository/commandlinetools-linux-16111833_latest.zip';
const TOOLS = [
  { name: 'cmdline-tools/', type: 'dir' },
  { name: 'cmdline-tools/bin/', type: 'dir' },
  { name: 'cmdline-tools/bin/sdkmanager', type: 'file', data: '#!/bin/sh\necho 23.0\n', mode: 0o100755 },
  { name: 'cmdline-tools/source.properties', type: 'file', data: 'Pkg.Revision=23.0\n' },
];
const EXTRAS = { suggested: [], php: [], java: null };
const sha = (b, kind = 'sha256') => crypto.createHash(kind).update(b).digest('hex');
const FIXTURE = fs.readFileSync(new URL('./fixtures/android-repository.xml', import.meta.url), 'utf8');
const listFor = (archive, { size = archive.length, edit = (t) => t } = {}) => edit(FIXTURE.replaceAll('{size}', String(size)).replaceAll('{sha1}', sha(archive, 'sha1')));

/** Every entry under `dir`, links not followed: its kind, mode, content hash (and a file's mtime). */
function snap(dir) {
  const out = {};
  const walk = (d, rel) => {
    let names;
    try {
      names = fs.readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[r] = `dir ${st.mode & 0o777}`;
        walk(p, r);
      } else out[r] = `file ${st.mode & 0o777} ${sha(fs.readFileSync(p))} ${st.mtimeMs}`;
    }
  };
  walk(dir, '');
  return out;
}

function world(tc) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'androidkit-')));
  tc.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = path.join(home, 'Workspace');
  fs.mkdirSync(ws, { recursive: true });
  Object.assign(process.env, { HOME: home, HOPRIG_WORKSPACE_DIR: ws });
  return { root, home, ws, place: path.join(ws, 'development', 'sdk', 'android-sdk') };
}
// A Linux computer with unzip and nothing else of the system: no program is started by the detection.
const sysOf = (w, over = {}) => sysFacts({
  platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', home: w.home, ws: w.ws, env: { PATH: '', SHELL: '/bin/bash' }, nvm: null, // seal: an environment given as data to the made-up system facts; no process is started with it
  has: (b) => ['unzip', 'sudo'].includes(b), exists: (f) => f.startsWith(w.root) && fs.existsSync(f), which: () => null, list: () => [],
  run: async () => ({ ok: false, code: 1, stdout: '', stderr: '' }), ...over,
});
async function runKit(sys, get, o = {}) {
  const ui = await quietUi({ yes: true });
  const ran = [];
  const r = await runPcSetup({ ui, yes: true, kits: ['android'], sys, get, runner: async (argv) => (ran.push(argv), { ok: true, code: 0 }), extras: EXTRAS, rules: false, codingTools: { findTool: () => null }, ...o });
  return { ...r, text: ui.text(), ran };
}
const made = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, { mode: 0o755 });
  }
  return dir;
};

test('the stand-in vendor: the command-line tools land at cmdline-tools/latest, the shell block once; a second run does nothing', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  const archive = zipOf(TOOLS);
  const v = await vendor(tc, { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { headers: { 'content-length': String(archive.length) }, body: archive } });
  const r = await runKit(await sysOf(w), v.get);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.ran, [], 'no command ran: no sdkmanager, no licence answered, never sudo');
  assert.deepEqual(v.asked, [`https://${ANDROID.host}${LIST}`, `https://${ANDROID.host}${ARCHIVE}`]);
  const mgr = path.join(w.place, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  assert.equal(fs.readFileSync(mgr, 'utf8'), '#!/bin/sh\necho 23.0\n');
  assert.deepEqual(fs.readdirSync(w.place), ['cmdline-tools']);
  assert.ok(!fs.existsSync(path.join(w.place, 'licenses')), 'no licence is accepted by Hoprig');
  assert.deepEqual(fs.readdirSync(path.join(w.ws, 'development')), ['sdk'], 'no temporary folder is left');
  assert.match(r.text, /The Android SDK command-line tools 23\.0 are in ~\/Workspace\/development\/sdk\/android-sdk/);
  for (const f of ['.profile', '.bashrc']) {
    const t = fs.readFileSync(path.join(w.home, f), 'utf8');
    assert.equal(t.split(BLOCK_BEGIN).length - 1, 1, f);
    assert.match(t, /export ANDROID_HOME="\$HOME\/Workspace\/development\/sdk\/android-sdk"  # android-home/);
    assert.match(t, /PATH="\$HOME\/Workspace\/development\/sdk\/android-sdk\/cmdline-tools\/latest\/bin:\$PATH"/);
    assert.match(t, /PATH="\$HOME\/Workspace\/development\/sdk\/android-sdk\/platform-tools:\$PATH"/);
  }
  // The licence is the owner's: said with the command he types, before and after.
  assert.match(r.text, /Android: yours to do: Google's licence for the Android SDK is yours to read and accept: Hoprig never accepts it for you[^\n]*\n {4}"\$HOME\/Workspace\/development\/sdk\/android-sdk\/cmdline-tools\/latest\/bin\/sdkmanager" --sdk_root="\$HOME\/Workspace\/development\/sdk\/android-sdk" --licenses\n/);
  const found = (await detectKits(await sysOf(w), ['android'])).android;
  assert.deepEqual([found[0].state, found[0].version, found[0].detail], ['ok', '23.0', 'in development/sdk/android-sdk']);
  assert.equal(found[1].state, 'missing', 'Android Studio is not downloaded');

  const before = snap(w.home);
  const again = await runKit(await sysOf(w), v.get);
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /Everything is here\. Nothing to do\./);
  assert.equal(v.asked.length, 2, 'the second run asked the vendor nothing');
  assert.deepEqual(snap(w.home), before, 'the second run changed nothing');
});

test('the plan says it before the yes: list, host, size, place, the shell lines, the licence and where Android Studio comes from', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  const sys = await sysOf(w);
  const found = await detectKits(sys, ['android']);
  const plan = buildPlan(['android'], found, sys, { named: ['android'] });
  assert.deepEqual(plan.steps.map((s) => s.do), ['android-sdk', 'shell']);
  assert.equal(plan.admin, false);
  assert.ok(plan.steps.every((s) => !s.argv), 'no command: nothing runs sdkmanager, nothing answers a licence');
  assert.equal(plan.steps[0].words, 'download the Android SDK command-line tools (the ones https://dl.google.com/android/repository/repository2-3.xml names) from dl.google.com over https, about 185 MB, check their sha1 (the only checksum Google\'s list gives), unpack them into ~/Workspace/development/sdk/android-sdk/cmdline-tools/latest');
  assert.deepEqual(plan.steps[1].lines.map((l) => l.key), ['android-home', 'android-tools', 'android-adb']);
  assert.match(plan.cannot.find((c) => c.item === 'android-studio').why, /^Hoprig does not download Android Studio \(it is large and has its own installer\): get it from https:\/\/developer\.android\.com\/studio, and Hoprig finds it afterwards\.$/);
  const info = kitInfo(kitById('android'), found, sys, plan);
  assert.equal(info.downloads[0].text, 'the Android SDK command-line tools, from dl.google.com over https (checked against its sha1)');
  assert.equal(info.size.text, 'about 185 MB to download, about 185 MB on disk');
  assert.equal(info.changes[0], 'a new folder ~/Workspace/development/sdk/android-sdk');
  assert.deepEqual(info.yours.map((y) => y.command), [
    '"$HOME/Workspace/development/sdk/android-sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$HOME/Workspace/development/sdk/android-sdk" --licenses',
    '"$HOME/Workspace/development/sdk/android-sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$HOME/Workspace/development/sdk/android-sdk" --install platform-tools',
  ]);
  // A dry run asks nothing and changes nothing.
  const before = snap(w.home);
  const r = await runPcSetup({ ui: await quietUi({ yes: true }), yes: true, dryRun: true, kits: ['android'], sys, get: async () => { throw new Error('asked'); }, extras: EXTRAS, rules: false, codingTools: { findTool: () => null } });
  assert.equal(r.code, 0);
  assert.deepEqual(snap(w.home), before);
  // No workspace: nothing to install into, and it says why.
  const none = await sysOf(w, { ws: null });
  const p2 = buildPlan(['android'], await detectKits(none, ['android']), none);
  assert.deepEqual(p2.steps, []);
  assert.match(p2.cannot.find((c) => c.item === 'android-sdk').why, /Set up the workspace first/);
  assert.equal(kitById('android').windows, false);
  assert.equal(kitById('android').defaultOn, false);
});

test('the list: the stable cmdline-tools;latest for this computer, and nothing it does not check', () => {
  const archive = zipOf(TOOLS);
  const text = listFor(archive);
  const o = { base: ANDROID.base, ceiling: ANDROID.ceiling };
  assert.deepEqual(chooseAndroid(text, { platform: 'linux', arch: 'x64', ...o }), { version: '23.0', url: 'https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip', sha1: sha(archive, 'sha1'), size: archive.length });
  assert.match(chooseAndroid(text, { platform: 'darwin', arch: 'arm64', ...o }).url, /commandlinetools-mac_arm64-16111833_latest\.zip$/);
  assert.match(chooseAndroid(text, { platform: 'darwin', arch: 'x64', ...o }).url, /commandlinetools-mac_x86_64-16111833_latest\.zip$/);
  assert.throws(() => chooseAndroid(text, { platform: 'win32', arch: 'x64', ...o }), /no command-line tools for this computer/);
  assert.throws(() => chooseAndroid(text, { platform: 'linux', arch: 'x64', base: o.base, ceiling: archive.length - 1 }), /more than Hoprig's ceiling/);
});

const refusals = (archive) => ({
  'a wrong sha1': { list: listFor(archive, { edit: (t) => t.replaceAll(sha(archive, 'sha1'), '1'.repeat(40)) }), why: /sha1 is not the one the vendor publishes/ },
  'a size in the list the server does not send': { list: listFor(archive, { size: archive.length + 5 }), headers: { 'content-length': String(archive.length) }, why: /the server says \d+ bytes, the vendor's list \d+: refused/ },
  'more bytes than the list gives (no Content-Length)': { list: listFor(archive, { size: archive.length - 5 }), headers: { 'transfer-encoding': 'chunked' }, why: /more than the \d+ bytes the vendor's list gives arrived/ },
  'the list names an archive on another host': { list: listFor(archive, { edit: (t) => t.replace('<url>commandlinetools-linux-16111833_latest.zip', '<url>https://example.com/tools.zip') }), why: /names an archive Hoprig does not take/ },
  'the list names a path with ..': { list: listFor(archive, { edit: (t) => t.replace('<url>commandlinetools-linux-16111833_latest.zip', '<url>../../evil/tools.zip') }), why: /names an archive Hoprig does not take/ },
  'the tools are not on the stable channel': { list: listFor(archive, { edit: (t) => t.replace('<channel id="channel-0">stable</channel>', '<channel id="channel-0">beta</channel><channel id="channel-9">stable</channel>') }), why: /not on its stable channel/ },
  'no sha1 in the list': { list: listFor(archive, { edit: (t) => t.replaceAll('type="sha1"', 'type="sha256"') }), why: /gives no sha1/ },
  'not the list sdkmanager reads': { list: '<html>sign in</html>', why: /not the list sdkmanager reads/ },
  'a redirect to another host': { archive: { status: 302, headers: { location: 'https://example.com/tools.zip' } }, why: /sent the download on to example\.com/ },
  'a redirect to http': { archive: { status: 302, headers: { location: `http://${ANDROID.host}${ARCHIVE}` } }, why: /which is not its own host over https/ },
  'a redirect on the host, outside its folder': { archive: { status: 302, headers: { location: `https://${ANDROID.host}/somewhere/else/tools.zip` } }, why: /outside \/android\/repository\/ on dl\.google\.com: refused/ },
  'an archive entry with ..': { bad: [...TOOLS, { name: 'cmdline-tools/../../evil', type: 'file', data: 'x' }], why: /a path with \.\./ },
  'an archive link that points outside': { bad: [...TOOLS, { name: 'cmdline-tools/out', type: 'link', link: '../../../..' }], why: /a link that points outside/ },
  'an archive with another top folder': { bad: [...TOOLS, { name: 'tools/', type: 'dir' }], why: /outside its cmdline-tools\/ folder/ },
});

for (const [what, c] of Object.entries(refusals(zipOf(TOOLS)))) {
  test(`refused, the home exactly as before and no temporary file: ${what}`, async (tc) => {
    const w = world(tc);
    const archive = c.bad ? zipOf(c.bad) : zipOf(TOOLS);
    const v = await vendor(tc, { [LIST]: { body: c.list || listFor(archive) }, [ARCHIVE]: c.archive || { headers: c.headers || {}, body: archive } });
    const before = snap(w.home);
    const r = await runKit(await sysOf(w), v.get);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, c.why);
    assert.equal(r.text.split('retry: hoprig pc setup --kits android').length - 1, 1, 'one retry line for the kit');
    assert.deepEqual(snap(w.home), before, 'nothing of the home changed: no place, no temporary file, no shell block');
    assert.ok(!v.asked.some((u) => !u.startsWith(`https://${ANDROID.host}/`)), v.asked.join('\n'));
  });
}

test('a stop in the middle of the download: the home as before, and the next run starts again and lands', async (tc) => {
  const w = world(tc);
  const archive = zipOf(TOOLS);
  const ac = new AbortController();
  let cut = true;
  const v = await vendor(tc, {
    [LIST]: { body: listFor(archive) },
    [ARCHIVE]: (req, res) => {
      res.writeHead(200, { 'content-length': String(archive.length) });
      if (!cut) return res.end(archive);
      res.write(archive.subarray(0, 50));
      setTimeout(() => ac.abort(), 20);
    },
  });
  const before = snap(w.home);
  const r = await runKit(await sysOf(w), v.get, { signal: ac.signal });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /the download was stopped/);
  assert.deepEqual(snap(w.home), before);
  cut = false;
  const again = await runKit(await sysOf(w), v.get);
  assert.equal(again.code, 0, again.text);
  assert.ok(fs.existsSync(path.join(w.place, 'cmdline-tools', 'latest', 'bin', 'sdkmanager')));
});

test('the place already taken (a folder, a file, a broken link): never written over, nothing downloaded', async (tc) => {
  const makers = {
    'a folder': (p) => fs.mkdirSync(p),
    'a file': (p) => fs.writeFileSync(p, 'mine\n'),
    'a broken link': (p, w) => fs.symlinkSync(path.join(w.root, 'gone'), p),
  };
  for (const [what, make] of Object.entries(makers)) {
    const w = world(tc);
    fs.mkdirSync(path.dirname(w.place), { recursive: true });
    make(w.place, w);
    const v = await vendor(tc, {});
    const before = snap(w.root);
    const r = await runKit(await sysOf(w), v.get);
    assert.match(r.text, /development\/sdk\/android-sdk is there already[^\n]*Hoprig never writes over it/, `${what}: ${r.text}`);
    assert.deepEqual(v.asked, [], `${what}: nothing was asked`);
    assert.deepEqual(snap(w.root), before, what);
  }
  // Taken between the plan and the run: the step itself refuses, before it asks anything.
  const w = world(tc);
  const sys = await sysOf(w);
  const step = buildPlan(['android'], await detectKits(sys, ['android']), sys).steps[0];
  fs.mkdirSync(w.place, { recursive: true });
  const v = await vendor(tc, {});
  const r = await runInside(step, { get: v.get });
  assert.deepEqual([r.ok, r.code], [false, 'taken']);
  assert.deepEqual(v.asked, []);
});

test('adoption: an SDK in ~/Android/Sdk and an Android Studio in ~/android-studio are used where they are; links only for a named kit', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  const sdk = made(path.join(w.home, 'Android', 'Sdk'), { 'cmdline-tools/latest/bin/sdkmanager': '#!/bin/sh\n', 'cmdline-tools/latest/source.properties': 'Pkg.Revision=19.0\n', 'platform-tools/adb': '#!/bin/sh\n', 'licenses/android-sdk-license': '\nabc\n' });
  const studio = made(path.join(w.home, 'android-studio'), { 'bin/studio.sh': '#!/bin/sh\n', 'product-info.json': '{"version":"2026.1.1.2"}\n' });
  const tools = () => ({ sdk: snap(sdk), studio: snap(studio) });
  const before = tools();
  const sys = await sysOf(w);
  const found = await detectKits(sys, ['android']);
  assert.deepEqual(found.android.map((r) => [r.state, r.version, r.detail]), [['ok', '19.0', 'found at ~/Android/Sdk: used where it is'], ['ok', '2026.1.1.2', 'found at ~/android-studio: used where it is']]);
  // Its licence was accepted and adb is there: nothing is the owner's to do.
  assert.deepEqual(yourSteps(['android'], found, sys), []);
  // Not named: no link, no line.
  assert.deepEqual(buildPlan(['android'], found, sys).steps, []);
  const plan = buildPlan(['android'], found, sys, { named: ['android'] });
  assert.deepEqual(plan.steps.map((s) => [s.do, s.why || '']), [
    ['link', 'The Android SDK found at ~/Android/Sdk: used where it is'],
    ['link', 'Android Studio found at ~/android-studio: used where it is'],
    ['shell', 'the kits block in your shell start files'],
  ]);
  for (const s of plan.steps) assert.equal((await runInside(s)).ok, true, s.why);
  assert.equal(fs.readlinkSync(w.place), sdk);
  assert.equal(fs.readlinkSync(path.join(w.ws, 'development', 'android', 'android-studio')), studio);
  assert.deepEqual(tools(), before, 'not one byte of either changed');
  const sys2 = await sysOf(w);
  const again = await detectKits(sys2, ['android']);
  assert.equal(again.android[0].detail, 'development/sdk/android-sdk points at ~/Android/Sdk: used where it is');
  assert.deepEqual(buildPlan(['android'], again, sys2, { named: ['android'] }).steps, []);
});

test('an ANDROID_HOME of the owner\'s is never overruled: the link is made, no line of the block names the SDK', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  const sdk = made(path.join(w.root, 'mysdk'), { 'cmdline-tools/latest/bin/sdkmanager': '#!/bin/sh\n', 'platform-tools/adb': '#!/bin/sh\n' });
  const env = { PATH: '', SHELL: '/bin/bash', ANDROID_HOME: sdk }; // seal: an environment given as data to the made-up system facts; no process is started with it
  const sys = await sysOf(w, { env });
  const found = await detectKits(sys, ['android']);
  assert.equal(found.android[0].detail, `found at ${sdk}: used where it is`);
  const plan = buildPlan(['android'], found, sys, { named: ['android'] });
  assert.deepEqual(plan.steps.map((s) => s.do), ['link']);
  // Its commands work on his own SDK, where it is.
  assert.deepEqual(yourSteps(['android'], found, sys).map((y) => y.command), [`"${sdk}/cmdline-tools/latest/bin/sdkmanager" --sdk_root="${sdk}" --licenses`]);
});

test('an SDK found without sdkmanager: said so, and no command names a program that is not there', async (tc) => {
  const w = world(tc);
  made(path.join(w.home, 'Android', 'Sdk'), { 'platform-tools/adb': '#!/bin/sh\n' });
  const sys = await sysOf(w);
  const found = await detectKits(sys, ['android']);
  assert.equal(found.android[0].state, 'ok');
  const y = yourSteps(['android'], found, sys);
  assert.equal(y.length, 1);
  assert.match(y[0].text, /has no sdkmanager/);
  assert.equal(y[0].command, undefined);
});

test('macOS: the archive for this CPU; an Android Studio in Applications is shown where it is and never linked', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  made(path.join(w.home, 'Applications', 'Android Studio.app', 'Contents'), { 'MacOS/studio': '#!/bin/sh\n', 'Resources/product-info.json': '{"version":"2026.1.1.2"}\n' });
  const mac = await sysOf(w, { platform: 'darwin', pm: 'brew', arch: 'arm64', clt: true });
  const found = await detectKits(mac, ['android']);
  assert.deepEqual([found.android[1].state, found.android[1].found, found.android[1].adopt], ['ok', '~/Applications/Android Studio.app', undefined]);
  const plan = buildPlan(['android'], found, mac, { named: ['android'] });
  assert.deepEqual(plan.steps.map((s) => s.do), ['android-sdk', 'shell']);
  assert.equal(plan.steps[0].platform, 'darwin');
});

test('an ANDROID_HOME the owner sets in ~/.bashrc (not in this run\'s environment): his SDK is used, no file gets a line over his', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  const sdk = made(path.join(w.home, 'mysdk'), { 'cmdline-tools/latest/bin/sdkmanager': '#!/bin/sh\n', 'platform-tools/adb': '#!/bin/sh\n', 'licenses/android-sdk-license': '\nabc\n' });
  fs.writeFileSync(path.join(w.home, '.bashrc'), 'export ANDROID_HOME="$HOME/mysdk"\n');
  fs.writeFileSync(path.join(w.home, '.profile'), '. "$HOME/.bashrc"\n');
  const v = await vendor(tc, {});
  const before = { bashrc: fs.readFileSync(path.join(w.home, '.bashrc'), 'utf8'), profile: fs.readFileSync(path.join(w.home, '.profile'), 'utf8'), sdk: snap(sdk) };
  const sys = await sysOf(w);
  const found = await detectKits(sys, ['android']);
  assert.equal(found.android[0].detail, 'found at ~/mysdk: used where it is');
  assert.equal(found.android[0].shellLine, false);
  const r = await runKit(sys, v.get);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(v.asked, [], 'no second SDK is downloaded');
  assert.equal(fs.readlinkSync(w.place), sdk);
  assert.deepEqual({ bashrc: fs.readFileSync(path.join(w.home, '.bashrc'), 'utf8'), profile: fs.readFileSync(path.join(w.home, '.profile'), 'utf8'), sdk: snap(sdk) }, before, 'his start files and his SDK as they were');
  // The closing sentence claims no shell line that was not written.
  assert.doesNotMatch(r.text, /ANDROID_HOME and its bin folders are in your shell start files/);
});

test('the commands to paste keep a home with a space as one word', { skip: process.platform === 'win32' && 'the Android kit is for Linux and macOS (not offered on Windows)' }, async (tc) => {
  const w = world(tc);
  const home = path.join(w.root, 'my home');
  const ws = path.join(home, 'Workspace');
  fs.mkdirSync(ws, { recursive: true });
  const sys = await sysOf({ ...w, home, ws }, { home, ws });
  const y = yourSteps(['android'], await detectKits(sys, ['android']), sys);
  assert.deepEqual(y.map((x) => x.command), [
    '"$HOME/Workspace/development/sdk/android-sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$HOME/Workspace/development/sdk/android-sdk" --licenses',
    '"$HOME/Workspace/development/sdk/android-sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$HOME/Workspace/development/sdk/android-sdk" --install platform-tools',
  ]);
});
