---
title: One command, and a computer is ready to code with AI.
description: Hoprig sets a computer up for coding with AI, brings your workspace and AI memory back from git, and moves a session to another provider at a usage limit.
kicker: Free · open source (Apache-2.0) · runs on your own computer
lead: Your rules, skills and memory come along to every machine, and every session is on one page, also on your phone.
under: Works on Linux. On a Mac the tests pass, but the install and the newer parts (the chat, the editor, Work) were not tried on a real Mac. Windows is not ready.
heroAlt: The Hoprig dashboard on a desktop and on a phone: Home with the chats and sessions that need you, and a chat waiting for an OK to run the tests
---

# One command, and a computer is ready to code with AI.

Hoprig sets a computer up for coding with AI coding tools (Claude Code, and OpenCode as a second one), keeps your workspace and an AI memory per project in git so they come back on any computer, and moves a session (one conversation with a coding tool) to another provider or account when one reaches its usage limit. It is free and runs on your own computers.

<!-- install -->

## What does Hoprig do?

Each of these exists somewhere on its own. Hoprig puts the three together, on your own computers.

:::cards three
:::card
### 1. It sets up the computer

One line installs Hoprig. It then checks what the computer has and installs what is missing: git, Node.js, Python, GitHub's own program and your sign-in to it, Claude Code, your projects, and the skills (short instructions for the AI) that fit them. It asks a few questions, each once, and leaves alone what is already there. Works on Linux; on a Mac these installs were not tried yet.

[A new computer in one run](/use-cases/new-computer/)
:::
:::card
### 2. One workspace that comes back from git

Your projects, their rules and an AI memory per project live in git. On the next computer one command brings all of it back where it belongs, and your coding tools read the same rules, skills and memory.

[Two computers, one workspace](/use-cases/two-computers-one-workspace/)
:::
:::card
### 3. A session goes on at a usage limit

Subscriptions, API keys and gateways are all "providers". When one reaches its limit, one tap continues the same conversation on another provider or another Claude account of yours. Auto mode, a choice on the Providers page, can do it for you, in Claude Code.

[What to do at a usage limit](/use-cases/usage-limit/)
:::
:::

## Who it is for

Find your case. Each page says who it is for, what Hoprig does step by step with the real commands, what you need, and what it does not do.

<!-- usecases -->

## How it works

:::steps
1. **Install.** Paste one line into a terminal. It adds what is missing, after a few questions, each asked once, and ends with a QR code (on a server: how to reach it from your own computer).
2. **Open the dashboard.** Scan the QR code with your phone, or open it on the computer. Until everything is set up, Home shows a Get started list.
3. **Code in a chat.** Pick a project and start a chat with Claude Code or OpenCode. You see each change and press **Allow** or **Do not allow**, at your desk or on your phone.
:::

<!-- install -->

## Compared, honestly

Other tools do some of this, and some of it better. Checked on 17 Nov 2026 from each tool's own pages.

| | Hoprig | Claude Code's own apps | Happy | tmux, SSH and a VPN |
|---|---|---|---|---|
| Sets up a fresh computer for coding | Yes on Linux; on a Mac not tried yet | No | No | No |
| Rules, skills and project memory come back on a new computer | Yes, from git | Partly: project memory stays on one computer | No | No |
| A session goes on with another provider or account at a limit | Yes | No: it waits for the reset, or you pay for extra usage | No | No |
| From a phone | Yes, in the browser | Yes, an app | Yes, an app | Yes, in a terminal app |
| From a phone with an API key or a gateway | Yes | No | Not checked | Yes |
| Goes on with your computer switched off | No | Yes, cloud sessions | No | No |
| Windows | Not yet | Yes | Not checked | Depends on the tools |

- [Hoprig and Claude Code's own apps and Remote Control](/compare/claude-code-remote-control/)
- [Hoprig and Happy](/compare/happy/)
- [Hoprig and the do-it-yourself way: tmux, SSH and a VPN](/compare/tmux-ssh-vpn/)

## Questions and answers

:::faq
### Is Hoprig free?

Yes. It is open source under the [Apache License 2.0](https://github.com/allswebtech/hoprig/blob/main/LICENSE): you may use, change and share the code. It runs on your own computers and has no server of its own, no account and no plan. What can cost money is the provider you choose: a Claude plan, an API key or a gateway.

### Do I need a server?

No. One computer is enough. Your phone reaches it on the same Wi-Fi, or from anywhere with the public link (a free Cloudflare address that Hoprig turns on with one switch). A server helps only as an always-on main computer for several computers.

### Does it work on Windows?

Not yet. Its code is written, but the tests do not pass on Windows. Linux is run and tested. On a Mac the tests pass on every change and switching providers was tried there, but the install itself and the newer parts (the chat, the editor, the desktop, Work) have not been tried on a real Mac.

### Does it change Claude Code?

No. Hoprig runs the official, unmodified Claude Code and OpenCode, and keeps your accounts on your own computers.

### Is it allowed to go on with a second Claude account?

Anthropic's documentation covers several accounts of your own on one machine, API keys and gateways. Whether going on past a limit on a second subscription of your own is acceptable is not clearly settled by the terms. The surest setup is one subscription, then an API key. [Is this allowed?](/docs/is-this-allowed/)

### Is there a phone app?

No. The dashboard is a web page made to work on a phone: chats, OKs, terminals and the editor. Typing with a real phone's on-screen keyboard in the editor and the chat has not been proven yet.

### Which coding tools does it run?

Claude Code, and OpenCode as a second one. OpenCode runs only on an API key or a gateway, never on a Claude subscription. Codex is not part of this version.

### What are the Operator and Tia?

The **Operator** is one page of the dashboard that lists what needs you now, the most urgent first, with one button for the recommended step. It does nothing by itself: [see on one page what needs you](/use-cases/what-needs-you/). **Tia** is the dashboard's assistant: you tell her what you want. She has three levels, set in Settings → Tia: **Ask me** (she asks you before everything she types into a session), **Do the work** (as installed: she does the job herself and asks you before anything risky) and **Hands off** (she may also use the paid providers you allowed, within the daily limit below). On the Operator page she has switches of her own, all off at first: rules such as the limit rule (a session at a usage limit goes on with the next provider of your order); **Tia decides** (for a new item that needs you, she asks a small model one short question and does the step it picks, or leaves it to you); and a look into what nobody can explain (a session that only reads the project, to find why a run failed). On a subscription she simply answers; when every subscription is at its limit she says so with the time and does not move to a paid provider by herself. What she asks to install, update, restart or power off on your computer, or to end a process there, comes to you as a card first, at every level. So does what costs money, except where you choose otherwise. Within a daily limit for paid use you set in Settings → Tia (none at first), she may write to sessions on paid providers unless her level is **Ask me**, and at **Hands off** also start or move her sessions there. At **Hands off**, the Operator's limit rule or **Tia decides**, once you turn them on, may also move a session at a usage limit onto a paid provider, only within that limit, and each move counts against it. At **Hands off**, the short call of **Tia decides** and a look into what nobody can explain may also run on such a provider when every provider you allowed her is paid per use (Auto mode counts as paid per use here when its order holds such a provider), only within that limit too, and each counts against it. The Operator's rules, once you turn them on, restart a gateway or the public link that does not answer and end a test's left-over processes by themselves. **Tia decides** may make the same restarts, type one fixed line of Hoprig's into a stuck session to nudge it, and end a stuck session only in a project where you ticked **Tia may end a stuck session in this project** on the project's page ([the Operator guide](/docs/operator/)). Typing into a session that runs on a provider paid per use, the nudge too, is money: **Tia decides** does it only at **Hands off** and within that limit, and it counts against it. She is experimental and off until you turn her on, and so is everything she may do by herself: [Tia, the assistant](/docs/tia/).

### How ready is it?

Its tests run on Linux and macOS with Node.js 22, 24 and 26 on every change. Hoprig needs Node.js 22.11 or newer, and the install adds it. The newer parts (the chat, the editor, the desktop, Work) were tried by hand on Linux only, not on a real Mac, and the last checks of this version ran on stand-ins for the coding tools, not on real Claude Code or OpenCode. Everything that is not built or not proven yet is on one page: [Not built, or not proven yet](/docs/not-proven-yet/).
:::

## Start now

<!-- install -->

Then read [how the install works](/docs/install/), or [find your use case](/use-cases/).
