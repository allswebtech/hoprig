// A program of the owner's own whose file moved (an update that puts a new version in a new folder and moves the link,
// or a name on PATH that now leads to another place): `hoprig gateways confirm` looks up again what he typed when he
// added it, shows the exact file it leads to now and what changed, and pins that only on his yes; the definition, its
// sharing and other computers' keys stay. A definition from before that was kept says so and takes --program.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewaymove');
const LINKS = { skip: process.platform === 'win32' && 'a symbolic link to a versioned folder: Windows makes one only with the right to (an administrator or developer mode)' };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const marker = path.join(box.root, 'ran.txt');
// A stand-in gateway that says which version it is, then answers on its port.
function version(file, name) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + '\\n');
require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[3]), '127.0.0.1');
`, { mode: 0o755 });
  return file;
}
const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);
const started = [];
test.after(() => {
  for (const pid of started) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  box.cleanup();
});

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const G = await import('../../src/addons/gateways.mjs');
const K = await import('../../src/gateway/keys.mjs');
const { main } = await import('../../src/addons/gatewaycli.mjs');
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
const stored = () => loadConfig().gateways.defined.find((d) => d.id === 'relay');
function io(answer) {
  const said = [];
  const asked = [];
  return { said, asked, out: (s) => said.push(s), err: (s) => said.push(s), ask: async (q) => { asked.push(q); return answer; }, tty: true, env: {} };
}
const opt = path.join(box.root, 'opt');
const link = path.join(box.root, 'bin', 'relay');
fs.mkdirSync(path.dirname(link), { recursive: true });

test('a link moved to a new versioned folder: confirm shows the new file and what changed; No leaves all as it was, Yes runs it with sharing and keys', LINKS, async () => {
  const v1 = version(path.join(opt, 'relay-1.0', 'relay'), 'V1');
  fs.symlinkSync(v1, link);
  const port = await freePort();
  try {
    let t = io('y');
    assert.equal(await main(['add', 'relay', '--title', 'Relay', '--bin', link, '--port', String(port)], t), 0, t.said.join('\n'));
    assert.deepEqual([stored().bin, stored().typed], [v1, link], 'the file pinned, and the link as it was typed beside it');
    K.setShared('relay', 'relay');
    const key = K.createKey('relay', 'laptop').key;
    // The update: the new version beside the old one, the link moved, the old folder removed.
    const v2 = version(path.join(opt, 'relay-2.0', 'relay'), 'V2');
    fs.rmSync(link);
    fs.symlinkSync(v2, link);
    fs.rmSync(path.dirname(v1), { recursive: true });
    const st = await findAddon('relay').status();
    assert.equal(st.needsConfirm, 'gone', 'said as a program to confirm, not only "not installed"');
    const s = await findAddon('relay').start();
    assert.equal(s.ok, false);
    assert.match(s.error, /is not on this computer any more \(an update may have moved it\).*confirm it with hoprig gateways confirm relay, or with Confirm the program in Settings → Add-ons/);
    const listed = io(null);
    await main([], listed);
    assert.match(listed.said.join('\n'), /relay {2}Relay \(yours\) · its program is not where you confirmed it\n.*\n {2}its program is not where you confirmed it any more .*: if that is yours, hoprig gateways confirm relay$/m);
    // No: nothing is pinned again.
    const before = JSON.stringify(loadConfig());
    t = io('n');
    assert.equal(await main(['confirm', 'relay'], t), 1);
    const shown = t.said.join('\n');
    assert.match(shown, new RegExp(`you confirmed ${v1}, and ${link} leads to ${v2} now\\.`), shown);
    assert.ok(t.said.includes(`  ${v2} --port ${port}`), 'the exact program it runs now');
    assert.ok(t.said.includes(`Its fingerprint (sha256) now: ${fileSha256(v2)}`), shown);
    assert.deepEqual(t.asked, ['Confirm it? (y/N) ']);
    assert.equal(JSON.stringify(loadConfig()), before, 'No changes nothing');
    // Yes: the new file is pinned; the link stays what was typed; sharing and keys stay.
    t = io('y');
    assert.equal(await main(['confirm', 'relay'], t), 0, t.said.join('\n'));
    assert.deepEqual([stored().bin, stored().sha256, stored().typed], [v2, fileSha256(v2), link]);
    assert.equal(K.sharedProvider('relay'), 'relay', 'sharing stays');
    assert.equal(K.verifyKey(key, 'relay')?.name, 'laptop', 'the other computer\'s key still works');
    assert.equal((await findAddon('relay').status()).needsConfirm, undefined);
    assert.equal((await startAndStop(findAddon('relay'))).ok, true);
    assert.deepEqual(ran(), ['V2']);
  } finally {
    G.removeDefinition('relay');
    fs.rmSync(link, { force: true });
    fs.rmSync(marker, { force: true });
  }
});

test('a name typed at add time and found on PATH at another place later: confirm shows that place and pins it on a yes', async () => {
  const first = path.join(box.root, 'first-bin');
  const second = path.join(box.root, 'second-bin');
  version(path.join(first, 'relay'), 'FIRST');
  const was = process.env.PATH;
  try {
    process.env.PATH = `${first}${path.delimiter}${was}`;
    assert.equal((await G.addDefinition({ id: 'relay', title: 'Relay', bin: 'relay', port: await freePort() })).ok, true);
    assert.deepEqual([stored().bin, stored().typed], [path.join(first, 'relay'), 'relay']);
    // Reinstalled elsewhere: the old one gone, the new one on PATH.
    fs.rmSync(first, { recursive: true });
    version(path.join(second, 'relay'), 'SECOND');
    process.env.PATH = `${second}${path.delimiter}${was}`;
    const asked = G.repinned('relay');
    assert.deepEqual([asked.was, asked.from, asked.def.bin, asked.def.typed], ['changed', path.join(first, 'relay'), path.join(second, 'relay'), 'relay']);
    assert.match(G.confirmProgram('relay', { expect: { bin: path.join(first, 'relay'), sha256: asked.def.sha256 } }).error, /not the one you were shown/);
    assert.equal(G.confirmProgram('relay', { expect: { bin: asked.def.bin, sha256: asked.def.sha256 } }).ok, true);
    assert.equal(stored().bin, path.join(second, 'relay'));
    assert.equal((await startAndStop(findAddon('relay'))).ok, true);
    assert.deepEqual(ran(), ['SECOND']);
  } finally {
    process.env.PATH = was;
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('a definition from before the typed program was kept: its moved program is named with --program; sharing and keys stay', async () => {
  const v1 = version(path.join(opt, 'old-1.0', 'relay'), 'OLD-V1');
  const port = await freePort();
  // As an older version wrote it: the file and its fingerprint, nothing typed.
  saveConfig({ gateways: { defined: [{ id: 'relay', title: 'Relay', port, bin: v1, sha256: fileSha256(v1) }] } });
  K.setShared('relay', 'relay');
  const key = K.createKey('relay', 'laptop').key;
  const v2 = version(path.join(opt, 'old-2.0', 'relay'), 'OLD-V2');
  fs.rmSync(path.dirname(v1), { recursive: true });
  try {
    assert.equal((await findAddon('relay').status()).needsConfirm, 'gone-old');
    assert.match((await findAddon('relay').start()).error, /If an update moved it, name the program it is now: hoprig gateways confirm relay --program <path>/);
    let t = io('y');
    assert.equal(await main(['confirm', 'relay'], t), 1);
    assert.match(t.said.join('\n'), /Not confirmed: there is no file .* on this computer, and config\.json does not keep the program as you named it .*: name the program it is now with hoprig gateways confirm relay --program <path>\./);
    assert.deepEqual(t.asked, []);
    assert.equal(await main(['confirm', 'relay', '--program'], io('y')), 2, 'the option needs its value');
    t = io('n');
    assert.equal(await main(['confirm', 'relay', '--program', v2], t), 1);
    const re = (p) => p.replace(/[\\/.]/g, '\\$&'); // a path as plain text in the expression (C:\… on Windows)
    assert.match(t.said.join('\n'), new RegExp(`you confirmed ${re(v1)}, and ${re(v2)} leads to ${re(v2)} now`));
    assert.equal(stored().bin, v1, 'No changes nothing');
    t = io('y');
    assert.equal(await main(['confirm', 'relay', '--program', v2], t), 0, t.said.join('\n'));
    assert.deepEqual(stored(), { id: 'relay', title: 'Relay', port, bin: v2, sha256: fileSha256(v2), typed: v2 });
    assert.equal(K.sharedProvider('relay'), 'relay');
    assert.equal(K.verifyKey(key, 'relay')?.name, 'laptop');
    assert.equal((await startAndStop(findAddon('relay'))).ok, true);
    assert.deepEqual(ran(), ['OLD-V2']);
  } finally {
    G.removeDefinition('relay');
    fs.rmSync(marker, { force: true });
  }
});

test('what was typed is checked when it is read: a hand-written one that is no program, or one on an npm package, is refused', () => {
  const ok = { id: 'relay', title: 'Relay', port: 20100, bin: '/opt/relay/bin/relay' };
  const LINUX = { platform: 'linux' }; // a POSIX path and an npm package: the rules of Linux (Windows refuses an npm gateway)
  assert.equal(G.checkDefinition({ ...ok, typed: 'relay' }, LINUX).def.typed, 'relay');
  assert.equal(G.checkDefinition(ok, LINUX).def.typed, null);
  for (const typed of ['../relay', 'relay;id', 7, '']) assert.match(G.checkDefinition({ ...ok, typed }, LINUX).error, /typed: the program is an absolute path or a plain name/);
  assert.match(G.checkDefinition({ id: 'relay', title: 'Relay', port: 20100, npm: 'relay-gw', typed: 'relay-gw' }, LINUX).error, /typed belongs to a program/);
});
