// A delete written in plain sight (src/asking.mjs mayDelete): what an OpenCode chat in bypass mode puts to the owner.
// The aim is the deletes a coding agent writes in plain sight, not a wall against a line written to get around it:
//   (a) a table of plain-sight lines that must be seen;
//   (b) ordinary lines that must not be a card (two lists of a coding agent's everyday lines, and compound forms);
//   (c) every call ends, fast: 200,000 random strings over shell signs, and the worst lines known;
//   (d) where bwrap can run: lines from a generator of plain-sight deletes run by bash with the real programs, the
//       deleters behind stand-ins that write down that they were started: no line that started one may be missed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { mayDelete } = await import('../src/asking.mjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const lines = (file) => fs.readFileSync(path.join(HERE, 'fixtures', file), 'utf8');

// ---------- (a) ----------

// A deleter's name written out, in every place a coding agent writes one: plain, with paths and other names of the
// program, behind programs that pass a command on (with their options written together), as a text a shell or eval
// runs, inside substitutions, compound commands, functions and here-documents, and find, git and rsync forms.
const PLAIN_SIGHT = [
  'rm -rf x', 'rm x', 'rm -f -- x', 'shred -u x', 'unlink x', 'truncate -s0 x', 'gnurm -rf x', 'gnushred -u x', 'gnuunlink x', 'gnutruncate -s0 x', 'coreutils rm -rf x', 'busybox rm -rf x',
  '/bin/rm x', '/usr/bin/rm -rf x', '/usr/lib/cargo/bin/coreutils/rm x', './rm x', 'RM=1 rm x', "r''m x", '"r"m x', '\\rm x', 'r\\m x', '"rm" x', "'rm' -rf x", '$"rm" x', '\\\nrm -rf x', 'rm\\\n -rf x',
  'command rm x', 'command -- rm x', 'exec rm x', 'exec -a q rm x', 'builtin command rm x', 'env rm -rf x', 'env -i rm x', 'env -u A rm x', 'env -iu A rm -rf x', 'env -iC . rm -rf x', 'env A=1 rm x', 'env -- rm x',
  'nice rm x', 'nice -n 1 rm x', 'nice -n1 rm x', 'nice -1 rm x', 'nice -n 1 -- rm x', 'nohup rm x', 'nohup rm x &', 'time rm x', 'time -p rm x', 'timeout 5 rm x', 'timeout -s KILL 5 rm x', 'timeout -vs KILL 5 rm -rf x',
  'timeout -ks1 KILL 5 rm x', 'timeout --signal=KILL 5 rm x', 'stdbuf -oL rm x', 'stdbuf -o L rm x', 'stdbuf -io L rm x', 'sudo rm -rf x', 'sudo -u root rm x', 'sudo -Eu root rm -rf x', 'sudo -iu root rm -rf x', 'sudo -nu root rm x',
  'sudo -- rm x', 'doas rm x', 'doas -u r rm x', 'doas -nu r rm x', 'setsid rm x', 'ionice -c3 rm x', 'A=1 B=2 rm x', '! rm x', 'coproc rm x', 'coproc C { rm -rf x; }', 'coproc C (rm -rf x)', 'gnuenv rm -rf x', 'gnutimeout 5 rm -rf x',
  'gnunice rm x', 'gnunohup rm x', 'gnustdbuf -oL rm x', 'setarch x86_64 rm -rf x', 'linux64 rm -rf x', 'prlimit -- rm -rf x', 'eatmydata rm -rf x', 'fakeroot rm -rf x', 'xvfb-run rm -rf x', 'dbus-run-session rm -rf x',
  'nsenter rm x', 'unshare rm x', 'chronic rm x', 'unbuffer rm -rf x', 'npx rm x', 'uv run rm x', 'systemd-run --user --pipe rm x', 'printf x | xargs rm', 'printf "x\\0" | xargs -0n 1 rm', 'printf "x\\n" | xargs -rn 1 rm',
  'printf x | xargs -tI {} rm {}', 'printf x | xargs -0r rm', 'printf x | xargs --null rm', 'busybox xargs rm <<< x', 'pv -q x | xargs rm',
  "bash -c 'rm -rf x'", "sh -c 'rm -rf x'", "bash -O extglob -c 'rm -rf x'", "bash -c -O extglob 'rm -rf x'", "bash -co pipefail 'rm -rf x'", "bash +O extglob -c 'rm -rf x'", "bash -o pipefail -c 'rm -rf x'", "bash -x -e -c 'rm -rf x'",
  "bash --norc -c 'rm -rf x'", "bash -ce 'rm -rf x'", "bash -c -- 'rm -rf x'", "sh -c 'rm \"$0\"' x", "bash -c 'rm -rf x' -x", "bash --rcfile /dev/null -c 'rm x'", "bash -s <<< 'rm -rf x'", "bash /dev/stdin <<< 'rm -rf x'",
  'zsh -c "rm -rf x"', 'dash -c "rm -rf x"', 'fish -c "rm -rf x"', "busybox sh -c 'rm -rf x'", "eval 'rm -rf x'", "eval -- 'rm -rf x'", "builtin eval -- 'rm x'", 'eval rm -rf x', 
  "echo 'rm -rf x' | sh", "echo 'rm -rf x' | bash", "echo 'rm -rf x' | (bash)", "echo 'rm -rf x' | { :; bash; }", "(bash) <<< 'rm -rf x'", "{ bash; } <<< 'rm -rf x'", "bash -c bash <<< 'rm -rf x'",
  "exec 0<<<'rm -rf x'; bash", "f(){ bash; }; echo 'rm -rf x' | f", "while :; do bash; break; done <<< 'rm -rf x'", "if :; then sh; fi <<< 'rm -rf x'",
  "sudo -i <<< 'rm -rf x'", "env -S'rm -rf x'", "env --split-string='rm -rf x'", "env -iS 'rm -rf x'", 'gnuenv -iS "rm -rf x"', "su -c 'rm -rf x'", "su -c'rm -rf x'",
  "su --command='rm -rf x'", "script -qc 'rm -rf x' /dev/null", "script --command='rm -rf x' /dev/null", "flock f -c 'rm -rf x'", "flock --command='rm -rf x' f", 'flock -c "rm -rf x"', "runuser --command='rm -rf x'", "watch 'rm -rf x'",
  "parallel 'rm -rf {}' ::: x", "trap 'rm -rf x' EXIT", "trap -- 'rm -rf x' EXIT", "ssh h rm -rf x", 'ssh host "rm -rf x"', "ssh -o ProxyCommand='rm -rf x' h", "env 'BASH_FUNC_ls%%=() { rm -rf x; }' bash -c ls",
  'echo "$(rm -rf x)"', 'echo $(rm -rf x)', 'echo `rm -rf x`', 'echo "`rm -rf x`"', 'x=$(rm -rf x)', 'x=${u:-$(rm -rf x)}', "echo \"${u:-'$(rm -rf x)'}\"", "u=1; echo \"${u:+'$(rm -rf x)'}\"", 'cat <(rm -rf x)', ': >(rm -rf x)',
  '[[ -n $(rm -rf x) ]]', 'echo $(( $(rm -rf x) + 1 ))',
  'if true; then rm -rf x; fi', 'if rm x; then :; fi', 'while rm x; do break; done', 'until rm x; do break; done', 'for d in */; do (cd "$d" && rm -rf build); done', 'for f in a; do rm "$f"; done', 'case a in a) rm -rf x;; esac',
  'f() { rm -rf x; }; f', 'function f { rm -rf x; }; f', '{ rm -rf x; }', '(rm -rf x)', 'true && rm x', 'false || rm x', 'echo a | rm x', 'rm x 2>&1 | tail', 'rm x # remove it', '# x\nrm x', 'cd . && rm -rf x', 'echo hi; rm x',
  'cat <<E\n$(rm -rf x)\nE', 'cat <<E\n`rm -rf x`\nE', 'bash <<EOF\nrm -rf x\nEOF', "bash <<-E\n\trm -rf x\n\tE", "cat <<A <<B | sh\na\nA\nrm -rf x\nB",
  'sudo -u git rm -rf /srv/x', 'sudo -u node rm -rf x', 'ssh stack rm -rf /data', 'cd config; ls stack rm', 'cd x; env config rm -rf y', 'git -C repo rm x # an option between',
  // A # is a comment only where bash begins one; no here-document in arithmetic; programs that run a text on the line.
  'n=${#PATH}; rm -rf x', '[ $# -eq 0 ] && rm -rf x', 'files=(x); [ ${#files[@]} -gt 0 ] && rm -rf x', 'echo $((1<<2))\nrm -rf x', 'ls *#*; rm -rf x', 'echo a#b; rm x', '(( n = 1 << 3 ))\nrm -rf x',
  'python3 -c "import os; os.system(\'rm -rf x\')"', 'perl -e \'system("rm -rf x")\'', "tmux new-session -d 'rm -rf x'", "echo 'rm -rf x' | at now", 'awk \'BEGIN{system("rm -rf x")}\'', "ruby -e 'system(\"rm -rf x\")'",
  "node -e \"require('child_process').execSync('rm -rf x')\"", 'sudo bash -c "rm -rf x"', 'env X=1 sh -c "rm -rf x"', 'time nice bash -c "rm -rf x"', 'timeout 5 bash -c "rm -rf x"', "screen -dm bash -c 'rm -rf x'",
  // A shell with -c wherever it stands; npm exec -c; # after \r, \v or a ) that closes $(( )) in a word is no comment.
  'docker exec box sh -c "rm -rf x"', 'docker run --rm -v "$PWD":/app img sh -c "rm -rf /app/node_modules"', 'docker compose exec web sh -c "rm -rf x"', 'podman exec c sh -c "rm -rf x"', 'kubectl exec pod -- sh -c "rm -rf x"',
  'lxc exec c -- sh -c "rm -rf x"', 'chroot /srv sh -c "rm -rf x"', 'strace -f sh -c "rm -rf x"', 'unshare -r sh -c "rm -rf x"', 'nsenter -t 1 -m sh -c "rm -rf x"', 'systemd-run --user sh -c "rm -rf x"', 'firejail sh -c "rm -rf x"',
  'uv run sh -c "rm -rf x"', 'poetry run sh -c "rm -rf x"', "npm exec -c 'rm -rf x'", 'pnpm dlx -c "rm -rf x"', 'nodemon --exec "rm -rf x"', "npx concurrently 'rm -rf x' 'vite'", 'echo a\r# ; rm -rf y', 'echo a\v#; rm -rf y', 'echo $((1))#; rm -rf y', "cat <<'E' | sh\nrm -rf x\nE", "bash <<'E'\nrm -rf x\nE", 'select x in a; do rm x; break; done <<< 1', 'hash -p /bin/rm l; l -rf x',
  'find . -delete', 'find . -name x -delete', 'find . -maxdepth 1 -name x -delete', 'find . -exec rm {} \\;', 'find . -execdir rm -f {} +', "find . -maxdepth 0 -exec sh -c 'rm -rf x' \\;", "find . -maxdepth 0 -execdir bash -O extglob -c 'rm -rf x' \\;",
  'git clean -fd', 'git clean -fdx', 'git -C . clean -f', 'git -C. clean -fd', 'git -c a.b=c clean -n', 'git --git-dir .git clean -fd', 'git --git-dir=.git clean -fd', 'git --exec-path=. clean -n', 'git --no-pager clean -fd',
  'rsync -a --delete a/ b/', 'rsync --del a b', 'rsync -a --delete-after d/ e/', 'rsync --remove-source-files a b',
];

// Lines the table held before rule 2 was written anew that it does not promise (. or source of a text, a pipe into a
// program other than a shell, at or batch, BASH_ENV, a script file written and then run): they stay out of the table.
const NOT_PROMISED = [". /dev/stdin <<< 'rm -rf x'", "source <(echo 'rm -rf x')", "{ . /dev/stdin; } <<< 'rm -rf x'", "echo 'rm -rf x' | bash -c 'source /dev/stdin'", "sh -c 'exec sh' < <(echo 'rm -rf x')",
  "echo 'rm -rf x' | script -q /dev/null", "echo 'rm -rf x' | sudo -s", "BASH_ENV=<(echo 'rm -rf x') bash -c :", "cat > clean.sh <<'EOF'\nrm -rf build\nEOF\nbash clean.sh"];

test('a delete written in plain sight is seen: the table', () => {
  process.stdout.write(`# not promised by rule 2 and left out of the table: ${NOT_PROMISED.length}\n`);
  assert.ok(PLAIN_SIGHT.length >= 150, `at least 150 lines: ${PLAIN_SIGHT.length}`);
  const missed = PLAIN_SIGHT.filter((l) => !mayDelete(l));
  assert.deepEqual(missed, []);
});

// ---------- (b) ----------

test('ordinary lines are no card: the two lists of everyday lines and compound forms, each card named', () => {
  const first = lines('ordinary-lines.txt').split('\n').filter(Boolean);
  const second = lines('ordinary-lines-2.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const compound = lines('ordinary-compound.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const report = (name, list) => {
    const cards = list.filter((l) => mayDelete(l));
    process.stdout.write(`# ${name}: ${list.length} lines, ${cards.length} a card${cards.length ? `: ${cards.map((c) => JSON.stringify(c)).join(' | ')}` : ''}\n`);
    return cards;
  };
  assert.deepEqual(report('ordinary 1', first), []);
  assert.deepEqual(report('ordinary 2', second), []);
  assert.deepEqual(report('compound', compound), []);
  for (const line of ['npm run eval', 'python3 scripts/eval.py', 'grep -rn "rm -rf" scripts/', "sed '1d;$d' data.csv", 'git rm x', 'npm rm lodash', 'docker rm web', 'docker image rm app:old', 'git commit -m "rm old files"',
    // A here-document's body is text, a comment is skipped, a subcommand where its program begins the command.
    'git commit -m "$(cat <<\'EOF\'\nFix the parser\n\nIt don\'t hang any more.\nEOF\n)"', "cat > NOTES.md <<EOF\nit's done\nEOF", "cat > x.sh <<EOF\nrm -rf build\nEOF", "cat > clean.sh <<'EOF'\nrm -rf build\nEOF",
    "cat <<'E' > a.txt\n$(rm -rf x) is only text here\nE", 'npm test # don\'t run e2e', 'echo a#b', 'sudo git rm x', 'env npm rm x', 'docker compose rm -f', 'podman volume rm v',
    // A runner's name as an argument is a word like any other.
    'grep -rn "rm -rf" .', 'git add . && git commit -m "rm old files"', 'rg "truncate" .', 'rg -n "shred|truncate" src', "sed -i 's/rm -rf/rm -r/' scripts/build.sh", 'find . -name "*.md" | xargs grep -l TODO',
    // A runner and a quoted deleter's name in another command, or a language not told to start a program.
    'npx tsc --noEmit && git commit -am "rm unused files"', 'npm run build && npx vitest run && git commit -am "chore: rm dist from repo"', 'node scripts/gen.mjs && git commit -m "unlink the old symlink step"',
    'python3 manage.py makemigrations && git commit -m "rm the status field"', 'npx jest && echo "Run rm -rf node_modules if it breaks"', 'tmux ls; git commit -m "rm tmp"', 'npx jest -t "rm"', 'python3 -m pytest -k "unlink or truncate"',
    'node scripts/build.js "rm"', "awk '/rm -rf/ {print}' log.txt", "perl -pi -e 's/rm -rf/rm -r/' build.sh", 'php artisan route:list | grep "rm"', 'ls -la sh bash "rm"', 'bash build.sh && git commit -m "rm x"', 'npx vitest -t "rm"', `python3 -c "print('rm')"`]) {
    assert.equal(mayDelete(line), false, line);
  }
  // Lines that may be a card: a deleter's name written out where it could run, or a delete of another kind.
  for (const line of ['echo rm is fine', 'aws s3 rm s3://bucket/key', 'gsutil rm gs://bucket/x']) process.stdout.write(`# may be a card: ${JSON.stringify(line)} → ${mayDelete(line)}\n`);
  // Not caught on purpose (src/asking.mjs mayDelete): a quoted deleter's name after a passer not in the lists.
  for (const line of ["eatmydata 'rm' -rf x", 'fakeroot "rm" -rf x']) assert.equal(mayDelete(line), false, line);
});

test('the neighbours of another reviewer: each line as it is meant', () => {
  const list = lines('maydelete-neighbours.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const wrong = list.filter((x) => mayDelete(x.line) !== (x.want === 'true'));
  process.stdout.write(`# neighbours: ${list.filter((x) => x.want === 'true').length} that delete, ${list.filter((x) => x.want === 'false').length} ordinary, ${wrong.length} judged otherwise\n`);
  assert.deepEqual(wrong, []);
});

// A leading assignment in the four forms the wall reads (src/wall.mjs ASSIGNMENT): NAME=, NAME+=, NAME[sub]= and
// NAME[sub]+=. A deleter's name written out, a command that takes a command with the deleter outside quotes, and an
// everyday line answer the same in all four. A quoted delete after a program that takes a command (or a shell, a
// language, npx -c, a pipe into at) counts after NAME+= as after NAME=; before, NAME+= hid it; and after NAME[sub]= and NAME[sub]+= too, whose [ and ]
// stay in the word, so the program after them is the head of its command (A[0]=1 eval 'rm -rf x'); also where the
// subscript holds a $ or a quote (A[$i]=1, A["k"]=1), read up to the ] that closes it.
test('a leading assignment in each form the wall reads answers as the plain one', () => {
  const FORMS = ['X=1', 'X+=1', 'A[0]=1', 'A[0]+=1', 'A[$i]=1', 'A[$i]+=1', 'A["k"]=1', 'A["k"]+=1'];
  for (const form of FORMS) {
    for (const rest of ['rm -rf build', 'xargs rm', 'sudo rm -rf x', 'Y+=2 rm -rf x', "xargs sh -c 'rm -rf x'"]) assert.equal(mayDelete(`${form} ${rest}`), true, `${form} ${rest}`);
    for (const rest of ['ls', 'npm test', 'bash build.sh', "echo 'rm -rf x'", 'git commit -m "rm old files"']) assert.equal(mayDelete(`${form} ${rest}`), false, `${form} ${rest}`);
  }
  const QUOTED = ["eval 'rm -rf x'", "ssh h 'rm -rf x'", "bash <<< 'rm -rf x'", "timeout 5 eval 'rm -rf x'", 'python3 -c "import os; os.system(\'rm -rf x\')"', "npx -c 'rm -rf x'", "nodemon --exec 'rm -rf x'", "Y+=2 eval 'rm -rf x'"];
  // Every row is judged before the one comparison, so a wrong answer names each row that has one.
  const missed = [];
  for (const form of ['X=1', 'X+=1', 'A[0]=1', 'A[0]+=1', 'A[i]=1', 'A[i]+=1', 'A[$i]=1', 'A[$i]+=1', 'A["k"]=1', 'A["k"]+=1']) {
    for (const line of [...QUOTED.map((rest) => `${form} ${rest}`), `echo 'rm -rf x' | ${form} at now`]) if (!mayDelete(line)) missed.push(line);
  }
  assert.deepEqual(missed, []);
});

// An assignment with brackets before a program that takes a command: the quoted delete is that program's text and
// asks; before a plain program it is no card. Everyday lines with brackets answer as they did before.
test('an array element assigned before a command: the program after it is read, everyday brackets are unchanged', () => {
  const missed = [];
  const cards = [];
  for (const line of ["A[0]=1 eval 'rm -rf x'", "echo 'rm -rf x' | A[0]=1 at now", "A[i]=1 eval 'rm -rf x'", "A[0]+=1 eval 'rm -rf x'", "A[i+1]=1 eval 'rm -rf x'",
    "echo 'rm -rf x' | A[i]+=1 batch", "A[0]=1 B[1]=2 eval 'rm -rf x'", "X=1 A[0]=1 ssh h 'rm -rf x'", "A[0]=1 sudo bash -c 'rm -rf x'", "A[k_1]=1 nohup sh -c 'rm -rf x'",
    "f(){ :; }; A[0]=1 eval 'rm -rf x'", "echo \"$(A[0]=1 eval 'rm -rf x')\"", "true && A[0]=1 eval 'rm -rf x'", "A[0]=1 rm -rf x", "[ -d y ] && rm -rf y", "ls [a-c]* && rm x",
    // A subscript with a $, a quote or brackets: read up to its ], the program after it is read.
    "A[$i]=1 eval 'rm -rf x'", "A[\"k\"]=1 eval 'rm -rf x'", "A['k']=1 eval 'rm -rf x'", "A[$'k']=1 eval 'rm -rf x'", "A[${k}]=1 eval 'rm -rf x'", "A[\"$k\"]+=1 ssh h 'rm -rf x'",
    "A[$i+1]=1 sudo bash -c 'rm -rf x'", "A[\"a b\"]=1 eval 'rm -rf x'", "A[B[0]]=1 eval 'rm -rf x'", "echo 'rm -rf x' | A[$i]=1 at now", "echo 'rm -rf x' | A[\"k\"]+=1 batch", "true && A[$i]=1 eval 'rm -rf x'",
    // A command in a subscript ends the reading there, so that command is read as before.
    'A[$(rm -rf x)]=1 ls', 'A[`rm -rf x`]=1 ls', 'A["$(rm -rf x)"]=1 ls', 'A["`rm -rf x`"]=1 ls', 'A[$i]=$(rm -rf x) ls',
    // A subscript that holds a command ($( ), $(( )), a backtick): that command is read, and so is the program after it.
    "A[$(id -u)]=1 eval 'rm -rf x'", "A[$((i+1))]=1 eval 'rm -rf x'", "A[`id -u`]=1 eval 'rm -rf x'", "A[\"$(id -u)\"]=1 eval 'rm -rf x'", "A[\"`id -u`\"]+=1 ssh h 'rm -rf x'",
    "A[i+$(id -u)]=1 sudo bash -c 'rm -rf x'", "A[$(echo ']')]=1 eval 'rm -rf x'", "A[$(id)]=1 B[`id`]=2 eval 'rm -rf x'", "true && A[$((1))]=1 eval 'rm -rf x'",
    "echo 'rm -rf x' | A[$(id -u)]=1 at now", "A[$(id -u)]=1 echo 'rm -rf x' | at now", "echo \"$(A[$(id -u)]=1 eval 'rm -rf x')\"", "A[$(B[$(id)]=1 ls)]=1 eval 'rm -rf x'",
    'A[$(id)]=1 rm -rf x', 'A[$(id; rm -rf x)]=1 ls', 'A[$(id)]=`rm -rf x` ls', 'A[$(id) ; rm -rf x]=1 ls']) {
    if (!mayDelete(line)) missed.push(line);
  }
  for (const line of ['A[0]=1 ls', 'A[i]=1 npm test', 'A[0]+=1 git status', "A[0]=1 echo 'rm -rf x'", 'A[i]=1 git commit -m "rm old files"', 'A[0]=1 B[1]=2 make',
    "A[0]=1 grep -rn 'rm -rf' .", 'ls [a-c]*', 'echo ${A[0]}', 'test -f x && [ -d y ]', '[[ -n $x ]] && ls', 'echo "${A[@]}"', 'arr[0]=1; echo ${arr[0]}', 'ls x[0]', "grep -E '[a-z]+' f",
    'echo ${#A[@]}', 'A[0]', 'A[', 'A[0', 'A[0]x=1 ls', "echo a[0] 'rm -rf x'", 'printf "%s\\n" "${files[@]}" | sort', 'x=${A[0]:-rm}', 'git rm x[0]',
    // The same with a $ or a quote in the brackets: an assignment before a plain program, or no assignment at all.
    'echo "${A[$i]}"', 'echo ${A[$i]}', '[[ $a == "b" ]]', '[[ $a == "b" ]] && ls', 'A[$i', 'A[$i]', 'A[$i]x=1 ls', 'A["k"] ls', "A[$i]=1 echo 'rm -rf x'", 'A["k"]=1 git commit -m "rm old files"',
    'A["rm -rf x"]=1 ls', "A['rm -rf x']+=1 make", 'arr[$i]=1; echo "${arr[$i]}"', 'declare -A m; m["a b"]=1; echo "${m["a b"]}"', 'A[$i]=1 B["k"]=2 make', "echo A[$i] 'rm -rf x'",
    // The same with a command in the brackets.
    'A[$(id -u)]=1 ls', "A[$(id -u)]=1 echo 'rm -rf x'", 'A[`id -u`]=1 git commit -m "rm old files"', 'echo "${A[$(id -u)]}"', 'echo ${A[$((i+1))]}', "A[$(id -u)] 'rm -rf x'",
    "echo A[$(id)] 'rm -rf x'", 'A[$(id) x]=1 ls', 'A[$(id)', 'A[`id`', 'n=${#A[$(id)]}; echo $n']) {
    if (mayDelete(line)) cards.push(line);
  }
  // An unclosed quote in a subscript is an unclosed quote, as before: a card.
  if (!mayDelete('A["k')) missed.push('A["k');
  if (!mayDelete("A['k]=1 eval x")) missed.push("A['k]=1 eval x");
  // Every row is judged before the one comparison, so a wrong answer names each row that has one.
  assert.deepEqual({ missed, cards }, { missed: [], cards: [] });
});

// ---------- (c) ----------

// mulberry32: a seeded source whose state runs through all 2^32 values before it repeats.
const source = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// bash keeps more inside one word than a reader that ends a word at every sign: a value with $ ~ * ? ! { } [ ], a
// subscript with a blank, a sign, a command or arithmetic, a host or a user written as ${NAME} or $( … ). Each of
// these lines was run through bash 5.3 with a harmless program in the place of the delete: the program ran.
test('a word bash keeps whole is read whole: the program behind it is the head of its command', () => {
  for (const line of ["X=$HOME/out eval 'rm -rf x'", "X=~/out eval 'rm -rf x'", "X=* eval 'rm -rf x'", "X=${HOME}/out eval 'rm -rf x'", "X=$(id -u) eval 'rm -rf x'", "X=`id -u` eval 'rm -rf x'",
    "X=a{b,c}d eval 'rm -rf x'", "X=a[bc]d eval 'rm -rf x'", "X=a?b eval 'rm -rf x'", "X=a!b eval 'rm -rf x'", "X=a^b eval 'rm -rf x'", "X+=$i eval 'rm -rf x'", "A[0]+=$i eval 'rm -rf x'", "T=${HOME} eval 'rm -rf x'",
    "X=$HOME/out Y=~ eval 'rm -rf x'", "true && X=$HOME eval 'rm -rf x'", "echo 'rm -rf x' | X=$HOME at now", "X=$HOME/out ssh h 'rm -rf x'", "X=$HOME sudo bash -c 'rm -rf x'", "X=$1 nohup sh -c 'rm -rf x'",
    // A subscript with a blank or a sign, as bash reads one: up to the ] that closes it.
    "A[i + 1]=1 eval 'rm -rf x'", "A[ 2 ]=1 eval 'rm -rf x'", "A[1<2]=1 eval 'rm -rf x'", "A[1>0]=1 eval 'rm -rf x'", "A[1&1]=1 eval 'rm -rf x'", "A[1|1]=1 eval 'rm -rf x'", "A[(1)]=1 eval 'rm -rf x'",
    "H[a;b]=1 eval 'rm -rf x'", "H[a b]=1 ssh h 'rm -rf x'", "A[${i}]=1 eval 'rm -rf x'", "A[i + 1]+=1 eval 'rm -rf x'", "A[i + 1]=$HOME eval 'rm -rf x'", "echo 'rm -rf x' | A[i + 1]=1 batch",
    // A host, a user or a session written with a variable or a command: the quoted text is still its program's.
    "ssh ${HOST} 'rm -rf x'", "ssh $(cat host) 'rm -rf x'", "ssh `cat host` 'rm -rf x'", "ssh ${U}@${HOST} 'rm -rf x'", "su ${U} -c 'rm -rf x'", "tmux send-keys -t ${S} 'rm -rf x' Enter",
    "printf x | xargs -I{} ssh {} 'rm -rf x'", "timeout ${T} ssh h 'rm -rf x'", "env X=${Y} eval 'rm -rf x'",
    // The same inside a command that stands in a $( … ) or a backtick, bare, in double quotes or in a subscript.
    "echo $(A[$(id)]=1 eval 'rm -rf x')", "echo \"$(X=$HOME eval 'rm -rf x')\"", "echo `X=$HOME eval 'rm -rf x'`", "A[$(B[i + 1]=1 eval 'rm -rf x')]=1 ls", "echo \"`A[i + 1]=1 eval 'rm -rf x'`\"",
    "X=$(Y=$HOME eval 'rm -rf x') ls"]) {
    assert.equal(mayDelete(line), true, line);
  }
  // Ordinary: the same words in front of a program that runs no text, or the text of a message.
  for (const line of ['X=$HOME/out ls', "X=$HOME/out echo 'rm -rf x'", "X=~/out git commit -m 'rm old files'", 'A[i + 1]=1 ls', "A[ 2 ]=1 echo 'rm -rf x'", "echo ${HOST} 'rm -rf x'", "echo $(date) 'rm -rf x'",
    'git commit -m "$(cat msg) rm old"', "grep -rn 'rm -rf' ${DIR}", 'for f in *.log; do echo "rm $f"; done', "ls ${DIR}/*.txt | grep 'rm '", "echo \"${A[i + 1]}\" 'rm -rf x'",
    "X=$(git log --grep 'rm -rf' | wc -l); echo $X", "if [[ $x == *.log ]]; then echo 'rm -rf x'; fi", "make ${TARGET} MSG='rm -rf x'", "find ${DIR} -name '*.rm'", "echo {a,b} 'rm -rf x'", "ls ~/x 'rm'",
    "git log --format='%h rm' ${A}..${B}", 'echo "$(git log -1 --format=%s) rm"', "A[i + 1] 'rm -rf x'", "echo A[i + 1]=1 'rm -rf x'", 'N=${#A[@]}; echo "rm $N"', "test -n \"${X:-}\" && echo 'rm -rf x'",
    'curl -s "https://example.com/?q=rm" | jq .', "node -e 'console.log(\"rm\")' ${ARGS}", 'npm test -- --grep "rm $(date +%s)"']) {
    assert.equal(mayDelete(line), false, line);
  }
});

test('every call ends, fast: 200,000 random strings of up to 4,000 characters and the worst lines known', () => {
  const rand = source(20261118);
  const SIGNS = [...'\'"`$\\\n ;|&(){}<>#*?[]!~=-/', 'rm', 'r', 'm', 'a', 'x', '\t', '$(', "$'", '$"', '<<', '\\\n'];
  const time = (line) => {
    const t = performance.now();
    mayDelete(line);
    return performance.now() - t;
  };
  let slowest = { ms: 0, line: '' };
  for (let n = 0; n < 200000; n++) {
    const len = Math.floor(rand() * rand() * 4001); // most short, some up to 4,000
    let s = '';
    while (s.length < len) s += SIGNS[Math.floor(rand() * SIGNS.length)];
    s = s.slice(0, 4000);
    const ms = time(s);
    if (ms > slowest.ms) slowest = { ms, line: s };
  }
  // The worst lines known, warmed up first; the slowest of all measured again (a pause of the collector is no call).
  for (const line of ['`(`', 'git ' + '-C '.repeat(1330) + 'status', '"'.repeat(4000), '\\'.repeat(4000), "'".repeat(4000), 'find '.repeat(800), '$('.repeat(2000), "$'".repeat(2000),
    // Many commands, texts and runners: every rule-2 fact is found in one pass per command.
    'npx '.repeat(999) + '"rm"', 'sh '.repeat(1300) + '-c', '"rm";'.repeat(800), '("rm")'.repeat(666), 'nodemon '.repeat(500), 'a|'.repeat(1999), '$("rm")'.repeat(500), 'x<<E\n'.repeat(700),
    // Brackets that may open an array element's subscript: each word is looked at for one once.
    'A['.repeat(2000), 'A[0'.repeat(1333), 'A[0]=1 '.repeat(571) + 'eval', 'A' + '[0'.repeat(1999), 'A[' + 'x'.repeat(3998),
    // Subscripts with a $ or a quote: read once each, also where one never closes.
    'A[$i]=1 '.repeat(499) + 'eval', 'A["k"]+=1 '.repeat(399) + 'eval', 'A[$i'.repeat(1000), 'A["'.repeat(1333), 'A[\'k\'x'.repeat(666), 'A[[[' + '"'.repeat(3996),
    // Subscripts that hold a command: each read once, also nested deep and never closed.
    'A[$(id)]=1 '.repeat(363) + 'eval', 'A[`x`]=1 '.repeat(444) + 'eval', 'A[$('.repeat(1000), 'A[`'.repeat(1333), 'A["$('.repeat(800), 'A[$(('.repeat(800), 'A[$(B['.repeat(571),
    '"$(A[$('.repeat(571), 'A[$(id)'.repeat(571),
    // The second reading: words kept whole, each nested command a line of its own, each read once per level.
    'X=$a '.repeat(666) + 'eval', 'A[i + 1]=1 '.repeat(363) + 'eval', '${'.repeat(2000), '${x}'.repeat(1000), '$(${'.repeat(800), '"$(`'.repeat(1000), 'A[ $( '.repeat(500) + ')]=1 '.repeat(500),
    '$('.repeat(1333) + ')'.repeat(1333), '"$('.repeat(800) + ')"'.repeat(800), '$(x)'.repeat(1000), '"$(x)"'.repeat(666), 'A[$(x)]=1 '.repeat(363) + "eval 'rm'", '{}'.repeat(2000), 'a[1]'.repeat(1000),
    '`x`'.repeat(1333), 'ssh ${H} '.repeat(444) + "'rm'"]) {
    for (let i = 0; i < 20; i++) mayDelete(line);
    const ms = Math.min(time(line), time(line), time(line));
    if (ms > slowest.ms) slowest = { ms, line };
  }
  const again = Math.min(...Array.from({ length: 5 }, () => time(slowest.line)));
  process.stdout.write(`# time: 200,000 random strings and the worst lines; slowest call ${again.toFixed(2)} ms (${slowest.line.length} characters)\n`);
  assert.ok(again < 5, `slowest call ${again.toFixed(2)} ms`);
  assert.equal(mayDelete('x'.repeat(4001)), true, 'over 4,000 characters');
});

// ---------- (d) ----------

// A generator of plain-sight deletes: a deleter's name written out, in every position and wrapping of the table.
function plainSightLines(n, seed) {
  const rand = source(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const sq = (t) => `'${t.replace(/'/g, "'\\''")}'`;
  // Names written out; the spellings that only bash joins (\rm, r''m, "r"m) stand where a command starts, not inside a
  // text another program runs (there the name is no longer written out).
  const NAMES = ['rm', 'rm', '/usr/bin/rm', 'shred -u', 'unlink', 'truncate -s0', 'gnurm', 'coreutils rm', 'busybox rm'];
  const SPELT = [...NAMES, '\\rm', "r''m", '"r"m'];
  const ARGS = ['-rf x', 'x', '-f x', '-- x', '-rf -- x', 'x y', '-r d'];
  const del = (top = true) => `${pick(top ? SPELT : NAMES)} ${pick(ARGS)}`;
  const PASS = ['', '', 'command ', 'exec ', 'env ', 'env -i ', 'env -iu A ', 'env A=1 ', 'nice ', 'nice -n1 ', 'nohup ', 'time ', 'time -p ', 'timeout 5 ', 'timeout -vs KILL 5 ', 'stdbuf -oL ', 'sudo ', 'sudo -Eu root ',
    'doas ', 'setsid ', 'ionice -c3 ', 'A=1 ', '! ', 'gnuenv ', 'gnutimeout 5 ', 'setarch x86_64 ', 'prlimit -- ', 'eatmydata ', 'fakeroot ', 'coreutils env '];
  const SHELL = ['sh', 'bash', 'dash', '/bin/sh', '/usr/bin/bash', 'busybox sh', 'env bash', 'sudo bash', 'nice bash'];
  const OPT = ['', '-x ', '-e ', '-O extglob ', '+O extglob ', '-o pipefail ', '--norc ', '--noprofile ', '--rcfile /dev/null '];
  const viaShell = (t) => pick([
    () => `${pick(SHELL)} ${pick(OPT)}-c ${sq(t)}`, () => `${pick(SHELL)} -c ${pick(OPT)}${sq(t)}`, () => `${pick(SHELL)} -c -- ${sq(t)}`, () => `${pick(SHELL)} ${pick(OPT)}<<< ${sq(t)}`,
    () => `echo ${sq(t)} | ${pick(SHELL)}`, () => `${pick(SHELL)} <<'E'\n${t}\nE`, () => `eval ${sq(t)}`, () => `eval -- ${sq(t)}`, () => `eval ${t}`,
    () => `echo ${sq(t)} | (${pick(SHELL)})`, () => `{ ${pick(SHELL)}; } <<< ${sq(t)}`, () => `su -c ${sq(t)}`, () => `su --command=${sq(t)}`,
    () => `script -qc ${sq(t)} /dev/null`, () => `flock f -c ${sq(t)}`, () => `watch ${sq(t)}`, () => `parallel ${sq(t)} ::: x`, () => `trap ${sq(t)} EXIT`, () => `env -S${sq(t)}`,
    () => `find . -maxdepth 1 -name x -exec ${pick(SHELL)} -c ${sq(t)} \\;`, () => `printf x | xargs ${pick(SHELL)} -c ${sq(t)}`,
  ])();
  const ctx = (c) => pick([
    () => c, () => `{ ${c}; }`, () => `(${c})`, () => `if true; then ${c}; fi`, () => `if ${c}; then :; fi`, () => `while ${c}; do break; done`, () => `for f in a; do ${c}; done`, () => `f(){ ${c}; }; f`,
    () => `function f { ${c}; }; f`, () => `echo $(${c})`, () => `echo "$(${c})"`, () => `echo \`${c}\``, () => `cat <(${c})`, () => `x=$(${c})`, () => `x=\${u:-$(${c})}`, () => `true && ${c}`, () => `false || ${c}`,
    () => `echo a | ${c}`, () => `${c} &`, () => `${c} 2>&1 | tail`, () => `case a in a) ${c};; esac`, () => `time ${c}`, () => `${c} # comment`, () => `# x\n${c}`, () => `echo hi; ${c}`, () => `cd . && ${c}`,
    () => `\\\n${c}`,
  ])();
  // A here-document's body is text (src/asking.mjs mayDelete): there only names written out, as in a text a shell runs.
  const inBody = (c) => pick([() => `cat <<E\n$(${c})\nE`, () => `cat <<'E' | sh\n${c}\nE`, () => `cat <<-E | bash\n\t${c}\n\tE`])();
  const payload = (depth = 0) => {
    const r = rand();
    if (r < 0.3) return del(!depth);
    if (r < 0.5) return `${pick(PASS)}${pick(PASS)}${del(!depth)}`;
    if (r < 0.57) return `printf ${pick(["'x\\0'", 'x', "'x\\n'"])} | xargs ${pick(['', '-0 ', '-n 1 ', '-0n 1 ', '-rn 1 ', '-I{} '])}${pick(depth ? NAMES : SPELT)}${rand() < 0.5 ? ' {}' : ''}`;
    if (r < 0.63) return `find . -maxdepth 1 -name x ${pick(['-delete', '-exec rm {} \\;', '-execdir rm {} +'])}`;
    if (r < 0.67) return `git ${pick(['', '-C . ', '-c a.b=c ', '--no-pager ', '--git-dir=.git '])}clean -fdx`;
    if (r < 0.7) return `rsync -a ${pick(['--delete', '--del', '--delete-after', '--remove-source-files'])} d/ e/`;
    return viaShell(depth < 1 && rand() < 0.25 ? payload(depth + 1) : del(false));
  };
  const out = [];
  for (let i = 0; i < n; i++) out.push(rand() < 0.15 ? inBody(payload(1)) : ctx(payload()));
  return out;
}

// What the harness's log says was started: a deleter (DEL), find with -delete, git clean, rsync --del….
const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
function unq(s) {
  const out = [];
  let cur = '';
  let any = false;
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === ' ') {
      if (any) out.push(cur);
      cur = '';
      any = false;
      i++;
      continue;
    }
    any = true;
    if (c === '\\') {
      cur += s[i + 1];
      i += 2;
    } else if (c === "'") {
      let e = s.indexOf("'", i + 1);
      if (e < 0) e = s.length;
      cur += s.slice(i + 1, e);
      i = e + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      let e = i + 2;
      while (e < s.length && s[e] !== "'") e += s[e] === '\\' ? 2 : 1;
      cur += s.slice(i + 2, e);
      i = e + 1;
    } else {
      cur += c;
      i++;
    }
  }
  if (any) out.push(cur);
  return out;
}
function started(log) {
  return log.split('\n').some((l) => {
    if (l.startsWith('DEL ')) return true;
    if (l.startsWith('RUN find ')) return unq(l.slice(9)).includes('-delete');
    if (l.startsWith('RUN git ')) {
      const a = unq(l.slice(8));
      let j = 0;
      while (j < a.length && a[j].startsWith('-')) j += GIT_VALUES.has(a[j]) ? 2 : 1;
      return a[j] === 'clean';
    }
    if (l.startsWith('RUN rsync ')) return unq(l.slice(10)).some((w) => w.startsWith('--del') || w === '--remove-source-files');
    return false;
  });
}

test('bash with the real programs is the judge: of the plain-sight generator\'s lines, none that started a deleter is missed', { timeout: 900_000 }, async (t) => {
  const bwrap = spawnSync('bash', ['-c', 'command -v bwrap']).stdout.toString().trim();
  if (process.platform !== 'linux' || !bwrap || spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', 'true']).status !== 0) {
    t.skip('bwrap cannot run here (macOS, Windows, a CI runner without user namespaces): the real programs are not run');
    return;
  }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-plainsight-')));
  try {
    // The stand-ins: deleters write down that they were started and delete nothing; find, git and rsync are logged and
    // then run for real; the passers that are not installed everywhere are small scripts.
    const sb = path.join(base, 'sb');
    fs.mkdirSync(sb);
    for (const f of fs.readdirSync(path.join(HERE, 'fixtures', 'delete-harness'))) fs.copyFileSync(path.join(HERE, 'fixtures', 'delete-harness', f), path.join(sb, f));
    for (const f of fs.readdirSync(sb)) fs.chmodSync(path.join(sb, f), 0o755);
    const extra = path.join(base, 'extra');
    fs.mkdirSync(extra);
    for (const f of ['doas', 'parallel']) fs.copyFileSync(path.join(sb, f), path.join(extra, f));
    for (const f of fs.readdirSync(extra)) fs.chmodSync(path.join(extra, f), 0o755);
    // The folder each line runs in: canaries and a git repository (git clean needs one).
    const tpl = path.join(base, 'tpl');
    fs.mkdirSync(path.join(tpl, 'd'), { recursive: true });
    fs.mkdirSync(path.join(tpl, 'home'));
    for (const f of ['x', 'y', 'z', 'f.txt', 'd/f']) fs.writeFileSync(path.join(tpl, f), 'canary');
    spawnSync('git', ['init', '-q', tpl]);
    // A real file to bind a stand-in over (a link there is bound through its target, or not at all).
    const exists = (p) => fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
    const binds = ['--ro-bind', '/', '/', '--tmpfs', '/home', '--tmpfs', '/tmp', '--tmpfs', '/mnt', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '--new-session'];
    for (const p of ['/usr/bin/find', '/usr/bin/git', '/usr/bin/rsync', '/usr/bin/ssh', '/usr/bin/busybox', '/usr/bin/coreutils']) if (exists(p)) binds.push('--ro-bind', p, `/mnt/r/${path.basename(p)}`);
    for (const p of ['/usr/bin/rm', '/bin/rm', '/usr/bin/gnurm', '/usr/bin/shred', '/usr/bin/gnushred', '/usr/bin/unlink', '/usr/bin/gnuunlink', '/usr/bin/truncate', '/usr/bin/gnutruncate', '/usr/lib/cargo/bin/coreutils/rm', '/usr/lib/cargo/bin/coreutils/shred', '/usr/lib/cargo/bin/coreutils/unlink', '/usr/lib/cargo/bin/coreutils/truncate']) {
      if (exists(p)) binds.push('--ro-bind', path.join(sb, 'del'), p);
    }
    for (const p of ['find', 'git', 'rsync']) if (exists(`/usr/bin/${p}`)) binds.push('--ro-bind', path.join(sb, 'wrap'), `/usr/bin/${p}`);
    for (const [from, to] of [['busybox', '/usr/bin/busybox'], ['coreutils', '/usr/bin/coreutils'], ['sudo', '/usr/lib/cargo/bin/sudo'], ['sudo', '/usr/bin/sudo'], ['su', '/usr/lib/cargo/bin/su'], ['su', '/usr/bin/su'], ['su', '/usr/sbin/runuser'], ['watch', '/usr/bin/watch'], ['sshw', '/usr/bin/ssh']]) {
      if (exists(to)) binds.push('--ro-bind', path.join(sb, from), to);
    }
    binds.push('--ro-bind', extra, '/mnt/extra');
    const all = plainSightLines(2000, 20261118);
    const distinct = [...new Set(all)];
    const runOne = (line, k) => new Promise((resolve) => {
      const run = path.join(base, `w${k}`);
      fs.rmSync(run, { recursive: true, force: true });
      fs.mkdirSync(path.join(run, 'log'), { recursive: true });
      fs.cpSync(tpl, path.join(run, 'w'), { recursive: true });
      fs.writeFileSync(path.join(run, 'log', 'log'), '');
      const args = [...binds, '--bind', path.join(run, 'w'), '/mnt/w', '--bind', path.join(run, 'log'), '/mnt/log', '--chdir', '/mnt/w', '/usr/bin/bash', '-c', line];
      const p = spawn('timeout', ['-k', '1', '4', bwrap, ...args], { stdio: ['ignore', 'ignore', process.env.HARNESS_DEBUG ? 'inherit' : 'ignore'], env: { PATH: '/mnt/extra:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/mnt/w/home', SHELL: '/usr/bin/bash', GIT_CONFIG_NOSYSTEM: '1', TERM: 'dumb', LANG: 'C.UTF-8' } }); // seal: a sandbox with a root of its own, its sudo and su bound to stand-ins
      p.on('close', () => resolve(fs.readFileSync(path.join(run, 'log', 'log'), 'utf8')));
    });
    let next = 0;
    let startedN = 0;
    const misses = [];
    await Promise.all(Array.from({ length: 6 }, async (_, k) => {
      while (next < distinct.length) {
        const line = distinct[next++];
        const log = await runOne(line, k);
        if (started(log)) {
          startedN++;
          if (!mayDelete(line)) misses.push(line);
        }
      }
    }));
    process.stdout.write(`# plain sight: ${all.length} generated, ${distinct.length} distinct lines run by bash with the real programs, ${startedN} started a deleter, ${misses.length} missed\n`);
    assert.ok(startedN > distinct.length / 2, `enough lines that started a deleter: ${startedN}`);
    assert.deepEqual(misses, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
