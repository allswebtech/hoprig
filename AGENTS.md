# AGENTS.md — rules for anyone (person or AI tool) working on Hoprig

`CLAUDE.md` and other tool files point here. Change the rules in this file only.

## What this is

Hoprig turns a computer into a managed place to code with Claude Code and OpenCode: it installs what is missing,
runs each coding tool under several providers (a session continues on another provider after a usage limit), and
serves a web dashboard (chats, terminals, a code editor, a desktop) that also shows other computers. Node.js ≥ 20, ES modules,
no framework, no build step. Runtime dependencies are few and pinned.

## Map

| Where | What |
|---|---|
| `bin/hoprig.mjs` | the command: dispatch only |
| `bin/hoprig-hook.mjs` | what Claude Code starts for a hook event: small on purpose, Claude Code waits for it |
| `src/*.mjs` | the launcher: providers (`profiles`), sessions, run records (`runs`), launch (`launch`), the hook that keeps a session's status (`hook`), Auto mode (`autoswitch`, `router`), menus |
| `src/server/` | the dashboard: HTTP and WebSocket server, login, terminal backends (`backends/`: tmux and built-in), per-OS information (`platform/`), background service (`service/`) |
| `src/machines/` | several computers: hub, pairing, tokens, relay, `join` |
| `src/chat/` | the coding chat: one engine per coding tool (`engines/`), its events, OKs, queue, hand-off to a terminal |
| `src/codetools/` | the coding tools (Claude Code, OpenCode; Codex kept switched off): install, start, servers, providers |
| `src/editor/`, `src/desktop/` | the code editor's routes (files, search, git) and the desktop's apps (files, processes, services, logs) |
| `src/assistant/` | Tia: tools, policy, confirm cards, jobs, MCP server, eval |
| `src/automation/` | queue, schedules, restore, retry, updates (no AI) |
| `src/setup/`, `src/pcsetup/`, `src/skillhub/`, `src/addons/` | first setup and doctor, computer and project setup, skills, add-ons |
| `web/` | the page: plain modules, no bundler (`web/chat/`, `web/editor/`, `web/desktop/` for those parts) |
| `test/` | `node:test`; one folder per area |

A feature of the server is one module registered in the `features` list in `src/server/server.mjs`; a part
of the page is one file registered through `web/registry.js`.

## Rules

- **Prove it.** `npm test` passes before a change is done. The end-to-end tests run on tmux where it is
  installed and on the built-in terminals everywhere. Say what you ran and what you could not run; never
  write "works on Windows" for code that was not run on Windows.
- **Small, plain code.** Small modules, comments that say why, no dead code, no new dependency without a
  strong reason. Plain words in everything a user reads; the same word for the same thing ("provider",
  "computer", "session"; the product is "Hoprig", the command `hoprig`).
- **Nothing private in the repo.** No machine paths, names, tokens or keys. Everything is found from the
  file's own place or from an environment variable.
- **Secrets stay where they are.** Provider files, tokens and passwords are never returned by a route,
  printed, logged or sent to a browser. Tests assert it.
- **The trust rules are code, not hope.** Input from a browser, a terminal, a file name, another computer or
  a downloaded skill is validated and treated as data. Every argument to another program is an array, never
  a shell string built from input. The router never attaches a subscription's token to a request: only
  Claude Code itself uses a subscription sign-in.
- **Fewer steps.** What is not needed goes. A setting has one plain sentence under it. Defaults are safe:
  anything that costs money, runs commands or opens the dashboard to a network is off until chosen.
- **Tia's tools** follow the checklist in `src/assistant/tools.mjs` (level, strict schema, server-side
  re-validation, confirm cards, audit) and the real-model eval must not drop below its baseline.

## How to work here

- Model and effort per task: the fast model for running and recording, the strong model for writing and
  reviewing code, the strongest for an unknown cause, a design decision and the last check. Effort low for
  mechanical work, high only where thinking decides the result.
- The narrow case first, then the rest side by side. Estimate before anything long.
- Commit messages say what changed and why in plain words.
