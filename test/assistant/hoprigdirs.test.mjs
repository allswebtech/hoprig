// Hoprig's own folders (src/paths.mjs hoprigOwnDirs) are the set an administrator command of Tia's may never write,
// at every level, Full too (docs/OPERATOR.md, Administrator rights). This holds the set complete: every folder Hoprig keeps
// things in — its settings (with the profiles), its runtime state (the runs, the handed hook settings and the coding
// tools it installs) and where it is installed — is covered, and a sudo write under each is refused as "hoprig-own" by
// the one reader (adminRefusal / sudoArgv), the functions the run_command administrator path passes hoprigOwnDirs() to.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { adminRefusal, sudoArgv } from '../../src/assistant/adminrefused.mjs';
import { configDir, hookSettingsDir, hoprigOwnDirs, runsDir, stateDir, toolsDir } from '../../src/paths.mjs';

// A config/state folder of this test's own, so the folders are known and are never this computer's real ones.
const base = path.join(process.env.TMPDIR || '/tmp', 'hoprigdirs-test');
process.env.HOPRIG_CONFIG_DIR = path.join(base, 'config');
process.env.HOPRIG_STATE_DIR = path.join(base, 'state');

const under = (p, dirs) => dirs.some((d) => p === d || p.startsWith(`${d}/`));

test('hoprigOwnDirs covers every folder Hoprig keeps things in, the state sub-folders by one entry', () => {
  const dirs = hoprigOwnDirs();
  assert.equal(dirs.length, 3, 'settings, state, install');
  assert.ok(dirs.includes(configDir()), 'the settings folder');
  assert.ok(dirs.includes(stateDir()), 'the runtime state folder');
  assert.ok(path.isAbsolute(dirs[2]), 'the install folder, an absolute path');
  // The runs, the handed hook settings and the installed coding tools all live under the state folder: one entry
  // covers them, so the list cannot forget one of them.
  for (const d of [runsDir(), toolsDir(), hookSettingsDir()]) assert.ok(under(d, dirs), `${d} is covered`);
});

test('a sudo write under each Hoprig folder is refused as hoprig-own, through both readers', () => {
  const dirs = hoprigOwnDirs();
  for (const d of [configDir(), stateDir(), runsDir(), toolsDir(), hookSettingsDir(), dirs[2]]) {
    const line = `sudo tee ${d}/x`;
    assert.equal(adminRefusal(line, { hoprigDirs: dirs }).id, 'hoprig-own', `adminRefusal refuses a write to ${d}`);
    const r = sudoArgv(line, { hoprigDirs: dirs });
    assert.equal(r.refuse && r.refuse.id, 'hoprig-own', `sudoArgv refuses a write to ${d}`);
  }
});

test('a sudo write that touches no Hoprig folder is not refused for that reason (it reaches the level path)', () => {
  const line = `sudo tee ${path.join(base, 'elsewhere', 'x')}`;
  assert.equal(adminRefusal(line, { hoprigDirs: hoprigOwnDirs() }), null);
  assert.ok(sudoArgv(line, { hoprigDirs: hoprigOwnDirs() }).argv, 'a plain admin write elsewhere is a runnable argv');
});
