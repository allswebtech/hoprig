# Contributing

Thank you for helping. The rules for working on this repository — for people and for AI tools — are in
[AGENTS.md](AGENTS.md): the map of the code, how to verify a change, and what a change must not do.

## In short

```sh
git clone https://github.com/allswebtech/hoprig.git
cd hoprig
npm install
npm test            # must pass; the tmux end-to-end test runs where tmux is installed
node bin/hoprig.mjs demo   # the dashboard with sample data, no coding tool needed
```

- One change per pull request, with a test that fails without it.
- Agree to the [contributor licence agreement](CLA.md): keep the line "I have read the CLA and agree to it" with
  your name in the pull request (the template has it). Without it a pull request is not merged.
- Say what you ran, on which system, and what you could not run.
- No new dependency without a strong reason. No build step.
- Words a beginner understands in everything a user reads.
- Changes to what Tia may do, to the router, to the login or to the token rules need a test for the refusal,
  not only for the happy path.

## The licence of a contribution

Hoprig is under the [Apache License 2.0](LICENSE). With the [CLA](CLA.md) you keep the copyright of what you
write and give Kevin Pareek, who holds Hoprig's copyright, a licence to use and share it, also under other licence
terms, and a patent licence, as the Apache Software Foundation's contributor agreement does. You confirm it in
each pull request, by that line; nothing to sign or send. The name "Hoprig" is covered by
[TRADEMARKS.md](TRADEMARKS.md), not by the code's licence.

## Reporting a bug

Open an issue with the output of `hoprig doctor` (it prints no secrets), what you did, what you expected
and what happened. For anything that looks like a security problem, see [SECURITY.md](SECURITY.md) instead.
