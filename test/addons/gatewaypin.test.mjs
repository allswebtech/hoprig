// A gateway the owner defines runs exactly the file he confirmed (src/addons/gateways.mjs pinProgram): a plain name
// is looked up once, when it is added; a link is followed then; the file and its folders may be changed by him alone;
// and a start refuses once the file's contents differ from the fingerprint kept with the definition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewaypin');
// What cannot be shown on Windows: a symbolic link needs a right there (an administrator or developer mode); a file has
// no mode bits saying who may change it or run it; and a gateway defined by its npm package is refused there.
const LINKS = { skip: process.platform === 'win32' && 'a symbolic link: Windows makes one only with the right to (an administrator or developer mode)' };
const MODES = { skip: process.platform === 'win32' && 'who may change or run a file is told by mode bits, which Windows files do not have' };
const NPM = { skip: process.platform === 'win32' && 'a gateway defined by its npm package is refused on Windows (gateways.mjs)' };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const marker = path.join(box.root, 'ran.txt');
// A stand-in gateway that says which file it is, then answers on its port.
const standIn = (file, name) => fs.writeFileSync(file, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + '\\n');
require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[3]), '127.0.0.1');
`, { mode: 0o755 });
const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);
const started = [];
test.after(() => {
  for (const pid of started) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  box.cleanup();
});

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const G = await import('../../src/addons/gateways.mjs');
const { findAddon } = await import('../../src/addons/index.mjs');
const { fileSha256 } = await import('../../src/addons/localgateway.mjs');
saveConfig({ server: { port: 7433 } });
const relayPid = () => JSON.parse(fs.readFileSync(path.join(box.state, 'addons', 'relay.pid'), 'utf8')).pid;
async function startAndStop(a) {
  const r = await a.start();
  if (r.ok) {
    started.push(relayPid());
    await a.stop();
  }
  return r;
}

test('a plain name is the file PATH named when it was added: a program of that name found first later is not run', async () => {
  const confirmed = path.join(box.root, 'confirmed-bin');
  const project = path.join(box.root, 'project', 'node_modules', '.bin');
  fs.mkdirSync(confirmed);
  fs.mkdirSync(project, { recursive: true });
  standIn(path.join(confirmed, 'relay'), 'CONFIRMED');
  standIn(path.join(project, 'relay'), 'PROJECT-BIN');
  const was = process.env.PATH;
  try {
    process.env.PATH = `${confirmed}${path.delimiter}${was}`;
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: 'relay', port: await freePort() });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.def.bin, path.join(confirmed, 'relay'), 'kept as the file it stands for');
    process.env.PATH = `${project}${path.delimiter}${confirmed}${path.delimiter}${was}`; // a session in a project
    const s = await startAndStop(findAddon('relay'));
    assert.equal(s.ok, true, s.error);
    assert.deepEqual(ran(), ['CONFIRMED']);
  } finally {
    process.env.PATH = was;
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('a file rewritten after the yes, or a link pointed elsewhere, does not run', LINKS, async () => {
  const file = path.join(box.root, 'relay.js');
  const other = path.join(box.root, 'other.js');
  const link = path.join(box.root, 'relay-link');
  standIn(file, 'CONFIRMED');
  standIn(other, 'LINK-TARGET-2');
  fs.symlinkSync(file, link);
  try {
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: link, port: await freePort() });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.def.bin, file, 'a link is kept as the file it points to');
    fs.rmSync(link);
    fs.symlinkSync(other, link);
    assert.equal((await startAndStop(findAddon('relay'))).ok, true);
    assert.deepEqual(ran(), ['CONFIRMED'], 'the link pointing elsewhere changes nothing');
    standIn(file, 'REPLACED-AFTER-CONFIRM');
    const s = await findAddon('relay').start();
    assert.equal(s.ok, false);
    assert.match(s.error, /^the program .* for Relay changed after you confirmed it\. If you changed it, confirm it with hoprig gateways confirm relay, or with Confirm the new program in Settings → Add-ons\. If you did not, do not confirm it$/);
    assert.deepEqual(ran(), ['CONFIRMED'], 'the rewritten file never ran');
  } finally {
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('after an update of the program the owner confirms it again: its definition, sharing and keys stay', async () => {
  const K = await import('../../src/gateway/keys.mjs');
  const file = path.join(box.root, 'relay-update'); // no extension: a #! stand-in Windows starts through Node, as the system does here
  standIn(file, 'V1');
  const port = await freePort();
  try {
    assert.equal((await G.addDefinition({ id: 'relay', title: 'Relay', bin: file, port, args: ['--port', 'PORT', '--quiet'] })).ok, true);
    K.setShared('relay', 'relay');
    const key = K.createKey('relay', 'laptop').key;
    const a = findAddon('relay');
    assert.equal((await a.status()).needsConfirm, undefined, 'as confirmed: nothing to say');
    assert.deepEqual(G.repinned('relay').was, null);
    standIn(file, 'V2'); // the owner updates his program
    assert.equal((await findAddon('relay').status()).needsConfirm, 'changed', 'the page and the list say so before a start');
    const asked = G.repinned('relay');
    assert.deepEqual([asked.was, asked.def.bin, asked.def.sha256], ['changed', file, fileSha256(file)]);
    // A yes for another file than the one shown changes nothing.
    assert.match(G.confirmProgram('relay', { expect: { bin: file, sha256: 'a'.repeat(64) } }).error, /not the one you were shown/);
    assert.match(G.confirmProgram('relay').error, /not the one you were shown/);
    assert.equal((await findAddon('relay').start()).ok, false);
    assert.deepEqual(G.confirmProgram('relay', { expect: { bin: asked.def.bin, sha256: asked.def.sha256 } }).ok, true);
    const def = loadConfig().gateways.defined.find((d) => d.id === 'relay');
    assert.deepEqual(def, { id: 'relay', title: 'Relay', port, bin: file, sha256: fileSha256(file), typed: file, args: ['--port', 'PORT', '--quiet'] });
    assert.equal(K.sharedProvider('relay'), 'relay', 'sharing stays');
    assert.equal(K.verifyKey(key, 'relay')?.name, 'laptop', 'the other computer\'s key still works');
    const b = findAddon('relay');
    assert.equal((await b.status()).needsConfirm, undefined);
    assert.equal((await startAndStop(b)).ok, true);
    assert.deepEqual(ran(), ['V2']);
  } finally {
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('a definition written by hand without a fingerprint says so, and is confirmed the same way', async () => {
  const file = path.join(box.root, 'relay-hand'); // no extension: a #! stand-in Windows starts through Node, as the system does here
  standIn(file, 'BY-HAND');
  saveConfig({ gateways: { defined: [{ id: 'relay', title: 'Relay', port: await freePort(), bin: file }] } });
  try {
    const a = findAddon('relay');
    assert.equal((await a.status()).needsConfirm, 'no-fingerprint');
    const s = await a.start();
    assert.equal(s.ok, false);
    assert.match(s.error, /config\.json keeps no fingerprint \(sha256\) of the program .* for Relay, so Hoprig does not start it: if it is yours, confirm it with hoprig gateways confirm relay, or with Confirm the program in Settings → Add-ons/);
    assert.doesNotMatch(s.error, /changed since/);
    const asked = G.repinned('relay');
    assert.equal(asked.was, 'no-fingerprint');
    assert.equal(G.confirmProgram('relay', { expect: { bin: asked.def.bin, sha256: asked.def.sha256 } }).ok, true);
    assert.equal((await startAndStop(findAddon('relay'))).ok, true);
    assert.deepEqual(ran(), ['BY-HAND']);
  } finally {
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('confirm is only for a program of the owner\'s own: not an npm package, not a gateway that is not there', () => {
  saveConfig({ gateways: { defined: [{ id: 'relay', title: 'Relay', port: 20100, npm: 'relay-gateway' }] } });
  try {
    // Windows loads no npm gateway of the owner's own (gateways.mjs checkDefinition): it says that instead.
    assert.match(G.repinned('relay').error, process.platform === 'win32' ? /in config\.json was not loaded \(on Windows a gateway of your own is its program, not an npm package/ : /Relay is an npm package: Hoprig runs the program npm installed for it, so there is nothing to confirm/);
    assert.match(G.repinned('nope').error, /there is no gateway "nope" of yours/);
    assert.equal(G.confirmProgram('relay', { expect: { bin: 'x', sha256: 'y' } }).ok, false);
  } finally {
    G.removeDefinition('relay');
  }
});

test('a program others can change, or one inside the workspace, is refused; so are Windows paths without a drive', MODES, () => {
  const loose = path.join(box.root, 'loose');
  standIn(loose, 'LOOSE');
  fs.chmodSync(loose, 0o777);
  const open = path.join(box.root, 'open-dir');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  standIn(path.join(open, 'relay'), 'IN-OPEN-DIR');
  const inWs = path.join(box.workspace, 'shop', 'relay');
  fs.mkdirSync(path.dirname(inWs), { recursive: true });
  standIn(inWs, 'IN-WORKSPACE');
  const base = { id: 'relay', title: 'Relay', port: 20100 };
  const check = (bin, o = {}) => G.checkDefinition({ ...base, bin }, { forAdd: true, ...o }).error || '';
  assert.match(check(loose), /other users of this computer can change /);
  assert.match(check(path.join(open, 'relay')), new RegExp(`other users of this computer can change ${open.replace(/[/.]/g, '\\$&')} `));
  assert.match(check(inWs), /inside the workspace, where sessions write/);
  assert.match(check(loose), /: copy it to a folder only you can change \(such as ~\/bin\) and add it from there$/, 'what to do instead');
  // A folder of the owner's that his own group may change: fine on Linux (a group of his alone, by default), not on a
  // Mac, where that group (staff) and Homebrew's (admin) hold other users too.
  const grp = path.join(box.root, 'group-dir');
  fs.mkdirSync(grp);
  fs.chmodSync(grp, 0o775);
  standIn(path.join(grp, 'relay'), 'IN-GROUP-DIR');
  assert.equal(check(path.join(grp, 'relay'), { platform: 'linux' }), '');
  assert.match(check(path.join(grp, 'relay'), { platform: 'darwin' }), new RegExp(`other users of this computer can change ${grp.replace(/[/.]/g, '\\$&')} .*: copy it to a folder only you can change`));
  for (const bin of ['\\\\host\\share\\relay.exe', '\\relay.exe']) assert.match(check(bin, { platform: 'win32' }), /an absolute path or a plain name/, bin);
  // In config.json a program is the file itself: a name there is not looked up.
  assert.match(G.checkDefinition({ ...base, bin: 'relay' }).error || '', /the absolute path of a file/);
});

test('the page\'s yes counts only for the file it was shown', async () => {
  const file = path.join(box.root, 'relay-yes.js');
  standIn(file, 'SHOWN');
  const raw = { id: 'relay', title: 'Relay', bin: file, port: await freePort() };
  const shown = await G.checkNew(raw);
  standIn(file, 'CHANGED-BEFORE-YES');
  const r = await G.addDefinition(raw, { expect: { bin: shown.def.bin, sha256: shown.def.sha256 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not the one you were shown/);
  assert.deepEqual(loadConfig().gateways?.defined || [], []);
});

test('a program that is not executable is refused at add with what to do, and a start says so instead of "not found"', MODES, async () => {
  const file = path.join(box.root, 'relay-noexec');
  standIn(file, 'NOEXEC');
  fs.chmodSync(file, 0o644);
  const raw = { id: 'relay', title: 'Relay', bin: file, port: await freePort() };
  assert.match(G.checkDefinition(raw, { forAdd: true }).error || '', /is not executable: make it so with chmod \+x/);
  fs.chmodSync(file, 0o755);
  const r = await G.addDefinition(raw);
  assert.equal(r.ok, true, r.error);
  fs.chmodSync(file, 0o644);
  try {
    const a = findAddon('relay');
    assert.equal((await a.status()).installed, true, 'the file is there');
    const s = await a.start();
    assert.equal(s.ok, false);
    assert.match(s.error, /is not executable: make it so with chmod \+x/);
  } finally {
    G.removeDefinition('relay');
  }
});

test('a gateway of the owner\'s own starts with no secret of the process that starts it', async () => {
  const file = path.join(box.root, 'relay-env'); // no extension: a #! stand-in Windows starts through Node, as the system does here
  const names = path.join(box.root, 'env-names.txt');
  fs.writeFileSync(file, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(names)}, Object.keys(process.env).join('\\n'));
require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[3]), '127.0.0.1');
`, { mode: 0o755 });
  // The fixed list of secrets, and what no such list names: cloud and registry credentials, an SSH agent, the marks of
  // the session whose PRERUN starts it.
  const SECRETS = { ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake', GITHUB_TOKEN: 'ghp_fake', GH_TOKEN: 'gho_fake', HOPRIG_ASSISTANT_TOKEN: 'tia-fake', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fake', HOPRIG_RUN_FILE: '/x/run.json', HOPRIG_TERM_ID: 't1', AWS_SECRET_ACCESS_KEY: 'aws-fake', NPM_TOKEN: 'npm-fake', DATABASE_PASSWORD: 'db-fake', HF_TOKEN: 'hf-fake', SSH_AUTH_SOCK: '/x/agent.sock', HOPRIG_PROFILE: 'api' };
  const NEEDED = { LANG: 'C.UTF-8', https_proxy: 'http://proxy.example:3128', XDG_CONFIG_HOME: '/x/config' };
  const keep = { ...process.env };
  Object.assign(process.env, SECRETS, NEEDED);
  try {
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: file, port: await freePort() });
    assert.equal(r.ok, true, r.error);
    assert.equal((await startAndStop(findAddon('relay'))).ok, true);
    const got = fs.readFileSync(names, 'utf8').split('\n');
    // Windows' names are case-blind, and its PATH is often spelled Path: a name counts in any case there.
    const has = (k) => got.some((g) => (process.platform === 'win32' ? g.toUpperCase() === k.toUpperCase() : g === k));
    assert.deepEqual(['PATH', 'HOME', ...Object.keys(NEEDED)].filter((k) => !has(k)), [], `what a server needs is there (it got ${got.join(', ')})`);
    assert.deepEqual(Object.keys(SECRETS).filter((k) => has(k)), []);
  } finally {
    for (const k of [...Object.keys(SECRETS), ...Object.keys(NEEDED)]) if (k in keep) process.env[k] = keep[k]; else delete process.env[k];
    G.removeDefinition('relay');
  }
});

test('on Windows a gateway of the owner\'s own defined by its npm package is refused: it could never start there', () => {
  const raw = { id: 'relay', title: 'Relay', npm: 'relay-gateway', port: 20100 };
  for (const forAdd of [true, false]) assert.match(G.checkDefinition(raw, { forAdd, platform: 'win32' }).error || '', /on Windows a gateway of your own is its program, not an npm package/);
  assert.equal(G.checkDefinition(raw, { platform: 'linux' }).error, undefined, 'elsewhere it is fine');
});

test('a gateway of an npm package runs the program npm installed globally, not a project\'s copy found first on PATH', NPM, async () => {
  const global = path.join(box.root, 'npm-global');
  const pkg = path.join(global, 'lib', 'node_modules', 'relay-gateway');
  const project = path.join(box.root, 'shop', 'node_modules');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(path.join(global, 'bin'));
  fs.mkdirSync(path.join(project, 'relay-gateway'), { recursive: true });
  fs.mkdirSync(path.join(project, '.bin'));
  standIn(path.join(pkg, 'cli.js'), 'GLOBAL');
  standIn(path.join(project, 'relay-gateway', 'cli.js'), 'PROJECT-COPY');
  fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(global, 'bin', 'relay'));
  fs.symlinkSync(path.join(project, 'relay-gateway', 'cli.js'), path.join(project, '.bin', 'relay'));
  const was = process.env.PATH;
  try {
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', npm: 'relay-gateway', bin: 'relay', port: await freePort() });
    assert.equal(r.ok, true, r.error);
    process.env.PATH = [path.join(project, '.bin'), path.join(global, 'bin'), was].join(path.delimiter); // a session in the project
    const s = await startAndStop(findAddon('relay'));
    assert.equal(s.ok, true, s.error);
    assert.deepEqual(ran(), ['GLOBAL']);
    process.env.PATH = [path.join(project, '.bin'), was].join(path.delimiter);
    assert.equal((await findAddon('relay').status()).installed, false, 'only a copy that is not npm\'s global one: not installed');
    // A folder in the workspace (where sessions write) laid out like npm's global one, first on PATH: not it either.
    const shaped = path.join(box.workspace, 'shop', 'lib', 'node_modules', 'relay-gateway');
    fs.mkdirSync(shaped, { recursive: true });
    fs.mkdirSync(path.join(box.workspace, 'shop', 'node_modules', '.bin'), { recursive: true });
    standIn(path.join(shaped, 'cli.js'), 'WORKSPACE-SHAPED-LIKE-GLOBAL');
    fs.symlinkSync(path.join(shaped, 'cli.js'), path.join(box.workspace, 'shop', 'node_modules', '.bin', 'relay'));
    process.env.PATH = [path.join(box.workspace, 'shop', 'node_modules', '.bin'), path.join(global, 'bin'), was].join(path.delimiter);
    const w = await startAndStop(findAddon('relay'));
    assert.equal(w.ok, true, w.error);
    assert.deepEqual(ran(), ['GLOBAL', 'GLOBAL'], 'npm\'s global program ran, not the workspace\'s');
  } finally {
    process.env.PATH = was;
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('a gateway of an npm package never runs a program from a folder others can change, laid out like npm\'s global one', NPM, async () => {
  const { packageProgram } = await import('../../src/addons/localgateway.mjs');
  const global = path.join(box.root, 'npm-global-2');
  const pkg = path.join(global, 'lib', 'node_modules', 'relay-gateway');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(path.join(global, 'bin'));
  standIn(path.join(pkg, 'cli.js'), 'GLOBAL');
  fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(global, 'bin', 'relay'));
  // Outside the workspace, in a folder everyone may write (no sticky bit): anyone could have laid it out.
  const open = path.join(box.root, 'open');
  const shaped = path.join(open, 'x', 'lib', 'node_modules', 'relay-gateway');
  fs.mkdirSync(shaped, { recursive: true });
  fs.mkdirSync(path.join(open, 'x', 'node_modules', '.bin'), { recursive: true });
  standIn(path.join(shaped, 'cli.js'), 'OPEN-FOLDER');
  fs.symlinkSync(path.join(shaped, 'cli.js'), path.join(open, 'x', 'node_modules', '.bin', 'relay'));
  fs.chmodSync(open, 0o777);
  const openBin = path.join(open, 'x', 'node_modules', '.bin');
  const was = process.env.PATH;
  try {
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', npm: 'relay-gateway', bin: 'relay', port: await freePort() });
    assert.equal(r.ok, true, r.error);
    // The same rule as for a program the owner names: pinProgram refuses that file too.
    assert.match(G.pinProgram(path.join(shaped, 'cli.js')).error, /other users of this computer can change/);
    process.env.PATH = [openBin, path.join(global, 'bin'), was].join(path.delimiter);
    assert.equal(packageProgram({ npm: 'relay-gateway', bin: 'relay' }), path.join(global, 'bin', 'relay'));
    const s = await startAndStop(findAddon('relay'));
    assert.equal(s.ok, true, s.error);
    assert.deepEqual(ran(), ['GLOBAL'], 'npm\'s global program ran, not the one in the open folder');
    process.env.PATH = [openBin, was].join(path.delimiter);
    assert.equal((await findAddon('relay').status()).installed, false, 'only the open folder\'s: not installed');
  } finally {
    fs.chmodSync(open, 0o755);
    process.env.PATH = was;
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});
