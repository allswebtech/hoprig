---
order: 9
who: A spare PC or a small server
short: Your always-on coding machine: sessions keep running, and you reach them from any browser.
---

# How do I turn a spare PC or a small server into an always-on coding machine?

Install Hoprig on it and let the dashboard run in the background: terminal sessions keep running in tmux when you close the page, and you reach them from any browser. Use the public link for a PC at home, or make a server the main computer behind HTTPS.

## Who this is for

You have an old laptop, a spare desktop or a cheap server. You want it to be the place where your AI coding runs, all day, reachable from your phone and your laptop.

## The problem

The do-it-yourself way works: a VPN, SSH, tmux and a terminal app on the phone. But it takes an evening, gives you only a terminal, and every new machine means doing it again. People search for "always-on Claude Code server" or "run Claude Code on a VPS and use it from my phone".

## What Hoprig does

1. Install Hoprig on the machine. Its setup puts the dashboard in the background so it starts with the computer (a systemd service on Linux). To keep it running while you are logged out: `sudo loginctl enable-linger $USER`.
2. With tmux 3.2 or newer installed, terminal sessions run in tmux: they survive a restart of the dashboard, and `tmux attach` over SSH still works.
3. Reach it from anywhere: for a PC at home, turn on **Settings → Public link → On** (in a terminal, the window where you type commands: `hop public on`).
4. On a server, in a terminal: `hoprig setup --hub` puts the dashboard behind HTTPS and refuses plain HTTP. With Tailscale, `hoprig setup --access tailscale` serves it only to your own Tailscale devices. The dashboard has no press for these two yet.
5. After a restart, **Reopen sessions after a restart** (Settings → Automations) brings Claude Code's and OpenCode's terminal sessions back where they were, each on its own conversation. It is on at first with the built-in terminals (the dashboard's own). With tmux it is off at first: tmux sessions live through a restart of the dashboard, but not a restart of the computer; switch it on to have them back after one.
6. A computer's page shows its load, memory, disks and the sessions on it. On a wide screen, **Open desktop** gives windows for its terminal, files, editor, processes, services and logs.
7. **Settings → Version and updates** shows the new versions of Hoprig, the coding tools and the tunnel helper; Manual is the default. Automatic installs the coding tools and the tunnel helper at a safe moment; Hoprig itself tells you and waits for you.

![A computer's page, Overview: load, memory, disks, Claude Code and the sessions on it](/screenshots/computer-overview-desktop-light.webp)

## What you need

- A machine with Linux (the background service is run and tested there). On macOS the background service is written but not yet installed for real.
- For a main computer on the internet: a server with a domain or an IP address. A main computer is small: about 80 MB of memory, measured with 20 computers and 20 open terminals.

## What it does not do

- When the machine is off, there is nothing to reach. There is no cloud.
- Shared web hosting usually does not work as a main computer.
- **Reopen sessions after a restart** does not reopen an OpenCode session whose conversation has no id yet: Work → Activity names it.
