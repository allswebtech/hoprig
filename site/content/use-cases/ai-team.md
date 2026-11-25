---
order: 18
who: An AI team
short: Give Tia a goal; sessions with roles (developer, tester, reviewer and more) do its tasks, each checked before it comes back to you.
answer: Partly, today. On Work → Team, Tia (an experimental assistant, off until you turn her on) takes a goal for a project; once you accept its plan, sessions do the tasks, each with one of six roles (developer, tester, reviewer, researcher, writer, ops) and each checked by code and by a reviewer session that did not write it. Coming, not built yet: roles beyond code such as sales, posts sent after your approval, and one dashboard for a whole business.
---

# Can I run an AI team under one assistant?

Partly, today. On the **Work** page, the tab **Team** lets Tia, the dashboard's assistant, take a goal for a project: once you accept its plan, AI sessions do the tasks, each with a role, and each is checked before it comes back to you. Roles beyond code are coming; see [Coming](#coming).

## Who this is for

You have more work on a project than one chat at a time: a feature, its tests, the documents. You want several pieces done while you are away, each one checked, and nothing merged or sent out without you.

## The problem

With one AI session at a time, you hand out each task yourself, wait, read the result and start the next. Letting the AI run alone feels unsafe: it could change what it should not, upload it, or spend more than you meant.

## What exists today

1. On **Work → Team**, open **Tia's switches and limits**: turn on **Tia works by herself**, turn on your project under **Projects**, set a **Spend cap per day ($)** above 0, and tick a provider (the subscription or API key the coding tool runs on) under **Providers**. All of them are off or empty at first, and nothing of hers starts until each is set.
2. Press **Give Tia a goal**, on Work → Team or Work → Plans, and write the goal in your own words. Plan with AI turns it into tasks; nothing starts before you press **Accept** on that plan.
3. Each task is done by one session with a role, on a branch of its own (in git, the program that keeps every version of your code, a branch is a separate line of changes, so your main code stays as it was), within the time limit you set. A session has only file tools: it cannot run a command, use git or reach the network, and the dashboard itself makes the one commit (the saved change) of what it wrote.
4. Code checks the result (for code, your project's tests, run in a closed box), and then a reviewer session that did not write it reads the change and says pass or fix. After two rounds of fixes it is yours to look at.
5. A task that passed waits for your **Accept** in Work. Only for documents and tests, and only when you turn them on under **Accept by itself**, is it accepted for you.
6. **Tia OFF**, one press on Team, and nothing new of hers starts. Team shows each role with its tasks, how many passed the first time, its tokens, cost and minutes.

The roles are files of Hoprig (one folder each under `roles/`), and you can turn each one off under **Roles**:

- **Developer**: writes the change a task asks for, with its tests, on the task's own branch.
- **Tester**: writes or repairs tests for what a task names; the task's check runs them in the box, or not at all.
- **Reviewer**: reads what another session did on a task's branch and says pass or fix, changing nothing.
- **Researcher**: finds out what a task asks from what is in the project and writes it into the file the brief names.
- **Writer**: writes or changes the documentation the brief names.
- **Ops**: writes down what would have to be run for a task, step by step, and what each step should show; it runs nothing.

What always stays yours: nothing of a mission merges into your main branch, uploads (pushes), deletes, releases or sends anything out, and it spends only within the cap you set. See [Missions in the Work guide](/docs/work/#missions-a-goal-tia-does-by-herself).

## Tia herself

**Tia** is an assistant in the dashboard: experimental, and off until you turn her on in **Settings → Tia**. She gets a coding job done for you: she opens a chat in a project, picks a provider among the ones you allow, sends the task, watches it and reports. Whatever she asks to install, update, restart or power off on your computer, or to end a process there, comes to you as a card first, at every level, and only you turn the public link on. So does whatever costs money, except where you choose otherwise. Within a daily limit for paid use you set in Settings → Tia (none at first), she may write to sessions on the paid API providers you allowed her unless her level is **Ask me**, and at the level **Hands off** also start or move her sessions there without asking. At **Hands off**, the Operator's limit rule or **Tia decides**, once you turn them on, may also move a session at a usage limit onto such a provider, only within that limit, and each move counts against it. At **Hands off**, the short call of **Tia decides** and a look into what nobody can explain may also run on such a provider when every provider you allowed her is paid per use (Auto mode counts as paid per use here when its order holds such a provider), only within that limit too, and each counts against it. The Operator's rules, once you turn them on, restart a gateway or the public link that does not answer and end a test's left-over processes by themselves. **Tia decides** may make the same restarts, type one fixed line of Hoprig's into a stuck session to nudge it, and end a stuck session only in a project where you ticked **Tia may end a stuck session in this project** on the project's page ([the Operator guide](/docs/operator/)). Typing into a session that runs on a provider paid per use, the nudge too, is money: **Tia decides** does it only at **Hands off** and within that limit, and it counts against it. Her own thinking runs on the provider set under **Tia runs on**: left at **Automatic**, the first of the subscriptions she may use that can answer now, inside your plan. With no such subscription she runs on Auto mode or another provider you ticked for her, and on a provider billed by use she answers only within the daily limit for paid use. When every subscription is at its limit she says so, and she never moves to a provider billed by use by herself.

She also does your Work: ask her what needs you today, or to have a session do a task, and she shows one card with the task, the brief, the provider, the model and the effort, and starts nothing before your yes. That card comes at every level, **Hands off** too. See [how to tell her what to do](/use-cases/tell-the-assistant/).

- [Tia in the docs](/docs/tia/)
- [Her tools and their levels](/tools/)

## Coming

Not built yet, and no date is promised. This page says what is built when it is.

- Roles for a business beyond code, such as sales. Today the six roles above work only on a project's files.
- Social media posts that go out only after your approval. Today nothing of a mission sends anything out, and Tia has no tool that posts.
- One dashboard that manages a whole business. Today the dashboard manages your computers, your coding sessions and the work on your projects.

## What you need

- Hoprig with Claude Code, and a provider for it. The sessions of a mission are Claude Code's, started in its own restricted mode.
- A project in your workspace, in git, and its test command set under **Projects** (**Its test command**) for code tasks.

## What it does not do

- It has no roles beyond the six above, and a session cannot ask you anything: a step that needs your OK is refused and the task's check decides what comes next.
- It does not merge, upload or release your code: accepting a task's branch into your main code is your step.
- Tia is experimental. Read what comes back before you rely on it.
