# Structure, memory, git and code rules

- Applies when: always, for every kind of project.
- Light form: none. A rule about a thing the project does not have (a database, a browser) has nothing to act on.

## What `hoprig project new` made

The project is a **parent** repository (rules, docs, decisions, the AI memory: no product code) with each product in
its **own** repository under `code/`. These are the files and folders it starts with; the list is checked against
what Hoprig makes, so it is exact:

<!-- made-by-hoprig:start -->
```text
AGENTS.md                         the rules for AI tools, with the part "Every session" (rule 6); fill it with the real commands
CLAUDE.md                         points to AGENTS.md
GEMINI.md                         points to AGENTS.md
.aiignore                         folders AI tools never read (test data, .env files)
.claudeignore                     the same, for Claude Code
.copilotignore                    the same, for Copilot
.cursorignore                     the same, for Cursor
.geminiignore                     the same, for Gemini
.claude/settings.json             what Claude Code may never read
.claude/skills/new-project/       this skill
.gitignore                        code/*, test data, .env files and .DS_Store stay out of the parent
code/.gitignore                   the parent never tracks product code
ai_brain/learnings.md             what was learned the hard way, one dated line each
ai_brain/active_context.md        what is being worked on now
ai_brain/daily_logs/              one file per day of work
ai_brain/claude-memory/           the coding tool's memory of this project, kept in git
ai_brain/claude-memory.json       where that memory folder is
docs/README.md                    the index of the docs
docs/brief.md                     the owner's brief, unchanged (only when a brief was given)
decisions.md                      the decisions and why
project.json                      the code repositories and where the memory lives
```
<!-- made-by-hoprig:end -->

A project made from the owner's own template has that template's files instead; read what is there.

## What you add

```text
docs/flows.md, docs/test-matrix.md, docs/checklist.md      before any code (the skill's step 4)
docs/standards.md                                          the owner's own rule book, when his defaults name one
ai_brain/archive/                                          older parts of active_context.md
ai_brain/scripts/memory-commit.mjs                         commits the memory (below)
.githooks/                                                 the parent's hooks (Git, below)
.cursor/rules/, .kiro/steering/, .github/copilot-instructions.md   pointers to AGENTS.md, for those tools
code/<folder>-<part>/                                      one repository per deployable part, one per mobile app:
                                                            hoprig project add <folder> <part>
```

1. The folder you are opened in is the project: never make another folder above or around it. Make only the code
   repositories the fit calls for (one per mobile app of the details).
2. Add a code repository with `hoprig project add <folder> <part>` (it makes the repository, its first commit and its
   entry in `project.json`). Without Hoprig: `git init` in `code/<folder>-<part>` and add it to `project.json`.
3. Each code repository gets its own short `AGENTS.md` (and a `CLAUDE.md` that points to it): the commands (run,
   test, build, migrate), a map of its folders and the rules of its stack.
4. Add a folder only when it is needed. Never a folder at the project's root that the two lists above do not name,
   unless the owner's defaults name it.
5. `test-data/` (git-ignored, never read by AI tools) holds local test data when there is any.
6. After the set-up, this skill stays the rule book. The parent's `AGENTS.md` says so in its part "Every session"
   (Hoprig writes it with the brief; add it when it is missing): read `ai_brain/learnings.md`,
   `ai_brain/active_context.md`, `docs/brief.md`, `decisions.md` and the applies table at the top of
   `docs/checklist.md`, then follow this skill's `SKILL.md` and the references the table marks `full` or `light`. Later
   sessions follow its rules but never redo the set-up steps (the skill's steps 1 to 3 and the work order's step 1).
   The fit is the exception: a new instruction that changes the project is fitted again first (the skill's step 4).

## Versions

7. The newest stable versions that work together, pinned exactly (an exact-save setting for the package manager),
   lock files committed, the runtime's version pinned in the repository (a version file and the package's engines).
8. Before using a library's interface, read the documentation of the installed version. No deprecated interfaces.
9. Report the installed versions at the end.

## AI memory

At the start of every session read, in this order:

10. `ai_brain/learnings.md`
11. `ai_brain/active_context.md`
12. `docs/brief.md`
13. `decisions.md`, before changing anything important
14. The applies table at the top of `docs/checklist.md`: it says which references of this skill the project uses.

While working:

15. Long-term learnings go into `ai_brain/learnings.md`: short, dated, one per line.
16. `ai_brain/active_context.md` is updated after important work; past about 150 lines, older parts move to
    `ai_brain/archive/`.
17. A recorded mistake is never made again.

When the owner says **FLUSH** (save the memory):

18. Update `ai_brain/active_context.md`.
19. Add the day's progress to `ai_brain/daily_logs/YYYY-MM-DD.md`.
20. Add new decisions to `decisions.md`.
21. Run `node ai_brain/scripts/memory-commit.mjs`: it commits `ai_brain/`, `decisions.md` and `docs/`, then pulls and
    pushes when there is a remote.

## Git

22. The parent and every code repository are separate repositories, default branch `main`, Conventional Commits.
23. When the details name a code host account, make private repositories there with its command (for example `gh`)
    and push. Otherwise stay local and make no remote.
24. Before work: pull with rebase. After each working step: commit and push. At the end, the remote equals the local
    copy in every repository.
25. Commit `.env.example` only. Never `.env` or any secret.
26. No AI attribution (`Co-authored-by` trailers, "made with" lines).
27. Hooks in `.githooks/` of each repository, turned on with `git config core.hooksPath .githooks`. Where the stack
    has an install script (for example npm's `prepare`), it sets this, so a fresh clone gets the hooks on install;
    elsewhere it is the first set-up step in that repository's `AGENTS.md`. Before a commit: refuse `.env*` files
    (except `.env.example`) and secrets (a secret scanner, or a pattern check when none is installed). On the
    message: check the Conventional Commit form and refuse AI attribution.
28. Automatic dependency updates where the code host offers them.
29. Ask the owner before anything destructive: deleting, a force push, `reset --hard`, dropping a table.

## Code rules

30. Clean, readable code, small files, clear names. Reuse the components and patterns that are there. No duplicate
    code.
31. Strict types where the language has them. No loose type and no silenced type error; a lint rule turned off only
    with a written reason.
32. A schema validates every input: forms, request bodies, query parameters, other services' hooks, command-line
    arguments and the environment (checked at start, in one module).
33. Server-rendered by default; code runs in the browser only for interaction.
34. Database code only in one data module, never in interface code.
35. Secrets only on the server: never in a browser, an app or a published package.
36. Every call to another service has a time limit and error handling. Users see a plain message. Logs are
    structured JSON with a request id.
37. English by default. All user-facing text in one messages file per language, read through a small helper. No
    translation library until a second language is needed.
38. No TODO, FIXME, placeholder or dead code at the end.
39. Look before overwriting anything that is there. Add folders only when they are needed.
