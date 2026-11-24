---
order: 4
who: Two or more computers
short: Home PC, office PC, laptop: the same projects, rules, skills and memory through git, every session on one page.
---

# How do I use Claude Code on two computers with the same skills, rules and memory?

Keep them in one workspace that lives in git. Hoprig links Claude Code's rules, skills and memory to your own AI brain repository and each project's memory to that project's repository; on the next computer `hop workspace restore` brings the brain back, `hop get` brings each project when you need it, and `hop workspace sync` keeps the repositories in step.

## Who this is for

You use Claude Code on a desktop and a laptop, or at home and at the office. A skill you made on one is missing on the other, and the project memory does not match.

## The problem

Claude Code keeps a project's memory under a folder named after the project's full path on that computer, so it does not carry over to another machine. People search for "sync Claude Code skills and memory between two computers" or "share CLAUDE.md and skills across machines", and many end up building their own git repository for it by hand.

## What Hoprig does

1. On the first computer, `hop workspace setup` creates the one folder tree (`~/Workspace` with `ai_brain/`, `projects/` and the rest). It creates only what is missing.
2. `hop workspace link` makes every coding tool that is on read the same global rules, skills and memory from your AI brain. Nothing is overwritten: a file that is already there is merged into the brain and kept as a dated backup.
3. `hop workspace git` signs you in to GitHub and offers to start your brain in a private repository.
4. `hop workspace map` writes one file in the brain that lists every git repository of the workspace, by address only, never a token. It never commits; it prints the `git add` and `git commit` to run.
5. On the second computer: install Hoprig, then `hop workspace restore <your brain's address>`. It shows the plan, asks once, and clones the brain and the other repositories its map names. A project comes when you ask for it: `hop get <name>` clones it with its code repositories and links its memory (`--with-projects` on restore brings them all at once). `hop get --list` shows every project of the map and which computer has it.
6. From then on, `hop workspace sync` fetches and fast-forwards every repository on this computer; it pushes only with `--push`, and `--memory` commits the memory folders first. `hop sync <name>`, or **Sync** on the Workspace page, does it for one project. Every few hours the dashboard can keep the AI brain and its other repositories in step by itself (off until you turn it on: `hop workspace auto --sync on`); it never fetches or pushes a project by itself.
7. To see both computers' sessions in one place: **Computers → Add a computer**.

On the first computer:

```sh
hop workspace setup         # the folder tree; only what is missing
hop workspace link          # the coding tools read the brain's rules, skills and memory
hop workspace map           # the list of every repository, in the brain
```

On the next computer:

```sh
hop workspace restore <your brain's address>
hop get <project>           # a project, when you need it here
hop workspace sync --memory # later: every repository in step
```

![The Computers page: every computer in one list, with its state](/screenshots/computers-desktop-light.webp)

## What you need

- Hoprig on both computers.
- A git server for your brain and projects. GitHub works; any git address does.

## What it does not do

- **Sessions stay on the computer they ran on.** The conversations themselves are not copied between computers; the dashboard shows every computer's sessions on one page, and the memory travels through git.
- It is not live sync. Memory moves when it is committed and pushed, and sync never merges: when both sides changed, it lists the command to run. The one exception is the map: with `hop workspace auto --commit on --push on`, two computers that each added a project still end with one map, which Hoprig unites by its own rule, never merging text and never forcing.
- Not yet proven between two computers in use: the workspace of 0.3.3 was run on Linux only, in temporary homes.
- Keys and passwords are never put in git. The `credentials/` folder stays on each computer; copy it yourself.
