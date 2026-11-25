---
order: 8
who: Freelancers and agencies
short: One folder, one set of rules and one provider per client project; fetch it when work starts, put it away after.
---

# How do I keep many client projects apart when I code with AI?

Give each client project its own folder with its own rules, AI memory and repositories, and keep only the ones you work on now on your computer. On the **Workspace** page, press **New project** or **Get an existing project** (in a terminal, `hop project new` or `hop project clone`): Hoprig makes or fetches such a project, opens each one with the provider and coding tool of its last chat, and shows every session of every project on one page.

## Who this is for

You build for several clients. Each has its own repositories, conventions and, sometimes, its own API key. Client work must not mix, and you want to pick up any project quickly.

## The problem

People ask how to "manage multiple client projects with Claude Code" or want "separate AI memory per project". With everything in one big folder, the rules of one client leak into another, and an old project's memory confuses the new one.

## What Hoprig does

1. On the **Workspace** page, press **New project**: it makes the project's own folder: its rules in `AGENTS.md`, its AI memory, its docs and decisions, and its code repositories (a project's folders kept in git, a record of every version of your files) under `code/`. Or press **Get an existing project** and type its name on GitHub or its address: it fetches an existing one with all its code repositories and its memory, and the project's page offers the dependency installs. In a terminal (the window where you type commands): `hop project new acme-shop`, or `hop project clone acme/shop`.
2. Each project's memory lives in that project's own repository, so nothing carries over from one client to another.
3. **New session** in a project opens with the provider, mode, model and effort of the last chat there, so once you have used a client's own key in that project, it is picked again next time. It is a remembered choice, not a lock: you can still pick another provider.
4. The **Workspace** page lists every project with its sessions under it; each project's own page shows its sessions, repositories and skills.
5. When the work is done, the project's page shows each repository's changes not saved to git and what is still to upload. Press **Sync and save the AI memory** there: it commits the memory and uploads what is only ahead. Then press **Take it off this computer**: it removes the folder only when all of it is on its git server. A workspace map that named the project keeps its address, so **Get it** on its card on the **Workspace** page gets it back the day the client returns. In a terminal: `hop project status acme-shop`, `hop project sync acme-shop --memory`, `hop drop acme-shop`, and later `hop get acme-shop` (or `hop project clone` with its address).

![The Workspace page: every project, each with its sessions under it](/screenshots/projects-desktop-light.webp)

## What you need

- Access to each client's repositories from your computer.
- A provider (a Claude sign-in, an API key or a gateway the coding tool runs on) per client if they pay for their own AI usage: press **Add provider** on the **Providers** page, or in a terminal `hop add`.

## What it does not do

- Hoprig never deletes a project folder that has work only on this computer: **Take it off this computer** (in a terminal, `hop drop`) refuses until everything is on its git server, and says what to do first.
- The provider of a project is the one its last chat used, not a lock. You can still pick another one.
- No time tracking or billing.
- Keys stay in the `credentials/` folder and the provider files; keep each client's keys apart yourself.
