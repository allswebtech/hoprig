# Contributing

Thank you for helping. The rules for working on this repository — for people and for AI tools — are in
[AGENTS.md](AGENTS.md): the map of the code, how to verify a change, and what a change must not do.

## In short

```sh
git clone https://github.com/allswebtech/hoprig.git
cd hoprig
npm install
npm test            # must pass; the tmux end-to-end test runs where tmux is installed
node bin/hoprig.mjs demo   # the dashboard with sample data, no Claude Code needed
```

- One change per pull request, with a test that fails without it.
- Say what you ran, on which system, and what you could not run.
- No new dependency without a strong reason. No build step.
- Words a beginner understands in everything a user reads.
- Changes to what Tia may do, to the router, to the login or to the token rules need a test for the refusal,
  not only for the happy path.

## Reporting a bug

Open an issue with the output of `hoprig doctor` (it prints no secrets), what you did, what you expected
and what happened. For anything that looks like a security problem, see [SECURITY.md](SECURITY.md) instead.
