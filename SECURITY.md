# Security

Hoprig's dashboard is a remote control for the computer it runs on, so security reports are welcome and
taken seriously.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's private report instead:
**Security → Report a vulnerability** on this repository. Say what you found, how to reproduce it, and which
version (`hoprig version`). You will get an answer as soon as it has been looked at.

## What matters most

- Anything that reaches the dashboard, a session or a file without the owner's login.
- Anything that makes Hoprig, Tia or a relayed computer run a command from text it only read (a terminal,
  a file name, a web page, a downloaded skill).
- Any way a password, token, key or provider file (a sign-in or an API key) leaves the computer, appears in a log, or reaches a browser.
- A token of one computer doing more on another than it should (changing the password, pairing, relaying on).

## What Hoprig does not protect against

- Someone who already has your user account on the computer: they can read your files, including Hoprig's.
- A dashboard opened to a network over plain HTTP. Use it only on a network you trust, or put it behind HTTPS
  (`hoprig setup --hub` does this).
- A skill or project you approve after reading its review: approving is your decision.
