// Set-up's access question: the default stays "devices on my network", and its label says plainly that it is for your
// own Wi-Fi only and not encrypted, so not for a shared or public Wi-Fi.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { which } = await import('../../src/setup/system.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: true }) });
const PATH = pathWith(s.tmp, bin);

test('the access question: the network default says own Wi-Fi only and not encrypted', async () => {
  const env = { ...process.env, PATH };
  for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[k];
  const has = (c) => c !== 'systemctl' && !!which(c, env, process.platform);
  const sys = K.sysInfo({ env, has, pm: null, root: false, serviceSupported: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null });
  const rec = recorder();
  const ui = makeUi({ interactive: false, dryRun: true, write: rec.write, askLine: async (q) => { throw new Error(`unexpected question: ${q}`); } });
  await SU.stepAccess(ui, sys, { access: null }, {});
  const line = rec.text.split('\n').find((l) => /my phone on the same Wi-Fi/.test(l)) || '';
  assert.match(line, /devices on my network, e\.g\. my phone on the same Wi-Fi: inside your own Wi-Fi only and not encrypted, so not for a shared or public Wi-Fi/);
  assert.match(line, /\(default\)/, 'the default stays the network');
});
