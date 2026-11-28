<!-- Generated from tia-core 0.2.0. Change it there, not here. -->
# The acts contract (tia-core 0.2.0)

How a product's assistant can do everything the product can: not from a list of tools typed by hand, but from the
product's own acts. An act is anything a person can do in the product: a changing route, a read route, a command, a
built-in skill, an in-process step. The product writes ONE row for each in its acts file (`acts.schema.json`); the
answer for each row is computed from seven facts; the assistant reaches every row through three catalog tools
(`tools/CONTRACT.md` section 13). `node bin/check-acts.mjs acts.json [registry.json]` checks every rule marked
"checked: <rule>". A rule marked "checked by review" is read by a person in the pull request that changes a row or
the server's checks. The sentences with words in capitals below are the contract.

## 1. Every act has a row

- Every act a person can do in the product MUST have ONE row in the product's acts file, and a row MUST NOT outlive
  its act. A row's id is unique and so is its source (the method and path, the command, the skill folder or the
  function the product's census matches). The product's own census test builds the list from the code; with that
  list (`--census`) a missing row and a dead row are findings. (checked: act-every, act-shape for the file's shape)
- A product MUST have three tests of its own: the census (the code's list equals the rows), a dry do_act for every
  row against its fake or real server that gets the derived answer, and the bytes of its eager tool array and its
  prompt under the numbers of its profile. The file names them. (checked: act-census on the declaration; that they
  pass by the product's own run)

## 2. The four answers and the seven facts

- Every row MUST get exactly one of four answers, DERIVED and never typed: read (she reads it now), alone (she does it
  now when the owner switched acting alone on, otherwise it is a card), card (she stages a card, he taps once, the
  product runs it with his login), open (she opens the exact screen at the exact item and says the one press; she
  never says I cannot). A fifth value, none, is only for a row of kind not-an-act (a hook, a router, a program's own
  door) with a one-sentence why. (checked: act-answer for none and its why, act-level for a typed answer)
- The answer MUST come from seven facts by ONE function, the reference `levelFor` of `lib/acts.mjs` (pinned for every
  combination in `level-table.json`): never is a class: open; reads and not spends, seen, other: read; own, undo
  true or remake, and not spends, seen, other: alone (spoken, and undo not true: card); everything else: card. A
  product's own function MUST give the same answer for every combination. (checked: act-facts for the facts of a
  row; the product's own equivalence test against `level-table.json`)
- The facts are reads (only reads), own (changes only the product's own state on this computer), undo (true: one
  press takes it back; remake: only makes again what the product makes; false), spends (usage or money), seen
  (another person, client or session sees it, or it leaves the computer; also when it interrupts something a
  session or client uses: a gateway or add-on start, stop or restart, a dashboard restart), other (another
  computer) and never (a class or none). Every row MUST carry all seven, each in its set. (checked: act-facts)
- At the call the server MUST look up facts itself (a paid provider, another computer, a session she did not start,
  spoken) and MAY only turn facts ON (`raiseFacts`): the model's words never lower an answer, and a row's `raise`
  lists only facts the server can turn on. (checked: act-raise on the declaration; the server's lookup by review)

## 3. The never classes

- The never classes are closed and the same in every product: sign-in (sign in or out, keys, passwords, tokens),
  credentials (the credentials folder and every secret path), open-out (open to the internet), pair (add, link or
  remove a computer, trust a host key), delete-work (delete projects, repositories, branches, files, accounts,
  keys, history; reset or force a git tree), her-rights (her level, cap, providers, the alone switch, permission
  modes, bypass, hands off, auto-installs, confirming a card). A product MAY map its own words onto them and MUST
  NOT add a class that lowers a level. A never row says in one sentence why, and no tool does it: she opens the
  screen. (checked: act-never)
- Every row MUST name the screen of the product and the one press (at most 60 characters). An open answer returns
  the screen, the focus (the item id) and the class sentence; a read or card row carries them as the fallback when a
  call is refused. (checked: act-open)

## 4. Input, result, undo

- Every row that takes arguments MUST carry its input as ONE strict JSON Schema (`additionalProperties` false at
  every level, every value bounded) or name the route's own schema the product exports; never a tenant, role, price
  or secret field (`tools/CONTRACT.md` section 4 applies to acts). (checked: act-input)
- Every read row MUST name the fields kept from the answer (`pick`, at most 40) and the cap (at most 4,000
  characters per fact). A read whose answer holds a field of the secret class (key, token, secret, password,
  cookie, authorization, verifier, device code, private key) and cannot be picked without it MUST be open, not
  read. (checked: act-result)
- A card or alone row whose undo is true MUST name its undo act, and the undo act MUST be a row. (checked: act-undo)

## 5. The catalog and the server

- A product MUST reach its rows through the three catalog tools find_acts, do_act and plan_acts; every eager tool
  action MUST be a row too, with the same act and the same answer; a new row is reachable with no new tool. (checked:
  act-catalog)
- On every call the server MUST: look the act id up as a row and compute the answer again from the row's facts and
  the facts found for this call; validate the arguments against the act's strict schema, never coerced; refuse a
  never row before any work with the same open answer every time; call the route through the product's own door
  with the same checks as the owner's page, as Tia and never with the owner's token; run a card only from his tap
  with his login; compare the before-hash of the shown state at the tap (stale: no act, a new card); treat the card
  id as the idempotency key and never retry a confirmed act blindly; count every spending call against the owner's
  daily cap; return only the picked fields, drop secret-class fields, fence outside text and enforce the cap in
  code; write one audit line (when, actor, door, tool, act id, masked input, outcome); and hold the guard limits
  of `guard/limits.json`. Each is also a case of the product's own eval. (checked by review)

## What the machine does not check

The checker reads the acts file and the registry. It does not read the product's code: that the census list is
true, that the facts of a row describe what the route really does, and that the server does the checks above are
the product's own tests and the reviewer's work. A row whose facts are wrong gets the wrong answer: the facts are
the part of a pull request that is read twice.
