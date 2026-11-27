# The workspace and the AI brain

One folder tree, the same on every computer. Coding happens inside `projects/`. The dashboard's **Workspace** page shows
your projects, each with its sessions.

![The Workspace page: two projects, each with its folder, its branch and the sessions that run in it](screenshots/workspace-desktop-light.webp)

```
~/Workspace/
├── ai_brain/              shared AI knowledge for all projects: the rules every coding tool gets, skills,
│                          memory, notes, scripts; its own private git repository
├── projects/<project>/    the project's parent: AGENTS.md, ai_brain/ (that project's memory, learnings,
│   │                      current context), docs, decisions, project.json
│   └── code/<repo>/       each code repository, its own git repository
├── credentials/           keys and passwords for local work: not in git unless you choose (Credentials, below); AI tools may use them but never print them
├── development/           toolchains and SDKs installed for you (node, flutter, android, …)
├── git/                   your own git material (mirrors, shared hooks)
├── database/postgresql/   local database data
├── database/mysql/        local MySQL or MariaDB data and dumps (only you can open it); the PHP kit makes it with MariaDB
└── backups/
```

Names are case-exact. The place is one setting: `workspaceDir` in Hoprig's `config.json` (default `~/Workspace`);
the environment variable `HOPRIG_WORKSPACE_DIR` wins over both. A project's parent is described in
[PC-SETUP.md](PC-SETUP.md#project-workspaces).

```sh
hoprig workspace status [--all] [--json]   # every folder: there or not, what it is for; the map against this computer;
                                           # clones hoprig get left under a temporary name, with what to do;
                                           # --all: which computer has what (each computer's own file)
hoprig workspace setup [--dry-run] [--yes] # create only what is missing
hoprig workspace link [--dry-run] [--yes]  # let every coding tool that is on read its rules, skills and memory from the brain
hoprig workspace map [--dry-run]           # write the map of every git repository (ai_brain/workspace.json)
hoprig workspace map --upgrade [--yes]     # the map to version 2, needed for groups (asks once)
hoprig workspace map --undo                # the old map back after an upgrade here, while the map has not changed
hoprig workspace map --fix-case [--undo]   # a folder that differs from the map only in letter case gets the map's name
hoprig workspace group add <dir> [--repo <address>] [--holds name:group,name]   # a folder of projects of your own
hoprig workspace group remove <dir>        # out of the map, when no project of the map is in it (nothing deleted)
hoprig workspace restore <brain address> [--with-projects]   # a fresh computer: the brain, credentials, groups and
                                           # other repositories; projects only with --with-projects
hoprig workspace sync [<project>] [--memory] [--push] [--with <computer>]   # what is here in step (hoprig sync: the same)
hoprig workspace label [<name>] [--again] [--new-id]  # this computer's short name in the workspace, given once
hoprig workspace set --dir <folder> --projects <folder>         # where things are, for future work (nothing moves)
hoprig workspace forget <entry>   # a project (<place>/<name> in a group), project/code/<name> or a folder out of the map
hoprig workspace git                       # git's name and e-mail, the GitHub sign-in, your workspace on GitHub
hoprig workspace auto [--map|--commit|--memory|--sync|--push on|off] [--push-branches <place>=on|off] [--every <hours>]
hoprig workspace mylink add|remove|list [<path>]   # a link in the workspace that is your own (Hoprig follows it)
hoprig workspace rules [--write] [--yes]   # the short text about this workspace for coding sessions: shown; written on a yes
hoprig get <name>…                         # one project of the map onto this computer (every step can be run again)
hoprig get --list [--json]                 # every entry of the map and which computer has it
```

Most of them take `--json`; `setup`, `link` and `git` do not. Most of those that change something take `--dry-run`,
which shows exactly what would happen; `auto` and `mylink add|remove` do not. `hoprig setup` and `hoprig pc setup` offer the workspace as one step: on a new computer (no AI brain yet)
they say in one sentence what it creates and ask once (default yes); where the brain is there already, they only
report. Before that comes the **Git and GitHub** step (below). `hoprig doctor` shows the workspace under Projects:
the tree, whether the brain is on a git server and in step (as of the last fetch; the doctor does not fetch), and
whether the map matches this computer.

A new project that starts from a brief (`hoprig project new shop --brief brief.md --start`, or **New project** in the
dashboard) gets the `new-project` skill and an AI session that sets it up: docs/PC-SETUP.md, "A new project from a
brief". The skill reads your own answers from `ai_brain/project-defaults.md` in this brain when you keep one there.

## A fresh computer in three commands

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh   # Hoprig, git, gh, …
hoprig workspace git                                  # name and e-mail, the GitHub sign-in (any other git server: skip)
hoprig workspace restore example/ai_brain             # or any git address of your brain
```

The installer's own setup already asks the second and third question in a terminal; the commands are for doing it
later or again. Restore brings the brain with its map, the credentials repository when the map names one, each
group's own repository and the other repositories, and makes the folders of the tree: **no project**. Each project of
the map is listed as "in the map, not on this computer"; `hoprig get shop` brings the one you work on here. Then
`hoprig workspace link` makes every coding tool that is on (Claude Code, and OpenCode when it is on) use the brain's
rules, skills and memory.

## On demand: a project comes when you ask for it

A computer that is formatted or lost must cost nothing, and a project lies on a computer only while you work on it
there. So:

- **"In the map, not on this computer" is the normal state.** `workspace status` shows such projects in a group of
  their own with `hoprig get <name>`, sync does not list them, and no notification is made for them. The Workspace
  page shows each as a quiet card with **Get it** and which other computer has it.
- **No project comes by itself, and one that is here is moved only when that is safe.** Restore clones none
  (`--with-projects` is the one option for an owner who wants every project everywhere). A project that is here is
  looked at every 30 minutes and before a session starts: a clean branch that is only behind is fast-forwarded (switch
  `ffProjects`, on for the projects folder, off for a group's own place); a branch with changes in the same files,
  commits on both sides, work under way or a session open is left alone and listed as Not in step on the Projects
  page. Nothing is ever merged, rebased, stashed or pushed by itself. The rest is yours: `hoprig sync [<name>]`,
  `hoprig workspace sync`, or Sync on the Workspace page. One switch per place (`pushBranches`, below) lets committed work on a branch that is
  not the default branch go up by itself; a default branch is never pushed by itself (a push there can be a release).
- **`hoprig get <name>`: every step can be run again.** A get that was cut off (the network, a closed lid) leaves
  what is complete and fetches the rest on the next run. A folder that holds a clone cut off half way (a repository
  with that address whose first commit was never checked out in full: no index yet) is moved aside under a dated name (`.shop-api.broken-<time>`,
  never deleted; `workspace status` names it) and cloned again. A repository the server no longer has under that
  address is named with git's own reason, and the rest goes on.
- **`hoprig get --list [--json]`** is the catalogue: every entry of the map with where it is checked out, here (from
  the disk) and on your other computers (from their own files). A computer that never wrote its file cannot be seen.

## A computer that already has projects

A computer that held projects before Hoprig came keeps them where they were: `~/code`, `D:\work`, a folder per
project with its repositories and notes beside them. Three steps bring each into the layout above, and none of them
moves, changes or deletes what was there. The commands do the mechanical part; the bundled skill `adopt-projects`
does the reading and the asking in a coding session you start (as `new-project` stands over `project new`). In the
dashboard: **Projects → Add project → Found on this computer**, the same three steps without a terminal.

```sh
hoprig adopt scan                          # looks at nothing: names the usual folders that are there
hoprig adopt scan --in ~/code [--json]     # Look: changes nothing, never fetches, never enters a private folder
hoprig adopt plan ~/code/blog              # Suggest: one plan file per project (in Hoprig's state folder)
hoprig adopt plan all --in ~/code          #   … for every project found there
hoprig adopt plan ~/code/blog --copy-installed   # copy installed packages and build output too
hoprig adopt plan ~/code/blog --name blog-site  # the project's name (else made from the folder's name)
hoprig adopt apply blog --dry-run          # what Arrange would do; nothing is written
hoprig adopt apply blog --name "Alex" --email alex@example.com   # Arrange: copy, then prove the copy
hoprig adopt verify blog                   # prove the copy against the original again
hoprig adopt retire blog                   # the originals go: on a terminal, with the name typed
hoprig sessions move <old folder> <new folder>   # the coding tool's conversations of a folder, copied to another
```

**Look** reads only the folders you name (`--in`, or the page's ticks): never the whole disk. A project is a folder
there that is a git repository, holds repositories, or has a project's own sign (`package.json`, `pubspec.yaml`,
`composer.json`, `*.sln`, `go.mod`, `Cargo.toml`, `pyproject.toml` and the like); dependency and build folders
(`node_modules`, `vendor`, `.venv`, `dist`, `build`, `target`, …) are never entered. For each repository it says the
remote (without any sign-in part), the branch, ahead and behind **as of its last fetch** (a scan never fetches),
uncommitted changes, stashes, other branches, linked worktrees and the size without dependencies, and what makes a
copy unsafe now: a program working in the folder (Linux reads each process's working folder; elsewhere it cannot
tell) or files changed within the hour. A file git shows as changed whose content differs only in line endings (under
`core.autocrlf` or a text attribute, git would store it as it is) is counted apart, as "line endings only", and never
"fixed"; a file git does not treat as text (a lone CR, a NUL) is always a real change. Git is asked through the same
reader as the dashboard's (no index refresh, no program the folder names). A private folder (`no-ai`, `ignore`,
`ai-ignore-dir`) is counted, never entered, and nothing in it is named.

**Find the projects on this computer** (the button above the folders on that page, `POST /api/adopt/home`) is the same
Look over your home folder, on your press only: nothing starts it by itself. It goes at most 4 levels down, reads at
most 20,000 folders and stops after 20 seconds, whichever comes first, and says which one ended it; a project it did
not reach is found when you name its folder by hand. It reads only folder names and whether a folder holds `.git` or
one of the signs above: it opens no file, runs no git and no program, and does not go into a project it found. It never
enters a hidden folder (`.config`, `.local`, `.cache`, the coding tools' own folders), the dependency and build folders
above, a private folder (counted, never named), your workspace (its projects are counted as already there), Hoprig's
settings and state folders, or the system's own folders in a home (Linux: `snap`, `Music`, `Pictures`, `Videos`; macOS:
`Library`, `Applications`, `Movies`, `Music`, `Pictures`, `Public`; everywhere: `go/pkg`, `miniconda3`, `anaconda3`). A
link is named and never followed; a folder it cannot read is counted. What it finds is then looked at exactly as a
folder you name, and each project's plan and arrange are your press, as above. Only one such look runs at a time.

A project counts as **already in the layout** only by Hoprig's own marks: a repository with a git folder of its own in
`code/`, and either a `project.json` that Hoprig's own reader takes with no key it does not know, or the template's
`AGENTS.md` and `code/.gitignore`. A `project.json` of another tool (an Nx app) or an `AGENTS.md` beside a submodule
in `code/` is not the layout: such a folder is planned as the repository it is.

**Suggest** writes one file, `<state folder>/adopt/<name>.json`, and nothing else. The project's name is made from the
folder's name unless you give one (`--name`, or the name field of the page's plan, which makes the plan again under
it); a name given is checked by the rule of `hoprig project new`: letters, digits, `.`, `_` and `-`. It says which repositories go to
`code/<name>` (a linked worktree with its repository, as `code/<name>.<worktree>` when it lies outside), where each
neighbour goes by its kind (AI tools' files and notes to `ai_brain/`, the project's own scripts to `scripts/`, data
copies and dumps to `test-data/`), what stays (installed packages, a folder whose git folder is elsewhere), the other
tools' skills, rules files and hooks, the session stores that name the folder, and every file and line that names an
old folder: tracked files, and where it bites in the copy (`.git/config` with a credential helper's full path, git
hooks, `.vscode/launch.json`, `.claude/settings.json`, other tools' files). Nothing is rewritten. You or the
session may edit the plan; apply reads it strictly (every place inside the new project folder, a worktree only one
its repository names) and takes it only while the folder is still as the plan saw it: a file added or edited (every
file is compared by its content, a touch alone is no change), a commit, a moved branch, and apply asks for a new plan.
Installed packages and build output inside a repository (a folder of the list that `hoprig drop` also lets go without a
word: `node_modules`, `vendor`, `.next`, `.venv`, `dist`, `build`, `target` and the like, and only where git ignores it as
a whole) are **left out of the copy** by default: the plan names each with its size and the command that makes it
again from the lockfile beside it (`npm ci` for a `package-lock.json`, `pnpm install --frozen-lockfile`, `composer
install`, `npm run build` for build output, ...), and Arrange says the same under what still needs you. A folder of
that name that git tracks, or does not ignore, is copied; so is one that holds a repository of its own. The proof
counts a folder left out as left out, never as missing. `--copy-installed` (on the page: **Copy them all the same**)
makes a plan that copies them with the rest.
Comparing by content reads every file outside installed packages: about one second for 20,000 files of 10 KB
(measured on Linux, warm disk cache), where a listing by size and time took a fifth of that.

For each repository with an address on GitHub the plan also says whether it is **public or private, as GitHub says**:
asked through `gh` with this computer's sign-in only when you make the plan yourself (the command, or your press on
the page), never guessed from the address. Another server, no sign-in or no answer reads "not known" with why. Scan
and a dry run never ask. Untracked folders inside a repository that hold another project (their own `.git` or a
project's sign, up to three folders down) are listed by name: a first push could take them, so you decide.

A project already in the layout keeps every file of its own at its own place: its `AGENTS.md`, `CLAUDE.md`,
`.gitignore`, `project.json`, `decisions.md`, `ai_brain/` (its learnings, its active context, its memory), `scripts/`
and `docs/` are copied as they are, and none is moved aside, replaced or written into. Hoprig adds only the files of its
layout that the old folder lacks, and the plan says which of the two it found and lists them. Where its `AGENTS.md` is
its own, the table of what was where goes to `ai_brain/moved-here.md` instead, and the parent's first commit holds only
what Hoprig added (none, when the layout lacked nothing). A parent that is itself a repository keeps its own history
where it was (the new project starts its own); that `.git` is named as staying.

**Arrange** makes the project from Hoprig's own template, with the commit identity you give for that command
(`--name`, `--email`: handed to git for its own commit only; nothing global is set). It copies each repository whole
(history, every ref, stashes, worktrees, uncommitted and untracked work, ignored `.env` files, private folders as a
whole) and then proves each copy before it says done, one line each: HEAD, every ref, the status and the index by
hash, the stash count, the remote, each worktree, the file set (path, kind, size, mode, mtime, content hash), and
`git fsck`. A mismatch stops there and removes only the folder this run made. The parent's `AGENTS.md` gets a table
of what was where and where it is now, and the parent's first commit holds Hoprig's own files only: what was copied
stays uncommitted for you. The coding tool's conversations of each old folder are copied under the new folder's key
and its memory into the project's own `ai_brain/claude-memory` (the old ones stay). Another tool's skill gets a
pointer in `.claude/skills/<name>` to where it was copied; a rules file is named for you to read (what is about you,
what is about the project); a hook is named as needing its equal for Claude Code and is never run or dropped. Last
comes the count of secret-shaped values in what a first push would take (tracked files, and untracked ones that are
not ignored, in the repository and in each of its worktrees), never a value, and beside it each repository's
visibility as the plan found it. When nothing was searched (no repository copied, or a listing failed) the line says
so: it never reads as a clean push. Look before any first push.

A line marked as a **warning** did not stop the run but is something to look at: files changed within the hour (if
someone is still writing, the proof sees it and the run is undone), hard-linked files copied as separate files, a
repository that is not private on its server.

**A stopped run.** Apply marks its run (a file in Hoprig's state folder naming the new folder, its process and a
token, and the same token in the new folder) until its record is written at the very end. A run that was killed or
lost its power leaves both behind: the next `apply` says the folder is the half-made copy of a run that stopped, and
`hoprig adopt apply <name> --clean-stopped` removes only that folder and arranges again. A folder there without the
matching token is never called that and never removed, with or without the flag: apply names the marker and says how
to go on. A run that is still going is named as such.

Never automatic, in any of these: a commit of your work, a fetch, a push or a new repository on a server, a choice
between two accounts, the AI brain on a server, a change to an original. **retire** is its own command: it checks
that nothing in the original changed since its copy (by content), lists what would go and what stays (a private
folder is never removed: it was never looked into), and needs the project's name typed. Without a terminal or the
page's sheet it is refused. Then, **before it removes anything, it compares every original with its
copy again itself**, trusting nothing that was said before (not the plan, not apply's proof): it finds the
repositories in the original folder again and checks that the copy holds HEAD, every branch, tag and other ref (or a
newer commit that has it as an ancestor), each stash entry, every worktree, and every working file with the same
content. What is missing stops it with one line that counts each kind (`1 branch, 1 stash entry, 1 working file`),
and nothing is removed. The one exception is a folder that apply left out of the copy (installed packages, build
output): its files are not counted as missing only when both the plan and apply's own record name it AND, asked again
at that moment in the old folder, it is still a folder of drop's list that git ignores as a whole, with no file git
tracks and no repository of its own in it. Before the name is typed, retire (and the page's sheet) names each such
folder with its size and file count, says that it was not copied and goes with the old folder, and gives the command
that makes it again in the new place. A recorded folder that no longer passes, or one that only the plan or only the
record names, stops retire and is named. Another project's clone in the same place that borrows objects from an original (`--shared`) stops it too; for such a clone anywhere else retire can only warn, since it never looks at the whole disk.

**Remove the old folders** (on a project's card after Arrange, and on Arrange's result) is the same retire from the
page. Its sheet shows retire's own lines (what goes, what stays and why), says "There is no undo: nothing can bring
these folders back from Hoprig. The copy in your workspace stays as it is." before the press, and goes ahead only when
you type the project's name into an empty field (the server compares it). The sheet is bound to what retire found when
it opened (the original's fingerprint as retire reads it, what goes and what stays) for ten minutes and is used once:
when anything of that changed, nothing is asked or removed ("This changed since you looked: look again."). Then
retire checks everything again, as above. Only your own page can do it: never Tia, a token of another computer or a
paired script. The routes: `POST /api/adopt/retire/check { name }` and `POST /api/adopt/retire { ticket, typed }`.

### Example

`~/code` on a laptop holds four folders:

```
~/code/
├── shop/        AGENTS.md, project.json, code/shop/       (already in the layout)
├── blog/        web/ (a repository with a stash), web-feature/ (its linked worktree), api/ (a repository),
│                deploy.sh, backups/db.sql, plan.md
├── notes/       a repository with uncommitted work, .env and .env.local (ignored), no-ai/
└── tools/       a repository with .kiro/skills/series, .kiro/steering/about.md, .kiro/hooks/guard.json,
                 and Claude Code sessions started in it
```

`hoprig adopt scan --in ~/code` lists the four with their states and changes nothing. `hoprig adopt plan
~/code/blog` says: `web` → `code/web` with its worktree → `code/web.web-feature`, `api` → `code/api`, `deploy.sh` →
`scripts/deploy.sh`, `backups` → `test-data/backups`, `plan.md` → `ai_brain/notes/plan.md` (to read: is it the plan
the blog came from?), and `deploy.sh:2 names the old folder`. `hoprig adopt apply blog` copies, prints every proof
line, and ends with `blog is arranged in ~/Workspace/projects/blog. Your old folders are untouched: ~/code/blog is
as it was`, then what still needs you (`scripts/deploy.sh:2 names an old folder: listed, not rewritten`). For
`tools` the plan names the skill, the rules file and the hook, and apply adds the pointer
`.claude/skills/series/SKILL.md`, copies the sessions under `~/Workspace/projects/tools/code/tools`, and names
`code/tools/.git/config:<line>` (its credential helper still names `~/code/tools`). `notes` keeps its uncommitted
work uncommitted, its `.env` files and its private folder, copied whole. A week later, `hoprig adopt retire blog`
shows what would go and asks for the name.

What only a computer of that kind can show: on Windows, a project path longer than 260 characters where long paths
are off, the copy of a junction, and which programs work in a folder (not read there); on macOS the same for
programs, and a case-blind disk with two names differing only in case (the path rules are tested with made-up paths;
the copies were run on Linux only).

## Needs: what a project reads from elsewhere

A project holds only its own repositories. When it has to read another entry of the map (a shared library, a vendor
tree), it names it in its own `project.json` instead of copying it in:

```json
{ "name": "shop", "repos": [], "memories": {}, "needs": ["kits/parts"] }
```

- **What a need may name.** A project of the map or a project of a group, by the name the map gives it (`blog`,
  `kits/parts`). Never the AI brain, the credentials folder (in any spelling), a group's own repository as a whole, a
  path, or the project itself. A name the map does not hold is named and left out; it never stops a session, status
  or the upkeep. Needs count only for a project of the map: one that is only on this computer (not in the map) gets
  no extra folder, and status and drop do not read its `needs` (`hoprig workspace map` adds it to the map).
- **Nothing comes by itself.** `hoprig get shop` names each need that is not on this computer, and each need of a
  need with whose it is, in one question (`shop also needs, to read: kits/parts; and kits/parts needs tools`). Only a
  yes, or `--with-needs`, brings them, each by the normal get. Without a terminal, with `--yes` or `--dry-run` nothing
  more comes and the command is said; `--json` gives `needs`, `missingNeeds` and `needsCommand`. On the page, **Get an
  existing project** shows the same lines and question under its result once the project is here, with **Get them
  too** (each need by the same get, and the same yes that lets the sessions read them; a need's own setup questions
  are never answered, as `--yes` never answers them) and **Not now** (`POST /api/pcsetup/project/needs`: its dry run
  is the offer, the press sends back the offer's id and is refused with "This changed since you looked: look again."
  when the offer made now differs). What a need just got names in its turn is offered again, never got without
  another press. Restore, the upkeep
  and a session's start never fetch a need. `workspace status` (and `--json`, key `needs`) names each project's needs
  that are not here.
- **A session reads its needs, once you allow them on this computer.** A `project.json` can come from anyone (a
  cloned project, a pull that adds a need), so a need opens nothing until you say yes HERE: at `hoprig get` (its one
  question, or `--with-needs`), with "Allow" on the project's page or in the new-session sheet, or with
  `hoprig workspace needs allow shop kits/parts`. Your yes is kept in Hoprig's own settings on this computer, never in
  the project, and taken back the same ways (`hoprig workspace needs revoke shop kits/parts`, "Take back"). A
  Claude Code session started in `shop`, in a terminal or in the App, then gets each allowed need that is on this
  computer as an extra folder (`--add-dir`, `additionalDirectories`), decided at its start. A need that is not
  allowed yet, or not here, is said once at the start with its command, and never opened or fetched. Its card and its
  page say "Also reads:".
- **Read, not write, as far as the coding tool holds it.** In the settings Hoprig hands the session, Claude Code is
  denied its file-writing tools (Edit, Write, NotebookEdit) under each extra folder, and Hoprig's own permission hook
  never allows anything there. A shell command could still write there: it is no wall. A need is never written to
  by the project that names it; the generated "Your workspace" rules say so too.
- **An extra folder brings its own protection.** Read is denied under its private folders (`no-ai`, `ignore`,
  `ai-ignore-dir`) and its credential links, and the deny rules of its own `.claude/settings.json` and
  `settings.local.json` are added, re-based onto it. Its allow rules never travel. Only the file tools are refused
  there: a shell command (`grep -r`) can still read its private folders and follows its links, as it can in a session
  of that project itself. So a folder with a link to the credentials folder as a whole, into the AI brain, to a
  folder that holds either (or holds a link into them), or out of the workspace is never opened as an extra folder;
  the start says which link. A link out of the workspace that you named as your own (`hoprig workspace mylink add`)
  is followed, and what lies below it is checked the same way. Every link counts, also one in `.git` or
  `node_modules` (git keeps links, so a cloned project can bring one anywhere). A private folder is never looked
  into, not even for its links, also when it is itself a link or a link leads into one: Read is denied to the file
  tools on the whole private folder and on such a link instead. The check runs once per start, in small pieces so
  the dashboard stays free; a folder it cannot check within five seconds is not opened ("too large to check").
- **One session, one more project: `hoprig --with <name>`** (several allowed), or **Read other projects too**, under
  **More options** in the new-session sheet. It is your own word for that one session, so it needs no yes of its own; the same
  rules hold; nothing is written to `project.json`. A name that is not on this
  computer is refused with `hoprig get <name>`. A session started with settings of your own (`--settings`) gets no
  extra folder, and is told so.
- **Drop asks.** `hoprig drop kits/parts` while `shop` on this computer names it says which projects need it and
  asks that first; a no removes nothing, and without a terminal it is refused with the list. `drop --check --json`
  names `neededBy`.

| Coding tool | Extra folders | Writing there | Its private folders |
|---|---|---|---|
| Claude Code (terminal and App) | yes | refused to its file tools by deny rules; a shell command is not stopped | refused to its file tools by deny rules; a shell command (`grep -r`) is not stopped |
| OpenCode | none: Hoprig cannot keep them read-only there | (told only: a project's needs are named at the start, `--with` and Read other projects too are refused) | (none opened) |

## Drop: a project leaves this computer safely

`hoprig drop <name>…` takes a project off THIS computer only when all of it is on its git server, so that
`hoprig get <name>` can bring it back. Another computer having it does not count: only the git server does. The map
keeps the entry (it is "in the map, not on this computer"); nothing is added to `skip`.

```
hoprig drop shop --check     what of shop exists only here (exit 1 when anything does); changes nothing
hoprig drop shop --dry-run   every step a drop would take, in order; changes nothing
hoprig drop shop             the drop itself (in a terminal: it may ask)
hoprig drop shop blog --json each on its own; one refused does not stop the other; exit 1 when any was refused
```

`--check` and `--dry-run` fetch nothing and write nothing; they ask the git server read-only (`git ls-remote`) and say
so when it cannot be asked. A drop goes in this order:

1. It takes the same lock as `hoprig get` of that project, then fetches (with prune) every git repository in the
   project's folder: the parent, each code repository, and any other one inside (nested, a submodule).
2. It checks each one. A commit is "on the server" when the server's branches or tags reach it; only `origin` counts.
3. It asks, before anything is done:
   - work not committed (a changed tracked file, an untracked file git does not ignore): one question offers to commit
     it on a new branch `wip/<label>-<time>` from where the repository stands and push that branch; the branch you
     were on does not move. What is staged is kept as its own commit;
   - commits only on the default branch: "This pushes `main` of projects/shop/code/shop-api: 2 commits", with three
     answers: push them, push them as a `wip/` branch instead, or stop (Enter stops). A push to a default branch can be
     a release, so nothing pushes one without this yes;
   - files git ignores that cannot be made again, listed one by one with their size (an ignored `.env`, key files,
     `test-data/`, dumps, any ignored file not on the list below): you type the project's name to delete them with it.
     No flag skips this question. Without a terminal there is no question: the drop is refused, with the list.
4. It commits the memory folder, saves the work on its `wip/` branch, and pushes: a branch only ahead of its branch on
   the server, a branch never on the server (under its own name, with its upstream set), and what you said yes to.
   Nothing is ever forced; a tag is never pushed (it can be a release).
5. It fetches and checks everything again. Only when that finds nothing that exists only here does the folder go.
6. The folder is renamed beside itself (`.shop.dropping-<time>`), Claude Code's memory links into it are taken away,
   this computer's file is written without it, and then it is deleted. A project folder that is a link is removed as
   a link: what it points to is never touched. A member that comes with its group's repository loses only its code
   repositories; its own folder with the group's files stays.
7. This computer's file is committed and pushed by the upkeep's own path when its switches are on (`hoprig workspace
   auto --commit on --push on`); else the words say the command that shares it.

After a drop, `hoprig get <name>` brings back every tracked file as it was, and every branch is on the git server:
get checks out the default branch, and each other one is there as `origin/<name>` (`git switch <name>` makes it local
again). A repository inside the project that neither the map nor project.json names is not cloned by get: the drop
names it with its address (add it to project.json, or clone it yourself).

A drop cut off after the rename (a closed lid) is finished by the next `drop` or `get`, after the whole check of the
renamed folder again: a terminal open in the project follows the rename, so work done there since keeps the folder,
named with the command to look at it. A folder in the project that cannot be written (a tool's read-only cache) is made
writable for you before the delete; one that still cannot be deleted is named with `chmod -R u+w … && rm -rf …`, and
`get` goes on meanwhile. A leftover whose delete stopped partway is kept and named the same way: the parts that lost
their git folder can no longer be pushed, while each part that still has one is named with `git -C <part> status`
(push from there first); then look at the rest and delete it yourself. `get` never offers to take such a folder back
under the project's name, since it clones the project there right after. `workspace status` names such a folder with `hoprig drop <name>`, and changes nothing.

**What goes without a word** is only this, decided in one place:
- a folder a build or an install makes again (`node_modules`, `vendor`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`,
  `.dart_tool`, `.gradle`, `Pods`, `build`, `dist`, `target`, `__pycache__`, `.pytest_cache`, `.venv`, `coverage`)
  that git ignores as a whole in its repository (`git check-ignore -q -- <folder>/`), and what is in it. Drop says it
  goes, and does not ask. A folder of that name that git tracks a file of, or ignores only in part, is no such folder:
  what in it is not on the git server is listed; so is one inside another folder git ignores (`test-data/build/` is
  test data). `apps` is not on the list: in most projects it is source, so an ignored `apps/` is listed;
- a credential link that is provably one: a symbolic link that `project.json` names under `credentials` and that
  points to the very file it names in the workspace's `credentials/` (the check `get` makes). `get` makes it again, so
  `--check` only says how many go, never a target;
- a plain file named exactly `.DS_Store` or `Thumbs.db`.

Everything else git ignores is on the typed list with its size, and so is every other link: a real file or a folder
where a credential link should be, a link that points elsewhere, and a link `project.json` does not name (only the
link goes; the file it points to stays). A `.env` the repository tracks is your choice and does not stop a drop.

**Private folders** (`no-ai/`, `ignore/`, `ai-ignore-dir/`): Hoprig never reads the names in them; it only asks git
yes or no, and counts their files. One the repository tracks with nothing changed is on the git server with its
branch and is not listed. One with a change not committed refuses: you commit and push it yourself. One that is not
in git at all (or holds files git ignores) goes on the typed list as a private folder with the number of its files,
whose content is lost unless you keep it elsewhere. This holds at any depth and whatever `.gitignore` says of it
(under a tracked `apps/` or `vendor/` too); only one inside a folder of build output that git ignores as a whole (an
installed package called `ignore` in `node_modules/`) goes without a word.

**What refuses**, each on one line with the repository, the thing found and the command that resolves it: a stash; a
merge, rebase, cherry-pick, revert or bisect under way; a detached HEAD with commits on no branch; a branch that moved
both here and on the server; a branch whose server copy was removed while it has commits of its own (never pushed
back); a tag only here; a repository without `origin`; a linked worktree with work in it, or one outside the project
(remove it first: `git worktree remove <path>`); Claude Code's memory for a folder of the project kept as a real
folder, not a link (it is in no git); a folder that leads out through a link that is not your own.

### Drop from the Workspace page

Everything above can be done on the Workspace page, without a terminal. A project's page has **Take it off this
computer** under Advanced. It opens a sheet that is the terminal's drop, question for question:

- first the check, in the same words `hoprig drop <name> --check` prints: what exists only on this computer;
- then exactly the terminal's questions. Another project here names it in "needs": first "blog needs shop: it names
  it in "needs" and its sessions read it." with a box, unticked, **Drop shop all the same?**; only your tick of it lets
  the drop go on, and a need added or taken away after the sheet opened counts as a change. Work not committed: a box, unticked, to commit it on a `wip/` branch and push
  that branch. Commits on a default branch: three answers, none chosen for you; only "push them" pushes that branch.
  Files that cannot be made again: you type the project's name into an empty field (no paste, no suggestion); the
  computer compares what you typed;
- **Drop it** fetches and checks everything again. When something changed since the sheet opened (a new file, a new
  commit), nothing is dropped and the sheet shows the new list. A sheet is good for one press and ten minutes.

Only you may drop, from your own page: signed in, on the dashboard's own address. A drop on another computer of yours
goes through the main computer with the same sheet; the computer that drops makes the check and compares the name, and accepts it
only from a main computer of yours (one it joined itself, or one that added it by SSH or with a pairing code you made), for that
main computer's own page. A script's token (`hoprig pair --json`), another dashboard's token and Tia are refused. Two cases
of a main computer of yours are refused until you take one step:

- a main computer that added this computer before tokens had the main computer's mark holds a plain token: mark it on this computer's own
  page, Computers, Add a computer, Advanced, Who may control this computer, **Mark as my main computer**;
- a main computer whose Hoprig is older than this computer's does not say that a request comes from its own
  page, so a drop, a group change and Sync with push from its page are refused also when its token is marked: update
  Hoprig on the main computer, then press again.

Tia can check a drop and open the sheet for you; she never drops and never types the name.

What a relayed drop trusts: the main computer's token. The mark that says "the main computer's own page" is set by the main computer, so a program on
the main computer that can read the main computer's list of computers (where that token is kept) can send it too. That token already opens
a terminal on this computer, where `hoprig drop` asks the same questions; so keep the main computer's computers list as private as
a password, and revoke a main computer you no longer use (`hoprig tokens revoke <id>`).

The commits a drop makes hold exactly the bytes its check showed. They are made without running the repository's own commit hooks and are not signed, also where `commit.gpgSign` is set: a hook could change what was shown.

## Before you format this computer

One check of the whole computer names everything that exists only here, each line with where it is, what it is,
its size and what to do (with the command to run). It looks at:

- **branches**: commits on no git server, or a local branch with no copy there (a default branch too: its push stays your own step);
- **work**: changes that are not committed, and files git does not know yet;
- **stashes**: work put aside with `git stash`;
- **repositories with no git server**;
- **folders in no git**: a folder of the workspace (or of `--also`) that is in no repository;
- **the described folders**: something in `backups/` or `database/` that exists nowhere else;
- **memory folders**: a coding tool's memory that is a real folder, not a link into a repository;
- **rules and skills folders** that are not linked to the brain;
- **keys**: a private SSH key with no identical copy in the credentials folder;
- **the Android debug keystore**, by the same rule;
- **the credentials folder**, when it is in no git or has work not on its git server;
- **databases**: an engine runs here and `database/<engine>/` has no dump newer than its newest change;
- **Hoprig's own providers and settings**, named by folder and size only;
- **other programs' folders in your home**: each one is asked about once, "keep (you back it up)" or "ignore".

It never fetches, writes, pushes, moves or deletes anything, and it never opens a database. A key is compared in
memory only; no file inside the credentials folder is named. Your marks (keep, ignore, outside, test data) are the
only thing it writes, and only when you give them. A folder the check must look at cannot be marked outside: the
workspace, its places, a project or repository of it, the brain, the credentials, `~/.ssh`, `~/.android`, Hoprig's
own settings and state and the coding tool's folder.

```sh
hoprig pc leave --check                  # what exists only here; exit 0 nothing, 1 something, 2 a wrong command
hoprig pc leave --check --also ~/Old     # also an older folder: each repository in it, and each folder in no git
hoprig pc leave --check --json           # the same report as JSON, for a script or an AI
hoprig pc leave --outside ~/Desktop/old  # a folder you back up your own way: named, not counted
hoprig pc leave --keep ~/.toolx          # a program's folder you back up yourself
hoprig pc leave --ignore ~/.toolx        # a program's folder that may be lost
hoprig pc leave --test-data postgresql   # this engine holds test data only
hoprig pc leave --unmark ~/.toolx        # check it again
```

The report ends in exactly one of `Nothing is only here: this computer can be formatted.` or
`<n> things exist only on this computer (above).`

**On the dashboard**: Computers, **Before you format this computer**. **Look now** runs the whole check in the
background (it only reads) and shows the same groups; each command is shown with a copy button and never run by the
page. **Keep (I back it up)** and **Ignore** answer a folder's question; **Check it again** takes a folder back
into the look. **Push my other branches** pushes the committed work of every branch that is not the default
branch, in every repository of the map, through the same gates as the upkeep's push; it never pushes a default
branch. Only your own page may press it, and two presses never run at once.

Two looks can run by themselves, both off until you turn them on (Settings → Workspace → By itself → More). **Look once a
day at what is only on this computer** runs this check without asking any git server and keeps only how many things
it found, by kind: never a name or a path. When that number changes it writes one line in Work → Activity, and it
tells you when something exists only here. **Look once a week at the git servers** asks the git server of each
repository of the map that is on this computer whether it still has it and still names its main branch as this
computer knows it. Both only read: nothing is fetched, changed or uploaded, a server that cannot be asked counts as
not looked, and whether a server's history was replaced is not told (that cannot be known without fetching).
`hoprig doctor` shows what the looks found as a suggestion.

The routes: `GET /api/workspace/leave` (starts the whole check, or polls it with `?run=<id>`),
`POST /api/workspace/onlyhere/push` (the press, your own page only) and `POST /api/workspace/leave/mark`
(keep, ignore, outside, test data, or check it again; your own page only).

## Each computer's own file

`ai_brain/computers/<label>.json` is written by that computer only, so two computers never conflict in it:

```json
{ "folders": { "development": { "there": true, "items": [ { "name": "flutter", "kind": "folder", "entries": 1 } ] },
               "database": { "there": true, "items": [ { "name": "postgresql", "kind": "folder", "entries": 2 } ] },
               "git": { "there": true, "items": [ { "name": "hooks", "kind": "folder", "entries": 3 } ], "unnamed": 1 },
               "backups": { "there": false } },
  "here": [ "kits", "shop", "shop/code/shop-api" ],
  "hoprig": "0.3.2", "id": "<32 hexadecimal digits, made once on this computer>", "label": "box2" }
```

- **The label** is your own short name for the computer (lower-case letters, digits, `-` and `_`), asked once at
  set-up; the host name is only offered as a suggestion and is never stored without your word. `hoprig workspace
  label <name>` gives it later, and so does this computer's name field in **Settings → Workspace → Where things are**. On the
  **Workspace** page's computers list, a name another
  computer's file holds asks "Is this computer <name>, set up again?", and **Yes, this is <name>** is the page's
  `--again`. After **Bring my workspace from git**, a computer with no name yet gets one line that leads there.
- **The id** is made once, at random. A label whose file holds another id (in the brain here or on its git server)
  belongs to another computer: set-up refuses it, unless you say this computer IS that one, set up again after a
  format (`--again`, which takes that file over); its file then starts again with an empty list of what is here. Two
  computers that took one label before either file was uploaded: the one whose file came second is told, and may give
  itself another label. A home folder copied to another computer copies the id too: each computer remembers the
  versions of its file it wrote, so a version it never wrote under its own id is noticed, that computer stops writing
  the file and is told to take an id and a label of its own (`hoprig workspace label <name> --new-id`).
- **What is in it:** the map's entries checked out here, the Hoprig version (the upgrade of the map reads it), and the
  four folders that are not in git described in names and counts (`database` one level down, so `postgresql` and
  `mysql` both show under it, as an older Hoprig reads it). Never a path of this computer, a host name, an
  address, a token or a password: a name that is not plain, looks like a secret or a key, or holds the host name is
  counted (`unnamed`), not named.
- `workspace map`, restore, `get` and the upkeep write it when something in it changed; a computer without a label
  writes none and is never asked (status says so). `workspace status --all` says which computer has what.

**Which computer has what** comes from these files only, read and never written by the page: for each entry, the
computers that have it; for each computer, what it has and when its file was written (the last commit of the file in
the brain). A file of another computer is "as of" that day and called old after a week: it may have changed since. A
computer in your Computers list that never wrote a file is named as unknown, never as having nothing. A computer listed
there under another name than its label in the workspace is joined with its file by the label it tells this dashboard
(kept when it is added and at each look; its row says the name it has under Computers). One whose Hoprig is too old to
tell its label is shown as unknown with the files it may be: update Hoprig there and the two are joined. For a project
that is not on this computer, the brain's history of this computer's own file says when it was last here, when it
does. The Workspace page (**Your computers**), `hoprig workspace status --all --json` and `hoprig get --list --json`
give the same answer, from one reader.

## The map: every repository in one file

`<workspace>/ai_brain/workspace.json` lists what makes up the workspace, by address, never by content. It lives in
the AI brain because the brain is the one repository every computer has.

```json
{
  "version": 1,
  "config": { "projectsDir": "code" },
  "brain": { "url": "https://github.com/example/ai_brain.git" },
  "projects": [
    { "name": "shop", "url": "https://github.com/example/shop.git",
      "memories": { ".": "ai_brain/claude-memory" },
      "repos": [ { "dir": "code/shop-api", "url": "https://github.com/example/shop-api.git" },
                 { "dir": "code/shop-web", "url": "git@gitlab.example.com:example/shop-web.git", "branch": "main" },
                 { "dir": "code/sketches", "url": null } ] }
  ],
  "others": [
    { "dir": "development/flutter/flutter", "url": "https://github.com/flutter/flutter.git", "branch": "stable", "sync": false },
    { "dir": "git/tool", "url": "https://github.com/example/tool.git", "branch": "main" }
  ],
  "skip": [ "old-project" ]
}
```

- **The map is the union of your workspace across your computers**, not a picture of one disk. `hoprig workspace
  map` adds and updates what is on this computer (addresses, branches, tool flags, memory links, code
  repositories); what the map has and this computer does not **stays as it is** and is listed as "in the map, not
  on this computer" (never as removed). A computer without a brain remote, or with a projects folder the map cannot
  describe, never blanks what the map says. Only `forget` takes something out. The one exception: a project that
  IS on this computer and whose own `project.json` no longer names one of its code repositories (whose folder is not
  here either): its `project.json` is the truth for it, so that repository is "taken out of <project> by its
  project.json". A linked worktree (`git worktree add`, a second checkout of another repository) is never added to
  the map; an entry whose folder here is one is kept as not on this computer (also when the project's `project.json`
  does not name it: the exception above is only for a folder that is not here at all), and restore and sync leave
  that folder alone. Apart from that one exception nothing leaves the map by itself: `forget` removes a stale entry. `map` shows
  what changed (added, taken out, a changed address), never commits, and prints the
  `git add` and `git commit` to run in the brain. `project new`, `project clone` and `project add` keep it up to
  date by themselves when there is a brain.
- A project's own `project.json` stays the truth for its code repositories. The map repeats them so that one file
  is enough to rebuild everything, and `map` adds a code repository found on disk to a `project.json` that lacks it
  (commit that in the project).
- Addresses are kept without a user name or password (`https://user:token@host/…` becomes `https://host/…`), and
  an address that still looks like it holds a secret is refused. Only https and SSH git addresses are accepted.
- A repository with no remote is listed with `"url": null` ("not on a git server yet") and reported; nothing is
  guessed. Folders named `no-ai`, `ignore`, `ai-ignore-dir`, `credentials`, `node_modules` and dot-folders are
  never looked into. `others` are git repositories elsewhere in the workspace (up to three folders deep), never in
  `ai_brain/` or the projects folder.
- **Tools: `"sync": false`.** A git repository that is a toolchain or SDK (by default everything under
  `development/`, such as a Flutter or nvm checkout) is restored on a fresh computer on its mapped branch, because
  that is how such a tool is installed, but `sync` (also `--with` and the automation) never fetches or moves it: that
  would be an upgrade nobody asked for. `map` says so ("tools: restored on a fresh computer, never synced"), `sync`
  counts them as "tools, left alone", and `status` shows them in their own group. Change it by editing the field:
  `"sync": true` makes a tool synced like the rest, `"sync": false` on any entry (a project, a code repository,
  another repository) makes it a tool; `map` keeps what you set.
- **The workspace's own settings**, so a fresh computer becomes the same place: `config.projectsDir` (the projects
  folder relative to the workspace, written only when it is not `projects`; a projects folder outside the workspace
  is not written: the map never holds a machine path) and each project's `memories` (which folder's Claude Code
  memory lives where, as in its `project.json`). Restore puts the projects there unless this computer chose a
  projects folder before, and links each project's memory as `project.json` says, or as the map says when the
  project has no `project.json`. Nothing from `credentials/`, no host names, no tokens.
- `forget` takes a project, a code repository (`<project>/code/<name>`, as `map` lists it) or another folder out of
  the map and adds it to `skip`, so `map` does not add it back and restore does not clone it from a `project.json`.
- A map read from a repository is checked strictly (unknown keys, names and folders that would lead out of the
  workspace, bad addresses or branch names): a map that fails is not used, and nothing is changed.

## Groups: folders of projects of your own

The default tree has one projects folder. A **group** is a folder of the workspace you add for more projects beside
it, for example one for client work. It is written to the map, so every computer of yours gets the same folders.
A group needs a map of version 2 (below); a new workspace has none until you add one.

```sh
hoprig workspace group add client-work                                   # a plain group
hoprig workspace group add kits --repo https://github.com/example/kits.git --holds packs:group,builds
hoprig workspace group remove client-work                                # only while no project of the map is in it
hoprig workspace group ignore kits                                       # the ignore lines kits lacks, written on a yes
```

On the Workspace page, under **Groups**: **Add a group** shows exactly what goes into the map (and the ignore lines a
group that is a repository needs) before you press **Add it to the map**; **Take out of the map** takes a group out
of the map with the same check as `group remove`, and never deletes its folder. **Text for coding sessions** shows the
"Your workspace" text and writes it on your press (adding a group never writes it). Only your own page may change the
groups or write the text; Tia can prepare a group and open the sheet for you.

- **A plain group** (`client-work/`): every folder in it is a project of the usual shape (a parent repository with
  `project.json` and `code/<repo>`), exactly as in the projects folder.
- **A group that is a repository** (`kits/`, `--repo`): it has its own files (an `AGENTS.md`, an `ai_brain/` with
  its memory, its tools) and keeps its projects in the folders it **holds**, never at its top. A held folder says
  whether each of its projects is a repository of its own (`builds`: `kits/builds/<project>`) or comes with the
  group's repository (`packs:group`: the group tracks `kits/packs/<project>`'s small files, only its `code/<repo>`
  folders are repositories).
- **The group's repository ignores what it holds.** One `git add` in `kits/` must never take a project, so its
  `.gitignore` needs `/builds/*/` and `/packs/*/code/`. `group add --repo` and `group ignore <dir>` show the lines
  it lacks and write them on your yes (`--yes` without a question); `workspace status` warns while git would still
  take a project or another repository inside it, and sync never counts a project as a change of the group.
- **Hoprig stays inside a project's own folder: a link that leads out is not followed unless you named it as
  yours.** Every place Hoprig acts (a clone, a fetch, a push, a commit, a file written or copied, a memory link, a
  dependency install, a hooks setting) must, with every link resolved, lie inside the real folder of its entry (the
  project's, the group's, the member's, the code repository's), and that folder must lie where the map puts it, with
  no link on the way. A repository is data from a git server: when it brings `builds -> /somewhere/else`,
  `code -> ..` or `.env.example -> ~/.ssh/...`, nothing is done there; a file is never written through a link. There
  is no difference between a link a repository brought and one you made by hand, except the links you name as
  yours on this computer: `hoprig workspace mylink add <path>` (a project folder you keep on another disk), kept in
  Hoprig's own settings, never in the map, never synced. `workspace status` names every other link it met with that
  command, and the project page shows a code folder that is not followed. The check is made at each act, so what it
  cannot see is a folder that a program already running on this computer swaps for a link in the instant between
  the check and the act, or a bind mount (it looks like a folder): the rule guards against what a repository brings,
  not against a program that already runs as you.
- **Names.** A project of the projects folder is `<name>`; one in a group is `<place>/<name>` (`client-work/shop`,
  `kits/packs/blog`). A name is unique in its place, so two places may each have a `blog`: every command, the page
  and Tia take the bare name when only one place has it, and refuse it naming both forms when two do; the projects
  folder's own is then `projects/<name>`. The map's `skip` list uses the same names, so
  `forget kits/packs/blog` never hides `client-work/blog`. One repository is in one place only: the map refuses the
  same address in two places when a command writes it, and the scan does not add a folder whose address the map has
  in another place. A duplicate that arrives through a merge on the git server is used, and `workspace status` names
  both entries with the `forget` to run. A project of the projects folder may have the name of a group's folder:
  they are two folders.
- **Memory.** A session started in a project of a group uses that project's own memory when it has one
  (`ai_brain/claude-memory`), else the group's; a session started in the group's own folder uses the group's.
  Restore, `hoprig get` and `hoprig project link <place>/<name>` make those links (`hoprig project link <group>`
  the group's own); for a project or a group that was here before, restore and `get` say a missing link with that
  command instead of making it.
- **Everything that listed the projects folder lists every place**: `workspace status`, `map`, `sync`, restore (a
  group's repository is cloned before its projects), the Workspace page (one section per place), the new-session
  list, `project status|sync|link`, and Tia's project list. `project new` stays in the projects folder unless
  `--in <group>` is given; `hoprig get <place>/<name>` (or `--in <group>` for a project the map does not have yet)
  puts a project into its group. `group add` drops nothing from the map: a repository an earlier map listed as
  "other" inside the new group's folder becomes the project (or the group's own repository) it fits as, every other
  one stays another repository, and it says which for each. A repository in a group's folder that is no project
  (a tool folder of the group, a folder of folders in a plain group) is another repository.
- **Folders are written one way.** The map holds `client-work`, never `client-work/` or `./client-work`, and no part
  of a folder starts with `-`; reserved names are compared without letter case (`Credentials` is `credentials`).
  What you type is tidied first (`group add a//b/` adds `a/b`).

The map with groups (version 2):

```json
{
  "version": 2,
  "brain": { "url": "https://github.com/example/ai_brain.git" },
  "groups": [
    { "dir": "client-work" },
    { "dir": "kits", "url": "https://github.com/example/kits.git", "memories": { ".": "ai_brain/claude-memory" },
      "holds": [ { "dir": "packs", "parent": "group" }, { "dir": "builds" } ] }
  ],
  "projects": [
    { "name": "shop", "url": "https://github.com/example/shop-workspace.git", "repos": [ … ] },
    { "name": "shop", "in": "client-work", "url": "https://github.com/example/acme-shop.git", "repos": [] },
    { "name": "blog", "in": "kits/packs", "url": null, "repos": [ { "dir": "code/blog-theme", "url": "…" } ] },
    { "name": "blog", "in": "kits/builds", "url": "https://github.com/example/blog-build.git", "repos": [] }
  ],
  "others": [ … ],
  "skip": [ "kits/builds/old" ]
}
```

The strict check covers every new key, one rule each: a group's folder and a project's `in` are folders inside the
workspace (no `..`, no full path, none of the folders the map never looks into, none of the workspace's own
folders), `in` names a declared group or held folder, a project that comes with its group has no address of its
own, a name is in its place once, no other repository is where a group, its held folder or a project of it is,
and only a group that is a repository keeps memory or holds folders. The upkeep never stops on the map: what keeps
it from being written is skipped with its reason, which `workspace status` shows.

**Version 1 and 2.** A map of version 1 is read as it is and stays version 1: the upkeep never upgrades it.
`hoprig workspace map --upgrade` does, once, when you run it. A computer whose Hoprig knows only version 1 refuses a
map of version 2 and changes nothing in it, but its map then stands still until Hoprig is updated there, so update
Hoprig on every computer first. The upgrade says how many computers reported a Hoprig that reads version 2 and which
reported an older one, and always that a computer that never reported cannot be seen from here; it asks once, with
"no" as the default. It keeps the content as it is and drops entries whose folder here is a linked worktree (a
second checkout an older map took for a repository).

**The map's old form, on the page.** Settings → Workspace says "Your workspace map is in the old form" while the map
is version 1, with **See what the upgrade changes**: a sheet with the entries that leave the map, that nothing on
disk changes, the same lines about the computers as the command, and what undo can and cannot do. **Upgrade the map**
does it (`POST /api/workspace/map/upgrade`, the owner's own page only); when the map changed since the sheet was
opened it says "This changed since you looked: look again." and changes nothing. Before the upgrade, the page and
`--upgrade` keep the old map's exact text in Hoprig's state folder (never in the brain). **Undo the upgrade**
(`hoprig workspace map --undo`) puts it back while the map is still exactly what the upgrade wrote, and removes the
kept copy; once the new map is saved in the brain's history and shared, your other computers have the new form, and
undo here does not reach them. The button stands under the line "The map was upgraded on this computer. Undo puts the
old form back while the map has not changed since."

**A folder that differs only in letter case.** A folder `Shop` for the map's entry `shop` is named by
`hoprig workspace status` and on the page: "The folder Shop is shop in the map". On a disk that ignores letter case
(macOS and Windows by default) it is one folder that other computers spell another way; on one that keeps letter case
the entry looks missing. `hoprig workspace map --fix-case [--dry-run] [--yes] [--json]` and the page's **Give it the
map's name** (`POST /api/workspace/map/case`) rename it through a temporary name in the same folder
(`Shop` → `.hoprig-case-shop` → `shop`), because a direct rename may do nothing on such a disk. Nothing is renamed
when the map's name is there as another folder, when two folders differ from it only in letter case, when the folder
is a link or not really inside its place, or when a program works in it (asked of the system on Linux; elsewhere the
sheet says to close any session there first). A rename cut off between its two steps is named ("halfway through its
rename") and finished by the next one. `--fix-case --undo` and **Undo the rename** (under "A folder was given its name in the map on this computer.") give
the old names back. Which kind
of disk it is, is asked of the disk with a file made and removed at once. This was tested on Linux only, with the
disk's answer given by the tests; no Mac ran it.

### A naming rule per place, and the look-up on the hosting site

The map is the union of what your computers have seen. A project that is only on the hosting site can be fetched by
one word when its place says how its repositories are named. A place whose projects are repositories of their own
(a plain group, or a held folder without `:group`) may carry a rule:

```json
{ "dir": "builds", "find": { "parent": "{project}-{product}-project", "code": "{project}-{product}-*",
                             "folder": "{product}-{project}", "make": ["code", "apps"], "skip": ["old"] } }
```

- A placeholder (`{project}`, `{product}`: a word of lower-case letters and digits in braces, never a name every
  object has such as `{constructor}`) stands for one word of a name, never one with a hyphen; `parent` uses one or
  two of them and a fixed part, `folder` and `code` use all of the parent's (else every repository of the account
  that fits `code` could become one project's code), `code` may end in `*` (the rest of the name). The check refuses
  a pattern whose parts cannot be told apart (`{a}{b}`, `{a}.{b}`). `make` lists the folders made in a fetched
  project (default `code`; plain names, never `ai_brain`, each once whatever its letter case); a code repository
  whose `*` part holds a word of `skip` is left out.
- `hoprig workspace find --in kits/builds [--json]` lists what the signed-in account and its organisations have that
  fits and the map has not: each project with its code repositories and its folder (`shop-alpha-project` →
  `kits/builds/alpha-shop`), and what does not fit exactly (another count of hyphens, no fixed ending, an excluded
  word, a code repository without a parent) as "does not fit", never guessed. `--add` writes the projects into the
  map and clones nothing; `--place-it <repository> <folder>` records one that does not fit under the folder you name.
- `hoprig get shop --in kits/builds` (or `hoprig get kits/builds/alpha-shop`) looks the project up, shows the parent,
  its code repositories and the folder, and after one yes fetches it; its entry is written into the map only once the
  clone succeeded (a failed one says `hoprig get kits/builds/alpha-shop` to try again). Two fits for one word are one
  question at a terminal; with `--json`, without a terminal or with `--dry-run` they are an error naming both.
  `get alex/shop-alpha-project --in kits/builds`, a git address or the bare repository name follow the rule the same
  way (its folder, its code repositories), or are refused plainly when the name does not fit. `--in` is checked
  before anything is looked up.
- In such a place one repository is in the map once (`--place-it` refuses an address the map has), a folder that
  differs from one of the map's only in letter case is refused, and a repository renamed on the hosting site is
  matched by what the site answers for its old name: it is not added again.
- **A parent without `project.json` in such a place is another tool's project, and Hoprig writes nothing into it**:
  no `project.json`, no ignore line, no renamed file, no hooks setting, no `.env`. What it needs to know is in the
  map's entry. `get` and restore clone the parent and its code repositories, make the folders of `make` and link its
  memory (in Claude Code's own folder); a parent that does not ignore `code/` is said, not changed. A project another
  tool made in such a place is seen by the next scan and written into the map. In a plain group without a rule a get
  still writes a `project.json` after asking.
- **On the page: "Look on the git server".** In **Settings → Workspace**, the map's part lists each place with a
  naming rule under **On the git server**, with a button **Look on the git server**. It shows what the command lists:
  each project with its parent repository, its code repositories, its folder and what the rule leaves out; what is in
  the map already (and whether it is on this computer); and what does not fit the rule, never guessed. Without the
  GitHub sign-in it says so and offers the GitHub sign-in this dashboard already has; a place without a rule and a
  look where nothing fits say that too. **Add these to the map** first shows which entries go in ("Nothing is cloned")
  and adds exactly those on your yes; when the map changed since you looked, the yes is refused with "This changed
  since you looked: look again." **Take them out again** right after takes out exactly the entries that add wrote,
  and leaves one that changed since. **Get** on one project first shows where it lands and what is cloned, then
  fetches it as `hoprig get <owner/name> --in <place>` does, as the page's background job (one at a time). A clone is
  not undone from there; Drop on the project's page puts it away again. Each of these is your own press on this
  computer's page (or a main computer's of yours): Tia, a script's token and another site are refused.

### A group's own command

A group that is a repository may name one command of its own:

```json
{ "dir": "kits", "url": "https://github.com/example/kits.git", "tool": { "name": "kit", "run": "kit.sh", "needs": ["git", "jq"], "needsOn": { "mac": ["pod"] } } }
```

```sh
hoprig workspace tool                     # each group's command: made, or waiting for your yes, and what it lacks here
hoprig workspace tool allow kits          # shows the name and the file, then makes the command after your yes
hoprig workspace tool remove kits         # takes it away again (only a command Hoprig made)
```

A map comes from a git server, so a command in it is never made by itself: only after your yes on this computer
does Hoprig write a small `kit` beside its own `hoprig` command. The yes is kept in Hoprig's own settings with what
you were shown: the group's address, the name and the file. `kit` does not start the file itself: it starts
`hoprig workspace tool run kits -- <your arguments>`, which checks at every start that the group is here with that
address, that the map still says that name and file, and that the file is a regular file really inside the group's
folder that the group's own repository tracks (never a file of another repository cloned into its folder, nor one it
does not track or ignores), and only then becomes the file (the same arguments, exit code and signals). Anything else: it does not
start, and says why in one sentence and how to allow it again. A name that is `hop`, `hoprig` or a command already
on your PATH is refused, and nothing at that name that Hoprig did not make (a dangling link too) is replaced; when
the folder is not on your PATH you get the line to add. No shell start file is edited, and Hoprig never runs the
command itself. Restore, the upkeep and `workspace status` say the truth about each command: made, waiting for your
yes, or why it would not start; status also names the programs of `needs` this computer lacks, and the kit that
installs one where Hoprig has it.

On the **Workspace** page, under **Groups**, **Commands of your groups** shows each group's command: the file it
starts, that every argument is passed on unchanged and that Hoprig never runs it by itself, the programs this computer
lacks for it, and its state here (waits for your yes, allowed here, asks again because the map changed it, would not
start, with why). **Allow on this computer** first shows what the yes makes (the group's address, the name, the file
and where the small command goes) and makes it only when you press **Allow on this computer** in that sheet (**Not
now** makes nothing); when the file changed after the sheet opened, it says "This changed since you looked: look
again." and makes nothing. **Remove the command from this computer** is the undo. These are your own presses: Tia,
a script's token and another computer's request without your page's mark are refused. The page calls the same
functions as `hoprig workspace tool allow` and `remove`.

### Your workspace, for coding sessions

`hoprig workspace rules` shows a short text about this workspace: its folders that are here, your groups that are
on this computer, a group's command only when you allowed it here, and the commands to ask where things are. The map
comes from a git server, so nothing of it goes into a file a coding tool reads as instructions without your yes:
`hoprig workspace rules --write` shows the text, asks (or `--yes`), and writes it into one file of Hoprig's own,
`~/.claude/rules/hoprig-workspace.md`, which says in its first line that Hoprig made it and ends with a closing line of its own; Hoprig replaces it as a whole.
Names that are not plain (letters, digits, `.`, `_`, `-`, at most 64 characters) are left out and named. The upkeep,
a restore and the group and tool commands never write it, your working rules file is never touched by it, and
`workspace status` says when the file is older than what the map says now. The first `hoprig pc setup` at a
terminal offers it as one question.

## Restore: the brain and what every computer has

`hoprig workspace restore <address>` clones the brain into `<workspace>/ai_brain`, reads the map, shows the plan
(every repository and where it goes), asks once, then clones the credentials repository when the map names one
(into `credentials/`, only its owner may open it), each group's own repository and the other repositories, and makes
the missing folders of the tree. Every project is listed as "in the map, not on this computer", with `hoprig get
<name>`. With `--with-projects` it also clones each project's parent and its code repositories (and any code
repository its `project.json` names that the map does not have yet) and finishes each project it cloned like
`project clone`: memory folders linked, git hooks, `.env.example` copied, the dependency installs offered. A project
that was here already is not changed: what it misses is said, with `hoprig project setup <name>`. `--dry-run`
writes nothing in the workspace; to read the map of a brain that is not here yet it clones the brain into a
temporary folder of the system and removes it.

- Each project goes into the folder the map names, whatever its repository is called (`shop` for
  `example/shop-workspace`; see [PC-SETUP.md](PC-SETUP.md#project-workspaces) for the rule `hoprig get` uses).
- Run it again and it only gets what is missing. What is there is never overwritten or moved: the same repository
  counts as done; a folder that is something else is reported and left alone. A project that is here under another
  name (the map says `shop`, the disk has `shop-workspace` with the same address) is not cloned a second time: restore
  and `workspace status` show the `mv` that gives it the map's name. A folder that is itself a project of the map
  under its own name (two entries may share one address) is in its place, never offered as another's copy. An
  address counts as the same in every spelling (ssh or https, `.git` or not; on the usual hosting sites the letter
  case of owner and repository too).
- A repository that cannot be cloned (no access, deleted) is listed with git's own reason, and the rest goes on.
- A brain folder that is another repository stops it before anything changes. The one exception is the starting
  brain `workspace setup` made and nobody changed (only its own files and first commit, no remote): it is kept
  aside as `ai_brain.unused-<time>`, so restoring after setup works.
- In the dashboard (no terminal) git may not ask for a password and ssh may not ask about a host key: such a
  repository fails with the reason instead of waiting.

## Sync: every repository in step

`hoprig workspace sync [<project>]` (or `hoprig sync [<project>]`) goes through every repository of the map that is on
this computer (or only that project's), the brain first, with the same engine as `project sync`, leaving tools alone
and saying only how many projects are in the map and not here: fetch; fast-forward a branch that is only behind; push a branch that is only ahead **only
with `--push`**. Uncommitted work stays where it is and does not stop a fast-forward, unless the new commits touch
the same files: then git refuses and nothing is changed. It never merges, rebases, forces or stashes. Whatever needs
a decision (both sides moved, something to pull into files with uncommitted changes, no upstream, a push that failed,
the brain, a group's repository or another repository not on this computer) is listed with the exact command. `--memory` first commits the memory folders (the brain's `claude-memory/` and each
project's), and only them. `--dry-run` changes nothing, not even a remote-tracking ref: it does not fetch, it asks the server for each branch's commit (`git ls-remote`) and says what it would pull and push (new commits that are not on this computer yet are named, not counted). `--with` does the same with the other computer.

## The upkeep the dashboard does by itself

While the dashboard runs (`hoprig serve`, or the background service), right after it starts and then every few
hours. The automation setting `workspace` (the same in the dashboard and in `hoprig workspace auto`). It never asks a
question, never clones a project, and moves a project only by the `ffProjects` look below:

| Switch | Default | What it does |
|---|---|---|
| `map` | on | **The map keeps building itself.** It looks at the workspace as `map` does (the union rule) and writes `workspace.json` only when something would change: a new project or code repository, a new address. Nothing changed: no write and no message. It never makes the first map (that is your `hoprig workspace map`), and it leaves `project.json` files alone. A computer with a label also writes its own file in the brain when something in it changed. |
| `commitMap` | off (on when the brain has a git server address and you never chose) | The map and this computer's own file are saved in the brain's history in one commit of those two files ("Update the workspace map"), with the brain's own git name and e-mail. Never while the brain has other staged changes: then the map is written, not committed, and you are told why. |
| `memory` | off | The memory folders of the brain (`claude-memory/`) and of each group's own repository are committed, and only them. Any other uncommitted change is never committed silently. With `commitMap` and `push` on, the brain's memory commit is carried over by the map's rule too (below). |
| `sync` | off | The brain, the credentials repository, each group's own repository and the other repositories are fetched and fast-forwarded, as `workspace sync` does (tools left alone). A project is moved by `ffProjects`, not by this switch. |
| `push` | off | Uploads what is purely ahead: sync's pushes, and the brain. With `commitMap` on, the brain is fetched every round and brought in step by the map's own rule (below); the map's own commits go up even with this switch off, and nothing else of yours does. |
| `pushBranches` | none | One switch per place that holds projects (`projects` for the projects folder, else the group's or held folder's name): committed work on a branch that is not the repository's default branch is pushed (to its upstream, or under its own name); a default branch never is, nor a branch whose upstream is another branch on this computer. Nothing is ever forced: every push is a plain push, which git refuses when it is not a fast-forward, and a branch behind or rewritten here is only said. A push of a branch without an upstream sets it (its first push, or one already on the server from a push without `-u`), so once its branch on the server is removed and a fetch here prunes it, it shows as gone and is never pushed back. When the last fetch did not prune, the server is asked once per repository which branches it has and which one it calls its default (`git ls-remote --symref`): a branch removed there, or moved there from elsewhere, is said and not pushed; when the server cannot be asked, or calls another branch its default than this computer knows, nothing of that repository is pushed in that round (the second with `git remote set-head origin --auto`). A branch that follows another git server than `origin` is said, never pushed. |
| `credentials` | off | A change in the credentials repository the map names is committed ("Update credentials", with that folder's own git name and e-mail) and pushed to that address only; a GitHub address only when `gh` says it is private in that round. Public, or a visibility `gh` cannot give: nothing is pushed, and you are told once. Without this switch a change there is never committed. |
| `ffProjects` | `projects` on | One switch per place that holds projects (`projects` for the projects folder; a group's own place is off unless you set it). Every 30 minutes, right after start and before a session or chat starts there (3 seconds at most), each project is fetched and a clean branch that is only behind is fast-forwarded, only where nothing is under way and no session is open in that folder. What is left is listed as Not in step on the Projects page. Never a merge, reset, rebase, stash or push. All places off: no look at all. `hoprig workspace auto --ff projects=off`. |
| `everyHours` | 6 | How often (1 to 168). |

```sh
hoprig workspace auto                                   # show the switches
hoprig workspace auto --commit on --push on --every 3   # --map --commit --memory --sync --push on|off, --every <hours>
hoprig workspace auto --push-branches projects=on       # one place's switch for the other branches
```

The first-run question offers `commitMap` and `push` together as one choice: "keep the map on your git server by
itself". When keeping in step (`sync`) is on and `push` is off, the question says that `push` also uploads the groups'
own repositories and the other repositories, and its default is no.

### The map keeps itself between your computers

Two computers that add different projects in the same hour both commit the map, and the second push is refused.
When the brain here and on the git server have both moved and the only difference on this side is the map or this
computer's own file, that is never your problem: Hoprig resolves it by its own rule, in code, never by git's text
merge. It is the one narrow exception to sync's rule "never merges, rebases, forces or stashes":

1. fetch;
2. only when every commit that is here and not on the server is Hoprig's own: a save of the map ("Update the
   workspace map", at least one file, nothing but `workspace.json` and `computers/<this computer>.json`) or of the
   brain's memory folder ("Update AI memory", nothing outside `claude-memory/`, and the server changed none of those
   files). A merge commit or any commit of yours, also one that changes no file or only the map, stops it. Those two
   files have no uncommitted change and nothing is staged; no rebase, merge, cherry-pick or revert is under way and a
   branch is checked out. Then the commit the branch is on is kept under `refs/hoprig/kept/` (the newest 20 stay),
   the memory files are put on top of the server's commit in one commit of Hoprig's own, and the local branch is
   moved there keeping the working tree (`git reset --keep`; a file the server changed that has a change here stops
   it, and so does a file it would bring that is here untracked or ignored: nothing is changed);
3. three-way: only what this side added since the common commit goes into the server's map. The server's map is
   taken as it is; a project, group, code repository or other folder that this side's map has and the map at the
   commit where the two parted (git's merge-base) lacks is added when the server's map lacks it; one that both of
   those have and the server's map lacks was removed or renamed on the other computer and stays out. With no map at
   that commit nothing of this side's map is put in. A `forget` on either side wins, for good. Then this disk is
   merged in by the union rule; an entry of this side that does not fit the server's map (a name that differs from
   one there only in letter case) is left out and named, and the rest goes on; this is checked before anything moves.
   When that changes nothing (this computer was only behind), nothing is written, committed or pushed and no
   activity line is written; else both files are written, committed and pushed;
4. when the push is refused because the server moved again: again from 1, three times at most, then you are told and
   the next round tries again. A push the server refuses by a rule or a hook (a protected branch) is said at once, in
   its own words.

In every other case nothing is touched and you are told, as before. One name whose folder here has another address
than the map keeps the map's address, in every round of the upkeep and in the rule, and you are told (else two
computers would change it back and forth on the git server); `hoprig workspace map`, run by you, gives the map this
folder's address, and the rule takes it up as a change of this side's (when the server's map changed that address too
since the two parted, the server's stays and you are told again). A
project or a repository removed or renamed in the map on one computer is not brought back by another computer's
older map (only a folder that is still on that other computer's disk comes back, by its scan, as any folder there
does). A round cut off between steps 2 and 3 is finished by the next one: what step 3 was about to write is kept
beside the brain's git folder until it is written, and then it is written as it is.

Each real change is one line in the activity log ("The map gained shop/code/shop-admin"). A notification comes
only when something needs you (a repository with no address, the brain's staged changes in the way, the brain and
its git server both moved), and the same list is not told twice. `hoprig workspace status` (and the dashboard)
says when the map on disk is not saved in the brain's history yet, with the command that saves it.

## Between your computers, without a git server

`hoprig workspace sync --with <computer>` gets the commits straight from another computer of yours, over SSH, for
a repository that has no git server or a server this computer cannot reach. Only a computer added by SSH (`hoprig
machines`) is used, at the address stored there; its own Hoprig says where its workspace and projects are.

It is **pull only**, on purpose: `git fetch` over SSH runs git-upload-pack there, which never writes on the other
computer. Pushing into its repository would change a branch that may be checked out there. What is fetched lands
under `refs/hoprig-peer/<computer>/<branch>` (not a branch, not a remote), and the branch here is fast-forwarded
only when it is only behind (uncommitted work stays, as in `sync`). The other computer gets this one's commits the same way, by running
`sync --with` itself.

## Credentials: a repository when you choose it

By default `credentials/` is a local folder that only you can open (mode 700), never in git. If a computer that is
formatted or lost must cost nothing, you can make it your own private repository:

```sh
hoprig workspace credentials                              # its state: a local folder, or a repository and its address
hoprig workspace credentials --repo https://github.com/example/credentials.git [--dry-run]
hoprig workspace credentials --github [<name>] [--dry-run]   # a new private repository (default name: credentials)
```

**This is a choice with a cost.** Whoever can read that repository reads every key in it, and a private repository
is only as safe as the account it is in. Hoprig says so once before it does anything, and you confirm by typing the
repository's name (the last part of the address). No option skips this, and without a terminal nothing is done.

- Hoprig never makes the repository public (`gh repo create <name> --private`) and never pushes to one that is
  public. For a GitHub address it asks `gh` for the visibility, at the start and again right before the push; an
  answer it cannot get (gh missing, not signed in, not found, an odd answer) is a refusal. It asks about the
  repository git really reaches: a `url.<base>.insteadOf` rule (in git's global settings or the folder's own) that
  sends the address to another owner, another name or another server is refused, wherever the rule is written
  (a settings file or the environment: the question is asked of git in the same environment the push runs in).
  An address in a shape Hoprig does not know for certain (a one-letter host, a relative path, a network share, a
  transport helper) is refused, never taken for a folder on this computer, and so is a remote that a helper program
  pushes (`remote.origin.vcs`). An address on another server is held to the same: a rule that sends it to a third
  place is refused. For another server Hoprig cannot ask: what you type confirms that it is private.
- What it does is all or nothing: the folder becomes a git repository if it is not one, everything in it is
  committed as "Credentials", the remote is set and it is pushed; then the map gets
  `"credentials": { "url": "<address>" }`. A failure undoes what that run did in the folder. A folder that is a
  repository with another remote, or a server repository with commits the folder does not have, is refused and
  nothing is changed (to get such a repository here, move the folder aside and restore). It needs a map of version 2
  (`hoprig workspace map --upgrade`). The folder stays mode 700 at every step.
- Restore clones it right after the brain, before any project. When it cannot be cloned, restore says git's reason
  and goes on. `sync` keeps it in step like the brain, and pushes it only under the same rule. The upkeep's switch
  `credentials` (off) commits and pushes a change by itself.
- Nothing from it leaves through Hoprig: no value, no file name inside it and no diff of it in any output, log,
  activity line, notification, the map or the dashboard. What is said is counts ("1 changed file").
- **On the Workspace page** (Settings → Workspace, under Workspace folders) the credentials line says where they are
  kept: on this computer only, or in a private repository of yours with its address (never a file in it). For a
  plain folder, **Make it a private repository** offers the same two choices as the command: a new private repository
  on GitHub, or the address of a repository you made yourself. The sheet shows the plan first (the cost sentence
  above, the steps, what GitHub says of its visibility), says "There is no undo: Hoprig does not take a push to a git
  server back. The folder on this computer stays as it is.", and goes ahead only when you type the repository's name
  (for another server you also tick that it is private). The server compares the name as the command does, refuses a
  plan that changed since you looked ("This changed since you looked: look again."), asks the visibility again right
  before the push and runs the step as the page's background job. Only your own page can do it, never Tia. With a
  map of version 1 the line says to upgrade the map first.
- **The upkeep's switch on the Workspace page.** Settings → Workspace, By itself, under More, shows **Save and upload the
  credentials by itself** beside the other switches, only when the credentials folder is a repository, and off until
  you turn it on. Its sentence: "At each look of the upkeep, every change in the credentials folder is saved and
  uploaded to its repository, by itself, only while that repository is private. Whoever can read that repository
  reads every key in it." It sets the same setting as `hoprig workspace auto --credentials on|off`, through the route
  the other switches use, with the same checks. Tia cannot turn it on.
- **Move to another computer** (the same line, shown only when there is another computer of yours): by your press only,
  sealed so that only the receiving computer can read it, with a list of names and sizes first (never a value or a
  hash). Each computer makes an X25519 and an Ed25519 key once, in its state folder, and writes only the public keys
  into its own file in the AI brain; a key that changes blocks sending until you press **Trust**. The sender seals the
  files (ephemeral X25519, HKDF-SHA256, AES-256-GCM, an Ed25519 signature) with a one-time number the receiver made
  (good for a few minutes, once); the main computer only passes sealed bytes on. The receiver writes through a
  temporary folder, files 600 in folders 700, never over a different file unless you press Replace, and then makes the
  project's credential links. A computer marked as not yours (Advanced) gets one project at a time, with its name
  typed, never everything. The log (`credmove.log`) holds counts and computer names, never a value. Only your own
  page can do any of it, never Tia.
- **Every computer that keeps this brain in step needs a Hoprig as new as this computer's before you run
  `workspace credentials`.** Some older builds that also call themselves 0.3.3 already sync the credentials repository the map names, and
  with `sync --push` (or the upkeep's push) it pushes a commit made there without asking whether it is private or
  whether its remote is the map's address. Version 0.3.2 and older do not sync that repository at all.

### Credential links

A project says which file or folder of `credentials/` it sees, and under which name, in its own `project.json`:

```json
{ "name": "shop", "repos": [ … ], "credentials": { "code/shop/.env.local": "shop/shop.env.local" } }
```

The key is where the link is, relative to the project; the value is what it points at, relative to
`credentials/`. Both are plain relative paths (no `..`, no absolute path, no empty part, nothing in `.git`, never
`project.json` itself); a refused entry is named and the rest of the project is used as usual. A fresh clone makes
the links (`hoprig get`, `restore --with-projects`, `hoprig project setup`), and so does `hoprig workspace link` for
every project here; each takes `--dry-run`. A link is relative, so it holds no path of this computer and survives the
workspace being moved. It is made only where it is safe:

- in a place git ignores: a link in a place the repository tracks, or does not ignore, is refused, with the line to
  add to that repository's `.gitignore`;
- never over anything: a real file there is named and left, a link that points elsewhere is reported and left, a
  link that is right already is left as it is;
- only to a target that is there and really inside `credentials/` (also through a link inside it): a missing target
  is named, no link to nothing is made, nothing is ever replaced by an empty file, and nothing is written into
  `credentials/`;
- never in a `.git` folder (also not through a link on the way), never a code repository's own folder or one that
  holds it; a place inside a code repository that is not cloned yet waits for its clone (its own `.gitignore`
  decides), and a place in a repository git cannot read is refused;
- a right link that is already there in a place git does not ignore is left as it is and named, with the fix;
- when the credentials are not here (no folder, an empty one, the starting folder of `workspace setup`, a clone that
  was cut off), each link is "waiting for the credentials" and the next `hoprig get`, restore or
  `hoprig workspace link` makes it, also in a project that was here already.

`hoprig workspace status` names each link that is missing, waiting, broken or refused, with its place and target as
`project.json` names them.

## Git and GitHub

One step of `hoprig setup` and `hoprig pc setup`, and `hoprig workspace git` on its own. The dashboard's Setup
does the same in the page, without a terminal: a small form for the name and e-mail; **Sign in** shows the
one-time code from `gh auth login --web` with a copy button and a link to github.com/login/device, you confirm it
there and gh finishes by itself (then `gh auth setup-git`); **Keep on GitHub** puts the brain into a new private
repository as a job. No GitHub password or token goes through the dashboard:

1. The GitHub sign-in: `gh auth login` in the terminal (you confirm a code in the browser), then
   `gh auth setup-git`, so plain git uses that sign-in too. Only the account name is ever kept or shown.
2. git's name and e-mail when they are missing. Once signed in, GitHub's no-reply address is suggested (it keeps
   your own address out of commits); nothing is made up.
3. **One path, asked once.** Set-up looks for your brain on GitHub: a repository of your account or your
   organisations whose name has "brain" in it and that holds a `workspace.json`. Found: *get it on this computer?*
   (the brain, the credentials and groups' repositories; projects when you ask). Not found: *start it here?* (the
   workspace, its brain and the first map; the brain goes into a new **private** repository at once, never public).
   Two that look like a brain: which one, asked. Then this computer's label (once) and *keep the map on your git
   server by itself?* Without a terminal nothing is made on GitHub, nothing restored and no label stored: the
   commands are said. A brain with another name: `hoprig workspace restore <its address>`. In the dashboard the same
   path is one press on Settings → Workspace while there is no map.

Other git servers (GitLab, your own SSH server) work for map, restore and sync through plain git with your own
sign-in (SSH key or credential helper). Only this sign-in help and creating a repository are GitHub's.

## Changing where things are

`hoprig workspace set --dir <folder> --projects <folder>` changes where the workspace and the projects folder are
for everything from now on. Nothing is moved: the `mv` that would move the files is shown, to run yourself.

## The command in every shell

Node.js installed with nvm is only on PATH in an interactive shell, so `ssh <computer> hoprig doctor` used to say
"command not found". `hoprig setup` (the installer runs it) writes two small scripts, `~/.local/bin/hoprig` and
`~/.local/bin/hop`, that start Hoprig with the full path of its Node.js, and puts `~/.local/bin` on PATH in
`~/.profile` (and `~/.bash_profile` when there is one). It also puts it at the **top** of `~/.bashrc`, before the line
that stops a non-interactive shell (when bash is your shell or that file is there); in `~/.zshenv` (when zsh is your
shell, on macOS, or that file is there); and in `~/.config/fish/conf.d/hoprig.fish` when fish is your shell. Each
line is added once. A new Node.js version: run `hoprig setup` again (the doctor says when the scripts point to one that is gone).
A file of npm's own in `~/.local/bin` is left alone.

## What setup creates, and what it never touches

- Only what is missing: the workspace folder and each folder of the tree. `credentials/` gets owner-only
  permissions and a short README. The projects folder for a **new** install is `<workspace>/projects`.
- `ai_brain/` is made **only when there is none** (or it is an empty folder): `BRAIN.md` (what the folder is),
  `learnings.md`, `active_context.md`, `daily_logs/`, `claude-memory/home/`, `skills/`, `scripts/`,
  `claude/CLAUDE.md` (Hoprig's working rules as the starting global rules), `.gitignore`, then `git init` and a
  first commit when git knows your name and e-mail.
- Never: a folder or file that exists is not moved, renamed, overwritten or "fixed" (a credentials folder others
  can open is reported, with the `chmod` to run). An existing `ai_brain` that is already a git repository with
  its own structure is adopted as it is. A projects folder chosen before (or `~/projects` from an earlier
  install) stays where it is. Claude Code's folder (`~/.claude`) is never touched by setup.

## Linking the coding tools into the brain

`workspace link` is a separate, explicit step. It first lists exactly what it will do:

| Claude Code's file or folder | Links to |
|---|---|
| `~/.claude/CLAUDE.md` (the rules for every project) | `ai_brain/claude/CLAUDE.md` |
| `~/.claude/skills/` | `ai_brain/skills/` |
| `~/.claude/projects/<home folder as a name>/memory/` | `ai_brain/claude-memory/home/` |

(`~/.claude` is `$CLAUDE_CONFIG_DIR` when that is set.) A real folder's files are merged into the brain (a name
that is taken gets `.from-<time>` added; nothing is overwritten) and the folder is kept as a dated backup. A rules
file moves into the brain only when the brain has none; when both exist with different text, nothing is changed
and you are told to keep one. A link that points somewhere else is left alone. Windows: folders become junctions;
a file link needs the right to make links, and without it the file is put back and the step reports the error.

### OpenCode: the same brain

When OpenCode is on (`hoprig tools on opencode`, or installing it), `workspace link` covers it too, so all
coding tools read the same rules, skills and memory:

| Coding tool | What is linked or named | In the brain |
|---|---|---|
| OpenCode | `~/.agents/skills/` | `ai_brain/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `ai_brain/claude/CLAUDE.md` |
| OpenCode | `"instructions"` in `~/.config/opencode/opencode.json`: Claude Code's `rules/*.md` and each project's `ai_brain/claude-memory/MEMORY.md` | (added to the list; the file's other settings stay, the old file is kept as a backup) |

It keeps no memory of its own, so the shared rules file gets a short **Memory** section at its end (once,
between two marker lines, after your own text) that tells it where each project's memory is and to keep it.
OpenCode does not read `CLAUDE.md` in a project, only `AGENTS.md`: the projects Hoprig sets up have both.
The **AI brain** page shows, per coding tool, whether it is linked, with one **Link** button.

## The AI brain in the dashboard

The **AI brain** page (under **More**) shows what the AI knows on a computer (also another computer, through the
main computer), read-only. The workspace folders themselves are in **Settings → Workspace** (the **Setup** part of a computer's page
links there). The AI brain page shows:

- the global rules (`CLAUDE.md` and Claude Code's `rules/` folder), and the brain's own copy;
- the brain's `BRAIN.md`, `learnings.md`, `active_context.md`, `PENDING.md`, the daily logs (newest first);
- skills: name and one-line description of each (Claude Code's skills folder, and the brain's when it is another);
- memory: for everywhere (the home folder's) and for each project (its parent's `ai_brain/claude-memory`), one
  entry per file with its name, description and type, and when it changed;
- each project's `AGENTS.md`, `decisions.md`, `ai_brain/learnings.md` and `ai_brain/active_context.md`.

The page asks for one item by the id the index gave it, never by a path. **Never shown**: anything outside these
places (no `..`, no absolute path, no link that leads out), folders named `no-ai`, `ignore` or `ai-ignore-dir`
(not even counted), `credentials` folders, dot-files, `.env` files, key files, and anything that is not plain
text (`.md`, `.txt`). Text that looks like a secret is masked before it leaves the computer; an item is cut at
200 KB.

Routes (behind the login; another computer's through the main computer): `GET /api/workspace`, `POST /api/workspace/setup`,
`GET /api/brain`, `GET /api/brain/item?id=<id>`, `GET|POST /api/workspace/link`, `GET|POST /api/workspace/map`,
`POST /api/workspace/map/commit`, `POST /api/workspace/map/upgrade`, `POST /api/workspace/map/case`, `POST /api/workspace/restore`,
`POST /api/workspace/sync`, `GET /api/workspace/job`, `POST /api/workspace/settings`, `POST /api/workspace/forget`,
`GET /api/workspace/git`, `POST /api/workspace/git/identity`, `GET|POST /api/workspace/git/signin`,
`POST /api/workspace/git/signin/cancel`, `GET /api/workspace/git/brains`, `GET|POST /api/workspace/git/brain`,
`GET /api/workspace/computers`, `POST /api/workspace/label`, `GET /api/workspace/whohas`,
`GET /api/workspace/instep`, `POST /api/workspace/instep/look`, `POST /api/workspace/instep/credentials`,
`GET /api/workspace/find?in=<place>`, `POST /api/workspace/find/add`, `POST /api/workspace/find/undo`, `POST /api/workspace/find/get`, `POST /api/workspace/drop/check`, `POST /api/workspace/drop`,
`POST /api/workspace/group`, `POST /api/workspace/group/remove`,
`GET /api/workspace/tools`, `POST /api/workspace/tools/allow`, `POST /api/workspace/tools/remove`,
`GET|POST /api/workspace/rules`, `POST /api/workspace/mylink`,
`POST /api/workspace/git/brain/moveout`,
`GET|POST /api/workspace/credentials` (the list with what each takes is at the top of
`src/workspace/feature.mjs`).

## What changes when you update from 0.3

- The upkeep no longer fetches, fast-forwards or pushes a project, even with "keep the workspace in step" and
  "upload" on: it keeps the brain, the groups' repositories and the other repositories in step. Sync a project with
  `hoprig sync <name>` or the page's Sync; turn on "Push my other branches" per place for committed work on branches
  that are not the default one. It still tells you about a project on this computer with commits to push, or to
  pull as of its last fetch (read from what is here, nothing fetched or moved), in the same "things to decide"
  notification as before. When keeping the workspace in step is on, its first round after the update says this once,
  in a notification.
- Restore no longer clones projects: `--with-projects` does, as before. A project only in the map is no longer
  "missing" in status or a "thing to decide" in sync; it is "in the map, not on this computer" with `hoprig get`.
- With `commitMap` the commit holds this computer's own file too, once the computer has a label; with `push` the
  brain is fetched every round, fast-forwarded when only the map differs here, and a both-moved brain whose only
  local change is the map is brought in step by the rule above.
- `hoprig sync` is a command now (the workspace's sync): a provider file named `sync` (or `get`) can no longer be
  started by that name. `hoprig add` refuses those names, the list of providers leaves such a file out and `hoprig
  doctor` names it with the way to rename it; it is never deleted.
- Nothing of yours is removed or moved by the update. A computer still on 0.3 that shares the brain keeps working:
  it reads the map as before, never writes `computers/`, and its own upkeep commits only `workspace.json`.

## What is checked where

Tests on temporary folders with local bare repositories as the git server: status, setup, adopting an existing
tree, linking with merge and backup, every refusal of the brain view, the map (a token stripped, private folders
unseen, a repository without a remote), restore (twice, with an unreachable repository, after setup), sync
(behind, ahead, both moved, uncommitted), `--with` between two temporary homes, and the Git and GitHub step with a
stand-in for `gh`. Groups: a workspace with the projects folder, a plain group and a group repository holding two
folders (scan, write, read, status, sync, memory links, restore on a second home, `git add -A` in the group taking no
project), one test per rule of the strict check, the upgrade from version 1, and the previous release's reader
meeting a version-2 map and changing nothing. Where Hoprig acts (`test/workspace/inside*.test.mjs`): the review's
cases, a property over 300 random trees with links in random places and over random workspaces with real git
(restore, get, sync with --push, the upkeep, project setup: nothing outside an entry's folder changes), and a test
that finds every raw act outside `inside.mjs`. End to end in two fresh Ubuntu 24.04 containers (`tools/e2e-workspace.sh`): install from a
tarball, a workspace built and mapped on one, restored on the other from the brain's address (no project), the
project got with `hoprig get`, a change synced, the command found over ssh. On demand and the computers' files (`test/workspace/ondemand.test.mjs`, `computer.test.mjs`,
`mapkeep.test.mjs`, `test/pcsetup/dryrun-ondemand.test.mjs`): restore on a second home gets the brain, the
credentials, a group's repository and the others and no project; a get cut off half way is finished, the cut-off
clone kept aside; a gone repository is named; the upkeep with every switch on leaves a project with unpushed work and
one behind exactly as they were; two homes write their own files and neither touches the other's; a taken label is
refused, one coming back starts empty; no path, host name or secret in a file; two homes add projects in the same
hour and both end with both, with no notification and no merge commit; a commit of another file, a staged change or
a server that keeps moving stops the rule; the rule cut off at each step is finished by the next round; a dry run of
every changed command changes nothing on a whole-home snapshot. The real GitHub sign-in needs a person and was not
run. Windows was **not run**.
