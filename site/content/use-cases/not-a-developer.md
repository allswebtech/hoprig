---
order: 1
who: Not a developer
short: The set-up is the wall. Hoprig installs and checks everything, then you build in a chat.
---

# I am not a developer. How do I start building with AI on my own computer?

Paste one line into a terminal and Hoprig sets up the rest: the programs coding needs, Claude Code and a first project, asking you nothing, and opens your browser on it, signed in. Then you build by chatting with the coding tool in a web page, where you see each change and press **Allow** or **Do not allow**.

## Who this is for

You have an idea for an app, a website or a tool. You have heard that Claude Code can build it. You are not a programmer, and you have never set up a computer for coding.

## The problem

Most guides start with "install Node.js, install git, sign in to GitHub, open a terminal". Each step can go wrong, and you do not know which error matters. People ask things like "how do I set up a computer for vibe coding from scratch" or "I am not a developer, how do I start with Claude Code". The set-up is the wall, before any building starts.

## What Hoprig does

1. You open your system's terminal (on Windows: press the Windows key, type PowerShell, press Enter; on a Mac: press Command and Space, type Terminal, press Enter; on Linux: press Ctrl+Alt+T) and paste the line below for your system, then press Enter. The line fetches Hoprig's installer from GitHub and runs it on your computer. It lists what is missing and installs it, without asking: Node.js (the program that Hoprig and Claude Code run on), Git on Windows when it is missing, and on Linux a few system programs, for which the computer may ask for your password. Then it installs Hoprig.
2. `hoprig setup` runs by itself after the install. When Claude Code is missing, it installs it for you. It adds Hoprig's own skills. It asks nothing on a first run, and only this computer can open the dashboard.
3. At the end your browser opens on Hoprig, already signed in: there is no password to find. On Windows the Start menu entry Hoprig opens it again.
4. Home says the next step. If you are not signed in to Claude yet, it is **Sign in to Claude** (it opens Claude's sign-in page in your browser); with no Claude plan, **No Claude plan? Pay as you use** signs in with a key.
5. Then **Start your first chat**: pick **New project** or **My own folder**, and describe what you want in plain words. Every change shows the lines it removes and the lines it adds, with **Allow** and **Do not allow** buttons.
6. You do not need your phone at first. To use Hoprig from your phone, turn that on later in Settings.

Windows:

```powershell
irm https://raw.githubusercontent.com/allswebtech/hoprig/main/install.ps1 | iex
```

Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
```

Linux:

```sh
wget -qO- https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
```

![Home on a new install: one card, Welcome to Hoprig, with Signed in to Claude and Start your first chat, New project or My own folder](/screenshots/first-run-desktop-light.webp)

At any time, open **Computers**, then this computer, then its **Health** tab: it checks everything, and under a problem that one press can fix there is a **Fix** button, which asks before it changes anything. (Or, in a terminal, `hoprig doctor` shows the same checks.)

## What you need

- A computer with Windows, macOS or Linux, and an internet connection.
- A Claude plan (or an API key) for Claude Code itself. Hoprig is free; the AI is not.
- A GitHub account (free) is useful: GitHub is a site that keeps your project's history safe. You can skip it at first.

## What it does not do

- **Windows is new.** The install and the tests run on GitHub's Windows machines, but a real home Windows PC has seen less of Hoprig than a Linux computer has.
- It does not teach you to code, and it cannot make the AI's work correct. Read what the chat says it did, and try the result.
- You still need the terminal once, to paste the install line.
- On a Mac, the newer parts (the chat, the editor, the desktop) have not been tried by hand on a real Mac; the install ran on GitHub's Mac machines, and on Linux in clean Ubuntu, Debian, Fedora and Alpine.
