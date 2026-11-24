// The public link's start finds no dashboard password any more (it was taken away while cloudflared installed, after
// the turn-on's own check passed): the status sends the code no-password beside its words, so Settings → Public link
// shows one button to Security at the Password panel (web/errorways.js). The "installed" cloudflared is a file of this
// test's own that is never run: the refusal comes before anything starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswitch-nopassword-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
const ran = path.join(tmp, 'ran');

const S = await import('../../src/addons/linkswitch.mjs');
const { binDir } = await import('../../src/addons/cloudflared.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashTag } = await import('../../src/server/strength.mjs');
const HASH = 'scrypt$32768$8$1$c2FsdA$aGFzaA';

test.after(async () => {
  await S.resetForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the password taken away during the install: the start is refused with no-password, and nothing runs', async () => {
  saveConfig({ server: { port: 7655, passwordHash: HASH, passwordCheck: { tag: hashTag(HASH), strong: true } } });
  // A computer without cloudflared: a PATH of this test's own empty folder (the runner's trap would count as one).
  const was = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(tmp, 'nobin-'));
  const installFn = async () => {
    saveConfig({ server: { passwordHash: '' } }); // the password goes while it installs
    fs.mkdirSync(binDir(), { recursive: true });
    fs.writeFileSync(path.join(binDir(), 'cloudflared'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(ran)}, 'x');\n`, { mode: 0o755 });
    return { ok: true };
  };
  try {
    await S.attach({ installFn, notifyFn: async () => ({ sent: false }), everyMs: 60_000 });
    assert.equal((await S.turnOn('temporary')).ok, true, 'the password was there at the turn-on');
    const s = await S.settled();
    assert.equal(s.state, 'error');
    assert.equal(s.error, 'Set a dashboard password first (Settings → Security and sign-in): the public link opens the sign-in page, and it needs a password.');
    assert.equal(s.code, 'no-password');
    assert.equal(fs.existsSync(ran), false, 'the stand-in was never run');
  } finally {
    process.env.PATH = was;
  }
  // Another failure later carries no stale code.
  await S.resetForTests();
  assert.equal('code' in S.status(), false);
});

test('Settings → Public link shows the way of its status\'s code beside the failure', () => {
  const page = fs.readFileSync(new URL('../../web/publiclink.js', import.meta.url), 'utf8');
  assert.match(page, /failure\(s\.error, wait, s\)/);
  assert.match(page, /const way = from \? wayLink\(from\) : null;/);
});
