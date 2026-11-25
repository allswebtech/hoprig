# Hoprig 0.3.5: every command

Each command's own help, as the program prints it (`hoprig` and `hop` are the same command). Made by
tools/build-skill.mjs at every build of the skill, so it matches this version.

## hoprig help

`hoprig help` prints:

```text
Hoprig — Claude Code and OpenCode under several providers, and a dashboard for every computer

  hoprig                      choose a profile, then start Claude Code in this terminal
  hoprig chat [folder]        code in a chat in the dashboard instead: prints its address and opens it
                                 in your browser (set up as your last chat in that folder;
                                 --tool opencode: a chat with OpenCode, where the dashboard offers it)
  hoprig <profile> [args]     start under that profile; args go to Claude Code
                                hoprig api -c            continue the last session of this folder
                                hoprig sub2 --resume ID  continue one session
                                hoprig api -- "fix the tests"  start, and send this as the
                                                         session's first message
  hoprig -c | --resume ...    choose a profile, then continue as asked
  hoprig <profile> --with <name>  also let this session read another project of the workspace
                                 (to read; its file tools cannot write there; this session only;
                                 a project's own "needs" come by themselves)

  hoprig opencode [provider] [args]  start OpenCode instead; -c, --resume ID and -- "first message"
                                 as above. Auto mode, plan usage and Tia's engine are Claude
                                 Code's only

  hoprig auto [args]          start in Auto mode: when a provider reaches its limit, work goes on
                                 under the next one without stopping, and comes back by itself

  When a session stops at a limit or an error, Hoprig offers to continue it on another profile.

  hoprig add [name]           add a profile (a provider: another Claude account, an API key, a proxy)
  hoprig profiles [--json]    list profiles
  hoprig profiles map <name> [on|off] [--yes]
                              a provider's model map (MODELS) for every session and chat on it:
                                 what it would rename, and whether it is on (off at first)
  hoprig rm <name> [--yes]    delete a profile (asks first; --yes: without asking)

  hoprig auto status          Auto mode's settings, each provider's usage and limits
  hoprig auto on | off        make Auto the default way to start (off at first)
  hoprig auto order a b c     the providers Auto mode uses, most preferred first

  hoprig demo                 try the dashboard with sample data (no Claude Code or provider needed)
  hoprig pc setup             make a fresh computer ready for coding (git, Node, tools, GitHub, projects)
  hoprig pc status            what this computer has, what is missing, what needs attention
  hoprig project new <name>   a new project: one folder for rules, AI memory and docs, with its code
                                 repositories under code/, all in git
  hoprig project clone <name> get an existing project with all its code repositories and its AI memory
  hoprig get <name>…          the same, short (the folder is the project's name; --dry-run shows it first);
                                 hoprig get --list: every project of your workspace and which computer has it
  hoprig drop <name>…         take a project off THIS computer safely: it pushes first, then checks, then removes
                                 (--check only says what exists only here; --dry-run shows every step)
  hoprig adopt scan|plan|apply  a computer that already has projects: look in the folders you name, a plan per
                                 project, then a proved copy into the workspace (adopt verify | retire)
  hoprig sessions move <old> <new>  the coding tool's conversations of a folder, copied under its new place
  hoprig sync [<name>]        bring the repositories on this computer (or one project) in step with git
  hoprig project status|sync  the state of a project's repositories; pull and push what is safe
  hoprig project setup <name> what a fresh clone sets up (.env, git hooks, memory link, installs)
  hoprig workspace            the one folder tree for your coding: AI brain, projects, credentials
                                 (workspace status | setup | link | map | restore | sync | set | forget | git |
                                 group | find | tool | mylink | rules | label)
  hoprig tasks                Work: your tasks and what needs you today, kept in a file of the workspace
                                 (tasks today | list | add | edit | done | open | drop | remove | do | runs | plans |
                                 plan | save;
                                 "hoprig tasks help" has the rest)
  hoprig ship status <project>  Go live: put finished task branches together, check them, go live on your yes
                                 (status | together | check | allow | live | back | auto; docs/GO-LIVE.md)

  hoprig setup                install what is missing and set everything up, step by step
  hoprig doctor               check that everything works
  hoprig move-to-user         move Hoprig from root to an ordinary user of this server (--dry-run shows it first)
  hoprig box check | run      a box for commands: no network, not your home, only the folders named
                                 (box run --write DIR -- <command>; docs/BOX.md)
  hoprig field                field reports: what Hoprig's own work showed, kept on this computer
                                 (field show <id> | inbox <folder> | way-round; docs/FIELD-REPORTS.md)
  hoprig claude status        Claude Code's version (also: claude update, claude install <version>)
  hoprig tools                the coding tools: Claude Code, OpenCode (tools install <tool>,
                                 tools update <tool | all>, tools on | off <tool>)
  hoprig update               update Hoprig itself

  hoprig link                 a one-time link and QR code that signs a phone or another browser in
  hoprig public on | off      open this dashboard from anywhere through Cloudflare, no server needed
                                 (public on --temporary | --custom; public status)
  hoprig machines             the other computers this dashboard also shows (add, list, remove)
  hoprig join <ssh target>    connect THIS computer out to another dashboard (for a PC behind a router)
  hoprig pair                 let another computer's dashboard control this one
  hoprig tokens               who may control this computer (list, revoke)

  hoprig skills               skills for you and your projects: suggest, find, review and
                                 add, update (skills suggest | find | add | list | update)
  hoprig addons               optional companions, such as an AI gateway that lets Claude Code use
                                 other providers (addons setup <id>)
  hoprig gateways             the gateways Hoprig knows; gateways add | confirm | remove: one of your own
  hoprig mcp                  Hoprig's tools as an MCP server (for the dashboard's assistant and
                                 for any MCP client, such as your own Claude Code)

  hoprig serve                start the web dashboard
  hoprig passwd               set the dashboard password
  hoprig service install      run the dashboard in the background
  hoprig service restart      start the background dashboard again (after an update)

  Profiles are files in ~/.config/hoprig/profiles
```

## hoprig chat

`hoprig chat --help` prints:

```text
usage: hoprig chat [folder] [--tool <coding tool>] [--no-open]   (the folder: this one when left out)
```

## hoprig opencode

`hoprig opencode --help` prints:

```text
hoprig opencode [provider] [-c | --resume <id>] [--permission-mode default|ask|bypassPermissions]
                 [--effort low|medium|high|xhigh|max] [--model <id>] [-- <first message>]

  Starts OpenCode in this terminal on a provider that serves it. Hoprig keeps the session's status for the
  dashboard and stops its own OpenCode server when the last session ends.
```

## hoprig setup

`hoprig setup --help` prints:

```text
usage: hoprig setup [--yes] [--dry-run] [--only base|pc|git|workspace|project|skills] [--hub [--domain D] [--ip A] [--tls-internal]] [--access local|network|tailscale] [--no-service] [--no-dashboard] [--password-file FILE] [--stay-root]
```

## hoprig doctor

`hoprig doctor --help` prints:

```text
usage:
  hoprig doctor [--offline] [--json]                       check everything, change nothing
```

## hoprig claude

`hoprig claude help` prints:

```text
usage:
  hoprig claude status | update | install <version|stable|latest>
                                                          the Claude Code installation
```

## hoprig update

`hoprig update --help` prints:

```text
usage:
  hoprig update [--dry-run]                                update hoprig itself
```

## hoprig tools

`hoprig tools help` prints:

```text
usage:
  hoprig tools [status] [--json]          the coding tools: on or off, installed, newest
  hoprig tools install <tool> [version]   install one (claude, opencode) and turn it on
  hoprig tools update <tool | all>        update one, or every installed one
  hoprig tools on | off <tool>            which tools the dashboard offers
```

## hoprig pc

`hoprig pc help` prints:

```text
usage:
  hoprig pc status [--json] [--offline]       what this computer has, what is missing, what needs attention
  hoprig pc setup [--yes] [--dry-run] [--kits basics,node,python,github,extras,docker,php,fvm,flutter,android] [--recipe <file|https address>]
  hoprig pc recipe save [file] [--with-email]  write a recipe to set up another computer like this one
  hoprig pc clone <git address | owner/repo>…  clone into the projects folder
  hoprig pc leave --check [--also <folder>]… [--json]  what exists only on this computer, before a format (reads only)
```

## hoprig pc setup

`hoprig pc setup --help` prints:

```text
usage: hoprig pc setup [--yes] [--dry-run] [--kits basics,node,python,github,extras,docker,php,fvm,flutter,android] [--recipe <file or https address>] [--no-projects] [--rules | --remove-rules]
```

## hoprig pc leave

`hoprig pc leave --help` prints:

```text
usage:
  hoprig pc leave --check [--also <folder>]… [--json]   what exists only on this computer, before a format (reads only)
       exit 0: nothing is only here; 1: something is (the list says what to do with each); 2: a word not understood
       --also <folder>   an older layout outside the workspace: its repositories and folders in no git too
  hoprig pc leave --outside <folder>… | --keep <dot-folder>… | --ignore <dot-folder>… | --test-data <engine>… | --unmark <name>…
       marks kept in this computer's own file: a folder you keep your own way, a dot-folder you back up or that does
       not matter, a database engine that holds test data only; --unmark takes a mark away
  hoprig pc leave help | --help | -h                     this help (reads nothing)
```

## hoprig get, project clone

`hoprig get` prints:

```text
usage: hoprig get <name | place/name | owner/name | git address>… [--in <group>] [--with-needs] [--json] [--dry-run] [--yes]
       --with-needs  also get what the project names in "needs" (other entries it reads), without asking;
                     --yes never answers the set-up questions of a need (its installs)
       hoprig get --list [--json]   every entry of the workspace map and where it is checked out
       (a place with a naming rule: hoprig get <word> --in <place> looks the hosting site up for it)
```

## hoprig drop

`hoprig drop --help` prints:

```text
usage: hoprig drop <name | place/name>… [--check] [--dry-run] [--json]
       --check     only say what exists only on this computer (exit 1 when anything does)
       --dry-run   show every step a drop would take; nothing is changed
       when another project here names it in "needs", drop asks first (--check and --json: neededBy)
```

## hoprig adopt

`hoprig adopt --help` prints:

```text
usage: hoprig adopt scan [--in <folder>]… [--json]     look at the projects in the folders you name (changes nothing)
       hoprig adopt plan <folder | all --in <folder>…> [--json]   a plan per project, as a file; nothing else is written
                    (it asks GitHub, with this computer's sign-in, whether each repository there is public or private)
                    [--name <name>]                      the project's name (else made from the folder's name)
                    [--copy-installed]                   copy installed packages and build output too (left out by default)
       hoprig adopt apply <project> [--dry-run] [--name <n> --email <e>]   copy it into your workspace and prove the copy
                    [--clean-stopped]                    first remove the half-made copy of an apply that stopped partway
       hoprig adopt verify <project>                         prove the copy against the original again
       hoprig adopt retire <project>                         remove the originals (on a terminal, with the name typed)
A scan never fetches and never enters a private folder; apply copies, never moves; the originals stay until retire.
```

## hoprig sessions

`hoprig sessions --help` prints:

```text
usage: hoprig sessions move <old folder> <new folder> [--dry-run]
       copies the coding tool's conversations of the old folder under the new one (the old ones stay)
```

## hoprig project

`hoprig project help` prints:

```text
usage: hoprig project new|add|start|clone|status|sync|link|setup …   (see docs/PC-SETUP.md)
  start <name>   the AI session that sets up a project made with a brief (project new --brief); --help for its options
```

## hoprig project new

`hoprig project new` prints:

```text
a name is needed — usage: hoprig project new <name> [--in <group>] [--template <folder|git address>] [--github [--repo-name <name>] | --remote <address>] [--brief <file> | --brief -] [--kind <kind>] [--scope product|setup] [--no-skill] [--git-name <name> --git-email <e-mail>] [--start] [--dry-run]
```

## hoprig project add

`hoprig project add` prints:

```text
usage: hoprig project add <project> <name> [--github | --remote <address>] [--git-name <name> --git-email <e-mail>] [--dry-run]
```

## hoprig project sync

`hoprig project sync --help` prints:

```text
usage: hoprig project sync [name] [--memory] [--dry-run]
```

## hoprig project link

`hoprig project link --help` prints:

```text
usage: hoprig project link <name> [--dry-run]   (<place>/<name> for a project in a group, <group> for a group's own memory)
```

## hoprig project setup

`hoprig project setup --help` prints:

```text
usage: hoprig project setup <name> [--dry-run] [--yes]
```

## hoprig workspace

`hoprig workspace help` prints:

```text
usage:
  hoprig workspace status [--all] [--json]     the workspace: what is there and what each folder is for;
                                               --all: which computer has what (each computer's own file);
                                               names each project's "needs" that are not on this computer
  hoprig workspace setup [--dry-run] [--yes]   create only what is missing (nothing that exists is changed)
  hoprig workspace link [--dry-run] [--yes]    let every coding tool that is on (Claude Code, OpenCode) read
                                               the same rules, skills and memory from the AI brain (backs up what
                                               is there; overwrites nothing); and make the credential links each
                                               project's project.json names
  hoprig workspace rules [--json]              the short text about this workspace for coding sessions (shown only)
  hoprig workspace rules --write [--yes]       write it, after you saw it, into ~/.claude/rules/hoprig-workspace.md
                                               (a file of Hoprig's own; your own rules files are never written)
  hoprig workspace needs [list] [--json]       each project's needs here, and whether you allowed its sessions
                                               to read each one on this computer
  hoprig workspace needs allow|revoke <project> <need>
                                               let the sessions of a project read a need it names, or take that
                                               back (kept on this computer only, never in the project)
  hoprig workspace mylink [list] [--json]      the links you named as your own on this computer (Hoprig follows
                                               them; any other link that leads out of its folder is not followed)
  hoprig workspace mylink add|remove <path>    name a link in the workspace as yours (a project folder kept on
                                               another disk), or take it off the list; never in the map, never synced
  hoprig workspace credentials [--json]       the credentials folder: a local folder, or a repository (its address)
  hoprig workspace credentials --repo <address> | --github [<name>] [--dry-run]
                                               make it your own private repository and push it (off by default;
                                               you confirm by typing the repository's name)
  hoprig workspace map [--dry-run] [--json]   write the map of every git repository of the workspace
                                               (ai_brain/workspace.json; shows what changed; never commits)
  hoprig workspace map --upgrade [--dry-run] [--yes] [--json]
                                               the map to version 2 (needed for groups); says first which
                                               computers need a newer Hoprig
  hoprig workspace map --undo [--dry-run] [--json]
                                               the old map back after an upgrade on this computer, while the map
                                               has not changed since (the Workspace page has the same button)
  hoprig workspace map --fix-case [--undo] [--dry-run] [--yes] [--json]
                                               give a folder whose name differs from its map entry only in
                                               letter case the map's name (Shop → shop), through a temporary
                                               name; --undo: the old names back
  hoprig workspace restore <brain address> [--with-projects] [--dry-run] [--yes] [--json]
                                               a fresh computer: clone the brain, the credentials and groups'
                                               repositories and the others its map names; no project unless
                                               --with-projects (hoprig get <name> fetches one)
  hoprig workspace sync [<project>] [--memory] [--push] [--with <computer>] [--dry-run] [--json]
                                               every repository here (or one project's): fetch and fast-forward;
                                               push only with --push;
                                               --with: straight from another computer over SSH (pull only)
  hoprig workspace set [--dir <folder>] [--projects <folder>] [--json]
                                               where the workspace and the projects folder are (nothing is moved)
  hoprig workspace forget <entry> [--yes] [--json]
                                               take a project (<place>/<name> in a group), a code repository
                                               (project/code/name) or a folder out of the map (no file is deleted;
                                               asks first)
  hoprig workspace group add <dir> [--repo <address>] [--holds name:group,name] [--yes] [--dry-run] [--json]
                                               a folder of projects beside the projects folder; --repo: the
                                               group is a repository holding named folders (name:group: its
                                               members come with the group's repository)
  hoprig workspace group remove <dir> [--dry-run] [--json]
                                               out of the map, when no project of the map is in it (nothing
                                               on a disk is deleted)
  hoprig workspace group ignore <dir> [--yes] [--dry-run] [--json]
                                               a group that is a repository: the ignore lines it lacks for
                                               what it holds (shown first, written on a yes)
  hoprig workspace group list [--json]         the groups of the map
  hoprig workspace find --in <place> [--json]  what the hosting site has that fits the place's naming rule and
                                               the map has not, and what does not fit
  hoprig workspace find --in <place> --add [--dry-run] [--json]
                                               write those projects into the map (nothing is cloned)
  hoprig workspace find --in <place> --place-it <repository> <folder> [--dry-run] [--json]
                                               record one repository that does not fit under the folder you name
  hoprig workspace tool [list] [--json]        the commands of your groups (the map's "tool"): made, waiting for
                                               your yes on this computer, or why one would not start
  hoprig workspace tool allow <group> [--yes] [--dry-run] [--json]
                                               make the group's command after your yes (its address, the name and
                                               the file are shown first); Hoprig never runs it by itself
  hoprig workspace tool remove <group> [--dry-run] [--json]
                                               take the command away (only one Hoprig made) and forget the yes
  hoprig workspace tool run <group> -- <arguments>
                                               what the command starts: Hoprig checks it again, then runs the file
  hoprig workspace git                         git's name and e-mail, the GitHub sign-in, your workspace on GitHub
  hoprig workspace label [<name>] [--again] [--new-id] [--dry-run] [--json]
                                               this computer's short name in the workspace (given once; its own
                                               file ai_brain/computers/<name>.json says what is here); --again: this
                                               computer IS <name>, set up again after a format; --new-id: it shares
                                               its id with another computer (a copied home folder)
  hoprig workspace auto [--map on|off] [--commit on|off] [--memory on|off] [--sync on|off] [--push on|off]
                       [--push-branches <place>=on|off] [--credentials on|off]
                       [--only-here on|off] [--servers on|off]
                       [--every <hours>] [--json]
                                               the upkeep the dashboard does by itself: show or set its switches
```

## hoprig sync

`hoprig sync --help` prints:

```text
usage:
  hoprig sync [<project>] [--memory] [--push] [--with <computer>] [--dry-run] [--json]
                                               every repository here (or one project's): fetch and fast-forward;
                                               push only with --push;
                                               --with: straight from another computer over SSH (pull only)
  (the same as hoprig workspace sync)
```

## hoprig tasks

`hoprig tasks help` prints:

```text
usage: hoprig tasks [today]                      what needs you, this week, done lately
       hoprig tasks list [--all] [--project P] [--by me|ai|<role>]
       hoprig tasks add "<title>" [--date YYYY-MM-DD] [--project P] [--priority high|normal|low]
                         [--by me|ai|<role>] [--note "..."] [--kind task|deadline|gate|opportunity] [--approx]
       hoprig tasks edit <id> [--title "..."] [--date D|none] [--project P|none] [--priority P|none]
                         [--by W] [--note "..."|none] [--kind K] [--status open|doing|review|waiting|done|dropped]
       hoprig tasks done|open|drop <id>
       hoprig tasks remove <id>                      only one you added; one from a plan is dropped instead
       hoprig tasks owner [<id>]                      your id in a planning tool's file: shown, or set
       hoprig tasks fix-ids                           give tasks that share an id (two computers, one title) ids of their own
       hoprig tasks tidy [--dry-run] [--yes]          a file a change would alter (a hand edit): see the difference, write it once
       hoprig tasks do <id> [--project P] [--folder F] [--brief "..."] [--dry-run] [--yes]
                         a coding session does the task: started through the running dashboard, in the task's project
                         (or P) and its own folder (or F: one of its code repositories, code/<name>); it shows the brief
                         and starts on a yes (--yes: without asking)
       hoprig tasks runs [<id>]                       what the sessions did: their answers, commits and changed files
       hoprig tasks schedules                         the schedules and the repeating items: what, on which computer, when next
       hoprig tasks progress [--since 12h|<time>]
                         what runs and how far, when it will be done (by what
                         finished here before), what waits for you, what
                         finished and failed (the last 24 hours)
       add and edit also take --repeat daily|weekly:1,4|monthly:31|none and --run-at HH:MM|none [--computer here|<id>]
                         (a run time is a run that ends by itself, on the computer named: without one it runs nowhere)
       hoprig tasks plans                             the plans: their progress and next date
       hoprig tasks plan <id>                         one plan: its goal, milestones and tasks, what waits, its note
       hoprig tasks save [--seen <token> --decide "<task>=mine|theirs,..."] [--drop-interrupted]
                         commit the Work file by name and send it; a list changed on another computer too is merged
                         by task, and a task changed on both is yours to decide (the save prints the token of what it
                         showed you); --drop-interrupted drops the record of an interrupted save you have looked at
       hoprig tasks tokens [revoke <id or name>]     the Work tokens of other programs (made, last used, their webhooks);
                         revoke ends one at once and removes its webhooks (they are made in Settings → Work)
  Every command takes --json; the ones that change something take --dry-run.
  Where the data lives: Settings → Work in the dashboard (the AI brain's work/ folder by default).
```

## hoprig ship

`hoprig ship help` prints:

```text
usage: hoprig ship status <project> [--json]
       hoprig ship together <project> <name> <branch>...   (the same name again goes on after a conflict)
       hoprig ship check <project> <name>
       hoprig ship allow <project> check|live|limiter [<name>]
       hoprig ship live <project> <name>
       hoprig ship back <project>
       hoprig ship auto <project> on|off [--from HH:MM] [--to HH:MM] [--back on|off]
       hoprig ship drop <project> <name>
```

## hoprig skills

`hoprig skills help` prints:

```text
hoprig skills — Claude Code skills: see, find, suggest, review, add, update

  hoprig skills list [--project <dir>] [--offline]   installed skills, their source and whether a newer one exists
  hoprig skills find <words>                      search the built-in catalog and skills.sh
  hoprig skills suggest [dir]                     skills that fit a project (read from its manifests, no AI), with why
  hoprig skills add <id | owner/repo[/path] | owner/repo@skill | git url> [--project <dir> | --user] [--yes]
                                                     fetch into quarantine, show the review, install on a yes
                                                     (--yes only for catalog entries at their reviewed commit)
  hoprig skills approve <review id>               install a review printed earlier (when no terminal could ask)
  hoprig skills update [name] [--check] [--project <dir>] [--overwrite-local]
                                                     newer versions: the diff and the scan, then a yes per skill
  hoprig skills undo <name> [--project <dir>]     go back to the version before the last update or removal
  hoprig skills rm <name> [--project <dir>] [--yes]   remove a skill (kept for undo)
  hoprig skills tools [--update <id>]             command-line tools catalog skills need: installed, latest, update

  Skills are folders with a SKILL.md that Claude Code loads: yours from ~/.claude/skills, a project's from
  <project>/.claude/skills. Hoprig records what it installs: yours in its state folder, a project's in
  .hoprig-skills.json next to them.
```

## hoprig addons

`hoprig addons help` prints:

```text
usage: hoprig addons                     list the add-ons and their state
       hoprig addons setup <id>          install it, start it and make a profile for it
       hoprig addons install|update|start|stop|status <id>
add-ons: trouteai, public-link
```

## hoprig gateways

`hoprig gateways help` prints:

```text
usage: hoprig gateways                  the gateways Hoprig knows, and yours
       hoprig gateways add <id> --title <title> --port <port> (--bin <program> | --npm <package> [--bin <name>])
                          [--args "<words, PORT where the port goes>"] [--dashboard <path of its page>]
                                       a gateway of your own: a program Hoprig will run (asks you first)
       hoprig gateways confirm <id> [--program <path>]
                                       after you changed the program of a gateway of yours (an update): Hoprig
                                       starts the program as it is now (asks you first; its sharing and keys stay);
                                       --program names it, when it is somewhere else now
       hoprig gateways remove <id>      forget a gateway of yours
```

## hoprig public

`hoprig public help` prints:

```text
usage: hoprig public [status] [--json]        whether this dashboard can be reached from anywhere, and where
       hoprig public on [--temporary|--custom] [--yes] [--new-password FILE]
                                                turn the public link on (Temporary: a new address at each start,
                                                nothing to set up; Custom: your own address, set up in the page)
       hoprig public off                        turn it off
```

## hoprig link

`hoprig link --help` prints:

```text
usage:
  hoprig link [--minutes N] [--url ADDRESS]
                                         a one-time sign-in link and its QR code: scan it with a phone and that
                                         phone is signed in, no password to type (works once, 15 minutes)
```

## hoprig pair

`hoprig pair --help` prints:

```text
usage:
  hoprig pair                         show a one-time code (10 min) that lets another computer's dashboard
                                         control this one: there, Settings → Computers → Add by address
  hoprig pair --json [--name NAME] [--hub]
                                      for another dashboard that logs in here by SSH: make a token for NAME
                                      (--hub: that dashboard is your main computer, which adds this one)
                                         and print it, with this dashboard's port, as one line of JSON
```

## hoprig tokens

`hoprig tokens --help` prints:

```text
usage:
  hoprig tokens [--json]              who may control this computer
  hoprig tokens revoke <id | name> [--yes]
                                         take that right away (asks first; --yes: without asking)
```

## hoprig machines

`hoprig machines --help` prints:

```text
usage:
  hoprig machines [--json]            the other computers this dashboard shows
  hoprig machines add <user@host>     add one by SSH (key login; nothing to open in a firewall)
          [--name NAME] [--label TEXT]
  hoprig machines add <https://...> --code CODE [--name NAME]
                                         add one by its address and the code "hoprig pair" shows there
  hoprig machines test <name>         check that it answers
  hoprig machines rename <name> <new-name>
  hoprig machines rm <name> [--yes]   remove it (by SSH its token there is revoked too; asks first)
  hoprig machines invite              on the main computer: a one-time code for a computer that connects by itself,
                                         and the whole line to type there
  hoprig machines fingerprint [FILE|-]
                                         on the main computer: the fingerprint of its own certificate authority
                                         (from a certificate file, or - for one on stdin)
  hoprig machines join …              the same as hoprig join …
  hoprig machines leave <ADDRESS>     the same as hoprig join --leave <ADDRESS>
  hoprig machines accept              the main computer's side of hoprig join over SSH: the joining computer runs it
                                         there (it reads one request on its input); not typed by hand
```

## hoprig join

`hoprig join --help` prints:

```text
usage:
  hoprig join <https://ADDRESS#join=CODE>
  hoprig join <https://ADDRESS> <CODE>   for a computer the main computer cannot reach (a computer at home behind
                                         a router): it connects OUT to the main computer's dashboard and stays
                                         connected, also after a restart. The line comes from the main computer
                                         ("hoprig machines invite" there, or Computers → Add a computer → "It is
                                         at home or behind a router").
          [--fingerprint sha256:…]       for a main computer with its own HTTPS certificate (no public authority
                                         signed it, as with an IP address and --tls-internal): the main computer
                                         shows the whole line with it. Checked on every connection; never turns
                                         checking off.
          [--insecure]                   plain http:// to another computer, NOT encrypted: only on a network
                                         you trust. Not a fix for a certificate problem (use --fingerprint)
  hoprig join <user@host>             the same over SSH instead (needs an SSH login to the main computer)
  hoprig join                         the dashboards this computer has joined
  hoprig join --leave <ADDRESS>       stop: that main computer forgets this computer (its address, or
                                         user@host for one joined over SSH)
```

## hoprig serve

`hoprig serve --help` prints:

```text
usage:
  hoprig serve [--host H] [--port P] [--password-file F] [--take-over]
                                       start the dashboard (default 127.0.0.1:7433; HOST and PORT in the
                                       environment also work; with no password set yet, F gets a new one;
                                       --take-over ends this Hoprig's dashboard on that port first)
```

## hoprig passwd

`hoprig passwd --help` prints:

```text
usage:
  hoprig passwd                          set the dashboard password (asked twice, not shown)
  hoprig passwd --generate <file>        write a random password to <file> (mode 600) and use it
```

## hoprig service

`hoprig service --help` prints:

```text
usage:
  hoprig service install|uninstall|status|restart
                                       run the dashboard in the background from login
                                       (systemd on Linux, launchd on macOS, Task Scheduler on Windows)
```

## hoprig mcp

`hoprig mcp --help` prints:

```text
usage: hoprig mcp     (an MCP server on stdio; started by an MCP client, not by hand)
```

## hoprig field

`hoprig field --help` prints:

```text
usage:
  hoprig field [--json]                      this computer's field reports, newest first
  hoprig field show <id> [--json]            one report whole (exactly what would be sent)
  hoprig field inbox <folder> [--json]       reports that arrived as files, joined and counted
  hoprig field way-round --failed "<what failed>" --worked "<what worked>"
                                             for a coding session: what needed a way round, as a skill draft
                                             the owner installs or discards in Skills → Learned
Field reports: docs/FIELD-REPORTS.md
```

## hoprig move-to-user

`hoprig move-to-user --help` prints:

```text
usage:
  hoprig move-to-user [--user NAME [--new]] [--no-admin] [--dry-run] [--yes] [--json]
      move Hoprig from root to an ordinary user (hoprig, made first when Hoprig made none here; --no-admin gives
      it no administrator rights): it lists what runs and what would be copied, asks first, copies, checks the
      copy and switches. Root's copy is kept. --dry-run only shows it. --new (with --user): only a user that is
      not there yet, or one Hoprig made (the main computer passes it when its look said the move makes the user).
  hoprig move-to-user --back [--user NAME]
      the step back: the user's dashboard stopped, root's started again.
```

## hoprig box

`hoprig box --help` prints:

```text
usage:
  hoprig box check [--json]       whether this computer has a box: a command run with no network, without your
                                    home, seeing only the folders it is given (exit 0: yes, 3: no)
  hoprig box run [--write DIR]... [--read DIR]... -- <command...>
                                  run a command in the box: --write folders it may change, --read folders it may
                                    only read; the current folder must be inside one of them. Its output is printed
                                    when it ends (at most 1 MB); after 30 minutes it is stopped (exit 124)
```

## hoprig demo

`hoprig demo --help` prints:

```text
usage: hoprig demo [--port N] [--no-open]
  Starts the dashboard with sample data on 127.0.0.1 (no Claude Code, no provider, nothing real)
  and opens it in the browser. Ctrl+C stops it and removes everything.
```
