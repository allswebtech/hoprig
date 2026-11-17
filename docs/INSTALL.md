# Install Hoprig

## Quick start

**1. Install.** Open a terminal and paste one line.

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
```

Windows (PowerShell). Not ready yet: the tests do not pass on Windows, see "What it needs, and what was run" below:

```powershell
irm https://raw.githubusercontent.com/allswebtech/hoprig/main/install.ps1 | iex
```

**2. Scan.** At the end you see a QR code. Scan it with your phone's camera: the dashboard opens.

That's it.

> Not published yet? Point the installer at a copy: `HOPRIG_SOURCE=/path/to/hoprig-0.1.0.tgz sh install.sh`
> (a `.tgz` from `npm pack`, a folder, or a git URL).

---

## More

### What the one run does

The installer ends in `hoprig setup`, and setup takes the computer from here to coding in one run. On a
machine that already has things, it first shows what is there and proposes only what is missing; when nothing is
missing it says so in one line and asks nothing.

1. **Claude Code and the dashboard.** Node.js, Claude Code (*install it now?* when it is missing), the sign-in
   (when no account is signed in it says so in one line and goes on), a dashboard password (made for you, kept in a
   private file), who may open the dashboard (*the second question*, below), and the dashboard running in the
   background so it starts with the computer.
2. **This computer for coding.** git, Node.js, Python, GitHub's `gh`, tmux and the rest: it shows what is there,
   lists the exact commands for what is missing, asks once ([PC-SETUP.md](PC-SETUP.md)). In a terminal it also
   offers working rules for Claude Code (a file in `~/.claude/rules/`, yours to edit; your own `CLAUDE.md` is
   never touched).
3. **Git and GitHub.** The GitHub sign-in in the terminal (`gh auth login`, then `gh auth setup-git` so plain git
   uses it), git's name and e-mail when missing (GitHub's no-reply address suggested), and *is there a workspace
   of yours on GitHub already?*: restore it, start a new one in a private repository, or later
   ([WORKSPACE.md](WORKSPACE.md#git-and-github)).
4. **The workspace.** On a new computer, `~/Workspace` with its AI brain ([WORKSPACE.md](WORKSPACE.md)); where
   it is there, only a report.
5. **A project.** When you have none: type a new name, `owner/repo` or a Git address, or press Enter to skip.
6. **Skills for it.** The skill that comes with Hoprig first, then what fits the project, each shown before it
   is added ([SKILLS.md](SKILLS.md)).
7. **A QR code.** Scan it with your phone to sign in.

Before all of it, setup makes the `hoprig` and `hop` commands work in every shell, also `ssh <computer> hoprig …`
where nvm's Node.js is not loaded: two small scripts in `~/.local/bin` and that folder on PATH in your shell's start
files, added once ([WORKSPACE.md](WORKSPACE.md#the-command-in-every-shell)).

One part that fails does not stop the next ones: at the end, setup names it with the command to try again.

**Who should be able to open the dashboard?**

- `1` only this computer
- `2` devices on my network, e.g. your phone on the same Wi-Fi *(default; not offered on a server with a public
  address, where it would be the whole internet over plain http)*
- `3` from anywhere: then *I have a server* (make it the hub: [HUB.md](HUB.md)), *a public link* (free,
  through Cloudflare, no server: a new address at each start, or your own domain; `hoprig public on`), or *Tailscale* (shown when it is installed and signed in; see Other ways below)

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

A server that only shows your other computers (a hub) stops after the first part: `hoprig setup --hub`, see
[HUB.md](HUB.md).

### What it needs, and what was run

- **Node.js 22 or newer.** The tests run on Linux and macOS with Node 22, 24 and 26 on every change (and natively
  on macOS with Node 26). On Windows they have been run and do not pass yet: Windows is not supported yet, and
  `install.ps1` has never been run.
- **tmux 3.2 or newer**, when you want sessions that outlive the dashboard. An older tmux is not used: the
  built-in terminals are taken instead.
- **npm 12** needs nothing from you: setup builds the one module that needs a build (`node-pty`, the only install
  script Hoprig's `package.json` approves). If it did not build, `hoprig doctor` names the cause.

### What gets installed, and where

| What | How | Where |
|---|---|---|
| Node.js (when missing or older than 20) | macOS / Linux: [nvm](https://github.com/nvm-sh/nvm), for you only, no administrator rights. Alpine: `apk add nodejs npm`. Windows: WinGet, the official `OpenJS.NodeJS.LTS` package | `~/.nvm` (macOS / Linux) |
| Build tools (Linux only) | your package manager (`apt`, `dnf`, `yum`, `pacman`, `zypper`, `apk`) with `sudo`; needed once to compile the terminal module | system |
| Hoprig | `npm install -g` | npm's global folder, or `~/.local` when that folder belongs to the system |
| The terminal module (`node-pty`) | built when Hoprig is installed; npm 12 and newer do not run that build in `npm install -g`, so `hoprig setup` runs it (`npm rebuild node-pty` in Hoprig's own folder, whose `package.json` allows the install script of exactly that module and no other) | inside Hoprig's folder |
| Claude Code | its official installer (`https://claude.ai/install.sh`, on Windows `install.ps1`) | `~/.local/bin/claude` |

Nothing is downloaded over plain http, and nothing is run as root except the package manager, after you saw the
command.

### Not logged in to Claude yet?

Setup says so in one line and carries on. Run `claude`, type `/login`, sign in in the browser, then run
`hoprig setup` again.

### Open it on your phone

- **Same Wi-Fi:** choose `2` in setup, scan the QR code. Plain http is not encrypted: use it only on a network you
  trust (your home), never on public Wi-Fi.
- **Anywhere:** **Settings → Public link → On** (`hoprig public on`), or a hub on a server; see
  [Which setup is mine?](COMPUTERS.md#which-setup-is-mine).
- **Other ways:** `hoprig setup --access tailscale` serves the page at an https address that only your own
  [Tailscale](https://tailscale.com/download) devices can open, for when you want no public sign-in page.

Run `hoprig setup` any time to see the QR code again.

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
hoprig update             # Hoprig itself (from npm, or git pull + npm install in a git checkout)
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

Run:

```sh
hoprig doctor
```

It shows what is there and what is missing, for everything, and changes nothing. It is grouped: This computer ·
Claude Code and providers · Dashboard · Coding tools · Projects · Skills. Each line is `✓` (fine), `!` (works, could
be better) or `✗` (needs fixing), and under each problem is the one command that fixes it. Only a `✗` makes its
exit code non-zero; missing coding tools are suggestions (`!`). `hoprig pc status` is the detailed view of
the computer alone. Common ones:

| doctor says | do this |
|---|---|
| `✗ Claude Code  not installed` | `hoprig setup` (or `hoprig claude install latest`) |
| `! Claude Code ... its folder is not on PATH` | open a new terminal, or run `hoprig setup` (it remembers the full path) |
| `✗ Claude login  not logged in` | `claude`, then type `/login` |
| `✗ Dashboard password  not set` | `hoprig passwd` |
| `✗ Terminal module (node-pty)` | the command shown: it builds the module, and on Linux installs the C++ build tools first when they are missing. The line says why it is not there (never built: npm 12; left out: no build tools when Hoprig was installed) |
| `! Terminal module (node-pty)` with tmux | sessions run in tmux and take messages, but no terminal opens in the browser until the command shown has run |
| `! Dashboard  not running` | `hoprig service install` (background) or `hoprig serve` (this terminal) |
| `! Background service  not installed` | `hoprig service install` |
| `! ... can be read by other users` | the `chmod 700` command shown |
| `✗ Settings file` | fix the JSON in the file shown, or move it away and run `hoprig setup` |

On Linux, to keep the dashboard running while you are logged out: `sudo loginctl enable-linger $USER`.

`hoprig doctor --json` gives the same as JSON (`{ ok, groups: [{ title, checks }] }`); `--offline` skips every
network lookup.
