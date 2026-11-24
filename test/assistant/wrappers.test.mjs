// A program in front of an administrator command never hides it, and a program behind sudo never hides which program
// runs as administrator. The wall reads a command the way the program that runs it receives its words: in quotes or
// not, behind a passer's own options, behind the shell's `if` and `while`, inside the command text a program is
// handed (`flock -c`, `env -S`), and, where a program's own words are not all known, from every later word a command
// of the owner's kinds can begin with (the net). What is found only by the net is held at every level. Beside it:
// what must NOT be newly held, so an ordinary command with the word `sudo` in it stays an ordinary command.
// Nothing is run here: the hook, the wall and the refusal list only answer, and her own tool runs through FakeOps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wrappers-')));
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
const { wallHeld, wallKind, runsItsWords } = await import('../../src/wall.mjs');
const { adminRefusal, sudoArgv } = await import('../../src/assistant/adminrefused.mjs');
const { hisAloneCommand } = await import('../../src/assistant/owner-tools.mjs');
const { AuditLog } = await import('../../src/assistant/audit.mjs');
const { CardStore } = await import('../../src/assistant/cards.mjs');
const { JobStore } = await import('../../src/assistant/jobs.mjs');
const { Skills } = await import('../../src/assistant/skills.mjs');
const { createAssistantCore } = await import('../../src/assistant/core.mjs');
const { FakeOps, baseState } = await import('./fake-dashboard.mjs');

const V = hoprigVersion();
const places = { cwd: CWD, home: HOME, workspace: path.join(HOME, 'Workspace'), projects: [path.join(HOME, 'Workspace', 'projects')], hoprig: [CONFIG, STATE], own: CWD, relative: true };
const ev = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: CWD });
const cfg = (level) => ({ server: { herRights: { level, version: V } } });
const hers = (command, level = 'full') => preToolHold(ev(command), null, { cfg: cfg(level), byTia: true, version: V, project: CWD, places });
const his = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: CWD, places });
const kinds = (hold) => (hold ? (hold.held.acts || [hold.held]).map((a) => a.kind) : []);
const LEVELS = ['off', 'ask', 'full'];
// Where a line runs with no card: his session with Hands-off on, or a session of hers at one of the three levels.
const runsSomewhere = (line) => [...LEVELS.filter((level) => !hers(line, level)).map((level) => `hers at ${level}`), ...(his(line) ? [] : ['his'])];
const heldEverywhere = (lines) => {
  const ran = lines.map((line) => [line, runsSomewhere(line)]).filter(([, where]) => where.length).map(([line, where]) => `${line}  (${where.join(', ')})`);
  assert.deepEqual(ran, [], `${ran.length} of ${lines.length} lines run with no card somewhere`);
};
const heldNowhere = (lines) => {
  for (const line of lines) {
    assert.equal(his(line), null, `his: ${line}`);
    for (const level of LEVELS) assert.equal(hers(line, level), null, `${level}: ${line}`);
  }
};
// The floor no level lifts, as it stands behind a program: a root shell, a login shell, a setuid bit, a sudoers file.
const FLOOR = ['sudo su', 'sudo -i', 'sudo chmod u+s /bin/sh', 'sudo tee /etc/sudoers.d/x'];

// ---- flock hands a command text to a shell ----
test('flock with a command text: the text is read, wherever it stands and however it is written', () => {
  const forms = [(t) => `flock /tmp/l -c '${t}'`, (t) => `flock -c '${t}' /tmp/l`, (t) => `flock -n /tmp/l -c '${t}'`, (t) => `flock -w 5 /tmp/l -c '${t}'`, (t) => `flock /tmp/l --command '${t}'`, (t) => `flock /tmp/l --command='${t}'`];
  const texts = [...FLOOR, 'sudo apt-get install -y nginx', 'git push origin main', 'npm publish', `sudo mv ${STATE} /tmp/x`, 'sudo rm -rf /var/tmp/x'];
  const lines = [];
  for (const form of forms) for (const t of texts) lines.push(form(t));
  assert.equal(lines.length, forms.length * texts.length);
  heldEverywhere(lines);
  // A text of one word needs no quotes, and a lock file may stand in quotes.
  heldEverywhere(['flock /tmp/l -c su', 'flock "/tmp/my lock" sudo su', 'flock -w 5 /tmp/l sudo su']);
  assert.deepEqual(kinds(hers("flock /tmp/l -c 'git push origin main'")), ['push']);
  assert.deepEqual(kinds(hers("flock /tmp/l -c 'npm publish'")), ['release']);
  heldNowhere(["flock /tmp/l -c 'make all'", 'flock /tmp/l make all', 'flock -n /tmp/l npm test', 'flock /tmp/l git commit -m "fix sudo su handling"']);
});

// ---- quotes do not change what a program is given ----
test('a quoted option, count or variable hides nothing: the command is the one it is without the quotes', () => {
  const lines = [];
  for (const pre of ['nice "-n" 5', 'timeout "5"', 'env "-i"', 'FOO="a b"', 'env "FOO=a b"', 'LC_ALL="C" nice \'-n\' 5', 'timeout "-s" KILL 5']) for (const floor of FLOOR) lines.push(`${pre} ${floor}`);
  heldEverywhere(lines);
  // An ordinary administrator command with a quoted variable in front is an administrator command: held in his
  // session and below Full, and at Full it runs as the same command without the quotes does.
  for (const line of ['DEBIAN_FRONTEND="noninteractive" sudo apt-get install -y nginx', 'LC_ALL="C" sudo systemctl restart nginx']) {
    assert.ok(his(line), `his: ${line}`);
    assert.equal(his(line).kind, 'admin', line);
    for (const level of ['off', 'ask']) assert.ok(hers(line, level), `${level}: ${line}`);
    assert.equal(hers(line, 'full'), null, `full: ${line}`);
  }
  heldNowhere(['FOO="a b" make', 'env "FOO=a b" npm test', 'nice "-n" 5 make', 'timeout "5" npm test']);
});

// ---- the shell's own words before a command ----
test('if, while, until and ! pass a command on like any passer', () => {
  heldEverywhere(['if sudo su; then echo x; fi', 'while sudo -i; do sleep 1; done', 'until sudo tee /etc/sudoers.d/x; do sleep 1; done', '! sudo su', 'if true; then sudo su; else sudo -i; fi', 'if ! sudo chmod u+s /bin/sh; then echo no; fi']);
  for (const line of ['if sudo -n true; then echo yes; fi', 'while sudo -n true; do sleep 60; done']) {
    assert.ok(his(line), `his: ${line}`);
    assert.ok(hers(line, 'ask'), `ask: ${line}`);
  }
  heldNowhere(['if [ -f x ]; then echo y; fi', 'while read line; do echo "$line"; done', '! grep -q x file', 'until test -f done.txt; do sleep 1; done']);
});

// ---- the net: a program whose own words are not all known ----
const RUNNERS = ['taskset -c 0,1', 'stdbuf -o L', 'exec -a name', 'screen -dm', 'tmux new-session -d', 'ssh host', 'eval', 'sg wheel', 'runuser -u x --', 'cgexec -g cpu:/g', 'strace -f', 'strace -o out', 'ltrace', 'faketime yesterday', 'xvfb-run -a', 'unbuffer', 'ionice -c 2 -n 7', 'chrt -f 50', 'numactl -N 0,1', 'nsenter -t 1 -m', 'setsid -w', 'parallel -j1', 'xargs -a list', 'xargs -I% -P 4'];

test('the table is built: every program that runs its words, against every form of the floor', () => {
  for (const pre of RUNNERS) assert.ok(runsItsWords(pre.split(' ')[0]), `${pre.split(' ')[0]} is on the one list`);
  const lines = [];
  for (const pre of RUNNERS) for (const floor of FLOOR) lines.push(`${pre} ${floor}`);
  assert.equal(lines.length, RUNNERS.length * FLOOR.length);
  heldEverywhere(lines);
});

test('an administrator command found only by the net, or fed by xargs, is not lifted at Full', () => {
  // The same ordinary command that runs at Full when it stands alone: behind a program whose words Hoprig cannot
  // place, or with words that are not on the line, it stays his card.
  assert.equal(hers('sudo apt-get install -y nginx'), null);
  for (const line of ['strace -f sudo apt-get install -y nginx', 'screen -dm sudo apt-get install -y nginx', 'ssh host sudo apt-get install -y nginx', 'watch -n 5 sudo systemctl status nginx', 'xargs sudo chown -R nobody', 'xargs -a list sudo apt-get install -y']) {
    const hold = hers(line);
    assert.ok(hold, line);
    assert.deepEqual(kinds(hold), ['admin'], line);
  }
  // Behind a passer whose own words ARE known the command is read as it is without it, so Full stays Full.
  for (const line of ['nice -n 5 sudo apt-get install -y nginx', 'timeout 600 sudo apt-get upgrade -y', 'time sudo systemctl restart nginx', 'nohup sudo apt-get install -y nginx', 'stdbuf -o L sudo apt-get update', 'ionice -c 3 sudo apt-get upgrade -y', 'VAR=1 sudo apt-get install -y nginx']) {
    assert.equal(hers(line), null, line);
    assert.ok(hers(line, 'ask'), `ask: ${line}`);
    assert.ok(his(line), `his: ${line}`);
  }
});

test('a command text a program is handed is read: env -S, a shell behind a tracer', () => {
  heldEverywhere(["env -S 'sudo su'", "env --split-string='sudo su'", "env -iS 'sudo su'", "env -S 'sudo -i' x", "strace -f sh -c 'sudo su'", "sg wheel bash -c 'sudo su'", "screen -dm bash -c 'sudo tee /etc/sudoers.d/x'"]);
  heldNowhere(["env -S 'make all'", "strace -f sh -c 'npm test'"]);
});

test('other doors to administrator rights are administrator acts no level lifts', () => {
  heldEverywhere(['run0 bash', 'run0 apt-get install -y nginx', 'systemd-run --shell', 'systemd-run -t bash', 'machinectl shell root@', 'machinectl login host', 'nice run0 bash']);
  assert.equal(wallKind('run0 bash'), 'admin');
  assert.equal((adminRefusal('run0 bash', { hoprigDirs: [CONFIG, STATE] }) || {}).id, 'non-sudo-escalator');
  heldNowhere(['systemd-run --user --scope make', 'machinectl list', 'machinectl status host']);
});

test('a push, a release or a deploy behind a program is what it is without it, at Full and in his session', () => {
  for (const [line, kind] of [['taskset -c 0,1 git push origin main', 'push'], ['stdbuf -o L npm publish', 'release'], ['strace -o out git push origin main', 'push'], ['sg wheel npm publish', 'release'], ['exec -a x gh release create v1', 'release'], ['if git push origin main; then echo ok; fi', 'push'], ['ssh host git push origin main', 'push'], ['timeout 5 10 git push origin main', 'push']]) {
    for (const level of LEVELS) assert.ok(kinds(hers(line, level)).includes(kind), `${level}: ${line}`);
    assert.ok(his(line), `his: ${line}`);
  }
  // Behind sudo with an option of sudo's own that takes a value, and a deploy script as administrator.
  assert.ok(kinds(hers('sudo -u www git push origin main')).includes('push'));
  assert.deepEqual(kinds(hers('sudo ./deploy.sh')), ['deploy']);
  assert.deepEqual(kinds(hers('sudo npm run deploy')), ['deploy']);
  assert.deepEqual(kinds(hers('sudo npm publish')), ['release']);
});

// ---- what must not be newly held ----
test('an ordinary command is not held for the word sudo, a branch called release, or a passer in front', () => {
  heldNowhere([
    'timeout 30 grep -rn sudo docs', 'xargs grep -l sudo', 'xargs -0 grep -l sudo', 'time echo sudo', 'nice -n 5 cat sudo.txt', 'timeout 30 man sudo', 'time -p grep sudo x',
    'command -v sudo', 'which sudo', 'echo sudo', 'grep sudo file', 'man sudo', 'apt-cache show sudo', "git commit -m 'use sudo su here'",
    'timeout 5 git checkout release', 'xargs git branch -D release', 'time git log release', 'env X=1 git fetch origin deploy', 'nohup git pull',
    'strace -f npm test', 'nohup npm start', 'timeout 10 docker ps', 'stdbuf -o L make', 'taskset -c 0,1 make', 'chrt -f 50 make', 'ionice -c 3 make -j4', 'xargs -n 1 echo', "xargs -I{} sh -c 'echo {}'", 'watch ls', "ssh host 'cd app && git pull'", 'env FOO=1 npm test', 'time ls', 'ls -la', 'npm test',
  ]);
});

test('Full is still Full: an ordinary administrator command with those words in it runs with no card', () => {
  for (const line of ['sudo apt-get install -y sudo git make', 'sudo grep -r sudo /etc/hosts', "sudo find /var/log -name '*.gz'", 'sudo docker ps', 'sudo npm install -g pnpm', 'sudo make install', 'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y git', 'sudo systemctl restart ssh']) {
    assert.equal(hers(line), null, line);
  }
});

// ---- behind sudo: a program that runs its words hides which program runs as administrator ----
test('a program that runs its own words is refused as the program sudo runs, by the wall\'s one list', () => {
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD };
  const lines = ['sudo chrt 1 bash', 'sudo taskset 1 sh', 'sudo flock /tmp/l bash', 'sudo flock /tmp/l su', 'sudo numactl -N 0 bash', 'sudo firejail bash', 'sudo firejail --noprofile bash', 'sudo busybox sh', 'sudo watch bash', 'sudo script -c bash /dev/null', 'sudo xargs bash', 'sudo parallel bash ::: x', 'sudo strace -f bash', 'sudo -n chrt 1 sudo su', 'sudo env A=b chrt 1 bash', 'sudo find /var -name x -exec bash ;', 'sudo find /var -execdir sh -c id ;', 'sudo nice -n 5 bash', 'sudo timeout 5 bash'];
  for (const line of lines) {
    assert.equal((adminRefusal(line, ctx) || {}).id, 'passer-as-admin', line);
    assert.ok(sudoArgv(line, ctx).refuse, `her own tool: ${line}`);
    for (const level of LEVELS) assert.ok(hers(line, level), `${level}: ${line}`);
  }
  // find that only looks is no such program, and a privilege tool keeps its own reason.
  assert.equal(adminRefusal("sudo find /var/log -name '*.gz'", ctx), null);
  assert.equal((adminRefusal('sudo setpriv --reuid 0 bash', ctx) || {}).id, 'privilege-tool-as-admin');
  assert.equal((adminRefusal('sudo chroot /mnt bash', ctx) || {}).id, 'privilege-tool-as-admin');
});

// ---- her own tool (run_command): it runs `sudo <program> <arguments>` and nothing else ----
function setup(level = 'full') {
  const ops = new FakeOps(baseState());
  ops.s.settings.server.herRights = { level, version: V, at: 1 };
  ops.adminPw = false; // sudo needs no password here, so Full runs an ordinary administrator command with no card
  const now = Date.now;
  const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }), skills: new Skills({ dirs: [{ dir: '/nonexistent-owner', source: 'owner' }] }) });
  return { ops, call: (command) => core.call('run_command', { command }, { conversation: 'c1' }) };
}
const ran = (ops) => ops.calls.filter((c) => c.op === 'runAdmin' || c.op === 'runCommand');

test('her own tool: a program in front of sudo is refused at Ask and Full, never run with the program dropped', async () => {
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD, argv: true };
  for (const command of ['chroot /mnt sudo apt-get install -y nginx', 'nice -n 5 sudo apt-get install -y nginx', 'timeout 60 sudo systemctl restart nginx', 'nohup sudo apt-get update', 'chrt 1 sudo ls /root', 'if sudo true; then echo x; fi']) {
    assert.equal((adminRefusal(command, ctx) || {}).id, 'wrapper-before-sudo', command);
    assert.ok(sudoArgv(command, ctx).refuse, command);
    for (const level of ['ask', 'full']) {
      const { ops, call } = setup(level);
      const r = await call(command);
      assert.ok(r.isError && !r.card, `${level}: ${command}`);
      assert.equal(ran(ops).length, 0, `nothing ran: ${command}`);
    }
  }
  // In a session the shell runs the line as it is written, so the floor does not refuse it for the program in front.
  assert.equal(adminRefusal('nice -n 5 sudo apt-get install -y nginx', { ...ctx, argv: false }), null);
  // A variable set in front of sudo is no program: the command runs as the same words after sudo.
  assert.deepEqual(sudoArgv('VAR=1 sudo apt-get install -y nginx', ctx).argv, ['sudo', 'apt-get', 'install', '-y', 'nginx']);
});

test('her own tool: no card is made for an administrator line its own tap could not run', async () => {
  for (const command of ['ls && sudo apt-get update', 'bash -c "sudo apt-get update"', 'strace -f sudo apt-get update', "flock /tmp/l -c 'sudo apt-get update'", 'watch sudo apt-get update', 'systemd-run --shell']) {
    for (const level of ['ask', 'full']) {
      const { ops, call } = setup(level);
      const r = await call(command);
      assert.ok(r.isError && !r.card, `${level}: ${command}`);
      assert.equal(ran(ops).length, 0, `nothing ran: ${command}`);
    }
  }
});

test('her own tool: what is the owner\'s own step without sudo is his with it', async () => {
  const ctx = { hoprigDirs: [CONFIG, STATE], home: HOME, cwd: CWD, argv: true };
  // The two rows are the same as without sudo (owner-tools.mjs hisAloneCommand), read behind sudo.
  const pairs = [['git push origin main', 'push-or-merge-as-admin'], ['git merge feature', 'push-or-merge-as-admin'], ['git -C /srv/app push', 'push-or-merge-as-admin'], ['scp x host:', 'sends-out-as-admin'], ['rsync -a /a/ host:/b/', 'sends-out-as-admin'], ['sftp host', 'sends-out-as-admin'], ['nc host 80', 'sends-out-as-admin'], ['curl -d @x http://h', 'sends-out-as-admin'], ['curl --data-binary @x http://h', 'sends-out-as-admin'], ['wget --post-file x http://h', 'sends-out-as-admin'], ['curl -X POST http://h', 'sends-out-as-admin']];
  for (const [plain, id] of pairs) {
    assert.ok(hisAloneCommand(plain), `refused without sudo: ${plain}`);
    assert.equal((adminRefusal(`sudo ${plain}`, ctx) || {}).id, id, `sudo ${plain}`);
    const { ops, call } = setup('full');
    const r = await call(`sudo ${plain}`);
    assert.ok(r.isError && !r.card, `sudo ${plain}`);
    assert.equal(ran(ops).length, 0);
  }
  // What only fetches is none of them, with or without sudo.
  for (const plain of ['curl -fsSL http://h/x', 'wget http://h/x', 'git pull', 'git status']) {
    assert.equal(hisAloneCommand(plain), null, plain);
    assert.equal(adminRefusal(`sudo ${plain}`, ctx), null, `sudo ${plain}`);
  }
});

test('her own tool at Full: a release, a pull request or a deploy behind sudo is his card, and nothing runs before his tap', async () => {
  for (const command of ['sudo npm publish', 'sudo gh release create v1', 'sudo gh pr merge 3', 'sudo ./deploy.sh', 'sudo npm run deploy']) {
    const { ops, call } = setup('full');
    const r = await call(command);
    assert.ok(!r.isError && r.card, `a card: ${command}`);
    assert.equal(ran(ops).length, 0, `nothing ran: ${command}`);
    assert.match(r.text, /more than an administrator command/, `the card says why: ${command}`);
  }
  // An ordinary administrator command still runs with no card.
  for (const command of ['sudo apt-get install ripgrep', 'sudo systemctl restart nginx', 'sudo npm install -g pnpm']) {
    const { ops, call } = setup('full');
    const r = await call(command);
    assert.ok(!r.isError && !r.card, command);
    assert.equal(ops.calls.filter((c) => c.op === 'runAdmin').length, 1, command);
  }
});
