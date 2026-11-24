// At Full, an administrator command of a session Tia started never hides what it does. What stands behind `sudo` is
// read as the same words without it are: a delete that is not plainly inside the session's own folder is the owner's
// card, a change of Hoprig's own folders or of a folder that holds them (up to `/`) is his card, and so is a command
// with a word whose value cannot be told from the line. The proof is a table that is BUILT, not typed: every way the
// home folder and Hoprig's folders are written, under every program that deletes, moves or changes them. Beside it:
// what must still run at Full with no card, so Full stays Full. Nothing is run here: the hook only answers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-fullholds-')));
const HOME = path.join(tmp, 'home', 'alex');
const CWD = path.join(HOME, 'Workspace', 'projects', 'shop');
const CONFIG = path.join(HOME, '.config', 'hoprig');
const STATE = path.join(HOME, '.local', 'state', 'hoprig');
for (const d of [CWD, CONFIG, STATE, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
process.env.HOPRIG_CONFIG_DIR = CONFIG;
process.env.HOPRIG_STATE_DIR = STATE;
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, '.claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { preToolHold } = await import('../../src/hook.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { wallHeld, adminDeletes } = await import('../../src/wall.mjs');
const { adminRefusal, sudoArgv } = await import('../../src/assistant/adminrefused.mjs');

const V = hoprigVersion();
const places = { cwd: CWD, home: HOME, workspace: path.join(HOME, 'Workspace'), projects: [path.join(HOME, 'Workspace', 'projects')], hoprig: [CONFIG, STATE], own: CWD, relative: true };
const ev = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: CWD });
const cfg = (level) => ({ server: { herRights: { level, version: V } } });
const hers = (command, level = 'full') => preToolHold(ev(command), null, { cfg: cfg(level), byTia: true, version: V, project: CWD, places });
const kinds = (hold) => (hold ? (hold.held.acts || [hold.held]).map((a) => a.kind) : []);

// ---- the built table ----
// The home folder, five ways; then nothing, or a way of writing the same folder again; or the way down to one of
// Hoprig's folders, the separator written three ways.
const HOMES = ['~', '$HOME', '${HOME}', '"$HOME"', HOME];
const SAME = ['', '/', '//', '/.', '/./', '/Workspace/..'];
const DOWN = ['.local/state/hoprig', '.config/hoprig', '.config'];
const SEPS = ['/', '//', '/./'];
const TARGETS = [];
for (const h of HOMES) {
  for (const s of SAME) TARGETS.push(`${h}${s}`);
  for (const d of DOWN) for (const s of SEPS) TARGETS.push(`${h}${s}${d}`);
}
// A program that deletes, destroys, moves or changes what it is pointed at.
const HEADS = [(x) => `rm -rf ${x}`, (x) => `mv ${x} /tmp/x`, (x) => `chown -R nobody ${x}`, (x) => `chmod -R 000 ${x}`, (x) => `find ${x} -delete`, (x) => `rmdir ${x}`];
const SUDOS = ['sudo', 'sudo -n', 'sudo env A=b'];
const TABLE = [];
for (const t of TARGETS) for (const head of HEADS) for (const s of SUDOS) TABLE.push(`${s} ${head(t)}`);

test('the table is built from every spelling, program and form of sudo', () => {
  assert.equal(TARGETS.length, 5 * (6 + 9));
  assert.equal(TABLE.length, TARGETS.length * HEADS.length * SUDOS.length);
});

test('at Full every line of the table is his card in a session she started', () => {
  const ran = TABLE.filter((line) => !hers(line));
  assert.deepEqual(ran, [], `${ran.length} of ${TABLE.length} lines would run with no card at Full`);
  for (const line of TABLE) assert.equal(hers(line).output.hookSpecificOutput.permissionDecision, 'ask', line);
});

test('below Full every line of the table is his card too (nothing got looser)', () => {
  for (const level of ['off', 'ask']) {
    const ran = TABLE.filter((line) => !hers(line, level));
    assert.deepEqual(ran, [], `at ${level}`);
  }
});

test('what the card is for: a delete says it deletes, a change of Hoprig\'s folders says so', () => {
  // A delete elsewhere: Full lifts the administrator act, and the delete is what is left for his card.
  assert.deepEqual(kinds(hers('sudo rm /var/tmp/old.log')), ['delete outside']);
  assert.deepEqual(kinds(hers('sudo rm -rf /srv/cache/*')), ['delete outside']);
  // A folder that holds Hoprig's own is also a form refused at every level, so nothing of the line is lifted: the
  // card lists every act.
  assert.deepEqual(kinds(hers('sudo rm -rf ~//')), ['admin', 'delete outside', 'settings']);
  assert.deepEqual(kinds(hers('sudo chown -R nobody $HOME//.config')), ['admin', 'settings']);
  assert.deepEqual(kinds(hers('sudo mv ~/. /tmp/x')), ['admin', 'settings']);
});

test('the spellings a look walked round the earlier check with are his card at Full, each by name', () => {
  const up = path.dirname(HOME); // the folder that holds the home folders
  for (const target of ['~//', '~/.', '~/*', '$HOME/*', '${HOME:?}', '${HOME%/}', '~alex', '~/Workspace/..', '../../..', '../../../.config', up, `${up}/*`, '/*', '/', '--no-preserve-root /']) {
    assert.ok(hers(`sudo rm -rf ${target}`), `sudo rm -rf ${target}`);
  }
  // The same folders under a program that is no delete: a change of a folder that holds Hoprig's, or a word whose
  // value cannot be told.
  for (const target of ['~//', '~/.', '~/.*', '$HOME/.c*', '${HOME:?}', '${HOME%/}', '~alex', '../../..', up, '/']) {
    for (const head of ['chown -R nobody', 'chmod -R 000', 'mv -t /tmp/x']) assert.ok(hers(`sudo ${head} ${target}`), `sudo ${head} ${target}`);
  }
  // A word that cannot be told keeps the administrator act itself: Full does not lift it.
  assert.deepEqual(kinds(hers('sudo chown -R nobody $SOMEWHERE')), ['admin']);
  assert.deepEqual(kinds(hers('sudo rm -rf ${HOME:?}')), ['admin', 'delete outside']);
});

test('a program that destroys what it is pointed at is held like a delete', () => {
  for (const line of ['sudo shred -u /var/tmp/x', 'sudo truncate -s 0 /var/log/syslog', 'sudo dd if=/dev/zero of=/dev/sda', 'sudo dd if=/dev/zero of=~/x', 'sudo mkfs.ext4 /dev/sdb1', 'sudo wipefs -a /dev/sdb', 'sudo rmdir /var/tmp/empty', 'sudo unlink /var/tmp/x', 'sudo rsync -a --delete /srv/a/ /srv/b/', 'sudo find / -name x -delete']) {
    assert.ok(kinds(hers(line)).includes('delete outside'), line);
  }
});

test('an administrator command inside another command\'s text is not lifted at Full', () => {
  // The floor of forms refused at every level reads a command that IS the administrator command. Wrapped in a shell's
  // or eval's text it was read as an administrator command and then lifted: a root shell with no card.
  for (const line of ['bash -c "sudo su"', "sh -c 'sudo rm -rf /var/tmp/x'", 'bash -c "sudo true"', 'eval "sudo true"', 'bash -lc "cd /tmp && sudo chown -R nobody /"']) {
    const hold = hers(line);
    assert.ok(hold, line);
    assert.equal(hold.held.kind, 'admin', line);
  }
});

test('a line with several commands: each is read, and one that is his holds the line', () => {
  assert.ok(hers('sudo true && sudo rm -rf /var/tmp/x'));
  assert.ok(hers('sudo apt-get update; sudo chown -R nobody ~'));
  assert.equal(hers('sudo apt-get update && sudo systemctl restart nginx'), null);
});

test('Full is still Full: her ordinary administrator commands run with no card', () => {
  for (const line of ['sudo true', 'sudo apt-get install -y nginx', 'sudo systemctl restart nginx', 'sudo tee /etc/nginx/conf.d/site.conf', 'sudo mv /etc/nginx/a.conf /etc/nginx/b.conf', 'sudo chown -R www-data /var/www/site', 'sudo env DEBIAN_FRONTEND=noninteractive apt-get upgrade -y', 'sudo cp /etc/nginx/*.conf /tmp/backup/', 'sudo chmod 0644 /etc/nginx/nginx.conf', 'sudo mkdir -p /opt/shop', "sudo sed -i 's/a.*b$/c/' /etc/nginx/nginx.conf", 'sudo ufw allow 443']) {
    assert.equal(hers(line), null, line);
  }
});

test('a program that only reads is not held for naming the home folder or a folder above it', () => {
  const up = path.dirname(HOME);
  for (const line of ['sudo ls ~', 'sudo du -sh ~', 'sudo ls -la $HOME/', `sudo ls ${up}`, 'sudo du -sh /', 'sudo cat /etc/hosts', 'sudo journalctl -u nginx --since today', 'sudo systemctl status nginx', "sudo find ~ -name '*.log'", 'sudo grep -r listen /etc/nginx', 'sudo tail -n 50 /var/log/syslog', 'sudo cat $LOGFILE']) {
    assert.equal(hers(line), null, line);
  }
  // A path IN one of Hoprig's own folders is held for a reader too, as it is without sudo.
  for (const line of ['sudo cat ~/.config/hoprig/config.json', 'sudo ls ~//.local/state/hoprig', 'sudo cat ${HOME}/.config/hoprig/*']) assert.ok(hers(line), line);
  // find stops being a reader when it can run a program, delete or write.
  assert.ok(hers('sudo find ~ -name x -exec chown nobody {} ;'));
  // A program that reads only under some of its words is read by them.
  assert.ok(hers('sudo systemctl restart $UNIT'), 'restart is no reading, and the word cannot be told');
});

test('a delete as administrator that is plainly inside the session\'s own folder runs, as it does without sudo', () => {
  for (const line of ['sudo rm -rf build', 'sudo rm -rf ./build/cache', 'sudo -n rm -f old.log', 'sudo rm -rf "build"']) assert.equal(hers(line), null, line);
  // Out of the folder, or in a form the plain reader does not know, it is his card.
  for (const line of ['sudo rm -rf ../other/dist', 'sudo -E rm -rf build', 'sudo  rm -rf build', 'sudo rm -rf $BUILD', 'sudo rm -rf .', 'sudo rm -rf build/../..', 'sudo env A=b rm -rf build']) assert.ok(hers(line), line);
});

test('without sudo too, Hoprig\'s folders are found however the path is written; the home folder alone is not a touch', () => {
  const held = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: CWD, places });
  for (const line of ['mv ~//.local/state/hoprig /tmp/x', 'mv "$HOME"/.config/hoprig /tmp/x', 'cp x ${HOME}/.config/hoprig/config.json', 'tee ~/./.local/state/hoprig/x', 'mv ~/Workspace/../.config /tmp/x', 'chmod 000 ../../../.local/state/hoprig', 'chmod 000 ../../../.local/state/hoprig/*', 'cat ~//.config/hoprig/*.json']) {
    const r = held(line);
    assert.ok(r, line);
    assert.equal(r.kind, 'settings', line);
  }
  for (const line of ['cd ~', 'ls ~', 'ls ~/', 'echo $HOME', 'cat ~/.bashrc', 'ls ~/Workspace/..', 'cp ~/notes.txt .', 'ls $OTHER/x', 'ls ~/W*']) assert.equal(held(line), null, line);
});

test('a session HE started is not held for any of it (no Hands-off switch is on)', () => {
  for (const line of ['sudo rm -rf /var/tmp/x', 'sudo chown -R nobody ~', 'bash -c "sudo true"']) {
    assert.equal(preToolHold(ev(line), null, { cfg: cfg('full'), byTia: false, version: V, project: CWD, places }), null, line);
  }
});

// ---- her own tool (run_command): the words run as written, with no shell between ----
test('her own tool: a folder that holds Hoprig\'s is refused at every level for a program that does not only read', () => {
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD, argv: true };
  const up = path.dirname(HOME);
  for (const line of ['sudo chown -R nobody /', `sudo mv ${HOME} /tmp/x`, `sudo chmod -R 000 ${up}`, 'sudo rm -rf ~', 'sudo rm -rf ~//', 'sudo rm -rf ../../..', `sudo mv ${HOME}/.config /tmp/x`, `sudo rm -rf ${HOME}/*`]) {
    assert.equal((adminRefusal(line, ctx) || {}).id, 'hoprig-own', line);
  }
  // A pattern in the root folder could name a file that decides who may be administrator: refused for that first.
  assert.equal((adminRefusal('sudo rm -rf /*', ctx) || {}).id, 'protected-path');
  for (const line of ['sudo ls ~', `sudo du -sh ${up}`, 'sudo ls /', 'sudo apt-get install -y nginx', 'sudo chown -R www-data /var/www/site', 'sudo rm /var/tmp/old.log']) assert.equal(adminRefusal(line, ctx), null, line);
});

test('her own tool: a word with $ is refused, because run as written it would name another path', () => {
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD, argv: true };
  for (const line of ['sudo rm -rf $PREFIX/etc', 'sudo chown -R nobody ${TARGET}', 'sudo cp x "$DEST"/y', 'sudo ls $HOME/x']) {
    assert.equal((adminRefusal(line, ctx) || {}).id, 'word-not-read', line);
  }
  // A `$` the shell would not fill in either is no variable.
  assert.equal(adminRefusal("sudo sed -i 's/a$/b/' /etc/x.conf", ctx), null);
  // In a session a shell fills the word in: this entry is not asked there, and the wall marks what it cannot tell.
  assert.equal(adminRefusal('sudo chown -R nobody ${TARGET}', { ...ctx, argv: false }), null);
});

test('her own tool: adminDeletes says which administrator commands delete or destroy', () => {
  for (const line of ['sudo rm /var/tmp/old.log', 'sudo -n rm -rf /srv/x', 'sudo find /srv -name x -delete', 'sudo shred -u /srv/x', 'sudo dd if=/dev/zero of=/dev/sda', 'sudo mkfs.ext4 /dev/sdb1', 'sudo true && sudo rm -rf /srv/x']) assert.equal(adminDeletes(line), true, line);
  for (const line of ['sudo apt-get install -y nginx', 'sudo systemctl restart nginx', 'sudo dd if=/dev/sda', 'rm -rf build', 'sudo ls /']) assert.equal(adminDeletes(line), false, line);
});

// ---- a program in FRONT of the escalator no longer hides it (the wrappers finding) ----
// A wrapper the wall did not read (a scheduler, affinity, lock, watch, find -exec, or a passer carrying a value such
// as `nice -n 5` / `timeout -s KILL 5` / `busybox` / `env -u X`) ran its administrator command with no card at Full,
// his session too: the escalator behind it was invisible. The one reader the wall and the floor share now steps the
// wrapper, so the administrator act is read, the floor's form behind it is refused, and nothing was run here.
const WRAP_CLEAN = ['nice -n 5', 'timeout 5', 'timeout --foreground 5', 'timeout -s KILL 5', 'env -u X', 'busybox', 'chrt 1', 'taskset 1', 'flock /tmp/l'];
const WRAP_WALK = [{ pre: 'watch', post: '' }, { pre: 'find . -exec', post: ' ;' }, { pre: 'find . -execdir', post: ' ;' }, { pre: 'find . -ok', post: ' ;' }, { pre: 'find . -okdir', post: ' ;' }];
const ALL_WRAP = [...WRAP_CLEAN.map((pre) => ({ pre, post: '' })), ...WRAP_WALK];
// The floor no level lifts, behind the wrapper: a root shell/escalator, a login shell, a setuid bit, a sudoers file;
// then a delete outside the folder and a change of one of Hoprig's own folders (held for what they are, not the floor).
const FLOOR_ESC = ['sudo su', 'sudo -i', 'sudo chmod u+s /bin/sh', 'sudo tee /etc/sudoers.d/x', 'sudo cp x /etc/sudoers.d/y'];
const FLOOR_DELETE = 'sudo rm -rf /var/tmp/x';
const FLOOR_HOPRIG = `sudo mv ${STATE} /tmp/x`;
const whis = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: CWD, places });

test('every finding wrapper, built against every floor form, is his card at Off, Ask and Full, and his session too', () => {
  const lines = [];
  for (const { pre, post } of ALL_WRAP) for (const floor of [...FLOOR_ESC, FLOOR_DELETE, FLOOR_HOPRIG]) lines.push(`${pre} ${floor}${post}`);
  assert.equal(lines.length, ALL_WRAP.length * (FLOOR_ESC.length + 2));
  const ran = lines.filter((line) => ['off', 'ask', 'full'].some((level) => !hers(line, level)) || !whis(line));
  assert.deepEqual(ran, [], `${ran.length} of ${lines.length} wrapper lines run with no card somewhere`);
});

test('a finding wrapper is read through to the escalator by the floor (run_command) and, for the ones it resolves, adminRefusal', () => {
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD };
  for (const pre of WRAP_CLEAN) {
    for (const esc of FLOOR_ESC) {
      const line = `${pre} ${esc}`;
      assert.ok(adminRefusal(line, ctx), `adminRefusal: ${line}`);
      assert.ok(sudoArgv(line, ctx).refuse, `run_command: ${line}`);
    }
    assert.equal((adminRefusal(`${pre} ${FLOOR_HOPRIG}`, ctx) || {}).id, 'hoprig-own', `${pre} ${FLOOR_HOPRIG}`);
  }
  // watch and find -exec run a command of their own, read one level in: her own tool refuses it as not a plain
  // `sudo <program>`, and the hook holds the administrator act (marked unsure, so Full does not lift it).
  for (const { pre, post } of WRAP_WALK) for (const esc of FLOOR_ESC) assert.ok(sudoArgv(`${pre} ${esc}${post}`, ctx).refuse, `run_command: ${pre} ${esc}${post}`);
});

test('a delete as administrator behind a finding wrapper is read: resolved wrappers by adminDeletes, watch/find refused whole', () => {
  // A wrapper the reader steps to the escalator (chrt, flock, env -u, …): the delete behind it is an administrator
  // delete her own tool cards (adminDeletes), as `sudo rm …` is.
  for (const pre of WRAP_CLEAN) assert.equal(adminDeletes(`${pre} ${FLOOR_DELETE}`), true, `${pre} ${FLOOR_DELETE}`);
  // watch and find run a command of their own, not a plain `sudo <program>`: her own tool refuses the whole line, so
  // the delete never runs, and the hook holds it in a session besides (the table test above).
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD };
  for (const { pre, post } of WRAP_WALK) assert.ok(sudoArgv(`${pre} ${FLOOR_DELETE}${post}`, ctx).refuse, `${pre} ${FLOOR_DELETE}${post}`);
});

test('a push or a release behind a finding wrapper stays what it is, Full and his session alike', () => {
  for (const line of ['chrt 1 git push origin main', 'taskset 1 npm publish', 'chrt 1 sudo git push origin main']) {
    for (const level of ['off', 'ask', 'full']) assert.ok(hers(line, level), `${level}: ${line}`);
    assert.ok(whis(line), `his: ${line}`);
  }
});

test('an ordinary command behind a wrapper, with no administrator program in it, is NOT newly held', () => {
  for (const line of ['nice -n 5 make', 'timeout 30 npm test', 'watch -n 2 ls', "find . -name '*.js' -exec grep -l x {} +", 'taskset 1 node a.js', 'chrt 1 node a.js', 'flock /tmp/l make', 'busybox ls', 'timeout -s KILL 5 npm run build']) {
    assert.equal(whis(line), null, `his: ${line}`);
    for (const level of ['off', 'ask', 'full']) assert.equal(hers(line, level), null, `${level}: ${line}`);
  }
});
