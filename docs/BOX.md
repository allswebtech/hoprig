# The box

Some commands are written by a coding session: the tests it wrote, a script it made. Run on your computer as you, such a
command could read your sign-in files and keys and send them out. Hoprig never runs what a session wrote outside the
box by itself. The box runs one command with **no network**, **without your home**, seeing **only the folders it is
given**.

```
hoprig box check            # does this computer have a box? (exit 0: yes, 3: no)
hoprig box run --write . -- npm test
hoprig box run --write . --read /opt/toolchain -- make check
```

`hoprig box run` ends with the command's own exit code. After 30 minutes it stops the command with every process it
started (exit 124). When nothing ran (no box, a wrong option), it says why in one line and ends with 3.

What Hoprig itself runs in the box: a mission's tests gate, and your own "Run the tests in the box" on a task's card
([WORK.md](WORK.md), Missions).
A mission's session may also run the project's own test command there while it works, through its one tool
`run_tests`, never a command of its own ([WORK.md](WORK.md), Missions).

`hoprig doctor` shows one information line about it. A computer without a box is not broken: the line says what would
give it one.

## When there is no box, nothing runs

Before the first command, and again when ten minutes have passed, the box tests itself inside the real box on this computer (see
"The self-test"). Only that yes, kept in the memory of the running program, lets a command run. When the box cannot be
made (no bubblewrap, a failed self-test, a failed start, a folder that is not there, a wrong option), the command does
not run at all. There is no fallback, no "run it anyway", and no setting or variable that switches the box off.

## What the box hides

- **Your home.** Neither the home of your user account nor the folder `HOME` names is there. A folder you name may lie
  inside your home: then only the path down to it is there, nothing beside it. The box has an empty home of its own,
  `/home/box`, and an empty `/tmp` of its own, both in memory and gone when it ends.
- **The rest of the disk.** The box is an allow list, never the whole disk minus a list. On Linux it holds only:
  `/usr` read-only (and `/bin`, `/lib`, `/lib64`, `/sbin` as the same links, or read-only folders, they are on the
  computer); from `/etc` only `ld.so.cache`, `ld.so.conf`, `ld.so.conf.d`, `alternatives`, `localtime` and
  `nsswitch.conf`, plus a `passwd`, `group` and `hosts` of its own (its own user, `localhost` only); a small `/dev` and
  its own `/proc`; the folder of the Node.js that runs Hoprig, read-only; and the folders you name, `--read` read-only
  and `--write` writable, at their own paths. Not `/home`, `/root`, `/run`, `/var`, `/mnt`, `/media`, `/opt`, `/nix`
  or a Linux Homebrew: a toolchain there is named with `--read`. The current folder must be inside a named folder.
  The whole disk, a home, or a folder that holds a home is refused as a named folder.
- **The network.** The box has a network of its own with nothing but its own loopback: no address outside, none of
  this computer's own services (not on the loopback, not on its own address), and no socket of your session (an ssh
  agent, the desktop bus, tmux, a container service): the folders those live in are not there, and abstract socket
  names are not shared.
- **Your processes.** The box sees only its own processes and cannot signal any other. It gets no new rights, has no
  terminal of yours (it cannot type into it), and ends when the program that started it ends. At the timeout its whole
  tree of processes ends, by the box's own means (its process group, and its own process space, whose end takes every
  process left), never by a name.
- **Your environment.** The command gets `PATH` (the folder of Node.js first, then `/usr/local/bin:/usr/bin:/bin`),
  `HOME=/home/box`, `LANG` (yours when it is a plain locale name, else `C.UTF-8`), `TERM=dumb`, `CI=1`, and the
  names the caller gives (capitals, digits and `_`; never `HOME`). bubblewrap also sets `PWD` to the current folder.
  Nothing else of your environment: no keys, no tokens.
- **Your git hooks and settings.** A hook or a setting written into a repository's git folder would run later, when
  git runs there outside the box. So the `.git` of each `--write` folder is read-only inside; for a worktree, its
  `.git` file, and the git folder and common folder it names when they lie inside a named folder, are read-only too.
- **Links that point outside.** A link in a named folder whose target is not in a named folder leads nowhere inside.
  A project whose `node_modules` is a link to another place therefore gets it only when that place is named with
  `--read`.
  A named folder whose path goes through a link of your own (one a command could have left in an earlier run) is
  refused: name the folder the link points to instead. Links of the system, owned by root, are followed.
  A named folder is one place however its path is written: the folder that is bound is the one the check walked to,
  and a path that reads to another place than it walks to (`..` after a part that is not there, or after a link) is
  refused.

## What the box does NOT promise

- **It is not a virtual machine.** It is built from the kernel's own separations (Linux namespaces, through
  bubblewrap). A fault in the kernel is outside what it can hold.
- **Code inside can use the processor and the memory, and fill its `--write` folders.** There is no limit on the
  number of processes (a limit per user would hit your other programs); the timeout ends them all.
- **It can read what the listed system folders hold:** everything under `/usr`, and the few names of `/etc` above.
- **It can read the whole folder of the Node.js that runs Hoprig,** globally installed npm packages and their files
  included. Only that folder's own `etc`, where a global npm settings file (an `npmrc` with a token) could sit, is
  hidden behind an empty folder.
- **A `.git` deeper inside a `--write` folder than its top is not made read-only.** Name such a repository's folder
  itself with `--write`, or keep it out of the box.
- **A `.git` a command makes inside a `--write` folder that had none when the box started is not held read-only**
  (there is nothing to bind over at that point). So the product never runs git by itself, outside the box, in a folder
  that had no `.git` before a boxed command ran there.
- **A named folder is checked when the run is planned, a moment before the box starts.** A folder that something
  else replaces by a link in that moment is not seen again. A command inside a box cannot do that to the folders
  named for it (it cannot rename or replace a folder it is bound in). So whoever calls the box names only a folder
  that no running command can reach from outside it: the top of the folder the run works in, or a folder that
  nothing a box wrote in can change.
- **Output is kept up to a limit** (1 MB for `hoprig box run`); the rest is counted, not kept.

## Why a set-user-id program cannot raise rights inside

Every process in the box runs with the kernel's "no new privileges" flag (`NoNewPrivs: 1` in `/proc/self/status`) and
with every capability dropped. With that flag the kernel ignores the set-user-id and set-group-id bits of a program and
its file capabilities: a program such as `sudo` starts as the same user without any added right, and fails. The box
also cannot make a new user space of its own, so it cannot get new capabilities that way.

## The self-test

The box is tried for real before it says yes, with the same plan, the same arguments and the same starter a command
gets. Each trial uses made-up files the test wrote in its own temporary folder, never a file of your home:

- a made-up file in a home cannot be read;
- the real homes are not there (or hold nothing but the path to a named folder);
- a made-up file outside the named folders can be neither read nor written;
- a listener the test opened on a free port, on the loopback and on this computer's own address, cannot be reached;
- a process the test started outside cannot be seen;
- the `--write` folder can be written.

One failing trial is a "no", with that trial named.

## Per system

- **Linux:** bubblewrap (`bwrap`), at `/usr/bin/bwrap` or `/bin/bwrap`, owned by root and writable by root only (it is
  never looked for on `PATH`). Install it with your system's packages, for example `sudo apt install bubblewrap`.
  Version 0.8 or later is needed. On some systems (Ubuntu 24.04 and later) the kernel refuses unprivileged user
  namespaces by default (`sysctl kernel.apparmor_restrict_unprivileged_userns` returns `1`), so bubblewrap cannot make
  its spaces until an AppArmor profile grants it one. On Ubuntu that profile ships in the `apparmor` package as
  `/etc/apparmor.d/bwrap-userns-restrict`: install the package if it is missing, check the profile is loaded with
  `sudo aa-status | grep bwrap`, and load it with `sudo systemctl reload apparmor` if it is not. `hoprig box check`
  says when this is what a computer needs.
- **macOS:** `sandbox-exec` with a profile Hoprig writes for each run: deny by default, the same allow list, the git
  folders denied for writing, no network, signals only to its own processes, and a real temporary home and `/tmp`
  removed afterwards. The profile's text is tested; **the box has not yet been run on a Mac**, and there the self-test
  decides.
- **Windows:** no box yet. Run Hoprig inside WSL 2 and install bubblewrap there.

## What it costs

Measured on one Linux computer (16 processor cores, Node.js 26, bubblewrap 0.11), twenty runs each, median and slowest:

| Command | Without the box | In the box |
|---|---|---|
| `/bin/true` | 3.2 / 4.0 ms | 14.5 / 17.2 ms |
| `node -e 0` | 35.5 / 41.0 ms | 43.7 / 48.6 ms |

The self-test takes about 90 ms and runs at most once every ten minutes within one running program. Each `hoprig box
run` from the command line is a fresh program that checks the box first (about 70–90 ms), so one such run costs about
a quarter of a second, not the box's own 15 ms. The numbers above are `runBoxed` with the box already checked.
