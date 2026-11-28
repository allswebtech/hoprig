---
order: 10
who: Team leads
short: Every machine set up the same, from one recipe and one AI brain, all on one page.
---

# How do I set up every machine the same way for AI coding?

On a computer's **Setup** page, open **Advanced: recipe for another computer** and press **Save as recipe**, then **Set up from a recipe** on every other machine, and give them the same working rules and skills from one AI brain in git (a record of every version of your files, kept on a server such as GitHub). The main computer then shows every machine's state, setup and sessions on one page.

## Who this is for

You look after several machines for coding: your own, a few servers, or the computers your AI agents run on. Each should have the same tools, rules and skills, and you want to see which one waits for an OK or hit a limit.

## The problem

Machines drift. One has an old Node.js, another lacks a skill, a third has different rules. And with six terminals open, it is easy to miss the session that waits for you.

## What Hoprig does

1. On the machine that is set up the way you want, open **Computers → this computer → Setup**, open **Advanced: recipe for another computer** and press **Save as recipe**: it downloads the recipe. A recipe holds the kits, the tool versions (as information), the projects folder and the addresses of your repositories. Never a key, a token or a password. In a terminal (the window where you type commands): `hop pc recipe save team.json`.
2. On every other machine: install Hoprig, then on the same fold press **Set up from a recipe** and paste the recipe or an https address of one. A recipe is checked strictly, and nothing in it can run a command. In a terminal: `hop pc setup --recipe team.json` (a file or an https address).
3. The same rules and skills everywhere: on each machine, press **Bring my workspace from git** on the empty **Workspace** page, then **Link** under "Coding tools" on the **AI brain** page. Claude Code (and OpenCode) then read the same AI brain. In a terminal: `hop workspace restore <brain address>` and `hop workspace link`.
4. On the main computer, press **Computers → Add a computer** and choose how the other machine is reached; on a machine that should connect out to it, open **Computers → Add a computer → Advanced → Show this computer on another dashboard**. The **Computers** page lists them all with their state. One machine is the main computer; the others join it (`hoprig join`) or are added by SSH (`hoprig machines add user@server`) in a terminal.
5. Open a computer, then **Setup**: what it has, what is missing, a **Fix** button where a fix exists, and **Set up this computer**. The install runs as a job on that page, also for a computer reached through the main computer.
6. In a terminal: `hop pc status --json` gives each machine's state as JSON, for your own scripts. The dashboard has no press for this; a computer's page shows the same state to read.

![The Computers page: every computer in one list, with its state](/screenshots/computers-desktop-light.webp)

## What you need

- One machine that is always on, as the main computer.
- The AI brain in a git repository every machine can reach.

## What it does not do

- There are no user accounts or roles. A dashboard has one password, and whoever signs in to the main computer can drive every computer it shows. It is for one person, or people you trust with all of it.
- There is no automatic drift check: a machine's **Setup** page shows what it has and what is missing, and in a terminal `hop pc status` on a machine shows what differs.
- Accounts stay each person's own. Never share a Claude account.
