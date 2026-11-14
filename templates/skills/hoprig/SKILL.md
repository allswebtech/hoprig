---
name: hoprig
description: Use Hoprig on this computer - check the setup, see sessions and providers, continue a session on another provider after a usage limit, start work on another computer, set up a project or a fresh machine. Use when the user mentions Hoprig, hop, a usage limit, another provider or account, the dashboard, or setting up this computer or a project.
---

# Hoprig

Hoprig runs Claude Code under several providers (Claude subscriptions, API keys, gateways) with one shared
session store, keeps a session going on another provider when one reaches its usage limit, and has a web
dashboard that also shows other computers.
The command is `hoprig`, or `hop` for short. `hop help` lists everything.

## When to use

- The user asks what is installed or what is wrong on this computer → `hop doctor`, `hop pc status`.
- A usage limit was reached, or the user wants to continue somewhere else → see "Limits" below.
- The user wants a session, a provider, another computer, a project or a skill managed.

## Procedure

1. Look before acting. These only read:
   - `hop doctor`: Claude Code, login, providers, the dashboard, the service.
   - `hop pc status`: tools, versions, disk, git and GitHub sign-in, projects.
   - `hop profiles`: the providers (names and kinds only). `hop auto status`: Auto mode, usage, limits.
   - `hop machines`: the other computers. `hop project status`: a project's repositories.
   - `hop workspace status`: the workspace folder tree (AI brain, projects, credentials) and what is missing.
   - `hop skills list` and `hop skills suggest`: skills here and skills that fit this project.
2. Say what you found in plain words and what you suggest.
3. For anything that changes the computer, tell the user the exact command and let them decide. Typical ones:
   - `hop setup` (first setup), `hop pc setup` (tools for coding), `hop project clone <name>`.
   - `hop add` (another provider; it asks for a sign-in or a key, which only the user gives).
   - `hop auto on` / `hop auto order <provider> <provider>` (Auto mode; an API key costs money).
   - `hop workspace setup` (creates only the missing folders; code inside `projects/`).
   - `hop skills add <id>` (it shows the skill for review first).
4. When the Hoprig MCP tools are connected (`hop mcp`), prefer them: they are checked by the dashboard
   and show the user a card to confirm for anything risky.

## Limits

- The same session continues on another provider: exit Claude Code and choose the provider in the menu that
  appears, or run `hop <provider> -c` in the same folder.
- With Auto mode on, sessions started as `hop auto` move to an API key without stopping, and are
  restarted on the next subscription when that comes first in the order.
  In the dashboard this is Providers → "When a provider reaches its limit" → "Carry on with the next provider".
- Never suggest sharing an account, using someone else's account, or making accounts to get around a
  suspension. Several accounts of the user's own are theirs to decide about; point to the "Is this allowed?"
  section of the Hoprig README when asked.

## Pitfalls

- One session, one terminal: never open the same session twice.
- Provider files, tokens, passwords and keys are never read, printed or passed along. If a step needs one,
  the user types it in Hoprig's own prompt or page.
- The first message after a move to another provider re-reads the whole conversation there; on an API
  key that is paid. Suggest `/compact` first for a long session.

## Verification

After a change, run the matching read-only command again (`hop doctor`, `hop pc status`, `hop auto status`)
and report what it shows now.
