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

The same is on the dashboard: **Computers**, open the computer, **Setup** (one of its four parts: **Overview**,
**Setup**, **Health** and **Advanced**). Setup also has a link to the workspace folders, which live in
**Settings → Workspace**. It shows the status with a **Fix**
button where a fix exists, and **Set up this computer** lets you tick kits. The installs run as a job on the
Setup part itself: each step with ✓ or ✗, the output as it comes, the result and **Check again**. The job goes on
when you leave the page and shows again when you come back. This works for another computer through the main computer too.

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

For another computer, the password may be typed on the main computer's page only when the leg from the main computer to that computer is
encrypted: SSH, an `https://` address, or a direct link over `wss://` (also with a pinned certificate). Over a plain
leg the page shows no password field: it says the password is asked only on that computer's own page, with a link
to it when its address is known, and both the main computer and the computer refuse a password sent that way.

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
| **PHP + database** (optional, off by default) | PHP's command line, Composer, MariaDB (server) | the package manager (apt `php-cli composer mariadb-server`, dnf/yum the same, pacman `php composer mariadb`, zypper `php8 php-composer2 mariadb`, apk `php85 composer mariadb mariadb-client`, brew `php composer mariadb`); not on Windows |
| **Flutter versions (fvm)** (optional, off by default) | fvm | `dart pub global activate fvm`, for you only; only for work on several Flutter versions at once; Flutter (its `dart`) comes first; not on Windows |
| **Flutter** (optional, off by default) | Flutter (the stable release) | into `development/flutter/flutter` of your workspace, for you only: Flutter's own release list is read, the archive comes only from storage.googleapis.com over https, its size is held against a ceiling and its sha256 checked before it is unpacked; a Flutter you already have (on your PATH, in `~/flutter`) is used where it is, through a link; its `bin` goes on PATH in the kits block of your shell start files; the packages it needs on Linux are shown as your own step; needs a workspace; not on Windows |

An optional kit is installed only when you choose it: `--kits php,fvm` (or a tick on the Setup part, or a recipe that
names it). `--yes` never takes one by itself. On the Setup part an optional kit's **Install…** opens "Set up this
computer" with only that kit ticked, so its commands come before the one yes; nothing is installed from its row. A kit
that has nothing to install here (fvm without Flutter's `dart`) has no button, only what comes first.

**Suggested kits.** `pc setup`, `pc status` and the Setup part name an optional kit that a project already on this
computer would use, with the reason ("shop has composer.json"), and leave it unticked:

- PHP + database: `composer.json` or `artisan` at a project's root or in one of its code repositories (`code/<repo>`),
  or the word PHP, MariaDB or MySQL in the project's own `AGENTS.md` or `project.json`;
- fvm: `.fvmrc` or `.fvm/fvm_config.json` (a Flutter project that pins its version);
- Docker: `Dockerfile`, `docker-compose.yml`/`.yaml` or `compose.yml`/`.yaml`.

Only the projects folder is read (one level of code repositories, at most 300 projects, by name; when there are more,
one line says how many were not read); a link out of it is not followed; nothing is cloned or fetched, and the workspace map is not written. A kit that is complete is not suggested.

**The PHP version.** For each PHP project, `require.php` of its `composer.json` is read with Composer's rules (`^`,
`~`, `>=`, `>`, `<=`, `<`, `!=`, an exact version, `8.2.*`, a space or `,` for AND, `|` or `||` for OR, `8.1 - 8.3`)
and compared with the PHP that `php` runs (or, with no PHP yet, the one apt or Homebrew would install, read without
administrator rights or the network: apt's `php-cli` is followed to the package it brings, `php8.5-cli`, for its full
version; where only a series is known it is compared as a series, and a result that depends on the patch release is
said as not known before it is installed). A form it cannot read
(`dev-master`) is said as such. When the PHP here is newer or older than what the project asks for, the note says so
and what you can do, in this order: another PHP on your PATH that fits (`php8.3`), another PHP series of the same
package manager where it has one (installed beside the other only when you choose the PHP kit, its command shown
first; with apt only a series OLDER than the PHP here, because Debian's package of a newer one takes over the `php`
command), or the project in Docker with the official `php:<series>` image (the Docker kit: the newest series whose last release
fits, picked from a short list of the series Docker Hub has an image for; a number in `composer.json` is never walked). The range is said in
words where it can be ("shop needs PHP 8.1 up to 8.3"). Hoprig never removes or downgrades a PHP, never adds a
package source (no PPA, no tap) and never changes which PHP the `php` command runs.

**MariaDB** is a service. Debian's and Ubuntu's package starts it itself; elsewhere (dnf, yum, pacman, zypper, apk,
Homebrew) the commands that start it are shown before the one question and again at the end, for you to run: Hoprig
does not start it. A MySQL or MariaDB server that is here already (its program may be in `/usr/sbin`) counts as the
database: MariaDB is never put beside MySQL. A server on your PATH is asked its version; one found only in such a
folder is not started, its file being there is enough. Where only a MySQL client is here (no server) and the package manager is
apt, dnf, yum, pacman or zypper, MariaDB's server is left out of the plan: the package manager would remove that client
for MariaDB's. The line says so and shows the install command without `-y`, for you to run, where the package manager
lists what it removes and asks first. Homebrew and Alpine do not remove such a client, so there MariaDB is planned as
usual.

With MariaDB the kit also makes the workspace's folder `database/mysql/` when it is missing (only that folder, which
only you can open, never a file inside it), and says so before the one question and in its dry run. It is the
workspace's place for this database's dumps and local data, as `database/postgresql/` is for PostgreSQL. MariaDB's own
data folder is not moved or changed: it stays where its package puts it. A computer without a workspace gets no
folder; `hoprig workspace setup` makes it with the rest.

**Java** has no kit: Hoprig never installs one. When a project of yours needs Java (it has a Gradle or Maven build
file, at its top or in its `android` folder), Hoprig looks, in this order, for `JAVA_HOME`, `java` on your PATH, Android
Studio's own Java (its `jbr` folder: `~/android-studio`, `/opt/android-studio`, the snap, JetBrains Toolbox (also its older
`AndroidStudio/ch-<n>/<build>` layout), beside the Android SDK; on macOS inside `Android Studio.app`), then a JDK of the system (`/usr/lib/jvm`,
`/Library/Java/JavaVirtualMachines`), and shows the first that runs: "Java 21.0.6, found in Android Studio
(~/android-studio/jbr)". One that is found but does not run is named ("No working Java. The Java in Android Studio … did not run: open
Android Studio once, or reinstall it."). On macOS Apple's `/usr/bin/java` stand-in is used only when
`/usr/libexec/java_home` names a JDK. Nothing is added to PATH, `JAVA_HOME` or a shell start file: when the Java found
is not the one `JAVA_HOME` names (also when `JAVA_HOME` points at nothing that runs), the line is shown, with the file
it goes in (`~/.bashrc`, or `~/.zshrc`) and when it is needed: `export JAVA_HOME="$HOME/android-studio/jbr"`. A Java
found on your PATH beside a broken `JAVA_HOME` gets the line with its own home (where its link leads, without
`/bin/java`, so a Mac's Homebrew Java is named and not the one `java_home` would pick; `java_home` is asked only for
Apple's own `/usr/bin/java`), or, where that cannot be told, the advice to remove the `JAVA_HOME` line. On Windows the optional kits and the Java search
are not covered, and say so.

Package managers: apt, dnf (4 and 5), yum, pacman, zypper, apk, Homebrew (offered first on a Mac without it) and
winget. "Old" (`!`) means past the end of life the project itself publishes (Node.js, Python).

Every command is written next to its source in `src/pcsetup/kits.mjs` (nodejs.org and nvm, cli.github.com,
docs.docker.com, brew.sh, docs.python.org, the winget package index, the distributions' package pages, fvm.app).

## Projects

`pc setup` first offers the workspace ([WORKSPACE.md](WORKSPACE.md)), then (in a terminal) asks where your projects live (default `~/Workspace/projects`; a computer that already uses `~/projects` keeps it; remembered) and which
repositories to clone: paste Git addresses or `owner/repo`, or pick from your own GitHub repositories. For each
clone it looks at what the project needs — the lockfile decides the dependency install (npm, pnpm, yarn, bun,
uv, poetry, pip, bundler, composer, go, cargo), `.nvmrc`/`engines` the Node version, and `.env.example` is
copied to `.env` when there is none — and asks before running the install. Nothing else of a project ever runs,
and an existing folder is never overwritten. The dashboard's **Workspace** page lists what is in the projects
folder, each project with its sessions under it (change the folder there: **Advanced**, **Projects folder**, **Change**), and **New session** offers those projects. `hoprig pc clone <repo>…` does the same for given repositories.

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
hoprig project new shop --brief brief.md [--kind <kind>] [--scope product|setup] [--start]   # from a brief (below)
hoprig project start shop [--kind <kind>] [--scope product|setup]    # that project's AI session, later
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

### A new project from a brief

Today you would hand an AI one long set-up prompt with your project's details. Hoprig does that with a skill:

- **`--brief <file>`** (or `--brief -` to type or pipe it): what the product is, who uses it, its main features, in
  your own words. It is kept byte for byte as `docs/brief.md`. A brief with a character nobody can see (a zero-width
  space, a direction mark) is refused before anything is made, as Work's briefs are; at most 24 KiB, UTF-8.
- **The `new-project` skill** comes with every new project, with a brief or without one, in
  `.claude/skills/new-project` with its record (so `hoprig skills list` and `update` know it), where every coding tool
  that opens the project finds it. Without a brief, `AGENTS.md` gets a part "No brief yet" instead: write the brief
  into `docs/brief.md`, or tell the session, and the skill sets the project up from it. **`--no-skill`** leaves the
  skill out (only without a brief); on the page it is the box **Add the New Project skill**, ticked at first. A
  template of your own that has its own `new-project` skill keeps it.
- **`AGENTS.md`** gets a part "Every session" (unless it has one already): every later session reads the memory, the
  brief, `decisions.md` and the applies table of `docs/checklist.md`, and follows the skill, so "add feature X" a
  month later keeps to the same rules.
- **`--kind <kind>`** is your hint: `website`, `web-app`, `multi-tenant` (many businesses or a marketplace),
  `internal`, `api`, `mobile-first`, `cli`, `library`, `extension` or `desktop`. The AI works the kind out from the
  brief all the same and tells you when it reads it differently. **`--scope product`** (the default) builds the whole
  product; **`--scope setup`** stops after the structure, the documents and a foundation that builds and passes its
  checks. In a terminal both are asked when not given; both go into `decisions.md`, as its entry "how the project
  starts" (which says so when neither was given). Neither is taken without a brief.
- **`--start`** opens a session in the App through the dashboard on this computer (the same coding tool, provider,
  model and effort choices as Work's "Do it": `--tool`, `--provider`, `--model`, `--effort`). Its first message
  names the skill, the scope and your hint, and carries the brief as you wrote it. Without `--start` nothing is
  started; `hoprig project start shop` does it later (with the kind and the scope the project was made with). While
  that session is open, a second start names it instead of opening another (`--again` opens one all the same).
  Without a running dashboard the project is made and the command says how to start it.

What the AI does then is the skill's order: it reads the brief and your defaults file, works out the **fit** (the
kind; a rows tier and a traffic tier, each with its numbers; who uses it; which features it has; and for each part of
the skill `full`, `light` or `not needed`, so a command-line tool never reads the mobile or search parts), and sends
you **one** message with its six points: the filled details, its understanding, the fit, what the brief missed
(yes or no each), only the questions it cannot answer (each with a suggested answer) and the tools it is missing.
You reply once ("ok" takes its suggestions); it writes `docs/flows.md`, `docs/test-matrix.md`, `docs/checklist.md`
and `decisions.md` before any code, then builds in its work order with proof for every row, and ends with a review
and a report.

**Your own answers**: put `ai_brain/project-defaults.md` in your workspace's brain with the answers you give for
every project (the language you are answered in, your country, currency and time zone, your providers, where you
deploy, your stack, your targets). The skill takes them without asking. Hoprig never writes that file.

The dashboard does the same: **Workspace → New project** takes the brief, the kind and the scope, and "Start with
AI" opens the session and goes to it (`POST /api/pcsetup/project/new`, then `POST /api/pcsetup/project/start`).

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
the clock, the working rules, the other coding tools Hoprig installs into its own tools folder (OpenCode), and every repository in the projects folder (branch, uncommitted changes,
ahead/behind — counts only). The exit code is 0 only when nothing needed is missing.

## For other parts of Hoprig

```js
import { runPcSetup, pcStatus } from './src/pcsetup/index.mjs';
await runPcSetup({ ui, yes, dryRun, kits, recipe, projects, rules }); // → { ok, changed, missing, code }
await pcStatus({ offline, projects });                                 // → [{ id, label, status, detail, fix, group, fixKit? }]
```

## What is checked where

This list was tried by hand when this part was built. The tests do not repeat it. Linux
(Ubuntu 26.04, Debian 12, Fedora 45) was run for real in fresh containers: setup, a second run doing
nothing, cloning and installing a project, a project workspace with two code repositories, a recipe applied on a
second computer, and the memory moving between the two. macOS was checked read-only (status and a dry run).
The PHP + database and fvm kits and the Java search were checked by unit tests and dry runs only: no real install of
PHP, Composer, MariaDB, Dart or fvm, no real Android Studio, and no macOS or other distribution was run for them.
Windows was **not run**: its commands (winget ids, the Visual Studio workload, the Python install manager) are
checked against their vendors' pages and by unit tests only.
