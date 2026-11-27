// The quiet first run of `hoprig setup` (no settings file yet): it asks nothing, runs none of the later parts, keeps the
// dashboard to this computer, prints no QR code and no password line, and ends by opening the browser at a one-time
// link of 127.0.0.1. A second run (the settings file is there now) is today's full run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder, scratch, windowsFacts } from './helpers.mjs';

const s = scratch({ fresh: true });
test.after(s.cleanup);
globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });

const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const FR = await import('../../src/setup/firstrun.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { loadConfig } = await import('../../src/config.mjs');
const { configFile } = await import('../../src/paths.mjs');
const { which } = await import('../../src/setup/system.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: false }) });
function sys(env = {}, platform = process.platform) {
  const e = { ...process.env, PATH: pathWith(s.tmp, bin), ...env };
  for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT', ...(env.DISPLAY ? [] : ['DISPLAY']), 'WAYLAND_DISPLAY']) if (!(k in env)) delete e[k];
  const made = K.sysInfo({ env: e, platform, has: (c) => c !== 'systemctl' && !!which(c, e, process.platform), pm: null, root: false, serviceSupported: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, run: windowsFacts(e) });
  made.probe = async () => 0;
  made.ownGateways = false;
  return made;
}
const asked = [];
const noQuestions = async (q) => {
  asked.push(q);
  throw new Error(`unexpected question: ${q}`);
};
const never = (name) => async () => {
  throw new Error(`the part "${name}" must not run on a first run`);
};
const PARTS = { workspace: never('workspace'), git: never('git'), pc: never('pc'), projectNew: never('project'), cloneProject: never('project'), projectSkills: never('skills'), userSkills: never('skills'), projects: async () => ({ dir: '/nowhere', names: [] }) };

test('a first run asks nothing, runs none of the later parts, and opens the browser at a one-time link', async () => {
  assert.equal(fs.existsSync(configFile()), false, 'fresh: no settings file yet');
  const rec = recorder();
  const ui = makeUi({ interactive: false, write: rec.write, askLine: noQuestions });
  const opened = [];
  const code = await SU.setup(['--no-service'], { ui, sys: sys({ DISPLAY: ':0' }), parts: PARTS, open: (u) => { opened.push(u); return true; } });
  const text = rec.text;
  assert.equal(code, 0, text);
  assert.deepEqual(asked, [], 'no question was asked');
  assert.equal(loadConfig().server.host, '127.0.0.1', 'only this computer');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/login#link=[A-Za-z0-9_-]{43}$/);
  assert.match(text, /Opening Hoprig in your browser/);
  assert.ok(text.includes(opened[0]), 'the fallback link is printed');
  assert.match(text, /You can close this window/);
  for (const gone of [/Scan with your phone/, /Password, if asked/, /Add another provider/, /Check everything/, /Still yours to do/, /Install these/, /GitHub/, /hoprig setup \d/]) assert.doesNotMatch(text, gone);
  assert.match(text, /Claude Code/, 'a tick for Claude Code');
});

test('without a browser at hand the link is printed to open', async () => {
  fs.rmSync(configFile(), { force: true });
  const rec = recorder();
  const ui = makeUi({ interactive: false, write: rec.write, askLine: noQuestions });
  const opened = [];
  // Linux with no display: a Mac or a Windows computer always has a browser to open, so this case is Linux only
  await SU.setup(['--no-service'], { ui, sys: sys({}, 'linux'), parts: PARTS, open: (u) => { opened.push(u); return true; } });
  const text = rec.text;
  assert.deepEqual(opened, [], 'no desktop: nothing opened');
  assert.match(text, /Open this link in your browser/);
  assert.match(text, /#link=/);
});

test('a second run (the settings file is there) is the full run: its banner, its closing', async () => {
  assert.equal(fs.existsSync(configFile()), true, 'the first run left its settings');
  const rec = recorder();
  const ui = makeUi({ interactive: false, write: rec.write, askLine: async () => null });
  const parts = { ...PARTS, workspace: async () => ({ ok: true }), git: async () => ({ ok: true }), pc: async () => ({ ok: true, missing: [] }), userSkills: async () => ({ ok: true, added: [], skipped: [] }), projectSkills: async () => ({ ok: true, added: [], skipped: [] }) };
  const opened = [];
  await SU.setup(['--no-service'], { ui, sys: sys(), parts, open: (u) => { opened.push(u); return true; } });
  const text = rec.text;
  assert.match(text, /hoprig setup/, 'the banner');
  assert.deepEqual(opened, [], 'it opens no browser');
});

test('what makes a run a first run', () => {
  const none = path.join(s.tmp, 'no-such-settings.json');
  assert.equal(FR.isFirstRun({}, none), true);
  for (const o of [{ hub: true }, { only: 'pc' }, { dryRun: true }, { access: 'network' }, { stayRoot: true }, { noDashboard: true }]) assert.equal(FR.isFirstRun(o, none), false, JSON.stringify(o));
  assert.equal(FR.isFirstRun({}, configFile()), false, 'the settings file is there');
});
