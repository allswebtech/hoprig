---
name: plan-work
description: Turns a goal of the owner into a short research note and a PROPOSED plan with milestones and dated tasks, each with a role and a done-check, and creates nothing until the owner says yes. Use when the owner states a goal or a project with an end ("launch X by a date", "make Y work"), asks for a plan, or asks how to get something done over days or weeks.
---

## When to use
A goal bigger than one task: it needs several steps, more than a day, or more than one kind of work. One clear
task ("fix this test") is not a plan: brief it with do-task.

## Procedure
1. Restate the goal in one line with its end date and what "done" means. If the end or "done" is missing, ask
   ONE question that covers both, then continue.
2. Research note, at most eight lines: what exists already (files, projects, earlier work, the owner's notes the
   tools can read), what is unknown, and the risks. Say for each point where it came from. Mark guesses "assumed".
3. Plan:
   - 2 to 5 milestones, each with a date and a check that shows it is reached.
   - Under each, tasks of at most one working day: what, the role (developer, reviewer, tester, researcher,
     writer, social, support, ops), the date, and its done-check.
   - Every task that writes code or content is followed by a review task done by another role.
   - Anything that goes out (a post, a mail, a publish, a push of a default branch, money) is a separate task
     marked "owner's OK".
4. End with the cost and the open questions: the model and effort per kind of task, a rough count of sessions, and
   the 1 to 3 decisions only the owner can take.
5. Show it as a PROPOSAL and ask for yes, changes or no. Create no task, session, file or calendar entry before
   the yes. After the yes, create exactly what was shown.

## Pitfalls
- A plan without dates and done-checks is a wish list. Every task has both.
- Do not plan what the owner did not ask for; put extra ideas in one line "Could also" at the end.
- Dates fall on working days and leave a review slot before the end date.
- Never start the first task "to save time" before the yes.

## Verification
- Each milestone has a date and a check; each task has a role, a date and a done-check.
- Nothing was created: the tool calls of this turn are reads only, or none.
- The reply ends with a question for yes, changes or no.

## Examples
- "Launch a blog for the bakery by 15 Dec" → note (domain exists, no posts, no photos: assumed the owner has them),
  3 milestones (site live 5 Dec; 4 posts written and reviewed 11 Dec; launch post approved 15 Dec), 9 tasks, cost
  about 6 sessions, decisions: the domain name, who takes the photos. "Shall I create these tasks?"
