# The workspace and the AI brain

One folder tree, the same on every computer. Coding happens inside `projects/`.

```
~/Workspace/
├── ai_brain/              shared AI knowledge for all projects: the rules Claude gets everywhere, skills,
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
hoprig workspace status [--json]           # every folder: there or not, what it is for; the map against this computer
hoprig workspace setup [--dry-run] [--yes] # create only what is missing
hoprig workspace link [--dry-run] [--yes]  # let every coding tool that is on read its rules, skills and memory from the brain
hoprig workspace map [--dry-run]           # write the map of every git repository (ai_brain/workspace.json)
hoprig workspace restore <brain address>   # a fresh computer: the brain, then everything its map names
hoprig workspace sync [--memory] [--push] [--with <computer>]   # every repository in step
hoprig workspace set --dir <folder> --projects <folder>         # where things are, for future work (nothing moves)
hoprig workspace forget <project or folder>                     # out of the map (no file is touched)
hoprig workspace git                       # git's name and e-mail, the GitHub sign-in, your workspace on GitHub
hoprig workspace auto [--map|--commit|--sync|--push on|off] [--every <hours>]   # the upkeep's switches
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
later or again. Then `hoprig workspace link` makes Claude Code use the brain's rules, skills and home memory.

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
  project.json". `map` shows what changed (added, taken out, a changed address), never commits, and prints the
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
- `forget` takes a project or folder out of the map and adds it to `skip`, so `map` does not add it back.
- A map read from a repository is checked strictly (unknown keys, names and folders that would lead out of the
  workspace, bad addresses or branch names): a map that fails is not used, and nothing is changed.

## Restore: everything the map names

`hoprig workspace restore <address>` clones the brain into `<workspace>/ai_brain`, reads the map, shows the whole
plan (every repository and where it goes), asks once, then clones each project's parent and its code repositories
(and any code repository its `project.json` names that the map does not have yet), the other repositories, makes
the missing folders of the tree, and finishes each project like `project clone`: memory folders linked, git hooks,
`.env.example` copied, the dependency installs offered.

- Run it again and it only gets what is missing. What is there is never overwritten or moved: the same repository
  counts as done; a folder that is something else is reported and left alone.
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
project's), and only them. `--dry-run` fetches and says what it would pull and push.

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

### Codex and OpenCode: the same brain

When Codex or OpenCode is on (`hoprig tools on codex`, or installing it), `workspace link` covers them too, so all
coding tools read the same rules, skills and memory:

| Coding tool | what is linked or named | in the brain |
|---|---|---|
| Codex | `~/.codex/AGENTS.md` (`$CODEX_HOME`) | `ai_brain/claude/CLAUDE.md` |
| Codex and OpenCode | `~/.agents/skills/` | `ai_brain/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `ai_brain/claude/CLAUDE.md` |
| OpenCode | `"instructions"` in `~/.config/opencode/opencode.json`: Claude Code's `rules/*.md` and each project's `ai_brain/claude-memory/MEMORY.md` | (added to the list; the file's other settings stay, the old file is kept as a backup) |

Neither keeps a memory of its own, so the shared rules file gets a short **Memory** section at its end (once,
between two marker lines, after your own text) that tells them where each project's memory is and to keep it.
Codex and OpenCode do not read `CLAUDE.md` in a project, only `AGENTS.md`: the projects Hoprig sets up have both.
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
stand-in for `gh`. End to end in two fresh Ubuntu 24.04 containers (`tools/e2e-workspace.sh`): install from a
tarball, a workspace built and mapped on one, restored on the other from the brain's address, a change synced, the
command found over ssh. The real GitHub sign-in needs a person and was not run. Windows was **not run**.
