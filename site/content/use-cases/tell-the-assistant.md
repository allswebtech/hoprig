---
order: 14
who: Talking instead of clicking
short: Say or type what you want; Tia shows one card with the task, the brief, the provider and the model, and starts nothing before your yes.
---

# How do I tell an AI assistant what to do, by voice or text, and approve just one step?

Turn on Tia, the dashboard's assistant, and tell her, in words or through the microphone, what you want: what needs you today, a task to add or change, or a task for a session to do. Before a session starts she shows one card with everything it will get, and nothing happens until you press **Confirm**.

## Who this is for

You know what should happen next ("have a session fix the login bug in shop") but you do not want to open the right page, pick a project, write the brief and set the provider yourself. Maybe you are on your phone, and speaking is easier than typing.

## The problem

People ask "can I just tell Claude Code what to do from my phone" or "an AI assistant that runs my coding sessions". An assistant that acts by itself is a risk: it can start paid work, or send a session text you never saw. One that asks about everything is no help.

## What Hoprig does

1. **Settings → Tia**: turn on **Tia is on**, choose what **Tia runs on** (at first **Automatic**: the first subscription of yours that can answer now, so she simply answers), the providers she may start sessions with, and how far she may go: **Ask me**, **Do the work** or **Hands off**.
2. Open **Tia** and write what you want, or tap the microphone (**Voice typing**) and say it: the words go into the box, and you send them yourself. The language is under **Settings → Appearance**. The App's message box has the same microphone.
3. Ask what needs you today, to add, change or finish a task, or to have a session do one. For a session she shows ONE card: the task, the project and the folder, the whole brief the session gets as its first message, the provider (and that it is paid, when it is), the model and the effort. **Confirm** starts it; **Decline** does not.
4. The card shows exactly what is sent. Every text she passes on is cleaned once of characters nobody can see, and that one value is what the card shows and what the session gets; the card says "Hidden characters were removed from this text." when that happened.
5. She follows the run and tells you in two lines what was done and what waits for you. Accepting the result stays yours: she never accepts one by herself, and a stop or a message she would send to that session is a card too. **Tia decides** (**Settings → Tia**), once you turn it on, may still do two things to that session without a card when it is stuck: type one fixed line of Hoprig's into it to nudge it, once while it makes no progress, and end it, but only in a project where you ticked **Tia may end a stuck session in this project** on the project's page ([the Operator guide](/docs/operator/)). Typing into a session that runs on a provider paid per use, the nudge too, is money: **Tia decides** does it only at **Hands off** and within her daily limit for paid use (Settings → Tia), and it counts against it.
6. Her last change to a task in a conversation can be undone: ask her, while the task is still as she left it.

![Tia: a conversation, the work she did, and a card that waits for your OK](/screenshots/tia-desktop-light.webp)

## What you need

- A provider for Tia's own thinking. With a Claude subscription she thinks on it, inside your plan; when every subscription is at its limit she says so with the time and does not move to a paid provider by herself. Without a subscription every message to her is a paid request.
- For the microphone: a browser with speech recognition (Chrome, Edge and Safari have one) and the dashboard on its https address or on this computer itself. Over plain http the browser does not allow the microphone; **Settings → Security and sign-in** sets up https.

## What it does not do

- Tia is experimental and off until you turn her on.
- She answers in text; she does not speak.
- Hoprig never gets the audio: the browser turns speech into text (Chrome's own recognition does that on Google's service). Where the browser has none, the microphone says so.
- A card for a Work task comes at every level, **Hands off** too. At **Hands off** she may start other jobs on the paid API providers you allowed her without asking, but only within the **Daily limit for paid use (US $)** you set in Settings → Tia. That limit is empty at first, and while it is empty she asks you first. The same limit holds what her switches in **Settings → Tia** spend, once you turn them on. At **Hands off**, the limit rule or **Tia decides** may move a session at a usage limit onto such a provider, only within that limit, and each move counts against it. The short call of **Tia decides** and a look into what nobody can explain may also run on one when every provider you allowed her is paid per use (Auto mode counts as paid per use here when its order holds such a provider), only within that limit too ([the Operator guide](/docs/operator/)).
- Her Work tool and voice typing were run on Linux only, in temporary homes, in this version.
