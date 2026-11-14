# Set up a computer for coding, and see what it is missing

Take a fresh computer (Linux, macOS or Windows; Xubuntu 26.04 is a good choice) and install Hoprig: its
first run ([INSTALL.md](INSTALL.md)) includes this part. To run it on its own, or again:

```sh
hoprig pc status     # what is there, what is missing, what needs attention
hoprig pc setup      # shows the same, proposes only what is missing, asks once, installs it
```

`pc setup` first shows what the computer has, kit by kit. If everything is there it says so in one line and
stops. Otherwise it lists the exact commands it will run, asks **one** question, and runs them with their output
as it comes. When a command needs the administrator password, `sudo` (or Windows) asks for it in your terminal:
Hoprig never sees, keeps or types a password. At the end it says what is ready, what failed (with the exact
command to retry), and what needs a new terminal or a new login. Running it again is safe: what is there is left
alone, never reinstalled or downgraded.

| Option | What it does |
|---|---|
| `--yes` | answer the one question with yes (sign-in questions are still asked when there is a terminal) |
| `--dry-run` | change nothing, only show what would happen |
| `--kits basics,node,…` | choose the kits (default: the kits that miss something) |
| `--recipe <file or https address>` | set up like another computer (see Recipes) |
| `--rules` / `--remove-rules` | add (or take out again) a good set of working rules for Claude Code: one file, `~/.claude/rules/hoprig-working-rules.md`, which Claude Code loads for every project; your own `CLAUDE.md` is never touched (an import line an earlier version added there is taken out) |

The same is on the dashboard: **Computers**, open the computer, **Setup** (next to **Overview** and **Advanced**;
Setup also shows the workspace folders). It shows the status with a **Fix**
button where a fix exists, and **Set up this computer** lets you tick kits. Anything that may need the administrator password opens in a
terminal session of the dashboard, where you type it. This works for another computer through the hub too.

## Kits

| Kit | Items | How |
|---|---|---|
| **Basics** | git, curl, unzip, C/C++ build tools (what node modules need to compile) | the system's package manager; macOS: the Xcode command line tools; Windows: the Visual Studio C++ build tools |
| **Node.js** | Node.js LTS, npm | nvm, for you only (no administrator rights); Alpine: `apk add nodejs npm`; Windows: winget |
| **Python** | python3, pip, venv | the package manager; Windows: the Python install manager |
| **GitHub** | `gh`, your commit name and e-mail, signing in | GitHub's own package repository; `gh auth login` (it can also set up git and an SSH key) |
| **Terminal extras** | tmux, ripgrep, jq | the package manager (no tmux on Windows) |
| **Docker** (optional, off by default) | Docker | Docker's own install script; you must log out and in again before it works without `sudo` |

Package managers: apt, dnf (4 and 5), yum, pacman, zypper, apk, Homebrew (offered first on a Mac without it) and
winget. "Old" (`!`) means past the end of life the project itself publishes (Node.js, Python).

Every command is written next to its source in `src/pcsetup/kits.mjs` (nodejs.org and nvm, cli.github.com,
docs.docker.com, brew.sh, docs.python.org, the winget package index).

## Projects

`pc setup` first offers the workspace ([WORKSPACE.md](WORKSPACE.md)), then (in a terminal) asks where your projects live (default `~/Workspace/projects`; a computer that already uses `~/projects` keeps it; remembered) and which
repositories to clone: paste Git addresses or `owner/repo`, or pick from your own GitHub repositories. For each
clone it looks at what the project needs — the lockfile decides the dependency install (npm, pnpm, yarn, bun,
uv, poetry, pip, bundler, composer, go, cargo), `.nvmrc`/`engines` the Node version, and `.env.example` is
copied to `.env` when there is none — and asks before running the install. Nothing else of a project ever runs,
and an existing folder is never overwritten. The dashboard's **Workspace** page lists what is in the projects
folder, each project with its sessions under it (change the folder there, under **Projects folder**), and **New session** offers those projects. `hoprig pc clone <repo>…` does the same for given repositories.

### Project workspaces

A project can be one private **parent** repository with its code in its **own** repositories, everything
synced through git, the AI memory included (in the workspace: `~/Workspace/projects/<project>/`):

```
<projects folder>/<project>/          the parent repository (private): rules, AI memory, docs, decisions
  AGENTS.md                            the one instruction file for AI tools
  CLAUDE.md, GEMINI.md                 short pointers to AGENTS.md
  .claudeignore .aiignore .cursorignore .copilotignore .geminiignore
  .claude/settings.json                shared Claude Code settings
  ai_brain/                            learnings.md, active_context.md, daily_logs/, claude-memory/, claude-memory.json
  docs/  decisions.md
  project.json                         { name, repos: [{ dir, url, branch? }], memories: { launch folder: memory folder } }
  code/.gitignore                      "*" and "!.gitignore": the parent tracks only this file under code/
  code/<project>-<stack>/              each one its own git repository
  test-data/                           ignored by git
```

```sh
hoprig project new shop [--github | --remote <git address>] [--template <folder or git address>]
hoprig project add shop web          # code/shop-web, its own repository (--github: a private one on GitHub)
hoprig project clone shop            # or owner/shop, or a Git address: the parent, every code repository,
                                        # the memory link, git hooks (.githooks), the dependency installs
hoprig project status [shop]         # parent and code repositories: branch, changes, ahead/behind
hoprig project sync [shop] [--memory]
```

- **Memory.** Claude Code keeps a folder's memory in `~/.claude/projects/<folder as a name>/memory`
  (`CLAUDE_CONFIG_DIR` is honoured). `project new` and `project clone` make that folder a link to the folder in
  the repository named in `memories` (`.` → `ai_brain/claude-memory`), so the memory travels with git. A memory
  folder that already has files is merged in first (a file with the same name is kept under a new name, never
  overwritten) and the old folder is kept as a dated backup. On Windows without links, `autoMemoryDirectory` is
  set in that folder's `.claude/settings.local.json` instead.
- **Sync** fetches, fast-forwards a clean branch that is only behind, and pushes a branch that is only ahead. It
  never merges, rebases, forces or stashes by itself: anything that needs a decision is listed with the exact
  command. `--memory` first commits the memory folders (and only them).
- **Without project.json** a parent is understood from what is there: the repositories in `code/` and
  `ai_brain/claude-memory.json` (kept in step with `project.json` when both exist; never deleted). When cloning
  such a project from GitHub, the owner's repositories named `<project>-…` are offered as its code repositories,
  and `project.json` is written.
- **Templates.** The built-in one is small and neutral. `--template` (a folder or a Git address; remembered as
  `projectTemplate`) copies your own structure; `{{project}}` and `{{Project}}` in names and text become the
  name. A template cannot write outside the new folder (no `..`, no absolute paths, no links out).
- Folders named `no-ai`, `ignore` or `ai-ignore-dir` are never looked into, not even to count changes.

## Recipes: make the next computer like this one

```sh
hoprig pc recipe save my-setup.json [--with-email]
hoprig pc setup --recipe my-setup.json        # or an https address
```

A recipe holds the kits, the tool versions (as information), the projects folder, and the addresses of your
repositories and project workspaces. Never a key, a token or a password; your e-mail only with `--with-email`.
A recipe is input from outside, so it is checked strictly: only known kits, only plain https or SSH Git
addresses (no user name or password in them), a projects folder in the home folder. Nothing in a recipe can run
a command.

## Status

`hoprig pc status [--json] [--offline]` checks, without changing anything or needing administrator rights:
the operating system (updates waiting and a pending restart where that can be read), free disk space where your
home and projects are, memory and swap, every kit item with its version, git name and e-mail, the GitHub
sign-in (only the account name is shown), an SSH key (only that a public key exists), Claude Code and its login,
the clock, the working rules, and every repository in the projects folder (branch, uncommitted changes,
ahead/behind — counts only). The exit code is 0 only when nothing needed is missing.

## For other parts of Hoprig

```js
import { runPcSetup, pcStatus } from './src/pcsetup/index.mjs';
await runPcSetup({ ui, yes, dryRun, kits, recipe, projects, rules }); // → { ok, changed, missing, code }
await pcStatus({ offline, projects });                                 // → [{ id, label, status, detail, fix, group, fixKit? }]
```

## What is checked where

Linux (Ubuntu 26.04, Debian 12, Fedora 45) was run for real in fresh containers: setup, a second run doing
nothing, cloning and installing a project, a project workspace with two code repositories, a recipe applied on a
second computer, and the memory moving between the two. macOS was checked read-only (status and a dry run).
Windows was **not run**: its commands (winget ids, the Visual Studio workload, the Python install manager) are
checked against their vendors' pages and by unit tests only.
