# Work: tasks and Today

Work is the dashboard's list of what your workspace has to do, one screen for what needs you now, and a way to have
a coding session do a task ("Do it") and look at what it did. Plans made with AI and repeating work come later.

## The page

**Work** is in the sidebar right under Home, and in the phone's bar.

- **Today**: **Needs you** (tasks overdue or due this week, tasks waiting for you, and the sessions on any of your
  computers that need an OK or reached a usage limit), **To review** (what a session has done: its answer, with
  Accept and Send back), **This week** (today and the six days after, day by day) and **Done lately** (the last seven
  days). "This week" is one rule everywhere: today and
  the six days after, for Needs you, This week, the Tasks part's "Next seven days" and the command.
- **Tasks**: every task, in groups: waiting for you, ready for your review, a session works on it, overdue, today,
  the next seven days, later, no date; done and dropped folded away. Filter by project and by who does it (you or
  the AI). **Add task** opens a sheet: the task, the day it is due (or none), a project of your workspace, the
  priority, who does it and a note. The round button marks a task done (and open again); **⋯** has Change,
  Waiting for you, Drop and Remove. Every action names the task by its place in the list and its id together, so
  of two tasks with one id the one you pressed is changed.
- **Activity**: the runs of every task (see "Do it" below), newest first and grouped by day; filter them by project and by day.
- **Save**: when the list has changes that are not committed, a bar says so ("2 changes not saved in git yet").
  Save shows first what it will do (the file, and per task: added, done, dropped, changed, removed, new id), then
  does it. A save reaches the server or leaves your change in the file: there are no saves "not sent yet".
- **Lines that ask for one thing**, shown over both parts when they apply:
  - *This file has things a change would alter* (a hand edit, see "The file as it is written" below), with **Tidy
    the file once**;
  - *2 tasks share their ids with another* (two computers added the same title), with **Give the doubles new ids**:
    a change like any other, shown in the Save plan;
  - *This list is a planning tool's file*, with **your id in this file** (see below);
  - *A save of the Work list was interrupted …*: one sentence when it was finished, or, when the repository is not
    where that save left it, where its list is kept, with **Drop the record** once you have looked (see Save).

## Do it: a session does a task

**Do it** (the ▷ button on a task, or **⋯ → Do it with a session**) opens a sheet that shows what will start, and
lets you change it first:

- the **brief**: the first time the task's title and note; a brief you change is kept on the task (`work.brief`);
- the **project** and the **folder** in it: the project's own folder or one of its code repositories (`code/<name>`).
  The task's project is the default; a task without a project asks for one;
- the **provider** (the folder's own, as New session picks it), the **model** and the **effort** (Settings →
  New-session defaults), and the coding tool when more than one is on;
- one line: "A session starts in <folder> with this brief. It changes files there as you allow in that session;
  nothing is pushed or merged by this."

**Start** opens an App session (the same kind a schedule starts) whose first message is the brief and one sentence
asking for a short report at the end: what was done, what was checked, what is left. The task is **doing** while it
works; its row offers **Open the session**, not a second start (two presses of Start make one run). Start goes with
the brief the sheet showed: when the task changed since (a merge, a save), nothing starts and the sheet shows it anew.
A brief, also one made from a task that came from another computer, is at most 4,000 characters and holds no
character that cannot be seen (a zero-width one, an invisible tag, a direction mark, words hidden in variation
selectors, a blank filler); when it does, the sheet offers **Take them out**, and the brief without them is kept on
the task when it starts. A session that works on the task on another computer is said in the sheet and does not stop
a start here; its run is shown, with no session to open on this computer.

When the session's turn ends well, the task goes to **review**, with the session's last answer, the commits made in
the folder's repositories since the start and the files it left changed and not committed (a file that was changed
before it started and holds the same is not counted). **Accept** makes the task done; **Send back** opens it again,
and what you write is added to its brief for the next run (the task's own text and the newest of what you sent
back, the oldest left out when they no longer fit together). A task in review is not started again before Accept or
Send back. A turn that ends in an error, at a usage limit with no other provider going on with it, or because you
stopped it puts the task back to **open** (or **waiting**, when it was waiting for you), with the reason. A
dashboard restart while a session works leaves the run working; when the dashboard is back it is settled from the
session's own record of how its turn ended, or marked stopped when the session is gone for good. In a planning
tool's file doing and review are written as `status: "open"` with Work's `state`, as for the other statuses.

**A run** is the record of one such session for one task: a file of its own beside the list, `runs/<run id>.json` (the
id holds the date and time and random characters, so two computers never write one file), written only by the
dashboard that ran it. It holds the task's id and title, when it started and ended, who started it, the project and
folder (never a full path), the coding tool, the provider's name, the model, the effort, the session's id, its state
(`running`, `done`, `failed`, `limit`, `stopped`) and reason, the answer (at most 4,000 characters, anything that
looks like a secret masked and the computer's own paths taken out), the commits (repository, short id, subject) and
the files left changed (repository, path, kind; at most 200, the rest and any name a run does not hold counted).
Commit subjects are cleaned like the answer, and the computer's name is taken out too. A run file is at most 64 KiB.
What the session started from (each repository's commit, the files changed before it) stays in this dashboard's
state folder, never in the run. Save commits a file in `runs/` only when it is a run of its own name (a plain file,
not a link); anything else there is named and left alone. Runs are not kept on the task, so a task changed on two computers
is still one change. The run file and the task's status are written under Work's one lock; when the status cannot be
written (the file needs a tidy, two tasks share the id), the run is written all the same and says why.

## Where the data lives

One file in a git repository of your workspace, chosen in **Settings → Work** ("Work data lives in"):

- **The AI brain** (the default): `ai_brain/work/tasks.json`. The brain is on every computer of yours, so every
  computer sees the same list after a sync.
- **A project**: a folder inside one project of the workspace, for example `docs/plans`.

The folder must be inside the brain or the project: a plain relative path, no `..`, no dot-folder, no private
folder, and no link that leads out (checked on the server each time, not only when you choose it). When the folder
already has a planning list named `deadlines.json` and no `tasks.json`, that file is used as it is.

The file is JSON: `{ "items": [ … ] }`. Each item:

| Key | What |
|---|---|
| `id` | made from the title (`renew-the-domain`), unique (two computers that add the same title can make doubles: see above) |
| `title` | one line, 3 to 200 characters |
| `date` | `YYYY-MM-DD` or `null` (no date); `approx: true` for "about then" |
| `kind` | `task`, `deadline`, `gate` or `opportunity` |
| `status` | `open`, `doing` (a session works on it), `review` (the AI is done, you look), `waiting` (it needs you: an account, a purchase, a yes), `done`, `dropped` |
| `state` | only in a planning tool's file: the status that tool does not know, beside `status: "open"` |
| `priority` | `high` or `low` (none: normal) |
| `note` | up to 2000 characters |
| `by` | who does it: `me`, `ai` or a role name |
| `project` | a project of the workspace |
| `source` | where it came from: your id for a task you added, else the plan note it was made from |
| `created`, `doneAt` | days; `doneAt` only while it is done |
| `plan`, `after`, `repeat`, `work`, `runs` | kept and shown; filled by later parts of Work (plans, "Do it", repeating work) |

A task you added can be removed. A task that came from a plan note is dropped instead, so the plan still shows
what was decided.

**A planning tool's list** in the same shape (items with `owner` and `brands`, the owner's own id for "you") is
opened as it is: `owner` is read as who does it. When the file does not use your id yet, the page says once that it
is a planning tool's file and asks for **your id in this file**, filled with the id the file uses most (also
**Settings → Work** and `hoprig tasks owner <id>`); until you say it, Work writes nothing that would put its own word
for "you" into that file (adding a task, "who does it: me"). That tool knows the statuses open, done and dropped and
counts only "open" as open work: in its file a task set to waiting, review or doing is written as `status: "open"`
with the real one in Work's own key `state`, which Work reads back as the status, so both tools show it as open.

### The file as it is written

A change writes only what changed, in the file's own style: its indent (or all on one line), its line ends, its
final newline and a byte-order mark. It never moves or drops a key Work does not know, and a file opened and saved
unchanged stays byte for byte the same.

Before any write Work checks that writing the file back **unchanged** in that style would give the same bytes. Some
hand-edited files would not: a number JSON cannot hold exactly (`12345678901234567890`) or writes another way
(`1.0`, `1e3`), a string written with escapes (`\u00e9`, `\/`), a key written twice (only its last value is read),
mixed line ends, a list written on one line in a file that is otherwise spread over lines, bytes that are not UTF-8
(a Latin-1 "é": the file is read strictly, and a write would put "�" in its place). Work then changes nothing
by itself: the page and the command list what a write would alter (which keys, which numbers, the line ends, the
layout, the bytes and their line), and offer one action, **Tidy the file once** (`hoprig tasks tidy [--dry-run]`),
which shows that exact difference line by line and writes it only on your yes. The sheet shows up to 400 lines of
it, each cut at 300 characters, and says so; `hoprig tasks tidy --dry-run` shows all of it. After that, changes work
again. A file nested more than 100 levels deep, or with a number longer than 400 characters, is not read at all:
Work says which and where, and writes nothing.

Every value is checked when it is written: a title is one line of 3 to 200 characters, and neither a title nor a
note may hold control characters or the marks that turn the direction of text around (a line break in a note is
fine). A file that is not valid JSON is reported by line and column and never overwritten. One change is written
at a time (a lock in Hoprig's state folder, never next to your file), through a temporary file and a rename. The
lock names its process (its pid and when it started), so a writer that still runs keeps it however long it takes; a
lock whose process has ended is taken at once, and one whose process cannot be told is taken after 60 seconds
without the refresh its holder makes every 5 seconds. "Today" is counted on this computer's clock, or in the time
zone named in Settings → Work.

## Save

Save commits the Work file and the new or changed run files (`runs/`), by name, in the repository that holds them,
and sends it to the branch's server branch.
It is one unit that **either reaches the server or leaves your change in the file** as a change not committed yet:

1. **Look.** It asks the server for news (a fetch). Everything it decides is read after that: what this computer
   has that the server lacks, whether the server only moved forward, the last version both had. A server branch
   that was rewritten (another computer forced it, and commits it had are gone) changes nothing: the message says
   so.
2. **Merge by task**, when the server changed the Work file too. The two lists are brought together **task by
   task**, not line by line: a change on one side wins over no change, tasks added on either side are kept (two
   different new tasks with one id: yours gets a new id), a task removed on one side and untouched on the other is
   removed, and the file's other keys follow the same rule. A task changed differently on both computers is yours
   to decide: before anything changes, your list is also kept **in the repository** (see below), then the Save
   sheet's result is written. The Save sheet shows "3 changes of yours, 2 from another computer, 1 to decide" and both versions,
   and **Merge and send** waits until you chose one for each. Tasks that share an id (in any of the three
   versions) are never paired by their place: all of them count as one group, taken as one side left it when the
   other did not change it, else one choice for the whole group. When only this computer changed the list, the
   result is your list as it stands, its order included.
3. **Fast-forward.** The server's new commits come in by fast-forward, never by a merge commit or a rebase. When
   they change a file that is changed or staged here, or that is here as a file git does not keep (also an
   ignored one), nothing is touched and the message names the files.
4. **Write and commit.** The merged list is written and committed; the commit names only the Work file, so other
   changed or staged files stay as they are. Your hooks run; when one changes the file while committing, the
   message says so.
5. **Send.** The save's own commit, named by its id, goes to the one server branch
   (`git push --quiet --no-follow-tags --recurse-submodules=no <remote> <id>:<server branch>`), never with your
   tags or another branch. Right before it, what lies between the server's commit and that id is checked once more:
   only the save's commit and earlier commits of the Work file alone. When the send fails (no connection, the
   server moved again, it refused), the commit just made is **taken back**: the branch goes back to where it was
   before it, the file keeps its content, nothing else is touched, and the answer says "Not saved to git: <why>.
   Your changes are kept in the file; Save again." A repository with no server branch: the save is the commit alone.
   A branch that git sends to **another place than the branch it follows** (`branch.<name>.pushRemote`,
   `remote.pushDefault`, a push refspec of the remote, or a `push.default` that names no place: `@{push}` is not
   `@{upstream}`): Work does not guess, the save is the commit alone, and the answer says "this branch is sent to
   another place than it follows, so Work did not send it".

**When you work in the same repository while a save runs** (a commit in a terminal, a switch of branch, an edit),
nothing of yours is lost, moved or sent. The plan records the commit it judged; when the branch is no longer on it
as the save begins, nothing is done and the answer says why ("your commit 1a2b3c4 "…" came in while the save ran",
or that another command brought the server's commits in). The save knows its own commit for certain (made on the
commit it stood on, of the Work file alone, with the save's subject); when a commit of yours lands on top of it,
nothing more is touched: "your commit … came in while the save ran; the save's commit … is under it, not sent",
and what sends it (Save again, or your own `git push` when your commit changes other files). A failed send takes
its commit back only while the repository is still on that branch, the branch exactly on the save's commit and the
file as committed; otherwise nothing is taken back and the answer names the save's commit, the branch it is on,
and that it is not on the server.

What is never sent by Save: a commit of yours that changes anything but Work's files (the list and the run files in
`runs/`; in the AI brain also the workspace map Hoprig keeps there); the commit subject plays no part. While one of those is not on the server,
Save commits nothing and names it by short id and subject: send it first. When your own commits are not on the
server and the server moved, nothing is touched, and the message gives the commands to run (`git stash push --
<file>`, `git pull --no-rebase`, `git stash pop`). An earlier commit of the Work file alone that an older version
or your own hand left unsent is sent along by the next Save; when the server moved meanwhile, nothing is touched
and the message gives one command (`git reset --soft <commit>`) that makes it a change in the file again, so the
next Save merges it task by task.

**A save that was interrupted is finished the next time.** Before its first change to the repository a save writes
a journal to Hoprig's state folder (`work-journal/`) and flushes it to disk: the repository, the branch and its
commit, the server's commit, the list it writes and your choices. Every look at the Work list (the page, a Save,
the command) checks for one first. When the repository is where one of the save's steps left it and nothing else
changed, the save is brought to a state you know, and one sentence says which: the list it was writing is in the
Work file as a change not committed yet (a commit that was made and not sent is taken back), or it had reached the
server and is done. In any other state nothing is touched: the page says where the list is kept and how the
repository stands, and Save waits until you **Drop the record** (`hoprig tasks save --drop-interrupted`). A save
killed before it changed anything changes nothing on recovery, also when you changed or discarded the file since.

**During a merge your list is kept in git too.** Between putting the file back to its last commit and writing the
merged list, your list is in no file. So before the file is put back, it is stored in the repository as a git
object under a ref of Hoprig's own, `refs/hoprig/work-save/<12 hex digits>` (git never prunes what a ref points at),
and deleted when the save is done or dropped. `git show refs/hoprig/work-save/<…>` prints it; every message of a
failure that leaves it names that command. When the journal is gone (the state folder was removed, or a dashboard
and a terminal use two state folders), the next look at the Work list finds the kept list, says so and shows how to
put it back (`git show <ref> > <file>`); it is never applied by itself, and Save waits until you drop it. A journal
that cannot be read, or one from another repository, also says where your list is kept.

One save runs at a time per repository: a lock in Hoprig's state folder, shared with the AI brain's own upkeep (its
map commit, its fetch and fast-forward, its push). While a save holds it, the upkeep skips its round and comes
again at the next tick; while the upkeep holds it, a save waits a few seconds, then says "The workspace is being
synced: Save again in a moment". The lock of the file is held only from the last look at it to the commit; when the
file or the server changed after the plan you saw, nothing is committed and the new plan is shown. git's own
messages (with the server's address or a full path) go to the dashboard's log, not to the page: an error on the
page is one plain sentence with a short code. The commit subject is a setting (default "Update work items").

## Commands

```sh
hoprig tasks [today]                       what needs you, this week, done lately
hoprig tasks list [--all] [--project P] [--by me|ai|<role>]
hoprig tasks add "<title>" [--date YYYY-MM-DD] [--project P] [--priority high|normal|low]
                  [--by me|ai|<role>] [--note "..."] [--kind task|deadline|gate|opportunity] [--approx]
hoprig tasks edit <id> [--title "..."] [--date D|none] [--project P|none] [--priority P|none]
                  [--by W] [--note "..."|none] [--kind K] [--status S]
hoprig tasks done | open | drop <id>
hoprig tasks remove <id>                   only one you added
hoprig tasks owner [<id>]                  your id in a planning tool's file: shown, or set
hoprig tasks fix-ids                       give tasks that share an id ids of their own
hoprig tasks tidy [--dry-run] [--yes]      a file a change would alter: the difference, then written once
hoprig tasks do <id> [--project P] [--folder F] [--brief "..."] [--dry-run] [--yes]
                                           a session does the task (through the dashboard): its brief first, then a yes
hoprig tasks runs [<id>]                   what the sessions did: answers, commits, changed files
hoprig tasks save [--seen <token> --decide "<task>=mine|theirs,..."]   commit, merge by task when needed, send
hoprig tasks save --drop-interrupted       drop the record of an interrupted save you have looked at
```

`tasks do` starts the run through the dashboard running on this computer (it reads a token the dashboard makes
in its state folder at each start, good for that one request); without a running dashboard it says so. `--dry-run`
checks everything and says what would start.

The command is `tasks`, not `work`, so that a provider named "work" keeps starting with `hoprig work`. A save that
stops at tasks to decide prints them and a token of what it showed (`--seen`): a choice is taken only with it, so
it never overrides a change the other computer made after you looked (then the new conflicts are shown).
Every command takes `--json`; the ones that change something take `--dry-run` (everything is checked, nothing is
written). A command refuses an option it does not understand (`add --status done`, `--title` beside a title), and
an id that two tasks share (it names both and points to `fix-ids`). With `--json` a refusal is one JSON object on
standard output, `{ "ok": false, "code": "...", "message": "..." }`, with the same exit code (2: not understood,
1: refused or failed). `tidy` writes only with `--yes` or a yes typed on the terminal. The sessions that need an OK
are shown on the dashboard's Today only.

## Not built yet

Plans and "Plan with AI", repeating tasks and the Automations page folded into Work, a session on a branch of its
own, Tia's Work tools, a token and webhooks for other programs.
