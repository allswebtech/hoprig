---
order: 2
who: Anyone with an AI-built project
short: A structure from day one: a project's own rules and memory, one AI brain, skills and checks.
---

# My AI-built project became a mess after a few weeks. How do I keep it in order?

Give every project the same structure from the first day: one folder with the rules for the AI, the AI's memory and the docs, and the code repositories inside it, all in git (a record of every version of your files). On the **Workspace** page, press **New project** and Hoprig makes that folder, then adds working rules and skills that fit the project; in a terminal, `hop project new` does the same.

## Who this is for

You build with an AI coding tool, and the first weeks went fast. Now the AI forgets what was decided, repeats old mistakes, and nobody knows which notes are current.

## The problem

The rules for the AI are in a file nobody updates, the memory is on one computer, decisions live in old chats, and every session starts by re-reading everything. People call it "instant legacy": code that is in use but that nobody, human or AI, can still change with confidence.

## What Hoprig does

1. On the **Workspace** page, press **New project** and give it a name: it makes one folder for the project, in git: `AGENTS.md` (the one instruction file for AI tools, with `CLAUDE.md` pointing to it), `ai_brain/` for the project's memory, learnings and current context, `docs/`, `decisions.md`, and `code/` for the code repositories. Choose **Also on GitHub, private** for a private repository (a project's folder kept on a server) on GitHub. In a terminal (the window where you type commands): `hop project new shop`, with `--github` for GitHub.
2. On the project's page, press **Add a repository** and name it web: it adds a code repository at `code/shop-web`, its own git repository, so code and notes do not mix. In a terminal: `hop project add shop web`.
3. The project's AI memory lives in its own repository: Claude Code's memory folder for the project is linked there. The next session, and the next computer, know what was decided.
4. On **Computers → this computer → Setup**, press **Add** on the row "Working rules": it adds a starting set of working rules for Claude Code: pick the model and effort for the task, prove the most important case first, and "done means proven" (run the check before saying it works). One file, yours to edit; your own `CLAUDE.md` is never touched. In a terminal: `hop pc setup --rules`.
5. On the **Skills** page, open the **Suggested** tab: it reads what the project is made of (its `package.json` and other manifests, no AI) and proposes skills (ready-made instructions for the coding tool) that fit. Press **Review** on one: you see every file and the risky lines before it is added. In a terminal: `hop skills suggest`.
6. The project's page shows each repository's branch, its changes not saved to git and what is to upload or download. Press **Sync and save the AI memory** there: it commits the memory folders and brings everything in step. In a terminal: `hop project status`, then `hop project sync --memory`.

![A project's page: its sessions, its earlier conversations and its code repositories](/screenshots/project-page-desktop-light.webp)

## When the project grows

A project that grows stays in order because each part has one place, the same in every project and on every computer. What keeps it so today, and where you see it:

- The project's own rules and memory: its `AGENTS.md` (what the AI is told for this project), `decisions.md` and its `ai_brain/` folder. On the **AI brain** page, each project has a part of its own with them.
- One AI brain for all projects: the folder `ai_brain` holds the rules every coding tool gets, the skills and the memory for everywhere, in its own private git repository (a folder whose every version git keeps, here on GitHub or another git server). The **AI brain** page shows it: "Rules for every tool", "Memory", "Learnings and current context" and "Daily logs".
- The same folder layout everywhere: the AI brain, then one folder per project with each code repository under its `code/`, then credentials, tools, databases and backups, each folder with its one purpose. **Settings → Workspace** shows where each one is.
- A map of every repository: one file in the AI brain lists every repository of the workspace by its address, so another computer knows what belongs where. **Settings → Workspace**, **Update the map**.
- Every repository in step: a project's page on **Workspace** shows each repository's branch and how many saved changes wait to be uploaded. **Sync** downloads new changes and uploads saved ones, and never merges or overwrites; **Sync and save the AI memory** also saves the memory first.
- Skills and checks that fit: **Skills → Suggested** lists skills that fit what the project is made of, and the working rules ask the coding tool to run the project's checks before it says "done".
- Plans: on **Work → Plans**, **Plan with AI** turns a goal into milestones and tasks you accept one by one, kept in Work and not in an old chat.

It does not design your code's structure for you, and it does not tidy a project that grew without one: the rules and skills tell the AI how to work, and the AI's work still needs your review.

## Your AI brain, and what it learns

There are two kinds of memory, both plain files in git:

- One memory per project: the project's `ai_brain/` folder. Claude Code's memory folder for the project is linked there, so what a Claude Code session saves to its memory lands in the project's repository, and **Sync and save the AI memory** on the project's page saves it in git.
- One main brain: the folder `ai_brain`, with the rules every coding tool gets, the skills, the memory for everywhere, the learnings, the current context and the daily logs. The **AI brain** page shows what it holds, read-only.

What learns today is one switch: **Skills → Learned**, **Learn skills from my work**, off until you turn it on, in the panel at the top of that tab. There you choose the provider and model that do the looking (a look costs usage there) and how many looks a week are allowed, 1 to 20 looks a week (5 by default). Only your own doing in **Work** is looked at: a result you sent back with your words, or one you accepted and marked with **Learn from this**. Never every session. From that it drafts a skill (a written way of doing one thing that your coding tools read), at most three drafts a week. A draft waits in **Skills → Learned**, with where it came from and the lines it would add: nothing is installed until you press **Install**, **Undo** takes an installed one back, and **Discard** removes a draft so the same idea is not offered again. A coding session that found a way round a failed Hoprig command can leave a draft there too.

The brain does not learn by itself from everything: the notes in it are written by you or by your coding tools, and Hoprig adds a learned skill only when you press **Install**. [Skills learned from your work](/docs/skills/#skills-learned-from-your-work) has every detail.

## What you need

- Hoprig on your computer, and git (setup installs it).
- A GitHub account if you want `--github`; any git server works with its address.

## What it does not do

- It does not tidy an existing codebase for you. For a project you already have, **Get an existing project** on the Workspace page (in a terminal, `hop project clone`) understands a parent folder with its code in `code/`; moving files into that shape is your step.
- It does not review your code. The rules and skills ask the coding tool to check its work; the checks run in your project.
- The working rules are a starting point, not a guarantee.
