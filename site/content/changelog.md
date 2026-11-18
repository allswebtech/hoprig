---
title: Changelog
description: What changed in each version of Hoprig, newest first, in plain words: new features, fixes, and what was not run yet on macOS.
---

# Changelog

Each version of Hoprig, newest first. Hoprig installs from the main branch of its repository; `hop update` brings the newest version, and **Settings → Updates** shows it in the dashboard.

## 0.3.2 (18 November 2026)

A Work page where a coding session can do a task for you, an App that works more like the Claude Code desktop app, groups of projects of your own in the workspace, and gateways of your own. Everything new in this version was run on Linux only.

### What changes when you update

- **Hoprig is now under the Apache License 2.0.** Versions up to and including 0.2.1 keep the licence they were released under ([License](https://github.com/allswebtech/hoprig#license) in the README). A NOTICE file names the copyright holder, a pull request is merged once its author agrees to the [contributor licence agreement](https://github.com/allswebtech/hoprig/blob/main/CLA.md) by one line in it, and the name and the logo have a [trademark policy](https://github.com/allswebtech/hoprig/blob/main/TRADEMARKS.md).
- **A folder of your workspace that is a link you made yourself is no longer followed until you name it.** A project folder, a code folder, the AI brain or a folder of the tree that leads elsewhere (to another disk, for example) is not synced, restored or set up, and the map is not written through it. `hoprig workspace status` lists each such link with the command that names it: `hoprig workspace mylink add <path>`. This keeps a link that came with a cloned repository from making Hoprig act outside that repository's folder.
- **New session asks first: App or Terminal.** The App is what was called a chat. In the page a chat is now a session in the App, for example in a schedule's **Open as** (App or Terminal).
- **The permission modes have Claude Code's own names**: Manual (was Ask first), Accept edits, Plan, Auto and Bypass permissions; Don't ask (was Never ask) is under **More modes**. In a session, Close is now **Archive**, **Open in terminal** is **Open in → Terminal** in the session menu (and a button in the title bar), and **Files** and **Changes** moved from the folder chip to the title bar.
- **A session's cost shows only in the Verbose transcript view**, and only for a provider billed by use. The status line no longer shows it.
- **The workspace map's version 2, which groups need, is written only when you run `hoprig workspace map --upgrade`.** A computer with an older Hoprig refuses a map of version 2 and its map then stands still, so update Hoprig on every computer first. Without groups nothing changes.
- **A project belongs in a folder of its own name.** `hoprig get example/shop-workspace` makes `shop/`. When a project of your map is here under another folder name, restore and `hoprig workspace status` show the `mv` that gives it the map's name and count it as needing you; nothing is moved by itself.

### Work

- **Your tasks and a Today screen, in one file of your workspace.** **Work** is under Home in the menu. **Today** shows what needs you now (tasks due this week or waiting for you, and the sessions on any of your computers that need an OK or reached a limit), what a session finished (**To review**), this week day by day and what was done lately. **Tasks** lists every task, with filters by project and by who does it. The list is one file in a git repository, the AI brain by default; **Settings → Work** chooses another place.
- **Do it: a coding session does a task.** The ▷ button on a task shows the brief, the project and folder, the provider, model and effort, then starts a session in the App with that brief. When its turn ends, the task waits in To review with the session's answer, its commits and the files it left changed: **Accept** marks it done, **Send back** opens it again with what you wrote added to its brief. Nothing is pushed or merged by it.
- **Activity lists every run**, newest first, by day. A run is a small file beside the list, with keys, this computer's paths and its name taken out, so the other computers see it after a Save. A brief that holds characters that cannot be seen is refused, with **Take them out**.
- **Save commits only Work's files, and either reaches the server or leaves your change in the file.** It brings another computer's changes in task by task and asks you only where both computers changed the same task. It never sends a commit of yours that changes anything else, and a save that was interrupted is finished the next time.
- **`hoprig tasks` does the same in a terminal**: `today`, `list`, `add`, `edit`, `done`, `do`, `runs`, `save` and more, each with `--json`, and `--dry-run` where it changes something. The command is `tasks`, so a provider named `work` keeps working. Details: [Work](/docs/work/).

### The App and New session

- **New session is one popup**: App or Terminal, the coding tool, then the project. A coding tool that is not ready says what it is missing. A tap on a project always starts a new session; where one runs already, **Open running session** is its own button beside the row.
- **A title bar as in the Claude Code desktop app.** The caret beside the title opens the session menu: **Transcript view** (Normal, Thinking or Verbose, kept in this browser), **Open in** (Terminal, Files, Changes), **Archive**, **Copy branch name** and **Rename**. The title bar has **Open in Terminal**, **Changes** and **Files**, and its ⋮ menu has **Background tasks** once there are some.
- **A session rail beside the chat on a wide screen**: where the session runs, its provider and branch, the folder's changes (their +N −M opens the editor's Changes), the context and the background tasks with **Stop**. **Hide session rail** is in the title bar.
- **A plan's answers in Claude Code's words**: "Yes, and use auto mode" (offered only once the session has shown it can), "Yes, manually approve edits" and "No, keep planning". Before, the first answer never went on in auto mode.
- **An answered OK folds into the tool card it was about** ("Ran npm test · allowed by you"), a queued message shows as you sent it, with its files by name, and a change of a file that failed reads "Could not write …".
- **Fixed**: a turn that starts from your queued message is no longer labelled as one the coding tool began by itself; a session's title survives **Open in Terminal** and the way back, also across a restart of the dashboard; a request an older Claude Code does not know is refused in plain words; an OpenCode session's Thinking view no longer says Claude; a plan no longer offers auto mode after a move to a provider or a model without it. The title bar's and the rail's controls are big enough for a finger, and after a choice in a menu the keyboard is back on what opened it.

### The workspace

- **`hoprig get <name>` fetches a project by one word**: the parent, every code repository, the memory link, the git hooks, a `.env` from `.env.example` and the installs (asked). A bare name is looked up in your map, then on GitHub as `<name>-workspace` and `<name>`, and the folder is the project's name whatever its repository is called. A project that is here already is not changed: `get` says what it misses, and `hoprig project setup <name>` sets it up.
- **A dry run changes nothing at all.** `hoprig get`, the `hoprig project` commands and the workspace commands take `--dry-run` and then only say what they would do: no lock, no settings file, no map, no git ref is written.
- **Groups: folders of projects of your own**, beside the projects folder and written into the map, so every computer gets them: `hoprig workspace group add client-work`. A group can also be a repository of its own that holds projects. A place can carry a naming rule: `hoprig workspace find --in <place>` lists what your GitHub account has that fits it, and `hoprig get <word> --in <place>` fetches it. A project in a group is named `<place>/<name>`, and the Workspace page shows one section per place. Details: [Workspace](/docs/workspace/).
- **A group may bring a command of its own.** It is made only after your yes on that computer (`hoprig workspace tool allow <group>`), and checked again at every start.
- **`hoprig workspace rules`** shows a short text about your workspace for coding sessions, and `--write` puts it, after your yes, into a file of Hoprig's own (`~/.claude/rules/hoprig-workspace.md`). Nothing from the map goes into a file a coding tool reads as instructions without your yes, and your own working rules are never touched.
- **`hoprig project new --github` names the repository `<name>-workspace` when your account has `<name>` already**; `--repo-name` chooses another name. A key of `project.json` that this version does not know is kept and shown as a warning, instead of stopping a clone.
- **One address in every spelling**: ssh or https, with or without `.git`, and on the usual hosting sites the owner and the repository in any letter case.

### Providers and gateways

- **A gateway of your own.** A gateway is a program that offers other AI providers through Claude's API. Beside the one Hoprig ships, `hoprig gateways add` (or **Settings → Add-ons → Add a gateway**) defines another: its program or npm package, its port and its own page. It is a program Hoprig will run, so you see the exact program and arguments and confirm with the dashboard's password; the assistant cannot add one. Hoprig runs exactly the file you confirmed, and asks again once it changes (`hoprig gateways confirm <name>`).
- **Other providers asks which gateway first** when there is more than one, and a provider whose gateway was removed says so.

### Safety

- **In a terminal session, the page answers only a permission, and only into the dialog its card shows.** **Allow** and **Do not allow** appear while Claude Code's permission dialog for that same command or file is on the screen. A question, a plan, or a screen that cannot be read sends you to the terminal, and with two questions waiting the page answers neither.
- **Bypass permissions follows one rule, in a terminal and in the App.** Claude Code still stops before some deletes in this mode. Hoprig answers by itself only a plain delete inside the folder the command runs in, the same in the App as in a terminal, and shows each one it allowed ("Allowed by Hoprig in bypass mode"). Every other stop of Claude Code's, a question, a plan and what your settings say "ask" for still come to you.
- **Hoprig stays inside each project's own folder.** A link that came with a repository is never followed, a file is never written through a link, and the map, a group's ignore file and the rules folder are never read or written through one.
- **More kinds of keys are masked** where Hoprig shows or keeps text (the AI brain page, Tia, Work's runs): Hoprig's own tokens, GitHub's fine-grained tokens, Stripe, Google and npm keys, and the password in an address.

- **Before Hoprig allows a delete by itself, it looks at what the shell will hand to rm.** Nothing is allowed from inside a repository's history, from your home, your workspace or a folder that holds projects; nothing that is a repository or holds one, at any depth; nothing reached through a link, on another disk or past a mount. It judges a pattern such as `*` by what it could match under any of the shell's options, also names that begin with a dot. Where it cannot tell in a quarter of a second (a very large folder), it does not allow: Claude Code asks you.
- **A delete with a word that begins with `-` after its first target is never allowed by itself.** The rm of macOS takes such a word for a file's name where the rm of Linux takes it for an option, so Hoprig allows such a line on no system. A git folder counts as one in any letter case of its name.
- **An OpenCode chat in bypass mode asks Hoprig before every shell command.** OpenCode has no stop of its own there. An ordinary command runs at once; one that names a delete in plain sight (rm, shred, find -delete, git clean, rsync --delete, also inside `bash -c`, `ssh` or `sudo`) and is not plainly inside the folder is put to you as a card. It is no wall: a script, a program, a command written to get around it and OpenCode's own file tools can still delete. What your own OpenCode settings deny stays denied; when they cannot be read, every command is a card.
- **A command an OpenCode chat asked about while the dashboard was down is taken up when it is back**, also with no page open: it runs if it is ordinary and shows its card if it is not. It never runs unanswered.

### Fixes

- **Sync no longer deletes a code repository or a group's project** that lives in a folder its parent ignores, when the parent starts to track a file at that place: git refuses now, and sync names the folder in the way. Before it suggests a merge or a rebase, sync says what either would delete.
- **On a busy computer, a running gateway, dashboard or editor server is no longer taken for one that stopped.** Only a port that refuses counts as not running. Before, joining a hub could stop with "the dashboard is not running", and the editor could remove a running code server's folder.
- **A paste into a tmux terminal that tmux did not read no longer stops the whole dashboard.**
- **With "stop an unused gateway" on, the automations keep running.** The public link made every check fail, which stopped the queue, the schedules, restore and retry.
- **Setting up a computer from a recipe** retries a project that needs you with its own fix, and a step run with sudo keeps a quoted path as one argument.
- **A long reply can no longer freeze a session's page or hold up the dashboard.** Three places that read text (the files named at the end of a message, the preview on a card, a heading) took a time that doubled with every few characters of certain text. Each reads its text in one pass now.
- **Two changes to a session's state at the same moment no longer lose one.** When a lock file was left behind by a process that had ended, two hooks could both take it over. The take-over is one step now, and only one of them makes it.
- **Ending or cancelling a Claude Code sign-in from the page no longer fails now and then.** Claude Code, just told to end, could still write into the sign-in's helper folder while Hoprig removed it; the page then got an error and the sign-in's text stayed in memory. The removal is tried again and never fails the end.
- **On macOS, a terminal of the built-in kind starts also when the terminal module's helper lost its executable bit in the install.** Hoprig sets the bit before every start. Run on GitHub's macOS runners, not on a Mac in use.
- **`npm test` no longer loses results.** On a busy computer the runner could end a test file's process before its last results were read, and the run still said "fail 0". Each file writes its results before it ends, a run whose file did not report everything fails and names the file, and a clean run ends with "every result arrived".
- **Esc typed in the terminal** settles the session's card at once, and **Tab** stays inside a popup whose last part is a closed Options section.

### The site

- **[hoprig.com](https://hoprig.com)**: use cases, each a question with the steps and what Hoprig does not do, honest comparisons, the docs and this changelog, built from the same repository.

Everything new in 0.3.2 was run on Linux only, not on macOS or Windows. See [Not built, or not proven yet](/docs/not-proven-yet/).

## 0.2.1 (17 November 2026)

Fixes, most of them found when the tests ran on macOS:

- **On macOS, a terminal session starts also when a folder in its path has letters beyond plain English ones.** macOS's own shell read such letters as other keys, and the session did not start.
- **On macOS, Hoprig tells a process it started from another one by the start time the system stored.** Before, on a busy computer a running session could be taken for one that had ended.
- **The editor never creates Claude Code's sign-in file**, also when Claude Code's folder is a link into an opened folder and the file does not exist yet.
- **The editor answers correctly for a folder that was moved or deleted**, also when it was named through a link, and no longer tells whether a path outside the allowed folders exists.
- **A chat of Tia's stops being hers** when a terminal went on with its conversation in the moment the chat stopped.
- **Pairing a computer again by SSH** finishes revoking its old token before it answers.
- What is new in 0.2 has still been run on Linux only. See [Not built, or not proven yet](/docs/not-proven-yet/).

## 0.2.0 (17 November 2026)

- **A chat for every project.** One tap on a project opens a chat with its coding tool: replies as they are written, each change as a diff, **Allow** and **Do not allow** buttons, the to-do list, agents and background tasks. The real terminal is one tap away and keeps the conversation.
- **OpenCode as a second coding tool**, on API keys and gateways, with the same rules, skills and memory as Claude Code.
- **A code editor in the page**: VS Code's editor core, with Explorer, Search and Source Control.
- **A desktop in the browser**: windows for a computer's terminal, files, editor, processes, services and logs.
- **The public link is one switch**, with two kinds: Temporary (a new address each time) and Custom (your own address).
- **Updates on one page** for Hoprig, Claude Code, OpenCode and the tunnel helper; Manual by default.
- **One process per conversation**: a conversation runs in a chat, a terminal session or a `hop` typed by hand, never two at once.
- **Safe git reads**: when the dashboard reads a project's git state, the repository's own settings never start a program.
- Node.js 22 or newer is required (Node.js 20 is no longer supported).
- Everything new in this version was run on Linux only. See [Not built, or not proven yet](/docs/not-proven-yet/).

## 0.1.0 (14 November 2026)

The first public version.

- Installs on a fresh PC or Linux server and sets up what is needed for coding with Claude Code; on a computer that already has things, it checks what is there and adds what is missing.
- One dashboard, phone included: your projects with their sessions, a real terminal in the browser, your providers (subscriptions, API keys, gateways) with sessions that carry on under the next provider at a usage limit.
- Your other computers in one place: by SSH, or through a small hub server that computers at home join by themselves.
- A workspace with one layout on every computer, and a read-only view of what the AI knows (the AI brain).
- Tia, an experimental assistant (off by default) that can run the dashboard for you behind confirm cards.

The [releases on GitHub](https://github.com/allswebtech/hoprig/releases) have the notes of each tagged version.
