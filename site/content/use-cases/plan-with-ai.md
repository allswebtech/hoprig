---
order: 13
who: Work that takes weeks
short: Write the goal, let a session propose milestones and tasks, accept what you keep, then have sessions do the tasks.
---

# How do I plan a piece of work with AI and let sessions do it?

Write the goal in your own words on the Work page and press **Plan with AI**: a session researches it and proposes a note and a plan with milestones and dated tasks. Nothing is written until you press **Accept**. Then each task is one **Do it with a session**, and each result waits for your **Accept** or **Send back**.

## Who this is for

You have a goal that takes more than one session ("launch the shop by March", "move the app to the new database") and you want the steps written down, in order, with dates, instead of a long chat that nobody can follow a week later.

## The problem

People ask "how do I get Claude Code to plan a big feature and then do it step by step". A plan in a chat is gone when the chat is. A plan the AI writes straight into your files is hard to review before it is there. And a task that depends on another one gets started too early.

## What Hoprig does

1. Open **Work**, then **Plans**, then **Plan with AI**. Write **Your goal**, choose **The project it is about** (and the others it is **Also about**), the coding tool, the provider, the model and the effort, and press **Plan**.
2. A session researches the goal and comes back with a proposal: a research note and a plan with milestones and tasks. It follows the bundled skill `plan-work`. While it works, **Work → Plans** says a session is planning, with **Watch** to look at it.
3. Look at the proposal on one screen, the session's words marked as the session's. Change a title, a date or who does it, take out a task or a milestone, or press **Plan again** or **Dismiss**. Nothing exists in your repository before you press **Accept**.
4. **Accept** writes the note, the plan and its tasks into your Work repository. The Plans tab lists every plan with its progress; a plan's own screen shows its goal, its milestones, what waits for what, and a timeline by week.
5. A task is done by a session: **Do it with a session** on its row shows the brief the session gets, the provider, the model and the effort, and starts on **Start**. A task that waits for another one is not offered **Do it** until that one is done; **Stop waiting** in the task's menu ends the wait.
6. When the run ends, the task waits for you: **Accept** marks it done, **Send back** opens it again with your words added to its brief. Nothing is pushed or merged by a run.

In a terminal, the same plans:

```sh nocopy
hop tasks plans          # every plan, its progress and next date
hop tasks plan <id>      # one plan: goal, milestones, tasks, what waits
hop tasks do <id>        # a session does one task, after you saw its brief
hop tasks runs <id>      # what the sessions did: answers, commits, changed files
```

## What you need

- The dashboard running on the computer, and a provider for the coding tool (`hop add`).
- A place for your Work data: **Settings → Work** (the AI brain's `work/` folder by default).

## What it does not do

- At first nothing starts by itself. A task starts on your **Do it**, or at the time you set on it with **Run by AI**. A result is done only when you accept it.
- **Tia works by herself** on Work → Team lets Tia start a plan's tasks herself. Its **Accept by itself** switches let her accept the results of documents and tests. All of them are off at first.
- It does not check that the plan is a good one, or that a session's work is right: you review both.
- The proposal is read strictly, as data. One with HTML outside a code block, an image, a character nobody can see, or a link whose words show one address and that leads to another is refused, with the reason.
- Plans were run on Linux only, in temporary homes, in this version.
