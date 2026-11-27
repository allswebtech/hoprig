# Field reports

When Hoprig finishes a piece of its own work on a computer, it writes a small report about it on that computer. The
reports let that computer's Hoprig notice a trouble that keeps coming back, and, only if you choose, let Hoprig's
developers see which troubles happen where.

This page takes about two minutes. Check it against a real report: `hoprig field` lists them, `hoprig field show <id>`
prints one exactly as it is kept (and as it would be sent).

## One report, whole

This one was made by `hoprig get` of a repository whose server asked for a sign-in that this computer did not have:

```json
{
  "format": 1,
  "id": "652d52c9e29a2a95",
  "time": "2026-11-19T09:14:48Z",
  "kind": "get",
  "outcome": "failed",
  "class": "git-auth",
  "version": "0.3.3",
  "system": {"os":"linux","arch":"x64","node":26},
  "seconds": 3,
  "steps": [
    {"id":"clone","end":"failed","stepIns":0}
  ],
  "stepsLeftOut": 0
}
```

| Field | What it holds |
|---|---|
| `format` | always 1: the version of this shape |
| `id` | 16 random hex characters, made for this report (not from anything of yours) |
| `time` | when the work ended, to the second, in UTC |
| `kind` | what was asked, one of: `setup`, `server-setup` (a set-up on a server), `pc-setup`, `kit`, `get`, `adopt`, `drop`, `go-live` (an update of Hoprig, and the restart of its background service after one), `start`, `doctor` |
| `outcome` | `ok` or `failed` |
| `class` | the kind of error, one of a fixed list: `none`, `network`, `timeout`, `not-found`, `permission`, `disk-full`, `port-in-use`, `missing-program`, `program-failed`, `install-failed`, `build-tools`, `node-too-old`, `terminal-module`, `signin-needed`, `git-auth`, `git-conflict`, `git-not-clean`, `git-not-pushed`, `folder-in-the-way`, `config-broken`, `not-set-up`, `service-failed`, `usage-limit`, `stopped`, `refused`, `open-to-network`, `other` |
| `version` | Hoprig's version, three numbers (`other` if it is not that) |
| `system` | the operating system (`linux`, `darwin`, `win32`, `other`), the processor kind (`x64`, `arm64`, `other`) and Node.js's major number |
| `seconds` | how long the work took |
| `steps` | at most 12 steps, each by Hoprig's own step name (`clone`, `push`, `pty`, `node`, …, or `other`), how it ended (`ok`, `failed`, `skipped`, `by-hand`) and how many times a person or a session had to step in |
| `stepsLeftOut` | how many more steps there were (the ones that ended well are left out first) |

## What is never in one

No path, no name of a computer, a person or an account, no address, no project or repository name, no file's content,
no line a program printed, no message of an error. This holds by construction: every value comes from the fixed lists
above, or is a number or a time. Anything else Hoprig was given is turned into `other` or left out before the file is
written, and the error's class comes from its code (`ENOTFOUND`, `EACCES`, …) and Hoprig's own failure points, never
from its text. A report is under 1 KB. A file in the folder that is not exactly this shape (edited by hand, too big) is
not read, shown, joined or sent.

## Where they are kept

In Hoprig's state folder, `field/reports/` (on Linux `~/.local/state/hoprig/field/reports/`), one file per report, the
newest 50. They are made at the end of `hoprig setup`, `pc setup` (and `--kits`), `get`, `drop`, `adopt apply` and
`adopt retire` (and the same arranging from the dashboard), `update`, `service install` when it replaced an older
version that was running, and a `doctor` run that found a problem (✗). A `--dry-run`, a `drop --check` and a doctor
run that is all ticks make none.
Making a report never changes what a command does or prints.

## What this computer learns

When the same class comes up twice for the same kind of work on this computer, Home shows it once: "This went wrong
twice: …", with what Hoprig knows to do about it (a command, a setting or a page of these docs). **Dismiss** hides it
until it comes up again. **Make a skill draft of this** makes a draft in Skills → Learned from Hoprig's own words for
that trouble. Nothing is changed and nothing is installed without your press.

## A session's way round

The bundled `hoprig` skill asks a coding session that got past a failed Hoprig command another way to write two
plain lines: `hoprig field way-round --failed "<what failed>" --worked "<what worked>"`. A command that works right after
the same kind of work failed (within the hour) also prints one line at its end that names this command; it says nothing
when nothing failed before. They become a draft of the skill
`ways-round` in Skills → Learned. They are checked by patterns: an absolute path (`/x/y`, `\x\y`, `C:\`, `D:/`, `~/`,
`file:///x`, also with look-alike slashes such as `∕` and with letters of any script such as `/données/x`; two
backslash escapes such as `\r\n` are text, not a path), a key,
an e-mail address, `user@host` (also with a full-width `＠`), this computer's name and look-alike letters are refused.
Patterns cannot know the name of a project, a repository or a person written in plain words: the draft is shown in
full before you press Install, so such a name is yours to catch (Discard, or Undo after Install). These lines are your
own text on your computer: they are never part of a report and never sent. At most three wait at once.

## Sending to Hoprig's developers: only if you choose

**Settings → Version and updates → Reports to Hoprig's developers** is empty after an install, and while it is empty nothing is ever
sent and nothing is asked. When you set an https address (one Hoprig's developers give you), you are asked once:

- **Never** (also what happens until you answer);
- **Ask each time**: each new report waits on Home, shown whole, with **Send** and **Don't send**;
- **Always**: each new report is sent as soon as it is made.

What is sent is the report's file, byte for byte what you can read with `hoprig field show`. Only reports made after
your choice. Changing the address asks you again. The dashboard sends it itself: https only, to the address it checked
(no redirect is followed, no proxy setting is used, an address on your own network only when you mark it so), ten
seconds at most. Each send and each failure is one line in Activity, with its status only. A send that failed is tried
again with the next send, three tries at most, never on a timer. If the record of what was sent cannot be read (a
hand edit, a disk error), it is put aside as `state.json.broken`, said once in Activity, and the reports made before
then are never sent again; while it cannot even be put aside, nothing is sent.

**Also write each report into this folder** (off by default) writes each report also into a folder of yours, for
instance in a private notes repository that gathers the reports of all your computers. Only the report files are
written there.

## For the developers: the inbox

Reports that arrive as files in a folder (how they arrive is up to you) are read with
`hoprig field inbox <folder>` (or `--json`). Reports with the same signature (version major.minor, operating system,
kind of work, class) are joined and listed by how often each came up, with the Node.js versions and processor kinds they
came from, the steps that failed and where someone stepped in. For the classes Node.js itself causes (`node-too-old`,
`terminal-module`, `build-tools`) its major number is part of the signature. Only
the folder itself is read, links are not followed, and a file over 4 KB or not exactly a report is counted as
"not read" and never printed.
