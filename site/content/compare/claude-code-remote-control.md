---
title: Hoprig and Claude Code's own apps and Remote Control
description: Claude Code's own apps reach a session from a phone and run work in the cloud. Hoprig sets up the computer, keeps a workspace in git and moves sessions.
---

# Hoprig or Claude Code's own apps and Remote Control?

If you use one Claude subscription on one computer, Claude Code's own mobile app and Remote Control are the simplest way to reach it from a phone. Hoprig is for when you want more: a computer set up by one command, the same rules, skills and memory on every computer, a session that goes on with another provider at a limit, and API keys or gateways that the official remote does not support.

## What Claude Code's own apps do

From Claude Code's documentation, 17 Nov 2026:

- [Remote Control](https://code.claude.com/docs/en/remote-control) reaches a session on your computer from a phone, a tablet or a browser. It needs a claude.ai subscription: API keys are not supported, and it does not work with Bedrock, Vertex, Foundry or a gateway set through `ANTHROPIC_BASE_URL`.
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) runs sessions in the cloud, from the web and the mobile app.
- [Projects](https://code.claude.com/docs/en/claude-projects), in public beta, start parallel threads in the cloud that share memory and instructions.
- [Agent view](https://code.claude.com/docs/en/agent-view), in research preview, lists your sessions with their state and runs background sessions.
- [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks) come in three kinds: in the cloud, in the Desktop app, and `/loop`.
- The [Desktop app](https://code.claude.com/docs/en/desktop) has parallel sessions, worktrees, SSH sessions, a file editor and a built-in terminal, on macOS, Windows and (in beta) Linux.
- At a usage limit, [Claude Code can wait for the reset and carry on](https://code.claude.com/docs/en/costs), or you pay for extra usage. It does not move to another account or provider.

## What they do better

- **A real phone app**, made by the makers of Claude Code.
- **Work in the cloud**: it goes on with your laptop closed. Hoprig needs a computer of yours that stays on.
- **Nothing extra to install or trust**, and official support.

## What Hoprig adds

| | Hoprig | Claude Code's own apps |
|---|---|---|
| Sets up a fresh computer for coding | Yes (Linux; macOS partly) | No |
| Project memory on another computer | Yes: it lives in the project's git repository | Partly: [Projects](https://code.claude.com/docs/en/claude-projects) (public beta) share memory across cloud threads; a project's memory on your own computer stays there ([issue #25739](https://github.com/anthropics/claude-code/issues/25739)) |
| A session goes on with another provider or account at a limit | Yes, by one tap or Auto mode | No |
| Phone and browser with an API key or a gateway | Yes | No |
| Several computers on one page | Yes, also behind a router | Partly, through Remote Control on each computer |
| A second coding tool (OpenCode) with the same rules, skills and memory | Yes | No |
| Phone app | No, a web page | Yes |
| Runs in the cloud | No | Yes |
| Windows | Yes, new | Yes |

## How to choose

- One subscription, one computer, and you want the simplest phone access: use Claude Code's own app and Remote Control.
- Several computers, API keys or gateways, a second account at the limit, or a fresh machine to set up: Hoprig.
- Both work together. Hoprig runs the official, unmodified Claude Code, so its own features stay available, with one exception: Remote Control does not work through Auto mode's router or with an API key.

## Questions and answers

### Is Hoprig a replacement for Claude Code?

No. It runs the official Claude Code. It sets up the computer around it, keeps your workspace in git, moves sessions between providers, and gives you a dashboard.

### Can I use Remote Control and Hoprig at the same time?

Yes, on a session that uses your Claude subscription directly. Remote Control does not work on a session that runs through Auto mode's router or on an API key; for those, the Hoprig dashboard is the remote.
