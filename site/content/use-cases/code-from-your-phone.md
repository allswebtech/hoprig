---
order: 3
who: Coding from a phone
short: The dashboard from anywhere, no server: a chat per project, the OKs and the real terminal.
---

# How do I code on my own PC from my phone with Claude Code?

Install Hoprig on the PC and scan the QR code it shows: your phone opens the dashboard, with a chat for every project, the OK buttons and the real terminal. On the same Wi-Fi that is all; from anywhere, one switch turns on a public link through Cloudflare, with no server of your own.

## Who this is for

You code on a desktop PC, and you want to keep the work going from the sofa, the train or a café: answer a question, allow a step, start the next task.

## The problem

You want "Claude Code from my phone" without renting a server, opening ports on your router, or typing commands into a tiny terminal. And you want to see which session waits for you, not dig through terminal tabs.

## What Hoprig does

1. Install Hoprig on the PC. In setup, the second question is who may open the dashboard; "devices on my network" is the default: your phone on the same Wi-Fi reaches it over plain http, behind its password.
2. Scan the QR code at the end of setup with your phone's camera. The phone is signed in; no password to type. Later, open **Settings → Security and sign-in** and press **Show a sign-in code** under "Sign in another device": it shows a new one-time link and QR code. In a terminal (the window where you type commands): `hop link`.
3. On the phone, **New session**, pick the project: a chat opens. Replies appear as they are written, each change as a diff, with **Allow**, **Allow in this session** and **Do not allow** (and **Always allow in this project** where Claude Code offers it). The real terminal is one tap away.
4. From anywhere: **Settings → Public link → On**, or in a terminal `hop public on`. *Temporary* gives a new https address at each start, with nothing to set up. *Custom* keeps your own address, on a domain in a free Cloudflare account. It turns on only with a strong dashboard password, and a visitor sees only the sign-in page.
5. Turn on **Notifications**: a push to your phone when a session waits for you, needs your OK or reaches a limit.

<p align="center"><img src="/screenshots/chat-phone-light.webp" alt="A chat on a phone: the OK card with its answers and the message box with its chips" width="250"> <img src="/screenshots/session-phone-light.webp" alt="A terminal session on a phone: the real terminal, a key bar and a message box" width="250"></p>

## What you need

- A PC with Linux that stays on while you work from the phone. On macOS its tests run on every change, but the install and the newer parts (the chat, the editor, the desktop) have not been run on a real Mac yet.
- A phone with a browser. Nothing to install on it.
- For the Custom public link only: a domain in a free Cloudflare account.

## What it does not do

- There is no phone app; it is a web page made for a phone.
- When the PC is off, there is nothing to reach. There is no cloud copy.
- On the same Wi-Fi the page uses plain http, which is not encrypted: use it only on a network you trust. Through the public link your traffic passes through Cloudflare.
- Typing with a real phone's on-screen keyboard in the editor and the chat has not been proven yet.
- With one Claude subscription on one computer, Claude Code's own mobile app and Remote Control are simpler. See [Hoprig and Claude Code's own apps](/compare/claude-code-remote-control/).
