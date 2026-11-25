// The Flutter kit end to end in a temporary home with a workspace, against a stand-in vendor (vendor.mjs: a server on
// 127.0.0.1 handed in as the getter, a trimmed list with the checksum of a tiny archive made here). The tool lands at
// development/flutter/flutter, a second run does nothing, the shell block appears once; every refusal leaves the home
// exactly as it was (a full snapshot) with no temporary file; a Flutter or an nvm found elsewhere is adopted by a link
// only when its kit is named, and not one byte of the tool changes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tarOf, tarXzOf } from './archives.mjs';
import { quietUi } from './dryrun-fixture.mjs';
import { vendor } from './vendor.mjs';

const { sysFacts, detectKits } = await import('../../src/pcsetup/detect.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { FLUTTER, buildPlan, kitById } = await import('../../src/pcsetup/kits.mjs');
const { runInside } = await import('../../src/pcsetup/devinstall.mjs');
const { findNvm } = await import('../../src/pcsetup/devplaces.mjs');
const { freshPath } = await import('../../src/pcsetup/setup.mjs');
const { BLOCK_BEGIN } = await import('../../src/setup/localbin.mjs');

const LIST = '/flutter_infra_release/releases/releases_linux.json';
const ARCHIVE = '/flutter_infra_release/releases/stable/linux/flutter_linux_3.50.1-stable.tar.xz';
const SDK = [
  { name: 'flutter/', type: 'dir' },
  { name: 'flutter/bin/', type: 'dir' },
  { name: 'flutter/bin/flutter', type: 'file', data: '#!/bin/sh\necho "Flutter 3.50.1"\n', mode: 0o755 },
  { name: 'flutter/version', type: 'file', data: '3.50.1\n' },
];
const EXTRAS = { suggested: [], php: [], java: null };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const listFor = (archive, edit = () => {}) => {
  const l = structuredClone(JSON.parse(fs.readFileSync(new URL('./fixtures/flutter-releases.json', import.meta.url), 'utf8')).linux);
  l.releases[0].sha256 = sha(archive);
  edit(l);
  return JSON.stringify(l);
};

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flutterkit-')));
  tc.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = path.join(home, 'Workspace');
  fs.mkdirSync(ws, { recursive: true });
  Object.assign(process.env, { HOME: home, HOPRIG_WORKSPACE_DIR: ws });
  return { root, home, ws, place: path.join(ws, 'development', 'flutter', 'flutter') };
}
// A Linux computer with tar and xz and nothing else of the system: no program is started by the detection.
const sysOf = (w, over = {}) => sysFacts({
  platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', home: w.home, ws: w.ws, env: { PATH: '', SHELL: '/bin/bash' }, nvm: null, // seal: an environment given as data to the made-up system facts; no process is started with it
  has: (b) => ['tar', 'xz', 'sudo'].includes(b), exists: (f) => f.startsWith(w.root) && fs.existsSync(f), which: () => null, list: () => [],
  run: async () => ({ ok: false, code: 1, stdout: '', stderr: '' }), ...over,
});
async function runKit(sys, get, o = {}) {
  const ui = await quietUi({ yes: true });
  const ran = [];
  const r = await runPcSetup({ ui, yes: true, kits: ['flutter'], sys, get, runner: async (argv) => (ran.push(argv), { ok: true, code: 0 }), extras: EXTRAS, rules: false, codingTools: { findTool: () => null }, ...o });
  return { ...r, text: ui.text(), ran };
}

test('the stand-in vendor: Flutter lands at development/flutter/flutter, the shell block once; a second run does nothing', async (tc) => {
  const w = world(tc);
  const archive = tarXzOf(SDK);
  const v = await vendor(tc, { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { headers: { 'content-length': String(archive.length) }, body: archive } });
  const sys = await sysOf(w);
  const r = await runKit(sys, v.get);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.ran, [], 'no command ran: the download is Hoprig\'s own step, never sudo, never apt');
  assert.deepEqual(v.asked, [`https://${FLUTTER.host}${LIST}`, `https://${FLUTTER.host}${ARCHIVE}`]);
  assert.equal(fs.readFileSync(path.join(w.place, 'version'), 'utf8'), '3.50.1\n');
  assert.ok(fs.statSync(path.join(w.place, 'bin', 'flutter')).mode & 0o100);
  assert.deepEqual(fs.readdirSync(path.join(w.ws, 'development')), ['flutter'], 'no temporary folder is left');
  assert.match(r.text, /Flutter 3\.50\.1 is in ~\/Workspace\/development\/flutter\/flutter/);
  for (const f of ['.profile', '.bashrc']) {
    const t = fs.readFileSync(path.join(w.home, f), 'utf8');
    assert.equal(t.split(BLOCK_BEGIN).length - 1, 1, f);
    assert.match(t, /PATH="\$HOME\/Workspace\/development\/flutter\/flutter\/bin:\$PATH"/);
  }
  const found = (await detectKits(await sysOf(w), ['flutter'])).flutter[0];
  assert.deepEqual([found.state, found.version, found.detail], ['ok', '3.50.1', 'in development/flutter/flutter']);

  const before = snap(w.home);
  const again = await runKit(await sysOf(w), v.get);
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /Everything is here\. Nothing to do\./);
  assert.equal(v.asked.length, 2, 'the second run asked the vendor nothing');
  assert.deepEqual(snap(w.home), before, 'the second run changed nothing');
});

test('the plan says the step in words before the yes: the list, the host, about how big, the place, the shell line', async (tc) => {
  const w = world(tc);
  const sys = await sysOf(w);
  const plan = buildPlan(['flutter'], await detectKits(sys, ['flutter']), sys, { named: ['flutter'] });
  assert.deepEqual(plan.steps.map((s) => s.do), ['flutter', 'shell']);
  assert.equal(plan.admin, false);
  assert.equal(plan.steps[0].words, `download Flutter's current stable release (the one https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json names) from storage.googleapis.com over https, about 1.6 GB (about 3 GB on disk), check its sha256, unpack it into ~/Workspace/development/flutter/flutter`);
  assert.deepEqual(plan.steps[1].lines, [{ key: 'flutter', var: 'PATH', prepend: true, value: '$HOME/Workspace/development/flutter/flutter/bin' }]);
  // No workspace: nothing to install into, and it says why.
  const none = await sysOf(w, { ws: null });
  const p2 = buildPlan(['flutter'], await detectKits(none, ['flutter']), none);
  assert.deepEqual(p2.steps, []);
  assert.match(p2.cannot[0].why, /Set up the workspace first/);
});

test('a workspace path a shell would read (a quote, $( ) gets no shell line: the plan says so, with the line to add yourself', async (tc) => {
  const w = world(tc);
  const ws = path.join(w.home, 'my "ws" $(touch gotcha)');
  fs.mkdirSync(ws, { recursive: true });
  const sys = await sysOf(w, { ws });
  const plan = buildPlan(['flutter'], await detectKits(sys, ['flutter']), sys, { named: ['flutter'] });
  assert.deepEqual(plan.steps.map((s) => s.do), ['flutter'], 'the download only: no step writes that path into a start file');
  const c = plan.cannot.find((x) => x.item === 'flutter-line');
  assert.ok(c, JSON.stringify(plan.cannot));
  assert.match(c.why, /holds a character a shell would read/);
  assert.ok(c.why.endsWith(`PATH='${ws}/development/flutter/flutter/bin':"$PATH"; export PATH`), c.why);
  const before = snap(w.home);
  const r = await runPcSetup({ ui: await quietUi({ yes: true }), yes: true, dryRun: true, kits: ['flutter'], sys, get: async () => { throw new Error('asked'); }, extras: EXTRAS, rules: false, codingTools: { findTool: () => null } });
  assert.equal(r.code, 0);
  assert.deepEqual(snap(w.home), before);
});

test('macOS and Linux by facts: the archive for this CPU from releases_macos.json; Linux on arm has none', async (tc) => {
  const w = world(tc);
  for (const arch of ['arm64', 'x64']) {
    const mac = await sysOf(w, { platform: 'darwin', pm: 'brew', arch, has: (b) => ['unzip', 'tar'].includes(b), clt: true });
    const plan = buildPlan(['flutter'], await detectKits(mac, ['flutter']), mac, { named: ['flutter'] });
    assert.equal(plan.steps[0].do, 'flutter');
    assert.match(plan.steps[0].words, /releases_macos\.json/);
    assert.equal(plan.steps[0].arch, arch);
  }
  const arm = await sysOf(w, { arch: 'arm64' });
  const p = buildPlan(['flutter'], await detectKits(arm, ['flutter']), arm);
  assert.deepEqual(p.steps, []);
  assert.match(p.cannot[0].why, /no archive for this computer's CPU \(arm64\)/);
  // Windows: Hoprig does not set it up there.
  assert.equal(kitById('flutter').windows, false);
  assert.equal(kitById('flutter').defaultOn, false);
});

const refusals = (archive) => ({
  'a wrong checksum': { routes: { [LIST]: { body: listFor(archive, (l) => (l.releases[0].sha256 = '1'.repeat(64))) }, [ARCHIVE]: { body: archive } }, why: /sha256 is not the one the vendor publishes/ },
  'another host in the list': { routes: { [LIST]: { body: listFor(archive, (l) => (l.base_url = 'https://example.com/releases')) } }, why: /example\.com is not the vendor's own host/ },
  'http in the list': { routes: { [LIST]: { body: listFor(archive, (l) => (l.base_url = `http://${FLUTTER.host}/flutter_infra_release/releases`)) } }, why: /is not https/ },
  'a redirect to another host': { routes: { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { status: 302, headers: { location: 'https://example.com/flutter.tar.xz' } } }, why: /sent the download on to example\.com/ },
  'a redirect to http': { routes: { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { status: 302, headers: { location: `http://${FLUTTER.host}${ARCHIVE}` } } }, why: /which is not its own host over https/ },
  'a redirect on the host, outside its folder': { routes: { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { status: 302, headers: { location: `https://${FLUTTER.host}/somewhere/else/flutter.tar.xz` } } }, why: /outside \/flutter_infra_release\/releases\/ on storage\.googleapis\.com: refused/ },
  'an archive entry with ..': { bad: [...SDK, { name: 'flutter/../../evil', type: 'file', data: 'x' }], why: /a path with \.\.|an absolute path or a \.\. in a name/ },
  'an archive entry with an absolute path': { bad: [...SDK, { name: '/tmp/evil', type: 'file', data: 'x' }], why: /an absolute path/ },
  'an archive link that points outside': { bad: [...SDK, { name: 'flutter/out', type: 'link', link: '../../../..' }], why: /a link that points outside/ },
});

for (const [what, c] of Object.entries(refusals(tarXzOf(SDK)))) {
  test(`refused, the home exactly as before and no temporary file: ${what}`, async (tc) => {
    const w = world(tc);
    const archive = c.bad ? tarOf(c.bad) : tarXzOf(SDK);
    const v = await vendor(tc, c.routes || { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { body: archive } });
    const before = snap(w.home);
    const r = await runKit(await sysOf(w), v.get);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, c.why);
    assert.equal(r.text.split('retry: hoprig pc setup --kits flutter').length - 1, 1, 'one retry line for the kit');
    assert.deepEqual(snap(w.home), before, 'nothing of the home changed: no place, no temporary file, no shell block');
    assert.ok(!v.asked.some((u) => !u.startsWith(`https://${FLUTTER.host}/`)), v.asked.join('\n'));
  });
}

test('refused: a download over the kit\'s ceiling (Content-Length, or the bytes counted when there is none)', async (tc) => {
  const w = world(tc);
  const archive = tarXzOf(SDK);
  const sys = await sysOf(w);
  const step = buildPlan(['flutter'], await detectKits(sys, ['flutter']), sys).steps[0];
  for (const headers of [{ 'content-length': String(archive.length) }, { 'transfer-encoding': 'chunked' }]) {
    const v = await vendor(tc, { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { headers, body: archive } });
    const before = snap(w.home);
    const r = await runInside({ ...step, data: { ...FLUTTER, ceiling: archive.length - 1 } }, { get: v.get });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'size', r.why);
    assert.deepEqual(snap(w.home), before);
  }
});

test('a stop in the middle of the download: the home as before, and the next run starts again and lands', async (tc) => {
  const w = world(tc);
  const archive = tarXzOf(SDK);
  const ac = new AbortController();
  let cut = true;
  const v = await vendor(tc, {
    [LIST]: { body: listFor(archive) },
    [ARCHIVE]: (req, res) => {
      res.writeHead(200, { 'content-length': String(archive.length) });
      if (!cut) return res.end(archive);
      res.write(archive.subarray(0, 100));
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
  assert.equal(fs.readFileSync(path.join(w.place, 'version'), 'utf8'), '3.50.1\n');
});

test('a process signal during the download (Ctrl-C): the step removes its half download, no later step runs, the run ends', async (tc) => {
  const w = world(tc);
  const archive = tarXzOf(SDK);
  // A made-up event name stands in for SIGINT: process.emit only calls the listeners. A real signal's name would
  // reach the runner's own listeners too (its SIGINT, Node's report on SIGUSR2).
  const SIG = 'test-stop';
  const listening = process.listenerCount(SIG);
  const v = await vendor(tc, {
    [LIST]: { body: listFor(archive) },
    [ARCHIVE]: (req, res) => {
      res.writeHead(200, { 'content-length': String(archive.length) });
      res.write(archive.subarray(0, 100));
      setTimeout(() => process.emit(SIG, SIG), 20);
      setTimeout(() => !res.writableEnded && res.end(archive.subarray(100)), 1000); // unheard, the download would land
    },
  });
  const before = snap(w.home);
  const r = await runKit(await sysOf(w), v.get, { stopOn: [SIG] });
  assert.equal(r.code, 1, r.text);
  assert.equal(r.stopped, true);
  assert.match(r.text, /the download was stopped/);
  assert.match(r.text, /Stopped/);
  assert.deepEqual(snap(w.home), before, 'no half download, no folder, no shell block');
  assert.equal(process.listenerCount(SIG), listening, 'the signal is heard only while the step runs');
});

test('a run that was killed left its temporary folder: the next install removes it, and nothing else', async (tc) => {
  const w = world(tc);
  const dev = path.join(w.ws, 'development');
  const dead = 999999999; // above any pid_max: no such process
  const leave = (name, files) => {
    const d = path.join(dev, name);
    fs.mkdirSync(path.join(d, 'into', 'flutter'), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, f), 'part');
    return d;
  };
  const left = leave(`.hoprig-tmp-${dead}-a1b2c3`, ['flutter.tar.xz']);
  const extra = leave(`.hoprig-tmp-${dead}-d4e5f6`, ['flutter.tar.xz', 'notes.txt']); // a name not Hoprig's: kept
  const living = leave(`.hoprig-tmp-${process.ppid}-g7h8i9`, ['flutter.tar.xz']); // its process runs: kept
  const nopid = leave('.hoprig-tmp-j0k1l2', ['flutter.tar.xz']); // no process id in the name: kept
  fs.writeFileSync(path.join(dev, `.hoprig-tmp-${dead}-file`), 'a file, not a folder'); // kept
  const archive = tarXzOf(SDK);
  const v = await vendor(tc, { [LIST]: { body: listFor(archive) }, [ARCHIVE]: { headers: { 'content-length': String(archive.length) }, body: archive } });
  const r = await runKit(await sysOf(w), v.get);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /the half download of an earlier run that was stopped is removed/);
  assert.ok(!fs.existsSync(left), 'the killed run\'s folder is gone');
  for (const d of [extra, living, nopid]) assert.ok(fs.existsSync(path.join(d, 'flutter.tar.xz')), d);
  assert.deepEqual(fs.readdirSync(dev).sort(), [path.basename(nopid), path.basename(living), `.hoprig-tmp-${dead}-d4e5f6`, `.hoprig-tmp-${dead}-file`, 'flutter'].sort());
});

test('the place already taken (a folder, a file, a link, a broken link): never written over, nothing downloaded', async (tc) => {
  const makers = {
    'a folder': (p) => fs.mkdirSync(p),
    'a file': (p) => fs.writeFileSync(p, 'mine\n'),
    'a link': (p, w) => {
      fs.mkdirSync(path.join(w.root, 'elsewhere'));
      fs.symlinkSync(path.join(w.root, 'elsewhere'), p);
    },
    'a broken link': (p, w) => fs.symlinkSync(path.join(w.root, 'gone'), p),
  };
  for (const [what, make] of Object.entries(makers)) {
    const w = world(tc);
    fs.mkdirSync(path.dirname(w.place), { recursive: true });
    make(w.place, w);
    const v = await vendor(tc, {});
    const before = snap(w.root);
    const r = await runKit(await sysOf(w), v.get);
    assert.match(r.text, /development\/flutter\/flutter is there already[^\n]*Hoprig never writes over it/, `${what}: ${r.text}`);
    assert.deepEqual(v.asked, [], `${what}: nothing was asked`);
    assert.deepEqual(snap(w.root), before, what);
  }
  // Taken between the plan and the run: the step itself refuses, before it asks anything.
  const w = world(tc);
  const sys = await sysOf(w);
  const step = buildPlan(['flutter'], await detectKits(sys, ['flutter']), sys).steps[0];
  fs.mkdirSync(w.place, { recursive: true });
  const v = await vendor(tc, {});
  const r = await runInside(step, { get: v.get });
  assert.deepEqual([r.ok, r.code], [false, 'taken']);
  assert.deepEqual(v.asked, []);
});

test('adoption: a Flutter in ~/flutter and an nvm in ~/.nvm are found and shown; a link only for a named kit; the tools unchanged', async (tc) => {
  const w = world(tc);
  const flutter = path.join(w.home, 'flutter');
  fs.mkdirSync(path.join(flutter, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(flutter, 'bin', 'flutter'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(flutter, 'version'), '3.41.2\n');
  const nvm = path.join(w.home, '.nvm');
  fs.mkdirSync(nvm);
  fs.writeFileSync(path.join(nvm, 'nvm.sh'), '# nvm\n');
  fs.writeFileSync(path.join(nvm, 'package.json'), '{"version":"0.40.8"}\n');
  const tools = () => ({ flutter: snap(flutter), nvm: snap(nvm) });
  const before = tools();
  const env = { PATH: '', SHELL: '/bin/bash' }; // seal: an environment given as data to the made-up system facts; no process is started with it
  const sys = await sysOf(w, { env, nvm: findNvm({ env, home: w.home, ws: w.ws }) });
  const found = await detectKits(sys, ['flutter']);
  assert.deepEqual([found.flutter[0].state, found.flutter[0].version, found.flutter[0].found, found.flutter[0].detail], ['ok', '3.41.2', '~/flutter', 'found at ~/flutter: used where it is']);
  const nodeOk = { node: [{ id: 'node', state: 'ok' }, { id: 'npm', state: 'ok' }] };
  // Not named (set-up picked it, or the page only looks): no link, no line.
  assert.deepEqual(buildPlan(['flutter', 'node'], { ...found, ...nodeOk }, sys).steps, []);
  const plan = buildPlan(['flutter', 'node'], { ...found, ...nodeOk }, sys, { named: ['flutter', 'node'] });
  assert.deepEqual(plan.steps.map((s) => [s.do, s.why || '']), [
    ['link', 'Flutter found at ~/flutter: used where it is'],
    ['shell', 'the kits block in your shell start files'],
    ['link', 'nvm found at ~/.nvm: used where it is'],
  ]);
  assert.equal(plan.steps[0].words, 'make development/flutter/flutter a link to ~/flutter (nothing of it is moved, copied or changed)');
  // An adopted nvm keeps its own lines (they name ~/.nvm): only the link is made.
  assert.ok(!plan.steps.some((s) => s.do === 'shell' && s.lines.some((l) => l.key === 'nvm')));
  for (const s of plan.steps) assert.equal((await runInside(s)).ok, true, s.why);
  assert.equal(fs.readlinkSync(w.place), flutter);
  assert.equal(fs.readlinkSync(path.join(w.ws, 'development', 'nodejs', 'nvm')), nvm);
  assert.deepEqual(tools(), before, 'not one byte of either tool changed');
  // Afterwards: found through the place, and a second plan has nothing to do.
  const sys2 = await sysOf(w, { env, nvm: findNvm({ env, home: w.home, ws: w.ws }) });
  const again = await detectKits(sys2, ['flutter']);
  assert.equal(again.flutter[0].detail, 'development/flutter/flutter points at ~/flutter: used where it is');
  assert.deepEqual(buildPlan(['flutter', 'node'], { ...again, ...nodeOk }, sys2, { named: ['flutter', 'node'] }).steps, []);
});

test('a new nvm goes into development/nodejs/nvm when a workspace exists, with NVM_DIR set for those steps and in the block', async (tc) => {
  const w = world(tc);
  const env = { PATH: '', SHELL: '/bin/bash' }; // seal: an environment given as data to the made-up system facts; no process is started with it
  const sys = await sysOf(w, { env, nvm: findNvm({ env, home: w.home, ws: w.ws }) });
  const place = path.join(w.ws, 'development', 'nodejs', 'nvm');
  const plan = buildPlan(['node'], { node: [{ id: 'node', state: 'missing' }, { id: 'npm', state: 'missing' }] }, sys, { named: ['node'] });
  assert.deepEqual(plan.steps.map((s) => s.argv && s.argv.slice(3)), [['bash', place], ['bash', place], undefined]);
  assert.match(plan.steps[0].argv[2], /^mkdir -p "\$1" && export NVM_DIR="\$1" && \{ \[ -s "\$NVM_DIR\/nvm\.sh" \] \|\| curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.8\/install\.sh \| bash; \}$/);
  assert.deepEqual(plan.steps[2].lines, [{ key: 'nvm', var: 'NVM_DIR', value: '$HOME/Workspace/development/nodejs/nvm' }]);
  // Without a workspace: nvm's own default (~/.nvm), as before.
  const bare = await sysOf(w, { ws: null, env, nvm: findNvm({ env, home: w.home, ws: null }) });
  assert.match(buildPlan(['node'], { node: [{ id: 'node', state: 'missing' }] }, bare).steps[0].argv[2], /NVM_DIR:-\$HOME\/\.nvm/);
});

test('later steps find the Node of a new nvm in development/nodejs/nvm (freshPath), only when the step names that folder', (tc) => {
  const w = world(tc);
  const nvm = path.join(w.ws, 'development', 'nodejs', 'nvm');
  fs.mkdirSync(path.join(nvm, 'versions', 'node', 'v24.11.0', 'bin'), { recursive: true });
  assert.equal(freshPath({ PATH: '/usr/bin' }, w.home, 'linux', nvm), `/usr/bin:${nvm}/versions/node/v24.11.0/bin`); // seal: the input of a pure function; no process is started with it
  assert.equal(freshPath({ PATH: '/usr/bin' }, w.home, 'linux'), '/usr/bin'); // seal: the input of a pure function; no process is started with it
});
