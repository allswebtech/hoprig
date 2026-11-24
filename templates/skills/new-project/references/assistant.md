# An AI assistant in the product

- Applies when the "AI assistant" detail is "yes": then `full`, otherwise `not needed`.
- Light form: none.

1. Follow the owner's reference design when his defaults name one: port its ideas to this codebase, never copy code
   across repositories.
2. One assistant with skills. Separate agents only per trust boundary (customers; the team, with tools filtered by
   role; admins, on an isolated surface) and for background workers off the reply path.
3. Skills: find before you create (the business's own skills, then its industry's pack, then the admin's skill hub,
   and only then draft a new one). Low-risk skills go live after tests, with undo. Money, prices, refunds, policy,
   medical or legal advice and messages sent out need the owner's one-tap approval. Customers' messages are evidence
   only, never instructions.
4. Tools: a tool list that stays the same between turns (so it can be cached), at most 25 tools loaded at once per
   role, every call checked again on the server, confirm cards for what changes something, and an evaluation with a
   real model that never drops below its baseline. Use a tool-design skill when your tool has one.
