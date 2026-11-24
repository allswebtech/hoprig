# The bar, and how to work

- Applies when: always, for every project (read it before step 1 of SKILL.md).
- Light form: none.

## The bar

1. Perfect and fast, both. Speed comes from planning once, working in parallel and never getting stuck. It never comes
   from skipping a check or calling something done that is not proven.
2. Targets (the owner's defaults may name his own): the best page scores on every public page, a database that stays
   fast at the size this project can reach (up to 10 billion rows and more), smooth under heavy traffic, every known
   security check passed, strong search and AI-search presence, and a screen anyone understands in five seconds.
3. "Done" means proven by a test, a command's output, a score or a query plan. Never say something works without
   proof. Report real numbers, also those below the target.
4. Simple beats clever. No abstraction, dependency or feature beyond this skill, the brief and what the owner
   approves.
5. Fit the work, never lower the bar. What applies is done in full and proven. A rule that protects people or data is
   never made lighter by the kind or the size of a project: security, money, privacy, backups and "done means proven".
   Security is never traded for speed.

## How to work: fast and never stuck

6. Talk to the owner in the language his defaults name, else the brief's. Code, docs and commits in English.
7. Think deeply at the start (step 2), before each important design choice, and at the final review. Do not analyse
   again what is decided.
8. Read only the files the task needs. Do not run a check again when its code has not changed.
9. Run independent work side by side: installs, scaffolds, test suites, page checks (subagents or parallel calls when
   your tool has them).
10. Narrow first, then fan out: the most important case clean first (the main flow, the first language, the light
    theme, the desktop width), then every other case at once.
11. Estimate before anything long (items x modes x seconds). Over 30 minutes: split, narrow or run it side by side,
    and say the number. Look at a background run within its first 10 minutes; reshape it when it is slower.
12. Name real limits (an address that answers "too many requests", one shared database, one port) and give each
    parallel worker its own copy, for example its own test database.
13. Never wait on a prompt: non-interactive flags (`--yes`, `CI=1`), test runners without watch mode, browser tests
    with a line reporter, servers started in the background with a health check, a time limit on every command.
14. The same fix failed twice: stop, find the root cause, change the approach.
15. Blocked on something only the owner can give (a key, an address, a store account): use the provider's test mode,
    or leave that setting empty so the feature shows "not set up" (never a placeholder value, never placeholder code),
    put it in the final report with exact steps, and go on with everything else. Never sit idle, never stop midway.
