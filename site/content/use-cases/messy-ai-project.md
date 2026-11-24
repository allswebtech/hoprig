---
order: 2
who: Anyone with an AI-built project
short: A structure from day one: a project's own rules and memory, one AI brain, skills and checks.
---

# My AI-built project became a mess after a few weeks. How do I keep it in order?

Give every project the same structure from the first day: one folder with the rules for the AI, the AI's memory and the docs, and the code repositories inside it, all in git. Hoprig makes that folder with one command, and adds working rules and skills that fit the project.

## Who this is for

You build with an AI coding tool, and the first weeks went fast. Now the AI forgets what was decided, repeats old mistakes, and nobody knows which notes are current.

## The problem

The rules for the AI are in a file nobody updates, the memory is on one computer, decisions live in old chats, and every session starts by re-reading everything. People call it "instant legacy": code that is in use but that nobody, human or AI, can still change with confidence.

## What Hoprig does

1. `hop project new shop` makes one folder for the project, in git: `AGENTS.md` (the one instruction file for AI tools, with `CLAUDE.md` pointing to it), `ai_brain/` for the project's memory, learnings and current context, `docs/`, `decisions.md`, and `code/` for the code repositories. Add `--github` for a private repository on GitHub.
2. `hop project add shop web` adds a code repository at `code/shop-web`, its own git repository, so code and notes do not mix.
3. The project's AI memory lives in its own repository: Claude Code's memory folder for the project is linked there. The next session, and the next computer, know what was decided.
4. `hop pc setup --rules` adds a starting set of working rules for Claude Code: pick the model and effort for the task, prove the most important case first, and "done means proven" (run the check before saying it works). One file, yours to edit; your own `CLAUDE.md` is never touched.
5. `hop skills suggest` reads what the project is made of (its `package.json` and other manifests, no AI) and proposes skills that fit. You see every file and the risky lines before one is added.
6. `hop project status` shows each repository's branch, changes and whether it is ahead or behind; `hop project sync --memory` commits the memory folders and brings everything in step.

![A project's page: its sessions, its earlier conversations and its code repositories](/screenshots/project-page-desktop-light.webp)

## What you need

- Hoprig on your computer, and git (setup installs it).
- A GitHub account if you want `--github`; any git server works with its address.

## What it does not do

- It does not tidy an existing codebase for you. For a project you already have, `hop project clone` understands a parent folder with its code in `code/`; moving files into that shape is your step.
- It does not review your code. The rules and skills ask the coding tool to check its work; the checks run in your project.
- The working rules are a starting point, not a guarantee.
