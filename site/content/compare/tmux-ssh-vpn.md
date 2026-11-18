---
title: Hoprig and the do-it-yourself way
description: tmux, SSH, a VPN and a terminal app put Claude Code on a phone with nothing new to trust. Hoprig adds machine setup, a workspace in git and provider moves.
---

# Hoprig or tmux, SSH and a VPN?

Many people already code from a phone this way: a VPN such as Tailscale, SSH, tmux to keep sessions alive, and a terminal app on the phone. It works, with nothing new to trust. Hoprig uses the same parts where it can, tmux for sessions and Tailscale if you choose it, and adds what the terminal does not give you: a computer set up by one command, your workspace from git, a session that moves to another provider at a limit, and a chat made for a phone.

## What the do-it-yourself way does

As people describe it in their own write-ups and on Hacker News: Claude Code runs in tmux on an always-on computer, a VPN makes that computer reachable, and a terminal app on the phone connects over SSH. "I use it as a Tailscale + ssh + tmux + Claude code machine, which gives me an always on Claude code environment with persistent sessions", wrote one user.

## What it does better

- **Nothing new to trust**: well-known tools, each doing one job.
- **Any tool, any provider**: whatever runs in a terminal works.
- **The terminal itself**, if that is where you are fastest.
- **A private network** with no sign-in page on the internet at all.

## What Hoprig adds

| | Hoprig | tmux, SSH and a VPN |
|---|---|---|
| Setup of a fresh computer | One command | By hand, each time |
| Workspace and AI memory from git on a new computer | Yes | By hand |
| A session goes on with another provider at a limit | Yes | By hand |
| A chat with diffs and Allow / Do not allow buttons on the phone | Yes | No, a terminal |
| Which session waits for you, on one page | Yes, with notifications | No |
| Sessions survive a closed connection | Yes, in tmux | Yes, in tmux |
| `tmux attach` over SSH | Still works | Yes |
| No public sign-in page | Yes with Tailscale (`hoprig setup --access tailscale`) | Yes |

## How to choose

- You live in the terminal and have the setup already: keep it. Hoprig's sessions are tmux sessions too, so you can add it later and still `tmux attach`.
- You want the same on every computer without an evening of setup, a chat on the phone, and sessions that go on at a limit: Hoprig.

## Questions and answers

### Can I keep using tmux with Hoprig?

Yes. With tmux 3.2 or newer, Hoprig's terminal sessions run in tmux. They survive a restart of the dashboard, and `tmux attach` over SSH still works.

### Can I keep the dashboard off the internet?

Yes. Setup asks who may open the dashboard. Pressing Enter makes it reachable from devices on your network, over plain http (not encrypted), behind its password; choose 1 to keep it on this computer only. On a computer with a public address, "devices on my network" is not offered. `hoprig setup --access tailscale` serves it at an https address that only your own Tailscale devices can open.
