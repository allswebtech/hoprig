# Skills

Skills are folders with a `SKILL.md` (and sometimes scripts) that a coding tool loads: yours from
`~/.claude/skills/<name>/`, a project's from `<project>/.claude/skills/<name>/`. Claude Code reads both, and so does
OpenCode (it also reads `~/.agents/skills`, which `hoprig workspace link` points at the brain's skills). A skill is
instructions an AI agent follows with your permissions, so taking one is like installing software from the internet. Hoprig
suggests skills that fit a project, finds others, and installs one only after you have seen it.

## One command or two taps

```bash
hoprig skills suggest            # what fits this project, and why ("package.json has next 16.0.1")
hoprig skills add <id>           # fetch → review → yes → installed
```

In the dashboard: **Skills**, pick the project under **Skills for:**, open **Suggested**, **Review** on a
suggestion, read it, **Install**.

## Commands

| Command | What it does |
|---|---|
| `skills list [--project <dir>] [--offline]` | installed skills: name, description, source and commit, "update available", "edited here" |
| `skills find <words>` | the built-in catalog and the public skills.sh search, with installs and license |
| `skills suggest [dir]` | reads the project's manifests (no AI) and proposes catalog skills with the reason |
| `skills add <spec> [--project <dir> \| --user] [--yes]` | `<spec>`: a catalog id, `owner/repo[/path]`, `owner/repo@skill`, a GitHub URL, or any git URL with `#path` |
| `skills approve <review id>` | install a review printed earlier when no terminal could ask |
| `skills update [name] [--check] [--overwrite-local]` | newer versions: the diff and the scan again, then a yes per skill; also the tools below |
| `skills undo <name>` | back to the version before the last update or removal (and again: forward) |
| `skills rm <name> [--yes]` | remove (kept for undo) |
| `skills tools [--update <id>]` | command-line tools catalog skills need: installed and latest version, the exact update command |

## How a skill is taken

1. **Fetched into quarantine** (`<state>/skillhub/quarantine/<id>`), never straight into a skills folder: plain
   `git`, one commit, only that commit's tree and the skill folder's files. No hooks, no submodules, no LFS
   filters. Nothing from the skill runs, at any step.
2. **Reviewed**: every file with its size and kind (text, script, binary, link), the full `SKILL.md`, the
   license, the source and commit, and a scan that points at risky lines: downloading and running (`curl … | sh`),
   commands Claude Code runs when the skill loads (`` !`…` ``), reading credentials or `.env`, recursive deletes,
   start-up files, network calls, encoded blobs, hidden Unicode, instructions to ignore rules, to hide things from
   you or to send data away, `allowed-tools` and `hooks` in the front matter. A link out of the folder, a setuid
   file, an unsafe name or a missing `SKILL.md` blocks the install. The scan cannot prove a skill safe; it makes
   the lines worth reading easy to find.
3. **Approved once.** `--yes` is accepted only for catalog entries at their reviewed commit (and the bundled
   skill). Anything else needs you to read it.
4. **Installed**: the files are checked against the review again (changed since? nothing is installed), staged
   next to the skills folder and swapped in with a rename. A record keeps the source, commit, the git tree of the
   skill folder and a SHA-256 per file. For a project's skills that record is `.hoprig-skills.json` next to them;
   for your own skills it is kept in Hoprig's state folder (on Linux `~/.local/state/hoprig/skillhub/user-skills.json`),
   so the record does not show up as a changed file in your AI brain: the git repository of your rules and skills
   that `hoprig workspace link` links your own skills folder to ([WORKSPACE.md](WORKSPACE.md)).

## Updates

`skills update --check` asks the source for its newest commit and compares the git tree of the skill's folder,
so a repository that moved without touching the skill is "up to date". An update shows what changed (files added,
removed, changed, and the changed lines), the scan again with new findings marked, and waits for a yes per skill.
A skill you edited is never replaced silently: the update says what you changed and needs `--overwrite-local`
(the edited version is kept for undo). The dashboard can check once a week (**Skills → Advanced**, "Check for updates once a week"; off at first). It only
tells you, with a notification where you set one up in **Settings → Notifications**; it never installs.

## Skills learned from your work

A computer can also draft skills from what you do in **Work**. It is off until you turn it on in
**Settings → Learn skills** ("Learn skills from my work"), where you choose the provider and model that do the
looking (a look costs usage there; the page says what the last one cost: dollars for a provider billed by use,
otherwise the tokens, which count toward your plan's usage limit) and how many looks a week are allowed
(1 to 20, 5 by default). At most three drafts are made a week, whatever that number says. Looks started at the same
time keep both caps: each is counted before it starts.

Only two things are looked at, both your own doing in Work:

- a result you **sent back** with your words (a correction: the strongest sign);
- a result you **accepted**, when you press **Learn from this** on its run.

Never every session, never a whole conversation. A look is one headless model turn that can only answer (no
tools, no MCP server, no settings, no memory, nothing saved), in an empty temporary folder (Claude Code still tells
the model its platform, OS version and date). It is given the task's brief, your send-back words,
the session's last answer and the list of files the run changed, each fenced as data, with secrets masked and the
computer's paths and name taken out, and the names and descriptions of your skills, so it changes one of them
rather than making a near copy. What a session wrote is data: a line in its answer, a file name or a commit
subject that asks for a skill is never followed, and the look is told so. Its answer must have one strict shape:
nothing; a change to one of your skills (the whole new text); or a new skill (name, description, steps, and
optional examples and edge cases, as the Agent Skills format has them). Anything else makes no draft. A learned
skill is text only: no scripts, no commands of its own. It may not name a secret, a computer's path, an e-mail
address, an account on a computer (`user@host`), a person named in the run's own text, this computer or its account,
and a word that mixes Latin letters with Cyrillic, Greek, Armenian or Cherokee look-alikes is refused (a unit such as
µs or kΩ is text).

A draft is never live by itself. It lands in quarantine (`<state>/skillhub/learned/drafts/<id>`) and is shown in
**Skills → Learned**: where it came from (the task, your words), the new text or the lines it changes, the same
scan as every skill, and its two or three test requests, each answered by the cheapest model once without the
skill and once with it, side by side. A draft the scan marks risky (downloading and running, a command that runs
when the skill loads, reading credentials, a recursive delete, an instruction to ignore rules, to hide something,
to stop asking you, to push, to skip tests or checks, or to send data away, also in Hindi or Hinglish and with
look-alike letters) cannot be installed at all. Install scans the draft again, so a rule added by a later version
reaches drafts made before it. A change of one of your own skills is judged by the lines it adds: your front matter
and lines it keeps as they were are shown, and do not block it.

- **Install** writes the one `SKILL.md` into the AI brain's `skills/<name>/` and makes exactly one commit of that
  file (under the brain's lock; refused while the brain has staged changes, is in the middle of a merge, rebase,
  revert or cherry-pick, is on a detached HEAD, or over a change of yours to that skill; never pushed). An Install
  that was stopped or refused by git is taken back when pressed again. The skill is listed as learned, with the
  Work run it came from, in its own front matter (`metadata: learned-by: hoprig`).
- **Undo** is a `git revert` of that commit, committed as the skill's folder alone (refused like Install while a git
  operation of yours is midway). Nothing is deleted: the commit stays in the history, and a new skill's text is also
  kept in `<state>/skillhub/learned/archive/`.
- **Discard** removes the draft and keeps only its idea's key and short hashes of its words, so the same idea is not
  offered again, also under another name or with a few words changed (80% of the words the same), and for a new
  skill also when only its steps are nearly the same (another name and description for the same steps).

## The catalog

`src/skillhub/catalog.json` lists skills that were opened and read before they were listed, each pinned to the
commit that was read, with what it is for, its license and the signals that make it relevant
(`npm:next`, `pub:flutter`, `stack:web`, `artifact:apk`, `file:docker`, `file:brief`, `always`). Four entries are
**bundled**, their version the package's: the `hoprig` skill in `templates/skills/hoprig`, which teaches Claude Code
to use Hoprig, offered first for every project, for you (`--user`): it is made by `node tools/build-skill.mjs` from a
short hand-written part (`templates/skills/hoprig.src.md`), every command's own help and the version, `skills
update` brings the newer one after an update of Hoprig, and without Hoprig `npx hoprig-skill --claude` (or
`--agents`, `--project <dir>`) puts the same skill into a coding tool's skills folder; the `plan-work` skill in
`skills/plan-work`, the method Work's Plan with AI asks its sessions to follow; the `new-project` skill in
`templates/skills/new-project`, which sets a new project up from its owner's brief; and the `adopt-projects` skill in
`skills/adopt-projects`, which brings the projects a computer already has into the workspace
([WORKSPACE.md](WORKSPACE.md)). `hoprig project new` puts the `new-project` skill into every new project made with a brief (docs/PC-SETUP.md, "A new project from a brief"); it is suggested for a project that
has a `docs/brief.md`, never for every project. Its `SKILL.md` holds the order and the fit; it always reads four
references (working, fit, finish, structure) and the others (database, performance, security, ui, search, services,
mobile, assistant, testing, docs) only when its applies table marks them `full` or `light`. Tests hold its kinds, applies table, tiers and scope to the
code, and its list of what `project new` makes to what a real run makes. To add an entry: read the skill at a
commit, add the entry with that full commit id, and run the tests (they validate the catalog).

## What leaves the computer

- `git ls-remote` / `git fetch` to the skill's host (GitHub for catalog entries).
- `find`: the words to `https://skills.sh/api/search` (the same search the `skills` CLI uses; `SKILLS_API_URL`
  changes it), and the repository names of the results to `api.github.com` for their license.
- Tools: the package name to the npm registry (`npm view <package> version`).

The `skills` CLI (`npx skills`) itself is not used: it needs Node 22.20+, links skills from `~/.agents`, sends
telemetry unless turned off, and has no quarantine review. Skills it installed are listed with the source from
its lock file.

## For the guided first run

`hoprig setup` runs this as its skills part ([INSTALL.md](INSTALL.md)): for the project chosen in the same
run, or, without one, the skill that comes with Hoprig. `hoprig setup --only skills` runs it again.


`src/skillhub/hub.mjs` exports:

- `skillsStatus({ project?, check = true })` → `{ user: { dir, installed, suggested }, project: { root, dir,
  installed, suggested, ideas } | null, updates: [{ scope, name, latest, edited }], checked }`
- `runSkillsStep({ ui, project, yes, dryRun })` → `{ ok, added, skipped }`; `ui` is `{ say(line),
  confirm(question) → Promise<boolean> }`. One review and one question per suggested skill; with `yes`, only
  bundled or catalog-pinned entries are added.
