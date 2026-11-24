// A session Tia started is no way round her administrator-rights level (src/hook.mjs
// sessionHold). Below Full, an act of a session she started that is the owner's alone is held as the owner's card —
// the coding tool's own "ask" dialog, the way the wall of Hands-off holds it — even with Hands-off off or not
// offered; at Full her administrator commands run without a card; a session HE started is untouched. The wall is the
// one reader of what is the owner's, so there is no gap: a line it cannot read with certainty (an administrator
// command hidden in $(…) or a backtick), and a delete or a change of the session's own Tia mark, are held too. Whose
// session it is is read from the mark the dashboard wrote beside the handed hook settings, never from the run record
// a command of the session can write.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-sessionhold-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { preToolHold } = await import('../../src/hook.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { configFile, hookFile, hookSettingsDir } = await import('../../src/paths.mjs');
const R = await import('../../src/runs.mjs');
const { readRun } = await import('../../src/runfile.mjs');

const V = hoprigVersion();
const CWD = path.join(tmp, 'proj');
fs.mkdirSync(CWD, { recursive: true });

// A PreToolUse event for a Bash command (the only tool an administrator command comes through).
const ev = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: CWD });
// A config that carries only the administrator-rights level (no Hands-off): handsOffOffered is false, so nothing but
// the session-hold can hold here — the level alone decides. Full is stamped with the running version, so it reads as
// Full (a Full under another version reads as Ask; its own test below).
const levelCfg = (level) => (level ? { server: { herRights: { level, version: V } } } : {});

test('a session she started, below Full: an administrator command is held as his card, Hands-off off', () => {
  for (const level of [undefined, 'off', 'ask']) {
    const hold = preToolHold(ev('sudo true'), { status: 'working' }, { cfg: levelCfg(level), byTia: true, version: V, project: CWD });
    assert.ok(hold, `held at level ${level ?? 'default'}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', 'the coding tool draws his card');
    assert.equal(hold.held.kind, 'admin', 'the wall read it as an administrator command');
  }
});

test('at Full her administrator commands run without a card', () => {
  assert.equal(preToolHold(ev('sudo true'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD }), null);
});

test('decision 4 is a floor Full does not lift: an escalator, a sudoers/PAM edit or a setuid bit is still held at Full', () => {
  // The forms refused at EVERY level: run at Full they would leave permanent root. They are held as his
  // card even at Full, so a bypass session cannot auto-run one while the owner is away and keep root after Off.
  // A root shell must not slip through at Full by a wrapper (env/nice) or a privilege tool (setpriv/unshare): these
  // run an arbitrary program as root while `sudo bash`/`sudo su` are correctly held, so the floor holds them too.
  for (const command of ['sudo su', 'sudo visudo', 'sudo chmod 4755 /bin/foo', 'sudo install -m4755 /bin/bash /tmp/r', 'sudo tee /etc/sudoers.d/mine', 'sudo env bash', 'sudo nice bash', 'sudo env su', 'sudo setpriv --reuid 0 bash', 'sudo unshare -r bash', 'sudo chroot / bash']) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD });
    assert.ok(hold, `held at Full: ${command}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', `his card at Full: ${command}`);
  }
  // Full still runs her ordinary administrator commands without a card (unchanged). The non-interactive apt form
  // Hoprig writes (`sudo env DEBIAN_FRONTEND=noninteractive apt-get …`) is an ordinary program read through the env
  // wrapper, so Full runs it too — the floor does not swallow a plain install.
  assert.equal(preToolHold(ev('sudo true'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD }), null);
  assert.equal(preToolHold(ev('sudo env DEBIAN_FRONTEND=noninteractive apt-get update'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD }), null);
  // The refusal of those forms is fail-closed at every level: a line the reader cannot break down (an administrator command hidden in
  // $(…) or a backtick) is refused, not run, so it is held as his card at Full too — never auto-run with no card.
  const unreadableAtFull = preToolHold(ev('sudo reboot $(date)'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD });
  assert.ok(unreadableAtFull, 'an unreadable administrator line is held at Full');
  assert.equal(unreadableAtFull.held.kind, 'unreadable', 'held as an uncertain line, not run with no card');
});

test('Full lifts only administrator commands: a push to the main branch and a release stay his card in her session', () => {
  // Full is about administrator rights alone. A push or a merge into the default branch and a release are his in every
  // mode, so at Full they are held as they are below it; a line that joins an administrator command with a push is
  // held for the push.
  for (const command of ['git push origin main', 'npm publish', 'sudo true && git push origin main']) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD });
    assert.ok(hold, `held at Full: ${command}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', `his card at Full: ${command}`);
    assert.notEqual(hold.held.kind, 'admin', `held for what is not an administrator command: ${command}`);
    assert.ok(hold.held.acts.every((a) => a.kind !== 'admin'), `the card lists no administrator command Full allows: ${command}`);
  }
});

test('Full chosen under another Hoprig version reads as Ask: her session is held again after an update', () => {
  const stale = { server: { herRights: { level: 'full', version: 'another-version' } } };
  const hold = preToolHold(ev('sudo true'), null, { cfg: stale, byTia: true, version: V, project: CWD });
  assert.ok(hold, 'a stale Full no longer runs her administrator commands without a card');
  assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask');
});

test('a session HE started is untouched: with Hands-off off, an administrator command goes through', () => {
  assert.equal(preToolHold(ev('sudo true'), null, { cfg: levelCfg('off'), byTia: false, version: V, project: CWD }), null);
});

test('an ordinary command of hers goes through: the wall holds nothing on it', () => {
  assert.equal(preToolHold(ev('npm test'), null, { cfg: levelCfg('off'), byTia: true, version: V, project: CWD }), null);
});

test('a line the wall cannot read is held for her session below Full: an administrator command cannot hide in $(…) or a backtick', () => {
  for (const command of ['sudo reboot $(date)', 'sudo `id` true', 'sh -c "sudo true $(x)"']) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('ask'), byTia: true, version: V, project: CWD });
    assert.ok(hold, `held: ${command}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', `his card: ${command}`);
    assert.equal(hold.held.kind, 'unreadable', `read as uncertain, not let through: ${command}`);
  }
  // The refusal of those forms is fail-closed at every level: a line the reader cannot read with certainty is held as his card at
  // Full too (held as an uncertain line), so an administrator command cannot hide in $(…) and auto-run with no card.
  const u = preToolHold(ev('sudo reboot $(date)'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD });
  assert.ok(u, 'held at Full');
  assert.equal(u.held.kind, 'unreadable');
});

test('a variable that is the program, and sudoedit, are held for her session below Full', () => {
  // The session-hold takes the wall's reading as it is, so the forms the wall now reads as administrator or as
  // uncertain are held as his card: sudoedit (editing a file as administrator) and a head that is a variable (its
  // value can be any program, e.g. `x=sudo; $x true` runs sudo).
  for (const command of ['x=sudo; $x true', 'sudoedit /etc/hosts']) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('ask'), byTia: true, version: V, project: CWD });
    assert.ok(hold, `held: ${command}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', `his card: ${command}`);
  }
  assert.equal(
    preToolHold(ev('sudoedit /etc/hosts'), null, { cfg: levelCfg('ask'), byTia: true, version: V, project: CWD }).held.kind,
    'admin',
    'sudoedit reads as an administrator act',
  );
});

test('an administrator command anywhere on the line is held, not only as the first act', () => {
  // The wall reads `npm publish && sudo true` as a release first, but the sudo is among the acts it found: the
  // session-hold reaches for that one administrator act, so the whole line is held.
  const hold = preToolHold(ev('npm publish && sudo true'), null, { cfg: levelCfg('ask'), byTia: true, version: V, project: CWD });
  assert.ok(hold, 'held when an administrator act is nested on the line');
  assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask');
});

// The hook program itself, the real route: it reads who the session is from the mark the dashboard wrote, and holds.
const runHook = (file, event) =>
  spawnSync(process.execPath, [hookFile()], {
    input: JSON.stringify(event),
    env: { ...process.env, HOPRIG_RUN_FILE: file, HOPRIG_WORKSPACE_DIR: path.join(tmp, 'ws') },
    encoding: 'utf8',
  });
const writeConfig = (cfg) => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
};
const markTia = (file) => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), `${path.basename(file)}.tia`), JSON.stringify({ byTia: true }));
};

test('the hook holds hers through its real route: the dashboard\'s mark, at level off, holds sudo', () => {
  writeConfig({}); // no Hands-off, default level off: only the session-hold can hold
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  markTia(file);
  const r = runHook(file, ev('sudo true'));
  assert.notEqual(r.stdout.trim(), '', 'the hook answered');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  R.removeRun(file);
});

test('the run record is NOT the source: without the dashboard\'s mark, byTia in the record holds nothing', () => {
  writeConfig({});
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  // A command of the session writes byTia into its own record: it must not make the session hers.
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), byTia: true, startedByTia: true }));
  const r = runHook(file, ev('sudo true'));
  assert.equal(r.stdout.trim(), '', 'the run record cannot mark a session hers');
  R.removeRun(file);
});

test('her session below Full cannot quietly unmark itself: a delete or a change of its own Tia mark is held', () => {
  // The mark sits beside the handed hook settings, in Hoprig's own state folder (the wall protects it). A session
  // handed $HOPRIG_RUN_FILE can compute the mark's path; deleting or rewriting it would set byTia false and lift the
  // session-hold. So any delete (outside its folder) or touch (mv/redirect) of Hoprig's own state is held as his card.
  for (const make of [(m) => `rm -f ${m}`, (m) => `mv ${m} ${m}.gone`, (m) => `echo '{}' > ${m}`]) {
    writeConfig({}); // no Hands-off, default level off: only the session-hold can hold
    const { file } = R.createRun({ profile: 'api', cwd: CWD });
    markTia(file);
    const mark = path.join(hookSettingsDir(), `${path.basename(file)}.tia`);
    const r = runHook(file, ev(make(mark)));
    assert.notEqual(r.stdout.trim(), '', `the hook answered: ${make('<mark>')}`);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask', `held: ${make('<mark>')}`);
    R.removeRun(file);
  }
});

test('at Full her session cannot delete its own mark by a ~ or a relative path with sudo', () => {
  // The mark is in Hoprig's state folder; sudo makes the line an administrator act, which Full lifts. The touch of
  // Hoprig's own files must stay his card at Full whichever spelling names the file, or the next command is unheld.
  const home = tmp;
  const state = process.env.HOPRIG_STATE_DIR; // <tmp>/state, so ~/state/… is the same file
  const places = { hoprig: [process.env.HOPRIG_CONFIG_DIR, state], home, workspace: path.join(tmp, 'ws'), projects: [], own: CWD, cwd: CWD, relative: true };
  const mark = 'hook-settings/abc-123.json.tia';
  for (const command of [`sudo rm ~/state/${mark}`, `sudo rm $HOME/state/${mark}`, `sudo rm ../state/${mark}`, `sudo rm ${path.join(state, mark)}`, 'sudo tee ~/config/config.json']) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD, places });
    assert.ok(hold, `held at Full: ${command}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', `his card at Full: ${command}`);
  }
  // An ordinary administrator command elsewhere still runs at Full. A delete elsewhere does not: a delete outside the
  // session's folder is the owner's without sudo, and sudo does not hide it (test/assistant/fullholds.test.mjs).
  assert.equal(preToolHold(ev('sudo systemctl restart nginx'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD, places }), null);
  assert.equal(preToolHold(ev('sudo rm /var/tmp/old.log'), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD, places }).held.kind, 'delete outside');
});

test('at Full a sudo touch of the home folder itself is held as his card by any spelling (its state folder and mark live under home)', () => {
  // Deleting the whole home by its ~ or $HOME spelling removes Hoprig's state folder — the hers-mark among it — and
  // then the session is no longer held even after the owner sets the level back to Off. Full lifts her administrator
  // commands but not a touch of the files that decide how the session is held, whichever spelling names home.
  const home = tmp;
  const state = process.env.HOPRIG_STATE_DIR;
  const places = { hoprig: [process.env.HOPRIG_CONFIG_DIR, state], home, workspace: path.join(tmp, 'ws'), projects: [], own: CWD, cwd: CWD, relative: true };
  for (const command of ['sudo rm -rf ~', 'sudo rm -rf $HOME', 'sudo rm -rf ${HOME}', 'sudo rm -rf ~/', 'sudo rm -rf $HOME/', 'sudo rm -rf "$HOME"', 'sudo chown -R root ~']) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD, places });
    assert.ok(hold, `held at Full: ${command}`);
    assert.equal(hold.output.hookSpecificOutput.permissionDecision, 'ask', `his card at Full: ${command}`);
  }
  // A command that merely names the home folder, with no administrator rights and no delete of it, still runs at Full:
  // the hold is for a session she started touching Hoprig's own files, not for every mention of ~ or $HOME.
  for (const ok of ['cd ~', 'ls ~', 'echo $HOME', 'cat ~/.bashrc', 'sudo ls ~/proj']) {
    assert.equal(preToolHold(ev(ok), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD, places }), null, `runs at Full: ${ok}`);
  }
});

test('at Full a push, a release or a pull request behind sudo stays what it is without sudo: his card, titled for it', () => {
  for (const [command, kind] of [['sudo git push origin main', 'push'], ['sudo npm publish', 'release'], ['sudo gh pr create', 'pr']]) {
    const hold = preToolHold(ev(command), null, { cfg: levelCfg('full'), byTia: true, version: V, project: CWD });
    assert.ok(hold, `held at Full: ${command}`);
    assert.equal(hold.held.kind, kind, `the act left is the ${kind}: ${command}`);
    assert.ok(hold.held.acts.every((a) => a.kind !== 'admin'), `the administrator act is lifted: ${command}`);
  }
});
