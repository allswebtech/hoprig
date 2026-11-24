// Custom address without a dashboard password: the refusal sends the code no-password beside its words, so the page
// adds one button to Settings → Security at the Password panel (web/errorways.js). The stand-in cloudflared on PATH is
// a script of this test's own; the refusal comes before anything is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nopassword-code-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const ran = path.join(tmp, 'ran');
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(ran)}, 'x');\n`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { publicLink } = await import('../../src/addons/linkaddon.mjs');
const { saveConfig } = await import('../../src/config.mjs');

test('making the Custom address without a password: no-password, and nothing is run', async () => {
  saveConfig({ server: { port: 7433 } });
  const r = await publicLink.actions['fixed-create']({ hostname: 'office.example.com' }, { onLine: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-password');
  assert.equal(r.error, 'Set a dashboard password first (Settings → Security and sign-in): the public link opens the sign-in page, and it needs a password.');
  assert.equal(fs.existsSync(ran), false, 'the stand-in was never run');
});

test('the page passes the job result to its toast, and Learn from this shows the way of its error', () => {
  const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
  assert.match(read('publiclink.js'), /toast\(res\.error \|\| 'That did not work', \{ kind: 'error', from: res \}\)/);
  assert.match(read('workdo.js'), /say\(e\.message, ' ', wayLink\(e\)\)/);
});
