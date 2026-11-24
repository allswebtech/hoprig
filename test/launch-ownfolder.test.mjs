import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Every location goes to a scratch folder BEFORE the modules read the environment.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-test-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P = await import('../src/profiles.mjs');
const L = await import('../src/launch.mjs');
const RS = await import('../src/routerstate.mjs');

// A reply on a provider that keeps Claude Code's folder in a folder of its own says nothing about the default folder's
// sign-in: Providers must not show the default provider as signed in (and hide its Sign in) after it.
test('a reply on a provider with a folder of its own leaves the default folder\'s sign-in mark as it was', { skip: process.platform === 'win32' }, async () => {
  // The stand-in Claude Code runs Hoprig's real hook program: it starts, one reply ends (Stop), it exits.
  const fake = path.join(tmp, 'fake-claude-reply.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8'));
const fire = (ev) => execSync(s.hooks[ev.hook_event_name][0].hooks[0].command, { input: JSON.stringify({ session_id: '7e570000-0000-4000-8000-00000000f001', ...ev }) });
fire({ hook_event_name: 'SessionStart', source: 'startup' });
fire({ hook_event_name: 'Stop', last_assistant_message: 'done' });
process.exit(0);
`, { mode: 0o755 });
  fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ claudeBin: fake, usage: false }));
  const own = path.join(tmp, 'own-claude');
  fs.mkdirSync(own, { recursive: true });
  P.writeProfile('alpha', { env: { CLAUDE_CONFIG_DIR: own } });
  P.writeProfile('beta', {});
  assert.equal(P.readProfile('alpha').kind, 'login');
  assert.equal(P.ownFolder(P.readProfile('alpha')), true);
  const mark = path.join(process.env.HOPRIG_STATE_DIR, 'claude-login.json');
  const write = process.stderr.write;
  const quiet = async (name) => {
    process.stderr.write = () => true;
    try {
      return await L.launch(name, ['-p', 'hi']);
    } finally {
      process.stderr.write = write;
    }
  };
  // The default folder is known as signed out, more than a minute ago.
  RS.rememberLogin({ loggedIn: false }, Date.now() - 5 * 60_000);
  const before = fs.readFileSync(mark, 'utf8');
  assert.equal(await quiet('alpha'), 0);
  assert.equal(fs.readFileSync(mark, 'utf8'), before, 'claude-login.json is left as it was');
  assert.equal(RS.loginSeen().loggedIn, false);
  // The same reply on the default folder's own provider still marks it signed in: the mark works, only not for alpha.
  assert.equal(await quiet('beta'), 0);
  assert.equal(RS.loginSeen().loggedIn, true, 'a reply on the default folder marks it signed in');
});

// Auto mode's check "is anybody signed in to Claude Code" reads the default folder: an identity with a folder of its
// own is not asked about it, so a signed-out default folder never moves Auto mode off such an identity.
test('Auto mode asks the default folder\'s sign-in only for an identity without a folder of its own', async () => {
  const own = path.join(tmp, 'own-claude-auto');
  fs.mkdirSync(own, { recursive: true });
  for (const p of P.listProfiles()) P.deleteProfile(p.name);
  P.writeProfile('alpha', { env: { CLAUDE_CONFIG_DIR: own } });
  P.writeProfile('gamma', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-made-up-000' } }); // seal: a value no program is started with
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ autoSwitch: { enabled: true, order: ['alpha', 'gamma'] } }));
  let asked = 0;
  const loginStatus = async () => { asked++; return { loggedIn: false }; };
  const R = await import('../src/router.mjs');
  const ident = R.autoIdentity(['alpha', 'gamma'], P.listProfiles(), new Set());
  assert.equal(ident?.name, 'alpha', 'the first of the order is the identity');
  // Only the identity choice is looked at: the router itself is never started here.
  const got = await L.autoIdentityFor({ loginStatus });
  assert.equal(got.name, 'alpha', 'stays on its own folder');
  assert.equal(asked, 0, 'the default folder was not asked');
});
