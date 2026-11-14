# Skills

Claude Code skills are folders with a `SKILL.md` (and sometimes scripts) that Claude Code loads: yours from
`~/.claude/skills/<name>/`, a project's from `<project>/.claude/skills/<name>/`. A skill is instructions an AI
agent follows with your permissions, so taking one is like installing software from the internet. Hoprig
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
   next to the skills folder and swapped in with a rename. `.hoprig-skills.json` next to the skills records the
   source, commit, the git tree of the skill folder and a SHA-256 per file.

## Updates

`skills update --check` asks the source for its newest commit and compares the git tree of the skill's folder,
so a repository that moved without touching the skill is "up to date". An update shows what changed (files added,
removed, changed, and the changed lines), the scan again with new findings marked, and waits for a yes per skill.
A skill you edited is never replaced silently: the update says what you changed and needs `--overwrite-local`
(the edited version is kept for undo). The dashboard can check once a week (**Skills → Advanced**); it only
tells you (a notification and a badge), it never installs.

## The catalog

`src/skillhub/catalog.json` lists skills that were opened and read before they were listed, each pinned to the
commit that was read, with what it is for, its license and the signals that make it relevant
(`npm:next`, `pub:flutter`, `stack:web`, `artifact:apk`, `file:docker`, `always`). One entry is **bundled**: the
`hoprig` skill in `templates/skills/hoprig`, which teaches Claude Code to use Hoprig; its version is the
package's and it is offered first for every project, for you (`--user`). To add an entry: read the skill at a
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
