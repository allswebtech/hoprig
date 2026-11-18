# Set up a computer for coding, and see what it is missing

Take a fresh computer (Linux, macOS or Windows; a current Ubuntu is a good choice) and install Hoprig: its
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
| `--rules` / `--remove-rules` | add (or take out again) a good set of working rules for Claude Code: one file, `~/.claude/rules/hoprig-working-rules.md`, which Claude Code loads for every project; your own `CLAUDE.md` is never touched (an import line an earlier version added there is taken out). Nothing of your workspace map is ever written into it; the short text about your workspace is `hoprig workspace rules`, offered once at a terminal and written into a file of its own only on your yes |

The same is on the dashboard: **Computers**, open the computer, **Setup** (next to **Overview** and **Advanced**;
Setup also shows the workspace folders). It shows the status with a **Fix**
button where a fix exists, and **Set up this computer** lets you tick kits. The installs run as a job on the
Setup page itself: each step with ✓ or ✗, the output as it comes, the result and **Check again**. The job goes on
when you leave the page and shows again when you come back. This works for another computer through the hub too.

**The administrator password in the page.** When a step needs sudo and sudo wants a password (`sudo -n true` is
refused; root and passwordless sudo need nothing), the page asks for your computer's password once, for that job:
it is used for these installs and not saved. The server checks it first (a wrong one installs nothing and the page
asks again), runs each admin step as `sudo -S -k -p '' -- <command>` with the password on sudo's input (never on
a command line; `-k` leaves no cached sign-in behind), keeps it in memory for that job only, and scrubs it from
every output line. It is never written, logged or sent back. On a plain `http://` page that is not this computer
the password would cross the network unencrypted: the page says so and offers **Use the terminal instead**. The
terminal session is also used for a step that needs you at the computer (macOS's install window, Windows' own
prompts). This replaced the earlier rule that a password never goes through the page: setup belongs on the page
it was started from, and the password goes the way the dashboard's own password already does.

For another computer, the password may be typed on the hub's page only when the leg from the hub to that computer is
encrypted: SSH, an `https://` address, or a direct link over `wss://` (also with a pinned certificate). Over a plain
leg the page shows no password field: it says the password is asked only on that computer's own page, with a link
to it when its address is known, and both the hub and the computer refuse a password sent that way.

After the kits, `pc setup` runs the **Git and GitHub** step (the GitHub sign-in with `gh`, `gh auth setup-git`,
git's name and e-mail, and restoring or starting your workspace) and then the workspace step: see
[WORKSPACE.md](WORKSPACE.md#git-and-github).

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
hoprig project new shop [--github [--repo-name <name>] | --remote <git address>] [--template <folder or git address>]
hoprig project add shop web          # code/shop-web, its own repository (--github: a private one on GitHub)
hoprig get shop                      # = hoprig project clone shop; or owner/shop-workspace, or a Git address:
                                        # the parent, every code repository, the memory link, git hooks
                                        # (.githooks), a .env from .env.example, the dependency installs
                                        # (asked). Several names at once; --json
hoprig project setup shop            # what a fresh clone sets up, for a project that is here
hoprig project status [shop]         # parent and code repositories: branch, changes, ahead/behind
hoprig project sync [shop] [--memory]
hoprig project link shop             # link Claude Code's memory folders again
```

Every command here that changes something takes `--dry-run` (`new`, `add`, `clone`/`get`, `setup`, `sync`, `link`):
it changes nothing at all on the computer, not even a lock, a settings file, the workspace map or a git ref, and says
what it would do instead. What it still does is read: the project's folders and git state, `gh` to look a name up on
GitHub (and `project.json` of a project that is not here yet), and for `sync` one `git ls-remote` per repository (a
dry run does not fetch: the server's new commits are named, and counted only when they are here already).

- **The folder is the project's name**, whatever its parent repository is called. A parent is often called
  `shop-workspace` because the product repository is `shop` (it then lives in `code/shop`). The folder is: the
  name the workspace map gives that address; else the `name` in the parent's `project.json` (the clone is made
  under a temporary name, `.hoprig-clone-…`, in the same folder and renamed once that file is read); else the
  repository's name with a trailing `-workspace` taken off. So `hoprig get example/shop-workspace` makes `shop/`.
  Every result says where its name came from (`nameFrom` in `--json`: `map`, `project.json` or `repository`); a
  dry run reads `project.json` through `gh` without cloning.
- **A name in `project.json` is used only where it is safe**: a plain name, not a folder the workspace never looks
  into (`no-ai` and the like), and not one your map uses for another repository. Otherwise the folder is the
  repository's name and the command says why in one sentence ("its project.json names it shop, which your map
  uses for another repository"); the map's other entry is never changed. A repository name that makes no plain
  folder name (`.x`, `-rf`) is refused before anything is cloned.
- **Nothing is overwritten or moved.** When the folder's name is taken (by a folder, a link, or something that
  appears while it clones), or your map uses it for another repository, the clone stays under its temporary name
  and the command says so with the `mv` to run. A project that is here already under another name (an older
  `shop-workspace/`, or `site/` whose `project.json` names it `website`) is reported with the `mv` that gives it
  its name, never moved by itself. Both are "not done, it needs you": the command exits non-zero, `--json` has
  `ok: false` with the `mv` as `fix`, the dashboard shows it as needing you, never as done.
- **The same address** is one repository in every spelling: `git@github.com:o/r`, `ssh://git@github.com/o/r` and
  `https://github.com/o/r`, with or without `.git` or a trailing `/`; on GitHub, GitLab, Bitbucket and Codeberg
  the owner's and the repository's letter case do not count either. A project here under its name is found
  whatever spelling cloned it; its missing code repositories are cloned and set up like a fresh clone.
- **A project that is here already is not changed by `get`.** Nothing inside it is written, linked or installed
  without asking: `get` says what a fresh clone would have set up and is missing there (a `.env` from
  `.env.example`, the git hooks, the memory link, the installs) and the one command that does it,
  `hoprig project setup shop`. In a terminal (without `--yes`) it asks for each one instead, and Enter leaves it.
  `hoprig workspace restore` treats a project that is here the same way.
- **A run that did not finish** (killed, or its folder name taken) leaves its clone under the temporary name, one
  name per address. The next `hoprig get` of that address finishes a complete one instead of cloning again, and
  moves an unfinished one aside as `.hoprig-clone-….aside-<time>` (never deleted); `hoprig workspace status` lists
  what is left, each with what to do. Two runs at once for one address (or one project of a group): the second
  says the project is being fetched by another run. The lock that tells is a file in Hoprig's own state folder
  (`get-locks/`), never in the folder a project is cloned into, so a group's repository never sees it; `workspace
  status` lists a lock whose run has ended, and the next `get` takes it over.
- **A bare name** (`hoprig get shop`) is looked up in the workspace map first, then on GitHub as `shop-workspace`
  and `shop` in your account and its organisations (by the name GitHub answers with: a repository found in another
  letter case, or under its name before a rename, counts once). Where both exist, the project parent (the one with
  a `project.json`) wins; where that cannot be told (also the same parent in two accounts) you are asked once, and
  without a terminal, with `--json` or with `--yes` the command stops with an error that names them all, so you
  can give `owner/name`.
- **`project new shop --github`** names the GitHub repository `shop`, or `shop-workspace` when your account has a
  repository `shop` already (often the product, made first); `--repo-name` chooses another name (without
  `--github` it is ignored, and said so). The folder is `shop` either way. `hoprig project add shop shop` makes `code/shop` for a product called like the project.
- **project.json from a newer Hoprig.** A key this version does not know is kept as it is, whatever its name (also
  when the file is written again; only `__proto__`, `constructor` and `prototype` never are), and shown as a
  warning in `project status` and its `--json`; it never stops a clone. The keys it knows
  are checked strictly as before.
- **Memory.** Claude Code keeps a folder's memory in `~/.claude/projects/<folder as a name>/memory`
  (`CLAUDE_CONFIG_DIR` is honoured). `project new` and `project clone` make that folder a link to the folder in
  the repository named in `memories` (`.` → `ai_brain/claude-memory`), so the memory travels with git. A memory
  folder that already has files is merged in first (a file with the same name is kept under a new name, never
  overwritten) and the old folder is kept as a dated backup. On Windows without links, `autoMemoryDirectory` is
  set in that folder's `.claude/settings.local.json` instead.
- **Sync** fetches, fast-forwards a branch that is only behind (uncommitted work stays; it stops the pull only
  where the new commits touch the same files), and pushes a branch that is only ahead. It
  never merges, rebases, forces or stashes by itself: anything that needs a decision is listed with the exact
  command. `--memory` first commits the memory folders (and only them).
- **Without project.json** a parent is understood from what is there: the repositories in `code/` and
  `ai_brain/claude-memory.json` (kept in step with `project.json` when both exist; never deleted). When cloning
  such a project from GitHub, the owner's repositories named `<project>-…` (and `<project>` itself) are offered as
  its code repositories, never the parent itself (`shop-workspace` fits `shop-…`), and `project.json` is written.
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
