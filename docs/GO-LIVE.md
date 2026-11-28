# Go live

Several sessions finish their tasks, each on a branch of its own. Going live is the last step: the finished branches
are put together on one branch, the whole check runs on what was put together, and on your tap the project is updated,
checked to answer, and compared with what it was. When it is not right, one press takes it back.

It is the **Go live** tab of the Work page, and `hoprig ship` on the command line. Nothing here pushes, merges into your
default branch or tags: publishing stays your own press, separate, always.

## The steps

1. **Pick the finished tasks.** The list shows your project's local branches with work that is not in the default
   branch yet, `work/...` first, with the task's title where a Work run names it. You pick them and their order.
2. **Put them together.** They are merged one after the other, in your order, into one branch `work/<name>-all`, made
   from the default branch, in a folder of Hoprig's own (its state folder). Your own folder, its branches, its files and
   its settings do not move. When two tasks changed the same lines, it stops there and says which two tasks meet in
   which files. Nothing is forced: you can give the conflict to a coding session in that folder with one press (it gets
   both tasks and the files), and when it has committed the merge, **Go on** merges the next branch.
3. **Check.** The project's own check commands run on the branch that was put together, one check at a time on this
   computer, at low priority, and not while the computer is overloaded. The result is kept for that exact content:
   "ready", "failed" with the last lines it printed, or "passed 2 times and failed 1 time", never "passed" for that.
   Each check runs in a fresh folder of its own with the committed files only (what a session left beside them, and
   what is not committed such as `node_modules`, is not there: a check that needs packages installs them first, as
   `["npm", "ci"]`), and the folder goes when the check ends.
4. **Go live, on your tap.** The tap shows what will run. Then, in one step that survives a restart of the dashboard:
   a picture of the files you keep (which files, how many, how big, their hashes; never their contents), the update,
   the check that it answers, and the picture again. When both are right: "live since 14:05" in Work → Activity.
   When not, it says which check failed or which kept files changed, and **Take it back** runs your project's `back`.

**The limiter** (at the foot of Work → Go live): a list of words every check command runs behind, such as `["nice", "-n", "15"]`
or a script of yours that waits for a free place. It is confirmed like a command: the sheet shows the words, your yes
is for those, and a change asks again. Until it is confirmed, no check starts: the check stops with "confirm them
again there first", and you start it again after your yes.

## Your project's commands are someone else's words until you confirm them

The commands come from the project's `project.json`. They run on this computer as you, so they run only after you
confirmed **exactly those commands** for that project on this computer. The page shows them in full; the command line
asks on the terminal (there is no `--yes`). A changed command asks again, also one a task branch changed. Your yes is
kept in Hoprig's settings, sealed with a key of this computer: a settings file copied from another computer holds no
yes here. Neither the assistant, another computer, nor a token can give it, and the command line refuses to ask in a
shell that a coding tool or Hoprig started. What the yes does not do: stop a program that already runs as you on this
computer. Such a program can read the key and your settings as you can; the yes guards against copied settings and
runs nobody meant, not against that.

Your yes covers the **words** of the commands, not the files they run. The check runs the code of the branches that
were put together, also a test script a task branch changed: that is what a check is for. A live command runs the
scripts in the project's folder as they are at that moment, so after the update they are the put-together's. Write
`back` so that it checks out `{before}` first and then runs your scripts, as the example below does: then it runs the
scripts you had before.

## project.json

```json
{
  "check": [{ "run": ["npm", "ci"], "minutes": 10 }, { "run": ["npm", "test"], "minutes": 10 }],
  "live": {
    "update": [["git", "-C", "code/shop", "checkout", "--detach", "{commit}"], ["./restart.sh"]],
    "verify": [{ "url": "http://127.0.0.1:8080/", "status": 200, "seconds": 30 }],
    "back": [["git", "-C", "code/shop", "checkout", "--detach", "{before}"], ["./restart.sh"]],
    "keep": ["data", "~/.config/shop"]
  }
}
```

The check sees only the committed files, so this one installs the packages first (`npm ci`), then tests.

- A command is a **list of words**, run without a shell: `["npm", "test"]`, never `"npm test"` (a line of text is
  refused). Either the list itself or `{ "run": [...], "minutes": N }` with its time limit (check: 10 minutes unless
  set, up to 240; live: 5, up to 60).
- A `verify` entry is a command, or an address that must answer: `{ "url": ..., "status": 200, "seconds": 30 }`.
- In the words of a live command, `{commit}` is the put-together's last commit, `{branch}` its branch, `{tree}` the id
  of its content, `{before}` the commit your project was on before the update.
- Live commands run in the project's folder. `keep` names paths in it, or in your home folder as `~/...`.
- A server that an update starts sends its output where it wants it (`> run/server.log 2>&1`, as `restart.sh` below
  does). What it prints into the command's own output after the command ended is not kept: Hoprig holds that output
  to its last 64 KiB until the server ends, so it can never fill the disk.
- `"github": true` gives the live commands your GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`), for an update that fetches
  from a private repository. Without it they do not get it; a check never does, and no command gets a provider's key.
  It is part of what you confirm, and the sheet says which way it is.
- `"restarts": "hoprig"` says the update restarts this dashboard (Hoprig itself is known without it), `"turnSeconds"`
  how long a running turn is waited for (300 unless set), `"waitSeconds"` how long the dashboard may be away (120).

## A whole example: the project shop

`shop` is a tiny web server. Its folder holds `project.json`, a script `restart.sh` and the repository in `code/shop`:

```
shop/
  project.json
  restart.sh
  data/orders.json
  code/shop/          the repository: server.mjs, its tests
```

`restart.sh` stops the server it started last (its pid in `run/server.pid`) and starts it again:

```sh
#!/bin/sh
cd "$(dirname "$0")"
[ -f run/server.pid ] && kill "$(cat run/server.pid)" 2>/dev/null
mkdir -p run
nohup node code/shop/server.mjs > run/server.log 2>&1 &
echo $! > run/server.pid
```

With the `project.json` above, the server listening on `127.0.0.1:8080`:

```
hoprig ship status shop                          the finished task branches
hoprig ship together shop tuesday work/cart work/prices
hoprig ship allow shop check tuesday             shows the check command, asks
hoprig ship check shop tuesday                   ready (1 passed, 0 failed)
hoprig ship allow shop live tuesday              shows update, verify, back and keep, asks
hoprig ship live shop tuesday                    shows what runs, asks, then: Live since 14:05.
hoprig ship back shop                            if it was not right: the same checkout with {before}, restarted
```

When `work/cart` and `work/prices` changed the same lines, `together` stops and names the files; resolve it in the
folder it names (or from the page, with a session), commit the merge, and run the same `together` again.

## Hoprig updating itself

Hoprig is a project like any other, whose update restarts the dashboard that runs the step. Before the update, the step
starts a small helper of its own. The dashboard that comes back finishes the step (the check that it answers, the
picture). When no dashboard comes back within the time limit, the helper runs the confirmed `back` (checked again
against your yes) and writes what happened. Never both.

Before such a restart it looks at what the restart would end: a turn of the assistant or of an App session that is
still running is waited for; what would still end after that, and every built-in terminal session (a restart always
ends those; tmux sessions live on), is named before the tap, and the tap says **Restart anyway**. Such a project goes
live from the page only, which can see those sessions.

## By itself, only where you typed it

"Go live by itself when the check passes" is a switch per project, off until you type the project's name, with hours
(09:00 to 18:00 unless you change them). With it on, a check that passes is followed by the go-live without the tap:
only inside the hours, once per put-together, never for one that also failed, never cutting a running turn (it waits,
and after the limit it says why and does not go live), and never while a command pushes or publishes (`git push`, `gh`,
`npm publish`). Nothing starts a put-together or a check by itself. Without an open step and without a switch on,
nothing of this reads a project or runs a program.

## When something is cut off

Each part of a step is written down before it begins, next to a lock in the repository's own git folder (never in its
files), so two go-lives of one project never run at once, also from two dashboards. A step cut off (a crash, a kill, a
restart) is finished by the next look: the dashboard's start, the page, or `hoprig ship status`. Cut before the update:
closed as "did not start", nothing ran. Cut while an update command ran: that command runs on, and the next look
waits for it (at its time limit it is ended with everything it started); then the step is checked and compared again
and closed as "the update was cut off", which names the commands that did not run, with the offer to take back. Cut
after the update: checked and compared again, then "live" or the offer to take back. "Live" is only ever said after
the whole update and the check that it answers. A project whose update restarts the dashboard has the restart as its
last update command: a cut there is the restart, and the dashboard that comes back finishes the step.

## Commands

```
hoprig ship status <project> [--json]
hoprig ship together <project> <name> <branch>...
hoprig ship check <project> <name>
hoprig ship allow <project> check|live|limiter [<name>]
hoprig ship live <project> <name>
hoprig ship back <project>
hoprig ship auto <project> on|off [--from HH:MM] [--to HH:MM] [--back on|off]
hoprig ship drop <project> <name>
```

A put-together that cannot finish (a branch that is gone, a conflict nobody resolves) keeps the picker away until it
is dropped: **Drop this put-together** on the page, or `hoprig ship drop`. Its branch and folder stay.
