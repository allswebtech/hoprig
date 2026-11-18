# The workspace and the AI brain

One folder tree, the same on every computer. Coding happens inside `projects/`.

```
~/Workspace/
├── ai_brain/              shared AI knowledge for all projects: the rules every coding tool gets, skills,
│                          memory, notes, scripts; its own private git repository
├── projects/<project>/    the project's parent: AGENTS.md, ai_brain/ (that project's memory, learnings,
│   │                      current context), docs, decisions, project.json
│   └── code/<repo>/       each code repository, its own git repository
├── credentials/           keys and passwords for local work: never in git; AI tools may use them but never print them
├── development/           toolchains and SDKs installed for you (node, flutter, android, …)
├── git/                   your own git material (mirrors, shared hooks)
├── database/postgresql/   local database data
└── backups/
```

Names are case-exact. The place is one setting: `workspaceDir` in Hoprig's `config.json` (default `~/Workspace`);
the environment variable `HOPRIG_WORKSPACE_DIR` wins over both. A project's parent is described in
[PC-SETUP.md](PC-SETUP.md#project-workspaces).

```sh
hoprig workspace status [--json]           # every folder: there or not, what it is for; the map against this computer;
                                           # clones hoprig get left under a temporary name, with what to do
hoprig workspace setup [--dry-run] [--yes] # create only what is missing
hoprig workspace link [--dry-run] [--yes]  # let every coding tool that is on read its rules, skills and memory from the brain
hoprig workspace map [--dry-run]           # write the map of every git repository (ai_brain/workspace.json)
hoprig workspace map --upgrade [--yes]     # the map to version 2, needed for groups (asks once)
hoprig workspace group add <dir> [--repo <address>] [--holds name:group,name]   # a folder of projects of your own
hoprig workspace group remove <dir>        # out of the map, when no project of the map is in it (nothing deleted)
hoprig workspace restore <brain address>   # a fresh computer: the brain, then everything its map names
hoprig workspace sync [--memory] [--push] [--with <computer>]   # every repository in step
hoprig workspace set --dir <folder> --projects <folder>         # where things are, for future work (nothing moves)
hoprig workspace forget <entry>   # a project (<place>/<name> in a group), project/code/<name> or a folder out of the map
hoprig workspace git                       # git's name and e-mail, the GitHub sign-in, your workspace on GitHub
hoprig workspace auto [--map|--commit|--sync|--push on|off] [--every <hours>]   # the upkeep's switches
hoprig workspace mylink add|remove|list [<path>]   # a link in the workspace that is your own (Hoprig follows it)
hoprig workspace rules [--write] [--yes]   # the short text about this workspace for coding sessions: shown; written on a yes
```

Every one of them takes `--json`; the ones that change something take `--dry-run`, which shows exactly what would
happen. `hoprig setup` and `hoprig pc setup` offer the workspace as one step: on a new computer (no AI brain yet)
they say in one sentence what it creates and ask once (default yes); where the brain is there already, they only
report. Before that comes the **Git and GitHub** step (below). `hoprig doctor` shows the workspace under Projects:
the tree, whether the brain is on a git server and in step (as of the last fetch; the doctor does not fetch), and
whether the map matches this computer.

## A fresh computer in three commands

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh   # Hoprig, git, gh, …
hoprig workspace git                                  # name and e-mail, the GitHub sign-in (any other git server: skip)
hoprig workspace restore example/ai_brain             # or any git address of your brain
```

The installer's own setup already asks the second and third question in a terminal; the commands are for doing it
later or again. Then `hoprig workspace link` makes every coding tool that is on (Claude Code, and OpenCode when it is
on) use the brain's rules, skills and memory.

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

### Your workspace, for coding sessions

`hoprig workspace rules` shows a short text about this workspace: its folders that are here, your groups that are
on this computer, a group's command only when you allowed it here, and the commands to ask where things are. The map
comes from a git server, so nothing of it goes into a file a coding tool reads as instructions without your yes:
`hoprig workspace rules --write` shows the text, asks (or `--yes`), and writes it into one file of Hoprig's own,
`~/.claude/rules/hoprig-workspace.md`, which says in its first line that Hoprig made it and replaces it as a whole.
Names that are not plain (letters, digits, `.`, `_`, `-`, at most 64 characters) are left out and named. The upkeep,
a restore and the group and tool commands never write it, your working rules file is never touched by it, and
`workspace status` says when the file is older than what the map says now. The first `hoprig pc setup` at a
terminal offers it as one question.

## Restore: everything the map names

`hoprig workspace restore <address>` clones the brain into `<workspace>/ai_brain`, reads the map, shows the whole
plan (every repository and where it goes), asks once, then clones each project's parent and its code repositories
(and any code repository its `project.json` names that the map does not have yet), the other repositories, makes
the missing folders of the tree, and finishes each project it cloned like `project clone`: memory folders linked,
git hooks, `.env.example` copied, the dependency installs offered. A project that was here already is not changed:
what it misses is said, with `hoprig project setup <name>`. `--dry-run` writes nothing in the workspace; to read the
map of a brain that is not here yet it clones the brain into a temporary folder of the system and removes it.

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

`hoprig workspace sync` goes through every repository of the map, the brain first, with the same engine as
`project sync`, leaving tools alone: fetch; fast-forward a branch that is only behind; push a branch that is only ahead **only
with `--push`**. Uncommitted work stays where it is and does not stop a fast-forward, unless the new commits touch
the same files: then git refuses and nothing is changed. It never merges, rebases, forces or stashes. Whatever needs
a decision (both sides moved, something to pull into files with uncommitted changes, no upstream, a push that failed, a repository not on this computer) is
listed with the exact command. `--memory` first commits the memory folders (the brain's `claude-memory/` and each
project's), and only them. `--dry-run` changes nothing, not even a remote-tracking ref: it does not fetch, it asks the server for each branch's commit (`git ls-remote`) and says what it would pull and push (new commits that are not on this computer yet are named, not counted). `--with` does the same with the other computer.

## The upkeep the dashboard does by itself

While the dashboard runs (`hoprig serve`, or the background service), right after it starts and then every few
hours. Five switches, the automation setting `workspace` (the same in the dashboard and in
`hoprig workspace auto`):

| Switch | Default | What it does |
|---|---|---|
| `map` | on | **The map keeps building itself.** It looks at the workspace as `map` does (the union rule) and writes `workspace.json` only when something would change: a new project or code repository, a new address. Nothing changed: no write and no message. It never makes the first map (that is your `hoprig workspace map`), and it leaves `project.json` files alone. |
| `commitMap` | off | A change of the map is saved in the brain's history: `workspace.json` is added and committed alone ("Update the workspace map"), with the brain's own git name and e-mail. Never while the brain has other staged changes: then the map is written, not committed, and you are told why. |
| `sync` | off | Every repository of the map is fetched and fast-forwarded, as `workspace sync` does (tools left alone). |
| `push` | off | Uploads what is purely ahead: sync's pushes, and the map's commit (only when the brain is ahead and not behind its git server). |
| `everyHours` | 6 | How often (1 to 168). |

```sh
hoprig workspace auto                                   # show the switches
hoprig workspace auto --commit on --push on --every 3   # set them: --map --commit --sync --push on|off, --every <hours>
```

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
3. *Is there a workspace of yours on GitHub already?* Repositories of your account and your organisations whose
   name has "brain" in it are offered (one with a `workspace.json` first): restore it. Or start a new one: the
   brain goes into a new **private** repository (never public), the map is committed in it and pushed. Or later.
   A brain with another name: `hoprig workspace restore <its address>`.

Other git servers (GitLab, your own SSH server) work for map, restore and sync through plain git with your own
sign-in (SSH key or credential helper). Only this sign-in help and creating a repository are GitHub's.

## Changing where things are

`hoprig workspace set --dir <folder> --projects <folder>` changes where the workspace and the projects folder are
for everything from now on. Nothing is moved: the `mv` that would move the files is shown, to run yourself.

## The command in every shell

Node.js installed with nvm is only on PATH in an interactive shell, so `ssh <computer> hoprig doctor` used to say
"command not found". `hoprig setup` (the installer runs it) writes two small scripts, `~/.local/bin/hoprig` and
`~/.local/bin/hop`, that start Hoprig with the full path of its Node.js, and puts `~/.local/bin` on PATH in
`~/.profile` (and `~/.bash_profile` when there is one), at the **top** of `~/.bashrc` (before the line that stops a
non-interactive shell), in `~/.zshenv`, and for fish in `~/.config/fish/conf.d/hoprig.fish`. Each line is added
once. A new Node.js version: run `hoprig setup` again (the doctor says when the scripts point to one that is gone).
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

| Claude Code's | links to |
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

| Coding tool | what is linked or named | in the brain |
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
hub), read-only. The workspace folders themselves are on a computer's page, **Setup**. The AI brain page shows:

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

Routes (behind the login; another computer's through the hub): `GET /api/workspace`, `POST /api/workspace/setup`,
`GET /api/brain`, `GET /api/brain/item?id=<id>`, `GET|POST /api/workspace/map`, `POST /api/workspace/restore`,
`POST /api/workspace/sync`, `GET /api/workspace/job`, `POST /api/workspace/settings`, `POST /api/workspace/forget`,
`GET /api/workspace/git`, `POST /api/workspace/git/identity`, `GET|POST /api/workspace/git/signin`,
`POST /api/workspace/git/signin/cancel`, `POST /api/workspace/git/brain` (the list with what each takes is at the top of
`src/workspace/feature.mjs`).

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
tarball, a workspace built and mapped on one, restored on the other from the brain's address, a change synced, the
command found over ssh. The real GitHub sign-in needs a person and was not run. Windows was **not run**.
