---
order: 1
who: Not a developer
short: The set-up is the wall. Hoprig installs and checks everything, then you build in a chat.
---

# I am not a developer. How do I start building with AI on my own computer?

Paste one line into a terminal and Hoprig sets up the rest: the programs coding needs, a sign-in to GitHub (a free site that keeps your project's history safe), Claude Code and a first project, asking you a few questions, each once. Then you build by chatting with the coding tool in a web page, where you see each change and press **Allow** or **Do not allow**.

## Who this is for

You have an idea for an app, a website or a tool. You have heard that Claude Code can build it. You are not a programmer, and you have never set up a computer for coding.

## The problem

Most guides start with "install Node.js, install git, sign in to GitHub, open a terminal". Each step can go wrong, and you do not know which error matters. People ask things like "how do I set up a computer for vibe coding from scratch" or "I am not a developer, how do I start with Claude Code". The set-up is the wall, before any building starts.

## What Hoprig does

1. You open the Terminal app (on a Mac: Terminal; on Linux: any terminal) and paste the line below (the one that starts with `curl`), then press Enter. The line fetches Hoprig's installer from GitHub and runs it on your computer. It lists what is missing and installs it, without asking: Node.js (the program that Hoprig and Claude Code run on), and on Linux a few system programs, for which the computer may ask for your password. Then it installs Hoprig.
2. `hoprig setup` runs by itself after the install. It shows what the computer already has and asks once before it installs the tools for coding. When Claude Code is missing, it installs it for you. It adds Hoprig's own skills without asking. What is already there is left alone.
3. It asks a few plain questions: who may open the dashboard (pressing Enter lets your phone on the same Wi-Fi open it; that link is not encrypted, so use it only on your own Wi-Fi; the QR code at the end signs your phone in, and the dashboard's password, if it is ever asked, is in the file named under the QR code; choose 1 to keep it on this computer only), whether to sign in to GitHub, and the name of a first project. Each one can be skipped and done later.
4. If you are not signed in to Claude yet, it says so in one line and goes on: you sign in later on the dashboard, where Home's Get started list has **Sign in to Claude** (it opens Claude's sign-in page in your browser).
5. At the end you see a QR code, a square pattern that your phone's camera opens as a link. Scan it to sign your phone in, or open the dashboard on the computer. Until everything is set up, Home shows a Get started list of what is done and what comes next.
6. Press **New session**, pick your project, and describe what you want in plain words. Every change shows the lines it removes and the lines it adds, with **Allow** and **Do not allow** buttons.

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
```

![Home with Get started: what is set up on this computer and what comes next, above the chats and sessions](/screenshots/get-started-desktop-light.webp)

At any time, open **Computers**, then this computer, then its **Setup** tab: it checks everything, and under a problem that one press can fix there is a **Fix** button, which asks before it changes anything. (Or, in a terminal, `hoprig doctor` shows the same checks.)

## What you need

- A computer with Linux, and an internet connection. On macOS its tests run on every change, but the install and the newer parts (the chat, the editor, the desktop) have not been run on a real Mac yet.
- A Claude plan (or an API key) for Claude Code itself. Hoprig is free; the AI is not.
- A GitHub account is useful (it is free) so that your project is kept safe in git. You can skip it at first.

## What it does not do

- **Windows is not ready yet.** Its code is written and its tests pass on GitHub's Windows runners, but it has not run on real Windows computers beyond one: Windows support is experimental.
- It does not teach you to code, and it cannot make the AI's work correct. Read what the chat says it did, and try the result.
- You still need the terminal once, to paste the install line.
- An install on a real Mac has not been run yet; Linux installs were run on clean Ubuntu, Debian and Fedora.
