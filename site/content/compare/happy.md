---
title: Hoprig and Happy
description: Happy is a free, end-to-end encrypted phone app for Claude Code and Codex. Hoprig sets up the computer, keeps a workspace in git and moves sessions.
---

# Hoprig or Happy?

Happy puts Claude Code and Codex in your pocket: native phone apps, end-to-end encrypted, free. Hoprig is a dashboard in the browser that also sets up the computer, keeps your workspace and AI memory in git, and moves a session to another provider at a usage limit. If all you want is a good phone app for your sessions, Happy is the more direct answer.

## What Happy does

From [its repository](https://github.com/slopus/happy), 17 Nov 2026:

- It wraps Claude Code and Codex in your terminal, so you can continue from your phone.
- Native apps for iOS and Android.
- End-to-end encryption between your computer and your phone.
- A relay server, whose code is in the same repository.
- MIT licence, and about 24,700 stars on GitHub.

## What Happy does better

- **Native phone apps** on iOS and Android. Hoprig is a web page.
- **End-to-end encryption** of what passes between computer and phone. Hoprig's public link goes through a Cloudflare tunnel, so your traffic passes through Cloudflare.
- **Codex**, which is switched off in this version of Hoprig.
- **Many more users**: about 24,700 stars on GitHub.

## What Hoprig adds

| | Hoprig | Happy |
|---|---|---|
| Sets up a fresh computer for coding | Yes (Linux; macOS partly) | No |
| Workspace and AI memory that come back from git on a new computer | Yes | No |
| A session goes on with another provider or account at a limit | Yes | No |
| Several computers on one page | Yes | Not checked |
| A code editor and a desktop in the browser | Yes | No |
| Native phone app | No | Yes |
| End-to-end encryption to the phone | No | Yes |
| Licence | Open source (Apache-2.0) | Open source (MIT) |

## How to choose

- You want your existing Claude Code or Codex sessions on your phone, with a native app: Happy.
- You want a machine set up, your workspace and memory on every computer, and sessions that go on at a limit: Hoprig.

## Questions and answers

### Do I need a server for either?

Hoprig needs none: on the same Wi-Fi the phone reaches the computer directly, and from anywhere the public link goes through a free Cloudflare tunnel. Happy uses a relay server; its repository contains the relay's code.

### Is Hoprig's connection encrypted?

Through the public link and through a main computer on a server, yes: HTTPS. On your own Wi-Fi the page uses plain http, so use it only on a network you trust. It is not end-to-end encrypted the way Happy describes its connection.
