---
order: 15
who: Starting from an idea
short: Write the brief once; the AI fits the work to the project, asks you once, writes the documents, then builds with proof.
---

# How do I start a new project with Claude Code from a written brief?

Write what you want in a brief, in your own words, and run `hop project new shop --brief brief.md --start`, or use **New project** on the Workspace page. Hoprig keeps the brief unchanged in the project, adds a skill that every coding tool finds there, and opens a session that asks you its open questions in one message before it writes any code.

## Who this is for

You have an idea for a website, an app or a tool, written down in a few paragraphs. You want the AI to build it the way a careful team would: the right parts for its size, documents first, checks at the end.

## The problem

People ask "what should I tell Claude Code before it starts a new project" or "how do I stop the AI from over-building a small site". A brief pasted into a chat is lost with the chat. The AI asks questions one at a time, or none at all, and a small website gets the machinery of a large product, or a product with accounts gets the shortcuts of a toy.

## What Hoprig does

1. Write the brief in a file, in your own words. It is kept as you wrote it.
2. `hop project new shop --brief brief.md --start` makes the project's folder in git, keeps the brief, unchanged, as `docs/brief.md`, and puts the bundled **new-project** skill into the project. `--dry-run` shows first what it would make.
3. `--kind` is your hint of what it is (`website`, `web-app`, `multi-tenant`, `internal`, `api`, `mobile-first`, `cli`, `library`, `extension`, `desktop`). `--scope product` has the AI build the whole product; `--scope setup` only its foundation.
4. In the dashboard, the same: **Workspace → New project**, the name, the brief, **What kind of project is it?**, **What should the AI build?** (**The whole product** or **The set-up only**), **Start with AI** with the coding tool, the provider, the model and the effort, then **Create and start with AI**.
5. `--start` (or **Start with AI**) opens a session in the App that begins with the skill. It works out what kind of project it is, how big its data and its traffic can get, and which of its parts apply in full, in a light form or not at all. It shows you that in one message, with a recommended answer to every open question, and waits for your one reply.
6. Then it writes the project's documents (the brief, the flows, a test matrix, a checklist with a row for every rule, the decisions) before any code, builds in a fixed order, and ends with a review and a report with proof.
7. Your own defaults (the language you are answered in, your country, your providers, your hosting) are read from `ai_brain/project-defaults.md` in your workspace when that file is there. Hoprig never writes it.

```sh
hop project new shop --brief brief.md --kind web-app --dry-run
hop project new shop --brief brief.md --kind web-app --start
```

## What you need

- Hoprig, and a provider for the coding tool (`hop add`).
- The dashboard running on the computer for `--start`: it is the dashboard that opens the session. Without it the project is made, and `hop project start shop` starts the session later.

## What it does not do

- The skill is instructions the coding tool follows. It makes the AI work in order and show proof; it cannot promise that the result is right. Read its report and try the product.
- A rule that protects people or data is never made lighter by the kind or the size of a project.
- The kind is a hint: the skill decides the kind from the brief and tells you what it read.
- Run on Linux only, in temporary homes, in this version.
