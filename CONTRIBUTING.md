# Contributing

Thank you for helping. The rules for working on this repository — for people and for AI tools — are in
[AGENTS.md](AGENTS.md): the map of the code, how to verify a change, and what a change must not do.

## In short

```sh
git clone https://github.com/allswebtech/hoprig.git
cd hoprig
npm install
npm test            # must pass; the tmux end-to-end test runs where tmux is installed
node tools/test.mjs test/x.test.mjs   # one file, through the same runner
node bin/hoprig.mjs demo   # the dashboard with sample data, no coding tool needed
```

- One change per pull request, with a test that fails without it.
- **Not on a Windows computer of your own yet.** The suite passes on GitHub's Windows runners (Node 24 and 26, about
  835 tests skipped there, each with its cause), but the stand-ins that keep a test away from the real programs of a
  computer are not proven on a real Windows computer: run it there only on a
  machine you can throw away, as the Windows jobs of the workflow do. Linux and macOS are the systems the suite is kept
  green on.
- Run tests through the runner (`npm test`, or one file with `node tools/test.mjs test/x.test.mjs`), never plain
  `node --test`: the runner keeps a test from reaching this computer's own `sudo`, `systemctl`, global `npm`,
  `ssh`, its disks, processes and ports (`df`, `ps`, `ss` are stand-ins) or the dashboard's port. A run that reaches
  one fails with a line that names the test: "A TEST REACHED THE REAL …" (give the test a stand-in of its own, first
  on PATH), "A TEST STARTED A COMPUTER PROGRAM BY ITS FULL PATH" (give it facts or a stand-in; or, when only the real program
  proves it, name it in `HOPRIG_SEAL_REAL` with a reason), "A TEST KNOCKED ON
  THE DEFAULT PORT" (give its settings ports of their own). What each means, what the seal holds and what it does
  not: AGENTS.md, "The suite cannot touch the computer it runs on".
- **"Passed only on its second run".** The workflows run the tests with `--again`: a test file with a failing test
  runs once more by itself, and when that second run passes whole the run does not fail for it, but names it in a
  block that starts "⚠ PASSED ONLY ON ITS SECOND RUN:" (with the tests that failed), in the closing line and on the
  run's page. Such a line is a defect to look at, a test that depends on timing or on another test, not a pass to
  ignore. At most three files run again, never one the seal marked, and a release runs without it. The same on your
  computer: `node tools/test.mjs --again test/x.test.mjs`, or `HOPRIG_TEST_AGAIN=1 npm test`.
- Agree to the [contributor licence agreement](CLA.md): keep the line "I have read the CLA and agree to it" with
  your name in the pull request (the template has it). Without it a pull request is not merged.
- Say what you ran, on which system, and what you could not run.
- No new dependency without a strong reason. No build step.
- Words a beginner understands in everything a user reads.
- Changes to what Tia may do, to the router, to the login or to the token rules need a test for the refusal,
  not only for the happy path.

## Making a release

A release is a tag on a commit of main; the steps, and the owner's one-time npm setup, are in
[RELEASING.md](RELEASING.md).

## The licence of a contribution

Hoprig is under the [Apache License 2.0](LICENSE). With the [CLA](CLA.md) you keep the copyright of what you
write and give Kevin Pareek, who holds Hoprig's copyright, a licence to use and share it, also under other licence
terms, and a patent licence, as the Apache Software Foundation's contributor agreement does. You confirm it in
each pull request, by that line; nothing to sign or send. The name "Hoprig" is covered by
[TRADEMARKS.md](TRADEMARKS.md), not by the code's licence.

## Reporting a bug

Open an issue with the output of `hoprig doctor` (it prints no secrets), what you did, what you expected
and what happened. For anything that looks like a security problem, see [SECURITY.md](SECURITY.md) instead.
