// The wall reads a shell command for the kinds that are the owner's wherever they run (administrator rights,
// publishing or releasing, a pull request made or merged). Each kind is tried against many real command lines:
// chained with && and ;, through a pipe, in sh -c and bash -lc, with env, with a count-taking passer (timeout,
// nice), through xargs, and with a quoted or split program name. Ordinary lines go through (null); a line the
// reader cannot read with certainty is held ('unreadable'). The six-kind table lives in src/wall.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { wallKind, wallHeld, readCommands } = await import('../src/wall.mjs');

// Wrap a bare (quote-free) held command in the forms a real session writes, so one base becomes many lines.
const WRAPS = [
  (b) => b,
  (b) => `true && ${b}`,
  (b) => `${b} ; echo done`,
  (b) => `echo start | ${b}`,
  (b) => `sh -c "${b}"`,
  (b) => `bash -lc "${b}"`,
  (b) => `env CI=1 LOG=on ${b}`,
  (b) => `timeout 120 ${b}`,
  (b) => `nice -n 5 ${b}`,
  (b) => `xargs ${b}`,
];
const spread = (bases) => bases.flatMap((b) => WRAPS.map((w) => w(b)));

const ADMIN = [
  'sudo true', 'sudo apt-get install nginx', 'sudo -u root whoami', 'sudo -i', 'sudo bash',
  'sudo chmod 777 /etc/hosts', 'sudo chown root file', 'sudo npm install -g pkg', 'su -c id',
  'doas pkg_add vim', 'pkexec systemctl restart app', 'doas sh',
];
const RELEASE = [
  'npm publish', 'npm publish --access public', 'pnpm publish', 'yarn publish', 'cargo publish',
  'twine upload dist/pkg.tar.gz', 'gem push mygem.gem', 'docker push myrepo/img:latest', 'podman push img',
  'gh release create v1.0.0', 'gh release create v2 --notes shipped', 'npm publish ./pkg',
];
const PR = [
  'gh pr create --fill', 'gh pr create --title feature --body text', 'gh pr merge 42', 'gh pr merge --squash 7',
  'glab mr create --fill', 'glab mr merge 9', 'gh pr create -B main', 'gh pr merge --auto 3',
  'glab mr create -t title', 'glab mr merge --rebase 1', 'gh pr create --draft', 'gh pr merge 100 --delete-branch',
];

for (const [kind, bases] of [['admin', ADMIN], ['release', RELEASE], ['pr', PR]]) {
  const lines = spread(bases);
  test(`${kind}: ${lines.length} lines are all held as "${kind}"`, () => {
    assert.ok(lines.length >= 80, `only ${lines.length} lines for ${kind}`);
    for (const line of lines) assert.equal(wallKind(line), kind, line);
  });
}

const ORDINARY = [
  'npm test', 'npm install', 'npm run build', 'npm ci', 'git status', 'git push origin feature',
  'git commit -m fix', 'gh pr view 12', 'gh pr list', 'gh pr checkout 3', 'gh repo clone example/shop',
  'docker build -t app .', 'docker run app', 'docker ps', 'cargo build', 'cargo test', 'cargo run',
  'yarn install', 'pnpm install', 'ls -la', 'cat README.md', 'echo sudo here', 'grep -r publish src',
  'which sudo', 'node build.mjs', 'python script.py', 'git log --oneline', 'make test',
  // Ordinary lines that use plain variables: their value does not change which program runs, so they go through.
  'node $FILE', 'cd $HOME', 'echo "$MSG"', 'npm test --grep $PATTERN', 'cat ${LOG}/out.txt',
  'git commit -m "publish the docs later"', 'echo "run gh pr create by hand"',
];
test(`ordinary lines go through (${ORDINARY.length})`, () => {
  for (const line of ORDINARY) assert.equal(wallKind(line), null, line);
});

const UNREADABLE = [
  'foo $(bar)', 'echo `id`', 'cat "oops never closes', 'ls $(pwd)',
  'sudo $(cat cmd)', 'npm publish $(echo x)', "cp 'half quote",
  "cat > notes.md <<'EOF'\nsudo is needed to install the service\nEOF", // finding 5: a word in a heredoc body
  'cat > f <<EOF\nnpm publish\nEOF',
];
test(`held because it cannot be read with certainty (${UNREADABLE.length})`, () => {
  for (const line of UNREADABLE) assert.notEqual(wallKind(line), null, line);
  // A substitution or an unterminated quote reads as 'unreadable', not as a false ordinary pass.
  assert.equal(wallKind('foo $(bar)'), 'unreadable');
  assert.equal(wallKind('echo `id`'), 'unreadable');
  assert.equal(wallKind('cat "oops never closes'), 'unreadable');
  // A heredoc body is not read as commands, so a "sudo" in a note is unreadable, not a false admin act.
  const heredoc = "cat > notes.md <<'EOF'\nsudo is needed to install the service\nEOF";
  assert.equal(wallKind(heredoc), 'unreadable');
  assert.match(wallHeld({ tool: 'Bash', input: { command: heredoc } }).reason, /could not read this command/i);
  // The <<< here-string is not a heredoc: it reads as it did before.
  assert.equal(wallKind('grep x <<< "some text"'), null);
});

test('readCommands: quotes taken off, names joined, substitutions held', () => {
  assert.deepEqual(readCommands('"sudo" true')[0].map((t) => t.word), ['sudo', 'true']);
  assert.deepEqual(readCommands('su""do true')[0].map((t) => t.word), ['sudo', 'true']);
  assert.deepEqual(readCommands("s'u'do x")[0].map((t) => t.word), ['sudo', 'x']);
  assert.equal(readCommands('a && b ; c').length, 3);
  assert.equal(readCommands('echo $(x)'), null);
  assert.equal(readCommands('echo "unterminated'), null);
});

test('a quoted or split program name is still read', () => {
  assert.equal(wallKind('"sudo" true'), 'admin');
  assert.equal(wallKind('su""do -i'), 'admin');
  assert.equal(wallKind("'npm' publish"), 'release');
  assert.equal(wallKind('g"h" pr create'), 'pr');
});

test('wallHeld: only Bash, carries a reason, lets an empty or non-shell call through', () => {
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'sudo true' } }).kind, 'admin');
  assert.ok(/administrator/i.test(wallHeld({ tool: 'Bash', input: { command: 'sudo true' } }).reason));
  assert.equal(wallHeld({ tool: 'Write', input: { file_path: '/x', content: 'sudo' } }), null);
  assert.equal(wallHeld({ tool: 'Bash', input: { command: '   ' } }), null);
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'npm test' } }), null);
});

test('sudoedit is an administrator act', () => {
  // sudoedit edits a file as administrator (it is `sudo -e`): it was read as an ordinary program because it stood
  // outside the admin set. The owner approves an editor as administrator at every level.
  assert.equal(wallKind('sudoedit /etc/hosts'), 'admin');
  assert.equal(wallKind('SUDO_EDITOR=vi sudoedit /etc/hosts'), 'admin');
  assert.equal(wallKind('time sudoedit x'), 'admin'); // through a passer, wherever it stands
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'sudoedit /etc/hosts' } }).kind, 'admin');
});

test('a bare variable that is the program (the head) is held; a variable in an argument still goes through', () => {
  // A bare variable standing alone as the command's head can expand to any program — `x=sudo; $x true` runs sudo —
  // so which program would run cannot be read with certainty, and the line is held, not read as the next word. A
  // head after leading assignments counts too (`FOO=1 $x`).
  for (const c of ['$x true', 'x=sudo; $x true', '${CMD} arg', 'FOO=1 $x', '$x --now']) {
    assert.equal(wallKind(c), 'unreadable', c);
  }
  // A variable that only stands in an ARGUMENT still goes through: its value does not pick which program runs. A
  // path whose program name is literal reads too, since the variable is only the directory (`$VENV/bin/python`).
  for (const c of ['node $FILE', 'cd $HOME', 'echo "$MSG"', 'cat ${LOG}/out.txt', 'FOO=$x cmd', '$VENV/bin/python app.py']) {
    assert.equal(wallKind(c), null, c);
  }
  // A redirection to a variable path is ordinary, not a variable head; sudo heading a variable stays administrator.
  assert.equal(wallKind('echo done > $LOG'), null);
  assert.equal(wallKind('sudo $x'), 'admin');
});

test('asking where a program is is not using it: locators go through; command NAME still runs it', () => {
  const held = (c) => { const h = wallHeld({ tool: 'Bash', input: { command: c } }); return h ? h.kind : null; };
  // The program name is only an argument to a locator, so nothing is run as administrator.
  assert.equal(held('command -v sudo'), null);
  assert.equal(held('command -V sudo'), null);
  assert.equal(held('command -pv sudo'), null);
  assert.equal(held('which sudo'), null);
  assert.equal(held('type sudo'), null);
  assert.equal(held('whereis sudo'), null);
  assert.equal(held('man sudo'), null);
  assert.equal(held('help sudo'), null);
  // `command NAME …` runs NAME, so it stays held; so does `command -p NAME …` (no -v).
  assert.equal(held('command sudo npm publish'), 'admin');
  assert.equal(held('command -p sudo rm -rf /'), 'admin');
});
