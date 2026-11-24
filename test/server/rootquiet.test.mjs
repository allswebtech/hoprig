// With nothing asked, a dashboard start and three looks at the sessions make no user and change nothing outside the
// state folder, as an ordinary user and as root (root is a fact handed in: nothing here runs as root). Every
// administrator program is a stand-in first on PATH that writes down what it was asked; `getent` is the one look
// that is allowed (the work user is read, never made).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { sealedPath } from '../seal.mjs';

const box = sandbox('rootquiet');
delete process.env.container;
const bin = path.join(box.root, 'admin-bin');
const asked = path.join(box.root, 'asked.log');
fs.mkdirSync(bin);
const ADMIN = ['useradd', 'usermod', 'userdel', 'chpasswd', 'passwd', 'runuser', 'su', 'sudo', 'visudo', 'loginctl', 'chown', 'systemctl', 'getent'];
for (const n of ADMIN) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} $*" >> '${asked}'\n${n === 'getent' ? 'exit 2' : 'exit 0'}\n`, { mode: 0o755 });
process.env.PATH = sealedPath([bin, ...String(process.env.PATH).split(path.delimiter)]);

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ launcher: ['L'], server: { roots: [box.workspace], passwordHash: await hashPassword('right-password') } });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name, id: 'pty-1' }), respawn: async () => {} };

/** Every file below the sandbox but the state folder, with its content: what a start must leave as it was. */
function outside() {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === box.state || p === asked) continue;
      if (e.isDirectory()) walk(p);
      else out[p] = e.isSymbolicLink() ? `-> ${fs.readlinkSync(p)}` : fs.readFileSync(p, 'utf8');
    }
  };
  walk(box.root);
  return out;
}

async function startAndLook(root) {
  fs.rmSync(asked, { force: true });
  const before = outside();
  const app = createServer({ backend, root, rootExists: () => false, watchTickMs: 50 });
  let ticks = 0;
  // The first look comes by itself a second after the start; an idle watcher waits long for the next, so the second
  // and third are asked here.
  const first = new Promise((resolve) => app.watcher.onTick(() => ++ticks === 1 && resolve()));
  await app.listen(0, '127.0.0.1');
  try {
    await Promise.race([first, new Promise((_, j) => setTimeout(() => j(new Error('no first look in 20 s')), 20_000))]);
    // A look that is still running ignores another tick: wait until it is done before asking the next.
    const idle = async () => { for (let i = 0; i < 200 && app.watcher.running; i++) await new Promise((r) => setTimeout(r, 25)); };
    for (let n = 2; n <= 3; n++) {
      await idle();
      await app.watcher.tick();
    }
    assert.equal(ticks, 3, 'three looks');
    await new Promise((r) => setTimeout(r, 200)); // a look the start began in the background has its time
  } finally {
    await app.close();
  }
  const after = outside();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
  const calls = fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8').split('\n').filter(Boolean) : [];
  return { changed, calls };
}

for (const root of [false, true]) {
  test(`${root ? 'as root' : 'as an ordinary user'}: a start and three looks make no user, ask no administrator program and write nothing outside the state folder`, async () => {
    const { changed, calls } = await startAndLook(root);
    assert.deepEqual(changed.map((p) => path.relative(box.root, p)), [], 'nothing outside the state folder changed');
    // Only looks: getent reads the work user Hoprig may have made, as root only.
    const admin = calls.filter((c) => !c.startsWith('getent passwd '));
    assert.deepEqual(admin, [], 'no administrator program was asked');
    if (!root) assert.deepEqual(calls, [], 'an ordinary user does not even look');
    // As root the work user is looked up through the stand-in: the log sees the programs the start asks.
    else assert.ok(calls.includes('getent passwd hoprig'), `the stand-ins are the ones asked: ${JSON.stringify(calls)}`);
  });
}

test.after(() => box.cleanup());
