// Hoprig's permission hook in bypass mode (hook.mjs hookAnswer) allows a plain delete inside the folder the command
// runs in. Inside, or around, an extra folder of the session (a need, --with, "Also open") it never answers: that
// folder is read-only for the session, and only the owner answers there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { extraDirs, hookAnswer } = await import('../../src/hook.mjs');

test('the hook never allows an act in or around an extra folder; elsewhere it answers as before', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-needshook-')));
  try {
    const shop = path.join(root, 'ws', 'projects', 'shop');
    const parts = path.join(root, 'ws', 'kits', 'parts');
    for (const d of [path.join(shop, 'build', 'a'), path.join(parts, 'build', 'a')]) fs.mkdirSync(d, { recursive: true });
    const ev = (cwd) => ({ hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions', tool_name: 'Bash', cwd, tool_input: { command: 'rm -rf build/*/*' } });
    const facts = (cwd, extras) => ({ rules: () => [], places: () => ({ home: path.join(root, 'home'), workspace: path.join(root, 'ws'), projects: [path.join(root, 'ws', 'projects')], cwd, relative: true }), extras: () => extras });
    assert.ok(hookAnswer(ev(shop), facts(shop, [])), 'without extra folders: allowed as before');
    assert.ok(hookAnswer(ev(shop), facts(shop, [parts])), 'in its own folder: still allowed');
    assert.equal(hookAnswer(ev(parts), facts(parts, [parts])), null, 'in the extra folder: never');
    assert.equal(hookAnswer(ev(path.join(parts, 'build')), facts(path.join(parts, 'build'), [parts])), null, 'inside it: never');
    assert.equal(hookAnswer(ev(path.join(root, 'ws', 'kits')), facts(path.join(root, 'ws', 'kits'), [parts])), null, 'around it: never');
    // Through a link to it: the same folder.
    fs.symlinkSync(parts, path.join(root, 'p'));
    assert.equal(hookAnswer(ev(path.join(root, 'p')), facts(path.join(root, 'p'), [parts])), null, 'by a link: never');
    // The extra folders are read from the settings file Hoprig handed the session.
    const f = path.join(root, 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ permissions: { additionalDirectories: [parts, 'relative/x', 7] } }));
    assert.deepEqual(extraDirs(f), [parts]);
    assert.deepEqual(extraDirs(path.join(root, 'none.json')), []);
    assert.deepEqual(extraDirs(null), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
