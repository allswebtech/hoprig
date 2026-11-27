---
order: 11
who: Long-running work
short: Tasks in a queue, schedules and Auto mode, and the results waiting in the chats in the morning.
---

# How do I let AI coding work go on while I sleep?

Line the work up before you go: queue the next messages for a session, or schedule a chat to start at a set time, and, for Claude Code, turn on Auto mode so that a usage limit does not stop it. In the morning the chats show what was done, with every reply and change to review.

## Who this is for

You hand feature-sized work to a coding tool at the end of the day and review it the next morning. You want the next task to start when the last one ends, not when you wake up.

## The problem

A session finishes its task at 1 a.m. and then sits idle. Or it stops at a usage limit, or waits all night for an OK you never saw. People search for "queue messages for Claude Code" and "schedule Claude Code tasks".

## What Hoprig does

The rules that start things are fixed, with no AI deciding: a schedule starts at its time, the queue sends at the end of a reply. What they start can be an AI session. The schedules and the queue are in **Work → Schedules**; the switches are in **Settings → Automations**.

1. **Queue** (always on: it acts only on messages you queued; you queue a message on the session itself): give a session its next messages. Each goes in when a reply ends, and only while the coding tool is the program in front in that terminal; otherwise it waits and its row says why.
2. **Schedules**: at a set time (once, every day, on some days of the week or every month), let the AI work by itself in a project, start a chat (or a terminal session), or send a message to one. When the AI works by itself, it works on a branch of its own. A task of Work can repeat, and can be run by AI at a set time.
3. **Try again after a server error** (on at first): in a Claude Code session, after a server error that is not a limit (never a 4xx, and never on a provider billed by use), wait and continue, three times, then stop and say so in Needs you.
4. **Reopen sessions after a restart**: Claude Code's and OpenCode's terminal sessions come back where they were. It is on at first, with the built-in terminals (the dashboard's own) and with tmux (a program that keeps terminals running when the dashboard stops): with tmux it matters after a restart of the computer, and when tmux itself dies.
5. **Auto mode** (Claude Code only) carries a session on to the next provider at a usage limit, without a tap.
6. **Notifications**: a push to your phone when a session waits for you, needs your OK or reaches a limit.

A chat that waits for your OK waits all night. The permission mode chip decides that before you go: in Bypass permissions (offered once **Allow bypass permissions mode** is on, in Settings → New sessions) Claude Code asks nothing except before some deletes, and Hoprig answers for it when the delete is plainly inside the session's folder; a question to you, what your own settings insist on and any other delete it stops for still wait. Use that mode only in a project you can afford to have changed.

![Work → Schedules: two schedules, with the queued messages below](/screenshots/work-schedules-desktop-light.webp)

## What you need

- The computer stays on, and the dashboard runs in the background (setup installs this background service by default; `hop service install` does it later if it was skipped with `--no-service`).
- A second provider for Auto mode, if limits are a concern.

## What it does not do

- It does not judge whether the work is good. Review it in the morning, as you would a colleague's.
- No triggers from outside, such as a GitHub event or a webhook: only the queue and schedules.
- A task of Work starts on your **Do it**, on your yes to Tia's card, at the time you set on it with **Run by AI**, or, in a mission whose plan you accepted, by Tia (missions are off until you turn them on, on Work → Team). Her tasks run one after another at first. **Sessions at once** on Work → Team lets up to four run side by side, never more than **At most this many at once** on Work → Schedules (also one at first).
- An API key used all night costs money. Auto mode is off until you turn it on.
- Tia, the assistant, can watch a job and report when it is done, but she is experimental and off by default. Her own thinking runs at first on a Claude subscription of yours that can answer, inside your plan; without one, each message to her costs money.
