---
title: The Hoprig skill
description: A skill that teaches an AI coding tool to use Hoprig: check the setup, see providers and limits, continue a session elsewhere, look before acting.
---

# The Hoprig skill

A skill is a short set of instructions that a coding tool such as Claude Code loads when a task fits it. The Hoprig skill teaches your coding tool to use Hoprig on your behalf: look before acting, say what it found, and leave every change to you.

Add it with `npx hoprig-skill --claude` (or `--agents`, or `--project <dir>`), or with Hoprig installed, `hop skills add hoprig --user`. [How to add it](#how-to-add-it) has the details.

## What an AI can do with it

- Check what is installed and what is wrong on the computer: `hop doctor`, `hop pc status`.
- See the providers, Auto mode, usage and limits: `hop profiles`, `hop auto status`.
- Tell you how to continue a session on another provider after a usage limit.
- Keep your tasks (`hop tasks`), see the workspace and get a project into it (`hop workspace status`, `hop get <name>`), see the other computers and the skills.
- Run a dry run first where a command has one, then suggest the exact command for the change (`hop setup`, `hop add`, `hop auto on`, `hop skills add …`) and let you decide.
- Use Hoprig's own tools through MCP (`hop mcp`) when they are connected: the dashboard checks them, and shows you a card to confirm anything risky.

It never puts a secret on a command line, never reads or prints a provider file, a token, a password or a key, and never deletes anything without your word.

## It cannot fall behind

The skill is made from Hoprig itself at every version: a short hand-written part (when to use Hoprig, the order of steps, what never to do), every command's own help as the program prints it, and the version. `SKILL.md` stays short; the full reference of every command and option is in `references/commands.md` beside it, which the coding tool reads when it needs it. A command that changes without the skill being made again fails Hoprig's tests.

## How to add it

**Without Hoprig**, into any coding tool's skills folder, with Node.js 24.13.1 or newer:

```sh
npx hoprig-skill --claude
```

- `--claude`: your own Claude Code skills (`~/.claude/skills`).
- `--agents`: the folder coding tools share (`~/.agents/skills`), which OpenCode reads.
- `--project <dir>`: one project's own (`<dir>/.claude/skills`).
- `--dry-run` with any of them: what it would write; it writes nothing. `--print` shows the skill's text.

It keeps a record of what it wrote. Run it again after a new version: a copy it wrote is updated, a copy you edited is left alone and you see what would change (`--force` replaces it anyway). `--remove` takes it away again.

**With Hoprig**, it comes with it. `hoprig setup` offers it first, and you can add it at any time:

```sh
hop skills add hoprig --user
```

It goes into your own skills folder (`~/.claude/skills/hoprig`), so it works in every project. Claude Code reads that folder, and OpenCode reads it too; after `hop workspace link` the folder is your AI brain's, which OpenCode also reads as `~/.agents/skills`. Its version is the version of Hoprig you have; after an update of Hoprig, `hop skills update` shows what changed in it and replaces it on your yes (Undo: `hop skills undo hoprig`). A copy you edited is not replaced unless you say so.

## Its text

This is the skill exactly as it ships, read from the code at every build of this site. It is also here as plain Markdown: [SKILL.md](/skill/SKILL.md), with every command's help in [references/commands.md](/skill/references/commands.md).

<!-- skill-text -->
