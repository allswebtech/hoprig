---
order: 5
who: New, formatted or lost computer
short: Install, sign in to git, and everything comes back where it was.
---

# How do I get my whole AI coding setup back on a new, formatted or lost computer?

If your workspace is in git (a record of every version of your files, kept on a server such as GitHub), install Hoprig on the new computer, sign in to GitHub and, on the empty **Workspace** page, press **Bring my workspace from git**: it brings your AI brain (your rules, skills and AI memory) with its map, your credentials and groups, and every project too when you tick **Also get every project of the map on this computer**. In a terminal (the window where you type commands), `hop workspace git` and `hop workspace restore <your brain's address> --with-projects` do the same, and also link each project's AI memory and offer the dependency installs.

## Who this is for

You got a new laptop, reinstalled your system, or lost a computer. You want your projects, rules, skills and AI memory back, without an evening of setup.

## The problem

A coding setup is many small things: tools and their versions, the repositories (a project's folders kept in git) and where they go, Claude Code's rules and skills, each project's memory. People search for "restore Claude Code setup after reinstall" or "set up the same AI coding workspace on a new laptop". Done by hand, something is always missing.

## What Hoprig does

Before anything happens, on the computer you have now:

1. The dashboard keeps a map of every repository of the workspace in one file in your brain, by itself. To write it now, open **Settings → Workspace** and press **Update the map** (under **Advanced** once the map is kept by itself). Then save the brain to its git server: on **Computers → this computer → Setup**, the AI brain's row offers **Save them** while it has changes not uploaded. In a terminal: `hop workspace map`, then commit and push the brain.
2. Optionally, on **Computers → this computer → Setup**, open **Advanced: recipe for another computer** and press **Save as recipe**: it downloads a recipe with the computer's kits, its projects folder and your repository addresses, and asks whether to put your commit e-mail in. Never a key, a token or a password. In a terminal: `hop pc recipe save my-setup.json`.

On the new computer:

1. Install Hoprig with the one line. Its setup installs git, Node.js, Python, GitHub's `gh` and the rest: the tools are listed, and set-up asks once before it installs them. These installs were run on clean Ubuntu, Debian, Fedora and Alpine, and on GitHub's Windows and Mac machines.
2. On **Computers → this computer → Setup**, press **Sign in** on the row "Signed in to GitHub": you type a one-time code on GitHub's own page, and no password is typed into the dashboard. **Set** on the row above it gives git your name and e-mail. In a terminal: `hop workspace git`.
3. On the **Workspace** page, which is empty on a new computer, press **Bring my workspace from git**, type your brain's address and press **Look at the plan**. It shows what will be cloned (copied down from the server) and what is left alone, then brings your AI brain with its map, your credentials and groups. Projects stay in the map until you get one (press **Get it** on its card), or tick **Also get every project of the map on this computer** to get them all at once. In a terminal: `hop workspace restore <your brain's address> --with-projects` clones every project too, links each project's memory, copies `.env.example` and offers the dependency installs; without `--with-projects`, `hop get <name>` fetches one project when you need it.
4. On the **AI brain** page, press **Link** under "Coding tools": your coding tools read the brain's rules, skills and memory again. Link shows each link before it is made. In a terminal: `hop workspace link`.
5. On **Computers → this computer → Setup**, open **Advanced: recipe for another computer** and press **Set up from a recipe**: paste the recipe, or an https address of one. It is checked first, then sets up the same kits as the old computer. In a terminal: `hop pc setup --recipe my-setup.json`.
6. After a format, in a terminal: `hop workspace label <its old label> --again` tells the workspace that this is the same computer, so its own file in the brain goes on. The dashboard has no press for this yet.

Bring it again and it only gets what is missing. What is there is never overwritten; a clone that was cut off half way is moved aside under a dated name, never deleted, and cloned again.

![A computer's page, Setup: what it has for coding, what is missing, and one button to install it](/screenshots/computer-setup-desktop-light.webp)

## In a terminal

```sh
curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh
hop workspace git
hop workspace restore <your brain's address> --with-projects
```

## What you need

- Your AI brain in a git repository you can reach (GitHub or any git server).
- Access to your private repositories from the new computer: the GitHub sign-in or an SSH key.

## What it does not do

- Only what was pushed comes back. Work that was never committed and pushed on a lost computer is gone.
- Keys and passwords are never in git. Your providers (Claude sign-ins, API keys) are added again: press **Add provider** on the **Providers** page, or in a terminal `hop add`. The `credentials/` folder is yours to bring.
- A repository that cannot be cloned (no access, deleted) is listed with git's own reason, and the rest goes on.
