---
order: 4
who: Two or more computers
short: Home PC, office PC, laptop: the same projects, rules, skills and memory through git, every session on one page.
---

# How do I use Claude Code on two computers with the same skills, rules and memory?

Keep them in one workspace that lives in git (a record of every version of your files, kept on a server such as GitHub): Hoprig links Claude Code's rules, skills and memory to your own AI brain repository (a folder kept in git) and each project's memory to that project's repository. On the next computer, press **Bring my workspace from git** on the empty **Workspace** page, then **Get it** on each project you need and **Sync** to keep them in step; in a terminal, `hop workspace restore`, `hop get` and `hop workspace sync` do the same.

## Who this is for

You use Claude Code on a desktop and a laptop, or at home and at the office. A skill you made on one is missing on the other, and the project memory does not match.

## The problem

Claude Code keeps a project's memory under a folder named after the project's full path on that computer, so it does not carry over to another machine. People search for "sync Claude Code skills and memory between two computers" or "share CLAUDE.md and skills across machines", and many end up building their own git repository for it by hand.

## What Hoprig does

1. On the first computer, open the **AI brain** page and press **Set up the workspace** (or **Create what is missing** under "Workspace folders" on **Settings → Workspace**): it creates the one folder tree (`~/Workspace` with `ai_brain/`, `projects/` and the rest), only what is missing. In a terminal (the window where you type commands): `hop workspace setup`.
2. On the **AI brain** page, press **Link** under "Coding tools": every coding tool that is on reads the same global rules, skills and memory from your AI brain. Nothing is overwritten: a file that is already there is merged into the brain and kept as a dated backup. In a terminal: `hop workspace link`.
3. On **Computers → this computer → Setup**, press **Sign in** on the row "Signed in to GitHub" (you type a one-time code on GitHub's own page), then **Keep on GitHub** on the AI brain's row and **Create it**: your brain goes into a new private repository of yours. In a terminal: `hop workspace git`.
4. On **Settings → Workspace**, press **Update the map**: it writes one file in the brain that lists every git repository of the workspace, by address only, never a token. The dashboard then keeps it up to date by itself, and **Save it now** saves a changed map in the brain's history. In a terminal: `hop workspace map`, which never commits; it prints the `git add` and `git commit` to run.
5. On the second computer: install Hoprig, open the **Workspace** page, press **Bring my workspace from git**, type your brain's address and press **Look at the plan**. It shows the plan, then clones (copies down) the brain and the other repositories its map names. A project comes when you ask for it: press **Get it** on its card, and it comes with its code repositories and its memory linked; tick **Also get every project of the map on this computer** to get them all at once. In a terminal: `hop workspace restore <your brain's address>`, then `hop get <name>` for a project (`--with-projects` on restore brings them all), and `hop get --list` shows every project of the map and which computer has it.
6. From then on, press **Sync** on the **Workspace** page: it fetches and moves every repository on this computer forward, and never merges. Tick **Also save the AI memory (commits only the memory folders)** or **Also upload my saved changes** in it when you want those. **Sync** on a project's page does it for one project. Every few hours the dashboard can keep the AI brain and its other repositories in step by itself: on **Settings → Workspace**, turn on **Keep the workspace in step** (off until you turn it on); it never fetches or pushes a project by itself. In a terminal: `hop workspace sync` (`--push` uploads, `--memory` commits the memory folders first), `hop sync <name>` for one project, `hop workspace auto --sync on`.
7. To see both computers' sessions in one place: **Computers → Add a computer**.

![The Computers page: every computer in one list, with its state](/screenshots/computers-desktop-light.webp)

## In a terminal

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

## What you need

- Hoprig on both computers.
- A git server for your brain and projects. GitHub works; any git address does.

## What it does not do

- **Sessions stay on the computer they ran on.** The conversations themselves are not copied between computers; the dashboard shows every computer's sessions on one page, and the memory travels through git.
- It is not live sync. Memory moves when it is committed and pushed, and sync never merges: when both sides changed, it lists the command to run. The one exception is the map: with **Save a change of the map in the AI brain's history** and **Also upload** on (Settings → Workspace, or in a terminal `hop workspace auto --commit on --push on`), two computers that each added a project still end with one map, which Hoprig unites by its own rule, never merging text and never forcing.
- Not yet proven between two computers in use: the workspace of 0.3.3 was run on Linux only, in temporary homes.
- Keys and passwords are never put in git. The `credentials/` folder stays on each computer; copy it yourself.
