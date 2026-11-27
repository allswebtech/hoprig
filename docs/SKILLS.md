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
(the edited version is kept for undo). The dashboard can check once a week (**Skills → Advanced**, "Look for updates and new skills once a week"; off at first). It only
tells you, with a notification where you set one up in **Settings → Notifications**; it never installs.

## Skills that fit a new project's technology

**New project** in the dashboard has the box **Add skills that fit its technology: text-only skills from your own and
from the reviewed catalog go in by themselves, with Undo; anything else waits for you.**, ticked at first. Ticked,
Hoprig looks when the project is made and once more when it first has code (the skills page's hourly look; it reads
the project's manifests, no AI). The order is "find before create":

1. A skill of your own (in every project) whose name holds the project's technology is listed as **Already yours**:
   nothing is copied.
2. A catalog skill that fits, at the version the catalog reviewed, goes into the project by itself only when it is
   low-risk: every file is text (`.md` or `.txt`), none can be run, none is a link, its `SKILL.md` asks for no tool
   (`allowed-tools`, `tools`, `hooks`), the catalog names no tool for it, the scan finds nothing, and it is at most 50
   files and 512 KB. It goes through the same quarantine, scan, install and record as a press of yours, and is listed
   as **Added by itself** with **Undo** (kept for undo: **Put back** brings it again).
3. Everything else is **Waiting for you**, with the reason it was not added; **Review** shows every file before you
   install it. A skill from outside the catalog (skills.sh, or any other public source) never goes in by itself.

Nothing is made for a technology by a model. The choice is kept per project in Hoprig's state
(`<state>/skillhub/fit.json`), never in the project; the project's **Skills** page shows it as **Fits its technology**,
with the switch **Add skills that fit this project's technology** to turn it off or on.

Routes, behind the owner's login (Tia's token is refused): `GET /api/skillhub/fit?project=<dir>` (the choice and the
three lists) and `POST /api/skillhub/fit/choice` (`{ project, fit }`).

## Skills learned from your work

A computer can also draft skills from what you do in **Work**. It is off until you turn it on in
**Skills → Learned** ("Learn skills from my work", the panel at the top of that tab), where you choose the provider and model that do the
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

The `hoprig` skill itself is made by Hoprig and is never changed by a look. A lesson about using Hoprig (its pages,
its `hop` commands) becomes a draft for a skill of its own, `hoprig-learned`, beside it in your skills: a new skill
the first time, and after that a change that adds one lesson below the ones there, by every rule above (off until
you turn learning on, your **Install**, **Undo**, the scan, at most three drafts a week). The `hoprig` skill tells
your coding tool to read `hoprig-learned` too when it is there.

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

## Proposals for Tia

A proposal is one file in Hoprig's state folder, `proposals/<id>.json`, left there by an improvement loop. Its shape
comes first:

- `format`: 1; `id`: `<YYYYMMDD>-<HHMMSS>-<kind>-<name>`, the file's own name without `.json`.
- `target`: `{ kind, name }`. `kind` is `skill` (a skill's name), `tool` (a tool's name) or `prompt` (a section of
  her system prompt, by its id: `opening`, `providers`, `out-of-scope`, `getting-work-done`, `work`, `style`). The
  sections that hold her safety rules (`untrusted-text`, `how-far`, `owner-only`) are never a target: a file or an
  eval candidate that names one is refused whole.
- `before`: the text it was measured against; `after`: the proposed text (a tool's description 40 to 1024
  characters, a prompt section at most 16 KiB).
- `why`, `numbers` (`whole`, `heldout`, `tokens_per_turn`, `fresh`, `cost`), `gates`, `created`, and an optional
  `issue`: a text for a coding session when the change is to code. It is shown, never applied.

Skills → Proposals shows each one with what would change and the numbers, compared here, never taken from
the file. **Accept** for a skill puts its new text in Tia's own skills folder. For a tool's description or a prompt
section it writes the text into `<state>/assistant/accepted/` (`tools/<tool>.description.txt` or
`prompt/<section>.md`, each with a `.json` record of the hash of Hoprig's own text it was measured against). Tia
reads these at her start and checks each again (the size, the threat scan, the protected sections, a name she
has). An accepted text applies only while Hoprig's own text still has that hash: after an update changes it, the
page says "no longer applies: Hoprig's own text changed since it was measured", with **Remove**. **Undo** takes an
accepted text back. Code is never changed by a proposal.

The eval's `--candidate <folder>` takes the same targets for one run: `skills/<name>/SKILL.md`,
`tools/<tool>.description.txt` and `prompt/<section>.md`; `--text prompt/<section>` prints a section's shipped text.

## Skill collections and the weekly look

`src/skillhub/hubs.json` names the skill collections: public repositories with many skills, read as data like the
catalog (the Skills page says `the reviewed hubs`). Today it has one, Hermes Agent
(`https://github.com/NousResearch/hermes-agent`, its folders `skills` and `optional-skills`; Review shows its licence). An entry
with an unknown key, a bad repository name or an address that is not its repository is refused on its own; the
others are still used.

When **Look for updates and new skills once a week** is on (**Skills → Advanced**, off at first), the weekly look
also reads each collection at its newest commit: plain git, one commit, only the tree and the `SKILL.md` files of
its skill folders (nothing is checked out or run). It keeps each skill's name, description and tags (Hermes writes
them under `metadata.hermes.tags`) in Hoprig's state folder, with the commit they were read from. A skill fits a
project when one of its tags or a word of its name is one of the project's technology words (its dependencies and
stacks, the same reading as the suggestions; no AI), and the reason says so: "because shop's package.json has
next". The skills that fit show as **Worth adding**, the first part of the **Suggested** tab (its number is on the tab), each with where it comes from,
the reason and **Review**. A collection that cannot be read is one line there; the look goes on. The search (Find)
also lists the skills the last look read.

Nothing from a collection is added by itself. **Review** fetches the skill at the commit the look read into
quarantine and shows every file, the scan, the skill's own licence and the collection's licence; **Install** is your
press. A skill without a licence of its own gets a `NOTICE` file with the collection's licence and notice, recorded
with its other files. Only skills are taken: Hermes Agent's tools are Python functions of its own runtime and are
not carried over.

## Improving Tia

Settings → Tia → **Improve Tia** starts a round by your press: Hoprig tries rewordings of Tia's skills, tool
descriptions and instructions, measures each with her tests, and shows you only the ones that do measurably better.
Nothing changes until you accept one, and every change has Undo.

- **What a round does.** It runs her eval once as it is (the baseline), picks a text from the cases that fail (a
  tool's description, one of her built-in skills, or a section of her instructions), and asks the model once for a
  rewording. The failing cases go to the model as data inside fences, never as instructions. Its answer is checked
  (its size, the threat scan, that it is the text asked for). The rewording is then tried on the failing cases, a
  held-out set of passing cases and every injection case, and, if it holds there, on the whole eval. At most three
  texts are tried in a round.
- **Measurably better** means: more cases pass than the baseline, no category passes fewer, and every injection
  case passes. Only such a version is written as a proposal file into `<state>/proposals/`, the same folder an
  outside improvement loop uses, so it shows in Skills → Proposals with its numbers and is accepted or undone there.
- **Never changed by a round:** her code, and the sections of her instructions that hold her safety rules
  (untrusted text, how far she may go, what only you do). A proposal for one of those is refused.
- **What it costs.** The page shows the estimate before the press: the runs of her test cases and the model calls,
  at the cost per case the last round measured on the same provider, or else the shipped eval's (measured on Claude
  Haiku) times the list price of the model the provider sends those requests to. When that model's price is not
  known, or the provider is a gateway, the page says the round can cost more. On a provider billed by use a round
  counts against your daily limit for paid use (none set: it does not start); before every eval run and the model
  call it holds an amount within that limit, refused when the limit would be passed, settled by what was measured.
  That amount is also the most the step may spend: the eval starts a case only with what is left of it, and the
  model call is given it as its limit, so a step that costs more than the estimate stops (the next estimate starts
  from what it cost) instead of spending past the hold. It stops at the cap you set for the round. On a
  subscription it uses that subscription's limits. The eval ends with the dashboard, also when the dashboard is
  killed, so nothing runs on unseen.
- **Its gates.** Only your press on your own page starts, stops or sets it: Tia's token and another dashboard are
  refused. One round runs at a time. **Stop** ends the eval's process. A round that was running when the dashboard
  stopped is marked stopped at its next start. **Run a round every week** is off until you switch it on; its words
  name the provider, the estimate and the limit.
- **What leaves the computer:** the eval's cases and the model call go to the provider you chose for the round.
- Tia's eval ships with Hoprig (`test/assistant/eval/`, its fake dashboard), so a round runs from an installed copy.

## What leaves the computer

- `git ls-remote` / `git fetch` to the skill's host (GitHub for catalog entries).
- The weekly look, when it is on: `git ls-remote` and a fetch of one commit's tree and `SKILL.md` files to each skill
  collection.
- Skills that fit a project's technology: the same `git fetch` of a catalog entry that fits, at its reviewed commit,
  when the project is made and once when it first has code (only when its choice is on).
- `find`: the words to `https://skills.sh/api/search` (the same search the `skills` CLI uses; `SKILLS_API_URL`
  changes it), and the repository names of the results to `api.github.com` for their license.
- Tools: the package name to the npm registry (`npm view <package> version`).

The `skills` CLI (`npx skills`) itself is not used: it needs Node 22.20+, links skills from `~/.agents`, sends
telemetry unless turned off, and has no quarantine review. Skills it installed are listed with the source from
its lock file.

## Skills from the shared core

For maintainers of Hoprig. Some of the built-in skills in `skills/` can come from the shared core, a separate
repository of skills that several products use. Hoprig never needs that repository to run: what it takes from it
is copied into `skills/` and loaded like every other skill there. `core.json` at the repository's top names the
core and the version taken; while it says `null`, no core is pinned and Hoprig's own copy is used.

- `node tools/core-sync.mjs --from <export folder>` shows what a version of the core would change, file by file
  (new, changed with its lines, unchanged, removed, changed locally), and writes nothing.
- `--write` takes it: the skills of the packs marked public go into `skills/<skill>/`, each text gets the line
  "Generated from the shared core <version>: change it there.", and `core.json` records the version and each
  file's sha256. A file that differs from its record, or a skill of Hoprig's own with the same name, is never
  overwritten: it is listed, and nothing is written.
- `--check` exits 1 and names every taken file that changed or went.
- An export folder holds `core-export.json` (`name`, `version`, `packs`: each `{ name, public }`) and
  `skills/<pack>/<skill>/SKILL.md` with the skill's other files. One that holds a link, an absolute path or `..`
  is refused whole. Nothing is fetched from a network.

## For the guided first run

`hoprig setup` runs this as its skills part ([INSTALL.md](INSTALL.md)): for the project chosen in the same
run, or, without one, the skill that comes with Hoprig. `hoprig setup --only skills` runs it again.


`src/skillhub/hub.mjs` exports:

- `skillsStatus({ project?, check = true })` → `{ user: { dir, installed, suggested }, project: { root, dir,
  installed, suggested, ideas } | null, updates: [{ scope, name, latest, edited }], checked }`
- `runSkillsStep({ ui, project, yes, dryRun })` → `{ ok, added, skipped }`; `ui` is `{ say(line),
  confirm(question) → Promise<boolean> }`. One review and one question per suggested skill; with `yes`, only
  bundled or catalog-pinned entries are added.
