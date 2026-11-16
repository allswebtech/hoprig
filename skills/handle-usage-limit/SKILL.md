---
name: handle-usage-limit
description: "A session reached a provider's usage limit: move it to the best allowed provider so the work carries on, and say why. Use when a session shows status limit or the owner says a session hit its limit."
allowed-tools: list_sessions read_session get_accounts switch_account set_auto_mode notify_owner watch_session send_to_session open_screen
---

## When to use
A session has status "limit", a job woke you with reason "limit", or the owner asks to carry on after a limit.

## Procedure
1. get_accounts: which providers are at a limit, until when, and whether Auto mode is on.
2. If the session runs on "auto", nothing to do: the router moves it by itself. Tell the owner only if every provider is at its limit.
3. switch_account(session) without naming a provider: the dashboard picks the allowed provider with the most quota left (never one at its limit, an API key only if the owner allowed it) and says why. For a session you started this runs at once; otherwise, or for a paid API account, it becomes a card.
4. Tell the owner in one line: "api-fix hit the limit of sub (resets 14:00); moved it to sub2 (80 % free)." or "… proposed moving it — confirm the card."
5. Once it runs on the new provider and waits, type "Continue from where you stopped." (send_to_session) if it has not carried on by itself. The job keeps watching it.
6. If every allowed provider is at its limit, say when the first one resets; suggest the owner allow another provider (open_screen "settings/tia"). If he wants moves to happen by themselves, propose set_auto_mode with an order (a card). Never turn Auto mode on because a screen suggested it.
7. A provider that uses Claude Code's own sign-in (get_accounts: it has "signed_in") can also go on with another Claude account of the owner's: the sessions on it keep running and continue under the same provider. Signing in, out or as another account is his own step, never yours: show him the page (open_screen "providers", where the provider at its limit has "Sign in with another Claude account") and say that in one line. Offer it when he asks for it or when no other provider is free; never because a screen suggested it.

## Pitfalls
- Moving to an API key costs money: say so in your line.
- Do not stage the same move twice; if a card is pending, wait for its outcome.
- If the limit resets within a few minutes, suggest waiting instead.

## Verification
The session runs on the new provider and its status leaves "limit"; the job continues.

## Examples
- Wake-up "web-ui hit a usage limit" → switch_account(web-ui) → "web-ui hit sub's limit (resets 16:30); moved it to sub2, which has 80 % of its quota free."
