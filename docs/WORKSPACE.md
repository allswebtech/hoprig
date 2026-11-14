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
hoprig workspace status [--json]           # every folder: there or not, what it is for; the brain and projects: git or not
hoprig workspace setup [--dry-run] [--yes] # create only what is missing
hoprig workspace link [--dry-run] [--yes]  # let Claude Code read its global rules, skills and home memory from the brain
```

`hoprig setup` and `hoprig pc setup` offer the workspace as one step: on a new computer they say in one sentence
what it creates and ask once (default yes); where any part of the tree is there already, they only report it.
`hoprig doctor` shows it in one line under Projects.

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

## Linking Claude Code into the brain

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

Routes (behind the login): `GET /api/workspace`, `POST /api/workspace/setup { dryRun? }`, `GET /api/brain`,
`GET /api/brain/item?id=<id>`.

## What is checked where

Run on macOS and in tests on temporary folders (status, setup, adopting an existing tree, linking with merge and
backup, every refusal of the brain view). Linux was not run separately for this part; Windows was **not run**.
