---
title: The Hoprig skill
description: A skill that teaches an AI coding tool to use Hoprig: check the setup, see providers and limits, continue a session elsewhere, look before acting.
---

# The Hoprig skill

A skill is a short set of instructions that a coding tool such as Claude Code loads when a task fits it. The Hoprig skill teaches your coding tool to use Hoprig on your behalf: look before acting, say what it found, and leave every change to you.

## What an AI can do with it

- Check what is installed and what is wrong on the computer: `hop doctor`, `hop pc status`.
- See the providers, Auto mode, usage and limits: `hop profiles`, `hop auto status`.
- Tell you how to continue a session on another provider after a usage limit.
- See the other computers, a project's repositories, the workspace and the skills.
- Suggest the exact command for a change (`hop setup`, `hop add`, `hop auto on`, `hop skills add …`) and let you decide.
- Use Hoprig's own tools through MCP (`hop mcp`) when they are connected: the dashboard checks them, and shows you a card to confirm anything risky.

It never reads, prints or passes on a provider file, a token, a password or a key.

## How to add it

It comes with Hoprig. `hoprig setup` offers it first, and you can add it at any time:

```sh
hop skills add hoprig --user
```

It goes into your own skills folder (`~/.claude/skills/hoprig`), so it works in every project. Claude Code reads that folder, and OpenCode reads it too; after `hop workspace link` the folder is your AI brain's, which OpenCode also reads as `~/.agents/skills`. Its version is the version of Hoprig you have; `hop skills update` brings the newest after an update of Hoprig.

**Coming:** an npm package for the skill, to copy it into a coding tool's skills folder without installing Hoprig first.

## Its text

This is the skill exactly as it ships, read from the code at every build of this site:

<!-- skill-text -->
