# The final review and the final report

- Applies when: always, for every project (the order's steps 6 and 7 in SKILL.md; their rows go into the checklist
  with the others at step 4).
- Light form: none. A point about something the project does not have says so in one line.

## The final review (before you say done)

1. Read this skill, the references that apply, `docs/brief.md` and the chat again. Every requirement has a row in
   `docs/checklist.md`, done or open, with its proof (count the rows of each part against its rules). A `not needed`
   reference has one row with its reason. Then check the fit itself: a `not needed` reference or an `n/a` row whose
   thing is now in the product, a table past its tier, or work built from a `not needed` reference is a defect: fit
   again and finish it.
2. Anything open: finish it first, then test it. Only what needs the owner (keys, addresses, accounts) may stay
   open, with exact steps.
3. Every row of `docs/test-matrix.md` passes.
4. Zero of each: bugs, gaps, unfinished parts, TODO or FIXME, duplicate code or docs, unused or dead code, known
   vulnerabilities (dependency audit, secret scan, security review), deprecated interfaces, loose types or silenced
   type errors, console errors, and warnings in install, build, test and analyser output. A warning from a
   dependency that has no fix yet goes into the report instead.
5. Walk every role's main journey as a first-time user. Fix what is confusing, and a step that could go or be done
   on the same page.
6. Future-proof: exact versions and lock files, `.env.example` lists exactly the names this project uses, docs that
   match the code, continuous integration green, backup and restore written down, nothing that depends on this
   computer.
7. A fresh review: when your tool has reviewers or subagents, one reviews all the code without your notes; fix
   what is real.
8. A clean clone of each repository into a temporary folder: install, migrate an empty database, build and run the
   whole suite. All green. Remove the temporary folder after.
9. Commit and push. `git status` is clean and nothing is unpushed in any repository.

## The final report

10. The folder structure.
11. The tools and their installed versions.
12. The applies table as it stands, and every task and requirement with its status (from `docs/checklist.md`). A
    point of this report about something the project does not have says so in one line.
13. Database: the tiers, the scale design, the plan test's results, query times at the seeded scale.
14. Sign-in and security results.
15. Web and mobile build status, test counts, continuous integration status.
16. Page scores per public page (desktop and mobile) and the load test's numbers.
17. How to run it locally and how to deploy or publish it.
18. The choices made for the owner (from `decisions.md`), so that he can change any of them.
19. What is still open, and what he must do (keys, addresses, store accounts), with exact steps and commands.
