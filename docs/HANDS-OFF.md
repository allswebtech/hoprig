# Hands-off

What a coding tool asks you is shown as the tool asked it, and, when you turn Hands-off on, Hoprig can answer some of
it for you so the work goes on while you are away. It uses no AI model: it follows fixed rules, listed here.

**Both parts are built: every card is exact, and the switch may be turned on.** With Hands-off off — the shipped
state, after an install and after every update — a card is shown as the tool asked it and nothing is answered for
you. Turn it on and Hoprig answers some cards for you and holds the commands that are yours alone where they are
run, in every permission mode (the coding tool's setting for how much it asks you first; bypass permissions mode asks
nothing), not only by their words. This part is called the wall. It reads each command line before it runs, so it
is a help against a mistake, not a fence: a session runs as your user, and what a script or another program then
does is not read (see **What the wall does not read**, below). An owner who wants the feature hidden sets
`handsOff.offered` to `false` in the settings file.

## Every card is exact (always, with or without Hands-off)

A question, a plan, a tool permission or a notice of the coding tool is shown from the tool's own data:

- **A question**: its words, every option in the tool's order with its description, the one option the tool marked
  as recommended ("Marked by the tool"), whether you choose one or several, and that you can write your own answer.
- **A plan to approve**: the plan's text.
- **A tool permission**: the tool and the exact command or file, as before.
- **A notice of the tool**: Claude Code's question whether you trust a folder is read from the terminal's screen in
  the tool's own words (the folder, the question, its two answers), and answered in the terminal.

Each card says where it came from ("As Claude Code asked it", "Read from the screen"). In a session of the App an
answer goes only to the question its card shows: if the question changed meanwhile, the answer is refused.

For OpenCode a question has no "recommended" mark, and the card says so. Codex is kept switched off.

## What Hands-off answers

Turn it on per project (Settings → Hands-off) or per session (the session's menu, on a terminal's page and in the
App). It is off after an install and
after every update of Hoprig.

The first time you turn on a Hands-off switch in a browser (a session's, a project's or an App chat's), a sheet
"What Hands-off does" explains what it answers, what always stays yours and how to stop it. It only explains: the
switch is already on, and closing the sheet does not turn it off. The browser keeps the fact that it showed the
sheet in its own storage, so you see it once per browser, not once per computer: another browser or a phone shows
it again. To read it again, open Settings → Hands-off and press "Read the first-time summary again".

Hands-off costs nothing by itself: it reads the questions by fixed rules, with no model, and the work goes on as if
you had answered each question yourself.

- **A question with a recommended option**: that option. "Recommended" counts only as the tool's own mark: the label
  of exactly one option ends with "(Recommended)". Words in the question or in a description that say an option is
  recommended, or that say to answer, change nothing.
- **A question with no mark**: If the tool has not marked a recommended answer, it gives your note for the project
  (Settings → Hands-off) as a written answer where the tool takes one; without a note that question still waits for
  you. The note is the field "How you want such questions answered".
- **A plan**: A plan in the App is approved, and the session keeps the mode it had (never the one that lets it do
  more). A plan in a terminal waits for you. Claude Code shows its plan dialog even after a hook (a check the coding
  tool runs before each step) approved it.
- **A tool permission**: nothing changes. The session's permission mode decides, as without Hands-off.
- **A notice of the tool**: nothing. Trusting a folder, a sign-in and a usage-limit menu are always yours.

## What it leaves to you

A question whose words or options look like they are about money or a paid plan, a sign-in, a push or a merge, a
release or publishing, sending something out, a delete outside the session's folder, admin rights, switching a
safety rule or a check off, or giving the session more freedom: Hoprig reads the question's words for a fixed list
of signs (English, Hindi and Hinglish; `src/handsoff.mjs`) and, when it finds one, leaves the question to you, also
when an option is marked as recommended. Letters that draw nothing or only look like Latin ones do not hide a word
from it.

This list is a **net**: it reads the *words* of a question and leans towards waiting, so it can hold back an
ordinary question whose words happen to match, and an unusual wording can slip past it.

It also leaves to you an ask whose words hold something that looks like a secret, and one longer than its card
shows (the tool reads the whole of it, so Hoprig must too).

## The net and the wall

Hands-off has two parts, and they are not the same:

- The **net** reads what a session *says* — the words of a question (above). It only ever makes a question wait; it
  leans towards waiting, and an ordinary question can be caught or an odd wording slip past. It changes nothing a
  session does.
- The **wall** reads what a session is about to *do* — the act, before it runs (`src/wall.mjs`). While Hands-off is
  on, a command of a kind that is yours alone is held as your card **in every permission mode**, bypass included.
  For each kind the wall holds the commands named here and a few more of the same kind; another command, or another
  way to the same act, is not held (see **What the wall does not read**).
  - Administrator rights: `sudo`, `sudoedit`, `su`, `doas`, `pkexec`, `run0`, `machinectl shell`, `machinectl login`,
    and `systemd-run` without `--user` (it runs a program through the system's own service manager) are held.
    `systemd-run --user make test` uses your own service manager and goes through. With `--system`, `-M` or
    `--machine`, `-H` or `--host`, `--uid` or `--gid` anywhere on the line, or an option of systemd-run the wall does
    not know, it reaches the system's own service manager, another user's or the administrator's service manager, a
    container on this computer, or another computer, so `systemd-run --user --system id`,
    `systemd-run --user -M root@ id` and `systemd-run --user --uid=root id` are held. The command it runs is still
    read: `systemd-run --user sudo su` is held.
  - Publishing or releasing, or changing what is already published: `npm publish`, `pnpm publish`, `yarn publish`,
    `cargo publish`, `twine upload`, `gem push`, `docker push`, `podman push`, `nerdctl push`, `gh release create`,
    `gh release upload v1 x.tgz`, `gh release edit v1 --draft=false`, `glab release create v1`,
    `glab release upload v1 x.tgz`, `poetry publish`, `uv publish`, `bun publish`, `flit publish`, `hatch publish`,
    `dotnet nuget push shop.1.0.0.nupkg`, `helm push shop-1.0.0.tgz oci://example.com/charts`, `vsce publish`,
    `ovsx publish`, `npm unpublish shop@1.0.0`, `npm deprecate shop@1 "use 2"`, `npm dist-tag add shop@1.0.1 latest`,
    `pod trunk push Shop.podspec`, `dart pub publish`, `flutter pub publish`, `mix hex.publish`, `mvn deploy`,
    `gradle publish` and `./gradlew publish` are held. Reading a release goes through: `gh release view v1` and
    `gh release list`.
  - A pull or merge request, made or merged: `gh pr create`, `gh pr merge`, `glab mr create` and `glab mr merge` are
    held.
  - A direct call to GitHub or GitLab that can change something there: `gh api` and `glab api` are held when the call
    is not a plain read, that is when it names a method other than GET or HEAD (the two ways of asking that only
    read), sends a field (a value set with the call) without naming one of them, or sends an input (a file sent as
    the request body) whatever it names: `gh api -X POST repos/o/r/pulls` and `gh api repos/o/r/issues -f title=x`
    are held. A plain read, `gh api repos/o/r/pulls`, goes through, and so does a call that names GET, whose fields
    only narrow what it reads: `gh api -X GET search/issues -f q=bug` goes through. A call that names HEAD reads as
    one that names GET does: `gh api -X HEAD repos/o/r/pulls` goes through. A call to the GraphQL endpoint
    (`gh api graphql`, also written `/graphql` or as a full address) is held whatever method it names, since there
    a read and a change differ only in what the call sends: `gh api -X GET graphql -f query=x` is held. So is a call
    that sends a field to an address written with a variable that may make it that address:
    `gh api -X GET "$EP" -f query=x` and `gh api -X GET "$BASE/graphql" -f query=x` are held. A plain read of such an
    address, `gh api "$EP"`, goes through, and so do a call whose written address names another path,
    `gh api -X GET "search/$KIND" -f q=bug`, and a variable that is only a field's value,
    `gh api -X GET search/issues -f q="$Q"`.
  - A push that would move a default branch (the main line of the project, usually `main`) or a tag (a fixed name
    for one version), or a merge or rebase that would change the default branch (made while standing on it), is held
    (asked of git itself, never read from the words). On a work branch, `git merge main` and `git rebase main` change
    only the work branch and go through.
  - A push that deletes branches of the other copy is held: a pruning push (`git push --prune origin`: it deletes
    the branches of the other copy that yours does not have), and a push that deletes a branch by name
    (`git push origin --delete feature`, `git push origin :feature`).
  - A change to the project's own `project.json` (its settings file for Hoprig), such as
    `cp draft.json project.json`, is held.
  - A delete outside the session's own folder is held.
  - A move, a write or any touch of Hoprig's own files is held.

  A line the wall cannot read with certainty is held, not let through. Where a repository has no known default
  branch (made with `git init` and `git remote add`, so it has no `origin/HEAD`: the record, kept in the repository, of
  which branch the server calls its default), the wall cannot tell which branch is the default, so **every** push
  there is held — a work branch's too (`git push origin feature`) — and the wall says so, with the one command that
  tells it: `git remote set-head origin -a`.
- A **mission's** run (`src/work/alone.mjs`) stands beside the wall, not under it: it is always started in the coding
  tool's restricted mode with the file tools only, and, for a work or fix run on a computer whose box says yes, the
  one tool `run_tests`, which runs the project's own test command in the box and no command of its own. It has no
  shell, no git and nothing that reaches the network, so it can run none of the commands the wall holds, and the wall
  never meets one.

Some words of the shell are used below. A script is a file of commands that a program runs. An interpreter is a
program that runs a script's text (Python, Node). A variable is a name that stands for a value filled in when the
line runs (`$BRANCH`). An alias is a short name you gave a longer command. A heredoc is text handed to a command over
several lines, ended by a word of your choice (its delimiter). A command substitution puts the output of one command
into another line. A refspec is the part of a push that names the branch. A glob is a pattern such as `*.txt` that the
shell turns into file names. A brace list is a list of names in braces, such as `{a,b}`, which the shell turns into
one word for each name. `cd` changes the folder the shell stands in; `pushd` does the same and remembers the folder
before. `~` and `$HOME` both stand for your home folder. `xargs` runs a command once for each word it is given.

**What the wall does not read.** It reads the command line a session hands its shell, and the path a file tool
would write. So this list is why the wall is a help against a mistake, not a fence: a session that sets out to hide
a command from it can. It does not read:

- what a script file holds: `bash fix.sh`, `./build.sh` and `source steps.sh` run whatever the file says, and go
  through (only a script whose name says it deploys is held, below);
- the program text handed to an interpreter: `python3 -c "import os; os.system('npm publish')"` and
  `node -e "require('child_process').execSync('npm publish')"` go through;
- a command fed to a shell or a scheduler as text, on its input or in a file: `echo "npm publish" | sh`,
  `sh < steps.txt`, `echo "npm publish" | at now` and `crontab steps.cron` go through;
- a tool for the same act other than the ones named above, such as a project's own publishing script under an
  unusual name, or a release made on a web page outside the session;
- a git alias: `git p` goes through, whatever `p` stands for;
- a short path to Hoprig's own folders after a `cd` whose target the wall cannot tell (another variable, or
  `cd -`, which goes back to the folder before): `cd $DIR && cat .config/hoprig/config.json` goes through, because
  the wall does not know which folder the shell then stands in;
- the value of a variable in an argument of a command other than a push or a delete: what `cat "$FILE"` reads is
  not known to the wall, and it goes through (a delete whose target is a variable, `rm -rf "$DIR"`, is held, since
  where it lands is not known);
- the other computer of a command run through `ssh`: `ssh box2 npm publish` is held, but a push there is judged by
  the repository here, so `ssh box2 git push origin feature` goes through;
- the coding tool's tools other than its shell (Bash) and its four file tools (Write, Edit, MultiEdit, NotebookEdit):
  Read, Grep and Glob only read, and a read of Hoprig's own files through them goes through;
- anything on Windows: there the wall's hook cannot run, so Hands-off is not offered at all.

**What it reads.** A program the wall knows in front of a command does not hide it: `timeout 60 npm publish`,
`nice -n 5 gh pr create`, `strace -f npm publish`, `FOO="a b" npm publish`, `if true; then npm publish; fi`,
`flock /tmp/l -c 'npm publish'`, `sh -c "npm publish"` and `eval "npm publish"` are held as `npm publish` is. In
bypass permissions mode, a delete inside a quoted command that such a program runs is asked of you first, also when
a variable is set in front of that program on the same line (`X=1` or `X+=1`, also with a value written with a
sign, `X=$HOME/out`), when an element of a list (an array) is set there, whatever stands between the brackets
(`A[0]=1`, `A[$i]=1`, `A["k"]=1`, `A[i + 1]=1` or `A[$(id -u)]=1`), and when the host or the user that program
is given is written with a variable. Nor
does a package runner (a program that fetches a tool and runs it, such as `npx`), an environment loader (a program
that sets values for a command and then runs it, such as `cross-env`) or a tool's own runner (a tool's own command
that runs another command in the project's setting) hide it: `npx npm publish`,
`cross-env A=1 npm publish`, `uv run twine upload dist/*`, `poetry run twine upload dist/*` and
`bundle exec gem push shop-1.0.gem` are held as the command behind them is, and `python3 -m twine upload` is held
as `twine upload` is (`-m` runs a module, a part of a program, as its own command). An ordinary line behind one goes
through as it does without it: `npx vitest run`, `uv run pytest` and `python3 -m pytest -q` go through. A
delete is judged by where it lands: `rm -rf build` in the session's folder goes through, `rm -rf ../blog` is held.
Hoprig's own folders are found when the path is written in full, from `~` or `$HOME`, with a `..` or with a doubled
separator, and a read there is held too, since the wall cannot tell a read from a write:
`rm -rf $HOME/.config//hoprig/`, `cat ../.config/hoprig/config.json`, `cat ~/.config/hoprig/config.json` and a
move of a folder that holds them, `mv ~/.config ~/old`, are held. A path with a wildcard (`*`, `?` or `[...]`, the
signs of a glob) or a brace list in a folder's name is held too when it could name one of them, also when the
wildcard stands in a folder above: `cat ~/.config/hop*/config.json`, `cat ~/.config/[h]oprig/config.json`,
`cat ~/.conf*/hoprig/config.json` and `cat ~/.config/{hoprig,other}/config.json` are held. A short path after a
`cd` or a `pushd` whose target the wall can tell (a plain path, a bare `cd`, `~` or `$HOME`, also with braces or in
double quotes, or a path with `..`) is read from the folder the shell then stands in:
`cd ~ && cat .config/hoprig/config.json` and `cd $HOME && cat .config/hoprig/config.json` are held.

**Where it cannot tell which command would run, it holds the line.** A variable standing as the program
(`$EDITOR notes.txt`) is held. The same variable in double quotes is the same program: `"$EDITOR" notes.txt` is held
too. A program word that ends in a variable behind text is held as well: `./run-$TARGET.sh` is held. Text with a path
separator after the last variable writes the program's name out, so `bin/$TOOL/run` goes through. More text behind a
variable in an assignment's value is only part of that value: `FOO=$A$B npm test` goes through, and the program
behind it is still read, so `FOO=$A$B npm publish` is held. A push or a merge after a change of folder or aimed at
another repository is held (`cd ../blog && git push origin feature`, `git -C ../blog push origin feature`), since
which repository it would move is not known. A push whose remote or branch is a variable is held as well
(`git push origin $BRANCH`), since where it would go is filled in only when the line runs.

**Known limits of the wall's reading (reading a line is not running it, so a few forms go through unheld):** a
command substitution `$( … )` or a backtick is held, because its value could be any program, and so is a heredoc
with an unquoted delimiter, whose body the shell would expand. One exception is a push of the branch the session
stands on: in `git push origin "$(git branch --show-current)"` and
`git push origin "$(git rev-parse --abbrev-ref HEAD)"`, with or without the double quotes, the substitution is read as
`HEAD`, so such a push goes through on a work branch and is held on the default branch, as a push of HEAD is. The other
is the form a coding tool writes a commit in, a heredoc whose delimiter stands in quotes: there the body is literal text
and no command runs, so this reads as an ordinary commit and goes through:

```sh
git commit -m "$(cat <<'EOF'
Fix the build
EOF
)"
```

The same with an unquoted delimiter (`<<EOF`) stays held. But the reader keys a program on its name, so `git`
reached through a renamed or copied binary (`mygit push`, `cp git g && ./g push`) is not recognised as git and such a push goes
through; and an `xargs -I` whose refspec is substituted at run time is read with its placeholder, not its value, so
`echo main | xargs -I REF git push origin REF` goes through too. (A command line a program is handed as its text is
read like any other: `env -S "sudo su"` is held.) A deploy script is held when its name begins with
*deploy*, *release* or *publish* and it is run by `npm run`, `make`, its own path, a shell such as `bash` or an
interpreter (a program that runs a script's text, like Python): `npm run deploy`, `make release`, `./publish.sh`,
`bash deploy.sh`, `python3 deploy.py`, `node scripts/release.mjs`, `deno run -A deploy.ts` and `bun run deploy` are
held. Other scripts go through (`node scripts/build.mjs`, `python3 manage.py test`), and so does a deploy script
under an unusual name (`npm run ship` and `make ship` go through). A test file an interpreter runs
(`node scripts/release.test.mjs`, `python3 deploy_test.py`) and node's own test runner (`node --test`) run the
tests, not a deploy, so they go through. A script that writes release notes is not a deployment, so an
interpreter running one goes through: `node scripts/release-notes.mjs` and `python3 scripts/release_notes.py` go
through. All of these need the session to set the
evasion up on purpose; they are conscious tradeoffs of reading a line without running it. A
delete after a `cd` is judged against the folder the `cd` lands in, but for a delete only a `cd` to a single plain
path word is followed (narrower than the follow for Hoprig's own folders above); a bare `cd`, a quoted or variable
or glob target, `cd -`, a `cd` with an option, and `pushd`/`popd` or an `env -C` leave the folder unknown, so a
delete after them stays held.

## Seen and stopped

- Every answer is shown where it was given, with its time: "Answered by Hoprig 12 min ago: npm (Recommended),
  because the tool recommended it" or "… from your note for this project", and it is one line in Work → Activity.
- One press on "Stop Hands-off" on the session, or turning the project's switch off, stops it at once: no answer
  starts after the press.
- Three answers in a row with no work between them (no edit, write or command that went through, no message of
  yours; a read or a search is no work) stop it for that session until you turn it on again. So do ten answers
  within an hour, whatever came between. Turning it on again starts the hour again.
- A stop ends the **answers**, not the **wall**. A stop is Hoprig's own doing, not your choice to hand the session
  back: you left with Hands-off on, so a command of a kind that is yours alone still waits for you as your card until
  **you** turn the switch off. The session's bar says so while it is stopped. (Only turning the switch off, on the
  session or the project, lets those commands run by the session's own permission mode again.)
- Hands-off is a help for your own sessions, not a fence around them. A session's commands run as your user and could
  write Hoprig's files like any other file of yours (as they could run what they ask about). Hoprig does not take the
  switch, or which session's and project's switch counts, from the record it hands the session.

## A move to another provider, and what it does not carry

Continuing a session on another provider after a usage limit keeps its Hands-off state: the owner's own switch for
it, the hour stop and the loop stop, the hour's count and the hour's answers. This holds for the dashboard's move
(the page, Auto mode at a limit, the Operator's limit rule, the watcher, the automation queue) and for the launcher's
own move — the one it makes in its own process, and the one the owner picks at its "Continue it on another
profile?" menu.

A start of an existing conversation that is **not** that move — reopening a session after a reboot (the restore
automation), opening a coding chat in a terminal, or taking a terminal session into a chat — cannot carry the old
run's Hands-off state. So the new run starts **off**, whatever the project's switch says: it answers nothing until
you turn Hands-off on for that session (its bar says so). It is never the other way round — a session is never
answered for on a start that could not read what you had chosen. The wall still holds on it by the project's switch
while it is off, so what is yours still waits for you.

Two starts Hoprig cannot make off, said plainly:

- A move or a start where the dashboard and the launcher are **different installs** (a dashboard updated before the
  launcher's files, or a `launcher` set in the config that names another copy). The older launcher does not read the
  hand-over or the reset, so it starts a new run that follows only the project's switch — which may be on. An ordinary
  update replaces both together, so this lasts only until the next launch.
- A dashboard that is **stopped in the middle of a move**. Here nothing is lost: the new run, if its launcher had
  started, already carries the move's stops (they travel in the launch file, written before the launcher runs); if it
  had not started, the old run stays as it was. When the dashboard starts again it clears the move's leftover mark, so
  the old run is not left silenced. The dashboard cannot reach into that new run to set it off, because the link from
  the old run to the new one lived only in the dashboard's memory; it does not need to, since the stops were carried.
