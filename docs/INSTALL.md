# Install Hoprig

## Quick start

**1. Install.** Open a terminal and paste one line.

Windows: press the Windows key, type PowerShell, press Enter, paste this line and press Enter.

```powershell
irm https://raw.githubusercontent.com/allswebtech/hoprig/main/install.ps1 | iex
```

Mac: press Command and Space, type Terminal, press Enter, paste this line and press Enter.

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
```

Linux: press Ctrl+Alt+T, paste this line and press Enter.

```sh
wget -qO- https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
```

**Windows, macOS and Linux.** The install line and the whole test suite run on GitHub's Windows, macOS and Linux
machines (the Windows test jobs are still allowed to fail), and the first run was walked on Windows four ways: a new
PC with scripts off, scripts allowed, an administrator window, and Git missing. Windows is new here, and a real home
Windows PC has seen less of Hoprig than a Linux computer has: the background service (Task Scheduler), winget and a
restart of the service were not run on one. Two things work differently on Windows: a go-live command ended at its time
limit also ends a server it started in the background (on Linux that server goes on running), and a scheduled run whose
coding tool could not be ended switches its schedule off until you switch it on again in Work → Schedules. Hands-off and
the box are not offered on Windows.

**2. Your browser opens.** Nothing is asked on the way. At the end Hoprig opens in your browser, already signed in, with one card, **Welcome to Hoprig**: press **Sign in** to sign in to Claude, then **New project** (or **My own folder**), and tell Claude what to make. (To use it from your phone, turn that on later in Settings → Security and sign-in.)

That's it.

> Not published yet? Point the installer at a copy: `HOPRIG_SOURCE=/path/to/hoprig-0.1.0.tgz sh install.sh`
> (a `.tgz` from `npm pack`, a folder, or a git URL).

---

## More

### What the one run does

The install line first says what is missing (Node.js 24.13.1 or newer when it is missing or older, and on Linux the
build tools and a few system parts, with sudo) and installs it without asking; sudo asks for its own password and
Ctrl-C stops it. On Windows an existing Node.js that is new enough is used; otherwise the official Node.js zip is
unpacked into your own folder after a checksum check (no administrator and no winget), and Git for Windows is added
with winget only when it is missing (Windows may ask once to allow a change). It was run from a packed build, as a plain user with sudo, on arm64 in Debian 12, Fedora 45, Alpine
3.24 and Ubuntu 24.04 containers, up to a dashboard whose sign-in page answers (Alpine uses its own Node.js 24, the
others get Node.js 26 through nvm). Arch, openSUSE and RHEL are written, not run.

The installer ends in `hoprig setup`. On a computer that has no Hoprig settings yet (the first run) setup is quiet: it
asks nothing, shows one tick line for each thing it does, and does only what a first chat needs:

1. **Node.js, Hoprig and Claude Code.** Claude Code is installed for you, without a question, when it is missing. A
   Claude sign-in that is already there on this computer is found and not asked for again.
2. **The dashboard**, kept to this computer only (nobody else can open it), with a password made for you and kept in
   a private file, running in the background so that it starts with the computer (on Windows with Task Scheduler and
   a Start menu entry **Hoprig**, on Linux with an app-menu entry **Hoprig**).
3. **Your browser opens**, signed in by a link that works once, and says "You can close this window". If it did not
   open, the line above it is the link. Coming back another day, use the **Hoprig** entry of the Start menu or the
   app menu.

Everything that used to be asked in the terminal is on a page now, when you want it:

| What | Where |
|---|---|
| Sign in to Claude, or pay as you use | the card on Home (**Welcome to Hoprig**), later **Providers** |
| The first project | **New project** or **My own folder** on that card, later **Workspace → New project** |
| This computer ready for coding (git, Node.js, Python, `gh`, tmux, the rest) | **Computers**, open the computer, **Setup** |
| Git and GitHub | the **Git and GitHub** row of **Setup** |
| The workspace folders and your workspace on GitHub | **Workspace** and **Settings → Workspace** ([WORKSPACE.md](WORKSPACE.md)) |
| Skills | **Skills** ([SKILLS.md](SKILLS.md)) |
| Your phone, or another device | **Settings → Security and sign-in → Sign in another device** |
| From anywhere | **Settings → Public link**, or a main computer ([HUB.md](HUB.md)) |

Run `hoprig setup` again later (it is no longer a first run once the settings exist) and it takes the computer further
in one run, asking only what is not decided yet. On a machine that already has things, it first shows what is there and
proposes only what is missing; when nothing is missing it says so in one line and asks nothing.

1. **Claude Code and the dashboard.** Node.js, Claude Code, the sign-in (when no account is signed in it says so in
   one line and goes on), a dashboard password, who may open the dashboard (*the second question*, below), and the
   dashboard running in the background so it starts with the computer.
2. **This computer for coding.** git, Node.js, Python, GitHub's `gh`, tmux and the rest: it shows what is there,
   lists the exact commands for what is missing, asks once ([PC-SETUP.md](PC-SETUP.md)). Working rules for Claude
   Code (a file in `~/.claude/rules/`, yours to edit; your own `CLAUDE.md` is never touched) are not asked in the
   terminal: Get started has one optional press for them.
3. **Git and GitHub.** The GitHub sign-in in the terminal, once (`gh auth login`, then `gh auth setup-git` so plain
   git uses it), git's name and e-mail taken from GitHub (its no-reply address) and said in one line, asked only when
   GitHub is not signed in, and *is there a workspace
   of yours on GitHub already?*: restore it, start a new one in a private repository, or later
   ([WORKSPACE.md](WORKSPACE.md#git-and-github)).
4. **The workspace.** On a new computer, `~/Workspace` with its AI brain ([WORKSPACE.md](WORKSPACE.md)); where
   it is there, only a report.
5. **A project.** When you have none: type a new name, `owner/repo` or a Git address, or press Enter to skip.
6. **Skills for it.** Hoprig's own reviewed skills are added without a question (one with a blocking finding is
   never added); what fits the project comes after, each shown before it is added ([SKILLS.md](SKILLS.md)).
7. **A QR code.** Scan it with your phone to sign in.

Before all of it, setup makes the `hoprig` and `hop` commands work in every shell, also `ssh <computer> hoprig …`
where nvm's Node.js is not loaded: two small scripts in `~/.local/bin` and that folder on PATH in your shell's start
files, added once ([WORKSPACE.md](WORKSPACE.md#the-command-in-every-shell)).

Get started on Home asks for three steps for a first session: Claude Code, the tools for coding and a first project.
Working rules, the phone, skills and Git and GitHub are optional there.

One part that fails does not stop the next ones: at the end, setup names it with the command to try again.

**Who should be able to open the dashboard?**

- `1` only this computer
- `2` devices on my network, e.g. your phone on the same Wi-Fi *(default; not offered on a server)*
- `3` from anywhere: then *I have a server* (make it the main computer: [HUB.md](HUB.md)), *a public link* (free,
  through Cloudflare, no server: a new address at each start, or your own domain; `hoprig public on`), or *Tailscale* (shown when it is installed and signed in; see Other ways below)

On a server, choice 2 is not offered and `hoprig setup --access network` is refused, because there it would open the
dashboard to the whole internet over plain http. Hoprig treats a computer as a server when it has a public address,
and on Linux also when you reach it over SSH (remote login) and it has no desktop of its own, or when its hardware
names a cloud. A Mac or a Windows computer counts as a server only by its public address. There `hoprig doctor`
fails a dashboard that is open to the network.

To take the safe defaults and not be asked at all (it installs the default tools, adds no project, and adds only
skills that come with Hoprig or are pinned in its catalog):

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh -s -- --yes
```

Run one part again later:

```sh
hoprig setup --only base       # Claude Code and the dashboard
hoprig setup --only pc         # this computer for coding (the same as: hoprig pc setup)
hoprig setup --only git        # git's name and e-mail, the GitHub sign-in, your workspace from GitHub
hoprig setup --only workspace  # the workspace folders
hoprig setup --only project    # a project
hoprig setup --only skills     # skills
hoprig setup --dry-run         # the whole plan, nothing changed
```

A server that only shows your other computers (a main computer) stops after the first part: `hoprig setup --hub`, see
[HUB.md](HUB.md).

### What it needs, and what was run

- **Node.js 24.13.1 or newer.** The tests run on Linux and macOS with Node 24 and 26 on every change (and natively
  on macOS with Node 26). On Windows they run as a job that is still allowed to fail (a failure there does not fail
  the run); the suite runs green there on GitHub's machines with Node 24 and 26. Windows is new here, and a real
  home PC has seen less of it than a Linux computer has (see above).
- **tmux 3.2 or newer**, when you want sessions that outlive the dashboard. An older tmux is not used: the
  built-in terminals are taken instead.
- **npm 12** needs nothing from you: setup builds the one module that needs a build (`node-pty`, the only install
  script Hoprig's `package.json` approves). If it did not build, `hoprig doctor` names the cause.

### What gets installed, and where

| What | How | Where |
|---|---|---|
| Node.js (when missing or older than 24.13.1) | macOS / Linux: [nvm](https://github.com/nvm-sh/nvm), for you only, no administrator rights. Alpine: `apk add nodejs npm`. Windows: the official zip from nodejs.org, checked against its SHA-256 list, no administrator and no winget | `~/.nvm` (macOS / Linux), `%LOCALAPPDATA%\hoprig\node` (Windows) |
| Build tools (Linux only) | your package manager (`apt`, `dnf`, `yum`, `pacman`, `zypper`, `apk`) with `sudo`; needed once to compile the terminal module | system |
| Hoprig | `npm install -g` | npm's global folder, or `~/.local` when that folder belongs to the system |
| The terminal module (`node-pty`) | built when Hoprig is installed; npm 12 and newer do not run that build in `npm install -g`, so `hoprig setup` runs it (`npm rebuild node-pty` in Hoprig's own folder, whose `package.json` allows the install script of exactly that module and no other) | inside Hoprig's folder |
| Claude Code | its official installer (`https://claude.ai/install.sh`, on Windows `install.ps1`) | `~/.local/bin/claude` |

Nothing is downloaded over plain http, and nothing is run as root except the package manager, after you saw the
command.

### Not logged in to Claude yet?

Setup says so in one line and carries on. Sign in on the dashboard: **Sign in to Claude** on the card on Home (or
**Providers**, the **Sign in** button of the Claude row, or **Computers → this computer → Setup**, the Claude login row's **Sign in**) opens Claude's sign-in page in your
browser. In a terminal instead: run `claude`, type `/login`, sign in in the browser, then type `/exit`.

### Open it on your phone

- **Same Wi-Fi:** run `hoprig setup --access network` and scan the QR code. Plain http is not encrypted: use it only on a network you
  trust (your home), never on public Wi-Fi.
- **Anywhere:** **Settings → Public link → On** (`hoprig public on`), or a main computer on a server; see
  [Which setup is mine?](COMPUTERS.md#which-setup-is-mine).
- **Other ways:** `hoprig setup --access tailscale` serves the page at an https address that only your own
  [Tailscale](https://tailscale.com/download) devices can open, for when you want no public sign-in page.

Run `hoprig setup` any time to see the QR code again; **Settings → Security and sign-in → Sign in another device** shows one on the page.

### Change a choice

```sh
hoprig setup --access local       # only this computer
hoprig setup --access network     # devices on your network
hoprig setup --access tailscale   # your Tailscale devices
hoprig setup --no-service         # do not run it in the background
hoprig setup --dry-run            # show what setup would do, change nothing
hoprig passwd                     # choose your own dashboard password
hoprig add                        # add another provider: a Claude account, an API key or a proxy
```

### Update

```sh
hoprig update             # Hoprig itself (from where it was installed: the repository's main branch, or git pull + npm install in a git checkout)
hoprig claude status      # Claude Code: installed version, newest version, login
hoprig claude update      # update Claude Code
hoprig claude install 2.1.89   # a specific Claude Code version (or: stable, latest)
```

Claude Code also updates itself in the background. To stay on one version, set `DISABLE_AUTOUPDATER` to `"1"` in
the `env` of `~/.claude/settings.json` ([Claude Code docs](https://code.claude.com/docs/en/setup)).

### Uninstall

```sh
hoprig service uninstall
npm uninstall -g hoprig
rm -rf ~/.config/hoprig ~/.local/state/hoprig    # your settings, profiles and password file
```

On Windows the settings are in `%APPDATA%\hoprig` and `%LOCALAPPDATA%\hoprig`. Claude Code stays installed;
to remove it too, see [its docs](https://code.claude.com/docs/en/setup).

### Troubleshooting

Open **Computers → this computer → Health** on the dashboard: the same checks as `hoprig doctor`, with a **Fix**
button where one press can fix a problem (it shows what it runs and asks first). In a terminal:

```sh
hoprig doctor
```

It shows what is there and what is missing, for everything, and changes nothing. It is grouped: This computer ·
Claude Code and providers · Dashboard · Coding tools · Projects · Skills. Each line is `✓` (fine), `!` (works, could
be better) or `✗` (needs fixing), and under each problem is the one command that fixes it. Only a `✗` makes its
exit code non-zero; missing coding tools are suggestions (`!`). `hoprig pc status` is the detailed view of
the computer alone. Common ones:

| Doctor says | Do this |
|---|---|
| `✗ Claude Code  not installed` | `hoprig setup` (or `hoprig claude install latest`) |
| `! Claude Code ... its folder is not on PATH` | open a new terminal, or run `hoprig setup` (it remembers the full path) |
| `✗ Claude login  not logged in` | **Sign in to Claude** on the card on Home, or **Providers → Sign in**; in a terminal: `claude`, then type `/login` |
| `✗ Dashboard password  not set` | `hoprig passwd` |
| `✗ Terminal module (node-pty)` | the command shown: it builds the module, and on Linux installs the C++ build tools first when they are missing. The line says why it is not there (never built: npm 12; left out: no build tools when Hoprig was installed) |
| `! Terminal module (node-pty)` with tmux | sessions run in tmux and take messages, but no terminal opens in the browser until the command shown has run |
| `! Dashboard  not running` | `hoprig service install` (background) or `hoprig serve` (this terminal) |
| `! Background service  not installed` | `hoprig service install` |
| `! ... can be read by other users` | the `chmod 700` command shown |
| `✗ Settings file` | fix the JSON in the file shown, or move it away and run `hoprig setup` |

On Linux, to keep the dashboard running while you are logged out: open **Computers → this computer → Health** and
press **Let them start after a restart** (it asks first; where sudo would ask for a password, the page shows the line
to type). In a terminal: `sudo loginctl enable-linger $USER`.

`hoprig doctor --json` gives the same as JSON (`{ ok, groups: [{ title, checks }] }`); `--offline` skips every
network lookup.

## A server with only a root login

Some servers hand out only a root login (root is the one account that can change everything on the computer).
Hoprig does not work as root: Claude Code refuses bypass permissions mode (the mode that asks nothing) for root, so
every session there would ask about each command. Under root the dashboard does not offer bypass permissions mode
at all.

So when you run the installer as root, it first lists every step it would take as root, then asks one question:

```
Make the user hoprig and set Hoprig up there? [Y/n]
```

The steps: make the user `hoprig` (no password), give it the keys that let you in as root, give it sudo (the
command that runs another command as administrator) without a password through one file
`/etc/sudoers.d/90-hoprig-hoprig` checked by `visudo` (sudo's own checker of such files), keep its services running
when nobody is logged in (lingering), then install Hoprig for that user and start its dashboard there. Sudo without a
password means that a command run as that user, a session's too, can act as administrator without asking. Run the
installer with `--no-admin` to give the user no administrator rights: such steps then stay yours, as root. Root's
own login, password and SSH (remote login) settings are not changed. With no terminal to ask in, nothing is made and the installer says the
two commands: `--yes` to make the user, `--stay-root` to keep Hoprig on root instead. `HOPRIG_YES` in the
environment is not a yes here: only `--yes` on the command line is. Inside a container (a closed-off
system of its own, such as Docker's) root is on purpose, and Hoprig stays on root without asking.

## Moving Hoprig off root

On a server that hands out only a root login, an older Hoprig installed itself under root. Claude Code refuses
bypass permissions mode for root, so every session there asks about each command. `hoprig doctor`, Health and
**Settings → Runs as root** say so in one line, with one step: move Hoprig to an ordinary user.

**The move needs the network.** It keeps root's build of Hoprig, but the user's own install fetches nvm, Node.js,
Hoprig's packages and Claude Code (from the npm registry, nodejs.org, raw.githubusercontent.com, github.com,
claude.ai and downloads.claude.ai). The move asks each of them first, before it makes or copies anything, and stops
with one line naming what it could not reach. Behind a proxy it cannot ask them itself, and says so.

```sh
hoprig move-to-user --dry-run      # what it would do; changes nothing
hoprig move-to-user                # asks once, then moves
hoprig move-to-user --back         # the step back: root's dashboard again
```

Its options (`hoprig move-to-user --help` lists them):

- `--user NAME`: move to this user instead of the one Hoprig made.
- `--new` (with `--user`): only a user that is not there yet, or one Hoprig made; a user of that name that Hoprig
  did not make is then refused. The main computer passes it when its look said the move makes the user.
- `--no-admin`: a user the move makes gets no administrator rights.
- `--dry-run`: only shows what it would do.
- `--yes`: the yes to the one question, given on the command line (in a terminal the question's default is no).
- `--json`: the look as one line of JSON (the main computer reads it); it changes nothing.
- `--back`: the user's dashboard stopped, root's started again.

The same runs from **Settings → Runs as root → Show what the move does** on that server's own page, after you type
the server's name. A computer token or Tia never starts it. The same page has **Keep Hoprig on root on purpose**:
you type `keep Hoprig on root`, the choice is kept in this computer's settings and can be taken back there; bypass
permissions mode stays unavailable, and doctor and Health then show root as information only.

- **The user.** The move uses the user Hoprig made (the file `.hoprig-made-by-move` in its home, owned by root,
  which only Hoprig's installer writes; the comment field alone is not trusted), or the one you name with `--user NAME` (a user id of 1000 or more and a home
  of its own). When there is none, the move makes `hoprig` first, after the same yes, the way the installer does:
  login keys copied from root, sudo without a password through one file `/etc/sudoers.d/90-hoprig-<user>` checked
  by `visudo` (`--no-admin` for none), lingering. A user named `hoprig` that Hoprig did not make is never used on
  its own: the move says so and offers another name, or `--user hoprig` to move to it all the same.
- **It stops first** when a session, a Work task or a Tia job is working, when the user's disk lacks the copy's
  size plus a tenth, or when a part to copy is already in the user's home and the move did not put it there. Idle
  terminals do not stop it. A copy the move made itself (it keeps a mark of it in root's state folder) is gone on
  from: run the same command again after a stop. Every stop says what it left and the command that takes it away.
- **It copies, never moves:** Hoprig's settings and state (not what belongs to the running dashboard), the
  workspace (every repository with its branches, stashes, untracked and ignored files), `~/.claude` and
  `~/.claude.json`, the gh, git, OpenCode and Codex settings, `~/.gitconfig`, `~/.npmrc`, and the keys git uses
  (`~/.ssh/id_*`, `config`, `known_hosts`; never `authorized_keys`). Everything copied belongs to the user. In the
  copy only, settings, links and git's records of linked work trees name the new home; each project folder of
  Claude Code is also placed under its new path's name, so history and "continue" find it. Conversations are never
  rewritten.
- **It checks the copy:** per repository and linked work tree the same head, status, branches, stashes and file
  count; per part the same entry count; no entry of another owner; the same conversations by content. It says how
  far it is while it runs.
- **Then it switches:** lingering for the user (its exact command is listed first), the same build of Hoprig that
  root runs installed for the user (Hoprig itself from root's installed copy; Node.js, its packages and Claude Code
  from the network, as above),
  a trial of the user's dashboard on a free port, root's service stopped, the user's service started on the usual
  port and checked to run as the user. On any failure after root's stopped, root's starts again. A gateway that ran
  as root moves with its data folder and then listens on this computer only. The same password signs in.
- **Root's copy is kept.** `~/HOPRIG-MOVED.txt` in root's home says where Hoprig runs now and how to become that
  user. Removing root's copy is a later step of its own.
