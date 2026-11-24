# AGENTS.md — rules for anyone (person or AI tool) working on Hoprig

`CLAUDE.md` and other tool files point here. Change the rules in this file only.

## What this is

Hoprig turns a computer into a managed place to code with Claude Code and OpenCode: it installs what is missing,
runs each coding tool under several providers (a session continues on another provider after a usage limit), and
serves a web dashboard (chats, terminals, a code editor, a desktop) that also shows other computers. Node.js ≥ 22.11 (`src/nodefloor.mjs`), ES modules,
no framework, no build step. Runtime dependencies are few and pinned.

## Map

| Where | What |
|---|---|
| `bin/hoprig.mjs` | the command: dispatch only |
| `bin/hoprig-hook.mjs` | what Claude Code starts for a hook event: small on purpose, Claude Code waits for it. A status event loads only `src/hookrecord.mjs` (the run record); `src/hook.mjs` (the wall, the answers) only for PreToolUse and PermissionRequest |
| `src/*.mjs` | the launcher: providers (`profiles`), sessions, run records (`runs`), launch (`launch`), the hook that keeps a session's status (`hook`), Auto mode (`autoswitch`, `router`), menus |
| `src/server/` | the dashboard: HTTP and WebSocket server, login, terminal backends (`backends/`: tmux and built-in), per-OS information (`platform/`), background service (`service/`) |
| `src/machines/` | several computers: hub, pairing, tokens, relay, `join` |
| `src/chat/` | the coding chat: one engine per coding tool (`engines/`), its events, OKs, queue, hand-off to a terminal |
| `src/codetools/` | the coding tools (Claude Code, OpenCode; Codex kept switched off): install, start, servers, providers |
| `src/editor/`, `src/desktop/` | the code editor's routes (files, search, git) and the desktop's apps (files, processes, services, logs) |
| `src/assistant/` | Tia: tools, policy, confirm cards, jobs, MCP server, eval |
| `src/automation/` | queue, schedules, restore, retry, updates (no AI) |
| `src/setup/`, `src/pcsetup/`, `src/skillhub/`, `src/addons/` | first setup and doctor, computer and project setup, skills, add-ons |
| `web/` | the page: plain modules, no bundler (`web/chat/`, `web/editor/`, `web/desktop/` for those parts) |
| `test/` | `node:test`; one folder per area |

A feature of the server is one module registered in the `features` list in `src/server/server.mjs`; a part
of the page is one file registered through `web/registry.js`.

## Rules

- **Prove it.** `npm test` passes before a change is done. The end-to-end tests run on tmux where it is
  installed and on the built-in terminals everywhere. Say what you ran and what you could not run; never
  write "works on Windows" for code that was not run on Windows. Before a release the whole suite passes on Node 22.11
  (the lowest supported, `src/nodefloor.mjs`) and on the newest LTS.
- **The suite cannot touch the computer it runs on.** Run tests through the runner: the whole suite with `npm test`,
  one file with `node tools/test.mjs test/x.test.mjs` (or `npm test -- test/x.test.mjs`). Plain `node --test` runs
  WITHOUT any of what follows. The tests need Node.js 22.11 or newer: below it the runner says so in one line and starts none. You do not have to remember the rest: it holds by construction.
  - **What holds it.** `tools/test.mjs` runs each test file in a home of its own and puts a trap folder first on its
    PATH: traps for `sudo`, `systemctl`, `loginctl`, the package managers, a global `npm`, `ssh`, `gh`, `docker`,
    `tailscale`, `cloudflared` and more (`TRAPPED` in `tools/seal-core.cjs`), and stand-ins for `df`, `ps` and `ss`
    (`tools/seal-standins.cjs`): `df` answers one made-up disk with room, `ps` and `ss` only the test file's own
    processes and listeners. The wrap (`tools/test-seal.cjs`, preloaded into every test file's process and, through
    `NODE_OPTIONS=--require`, into every Node child) seals any environment a test hands a child (no PATH, an empty
    PATH, `env -i`, `env -u PATH`, a fork, a Node child of a Node child), sends a full path to a trapped name to its
    trap, refuses any other program of the computer started by a full path (allowed: node, a shell, `env`, `git`,
    `bwrap`), refuses a connection to a default port of the product (the dashboard's, the router's, a shipped
    gateway's, Caddy's admin API), and on Linux shows only the test's own processes in a listing of `/proc`. The
    preload leaves how a Node child's main file is loaded alone, so a program laid out like the coding tool's own
    install (`…/versions/2.1.328`) starts as it would on a person's computer.
  - **npm.** The npm trap passes on only a call that stays on the computer (`npm --version`, an install into a
    temporary folder). Such a call gets a cache and a log folder under the test's own home, whatever `npm test` set
    (`npm test` sets `npm_config_cache` to the person's `~/.npm`), and a registry and proxy that are a refusing
    stand-in of the trap's own on 127.0.0.1, so nothing it asks leaves the computer. A registry the test runs itself
    on 127.0.0.1 (`npm_config_registry`) is left as it is. The runner also watches the person's `~/.npm/_logs`: a log
    made during the run that names the run fails it.
  - **What a line of the seal means, and what to do.** The run fails with one line per reach, naming the test file:
    - `A TEST REACHED THE REAL <program>`: the trap stopped it, the real program did not run. Give the test a
      stand-in of its own, first on PATH, in its temporary folder (`os.tmpdir()`, also by its real path) or under
      `test/`; or build the PATH with `sealed()` / `sealedPath()` from `test/seal.mjs`. To play a computer WITHOUT
      the program, give the product facts that say so, or a PATH of the test's own empty folder: the trap on the
      runner's PATH is a program of that name, and the product would take it for an installed one.
    - `A TEST STARTED A COMPUTER PROGRAM BY ITS FULL PATH`: refused as a missing file. Give the test facts that say
      the program is not there (the facts `sysFacts` is given, or `--offline`) or a stand-in in its own area.
    - `A TEST KNOCKED ON THE DEFAULT PORT <port>`: refused as a closed port. Give the test's settings ports of its own
      (`server.port`, `router.port`, `addons.<id>.port`, `closedGateways()` from `test/seal.mjs`), also when the
      test listens on a port of its own: a part of the product that reads the address from the settings knocks on
      the default when they name none.
    - `A TEST ASKED A PUBLIC REGISTRY: <file>`: an npm call of the test needed the network (`npm view`, an install
      from the registry); the trap's stand-in refused it, nothing left the computer. Hand the product the answer it
      would get (a run of its own, such as `toolRun`), or give the test a registry of its own on 127.0.0.1.
    - `NPM WROTE INTO THE REAL HOME: <file>`: an npm got past the trap (started by a full path, or with an
      environment of its own that names the person's cache) and wrote into `~/.npm/_logs`. Start npm by its name and
      keep the environment the test was given.
    - A READ of a file by a full path (`/etc/os-release`, `/proc/<pid>/…`) is not a start and is not refused.
  - **A test that needs the real one.** A test that proves something only the real `df`, `ps`, `ss`, the whole
    `/proc`, or a program of the computer started by its full path holds (a browser's cookies, `ssh-keygen`'s print
    of a key file the test wrote) sets `HOPRIG_SEAL_REAL` (for example `'ps'` or `'ssh-keygen'`; names are split at
    commas), for as short a time as it can, on a line that says why (`// seal: <why>`) and is listed
    in `REAL_PROGRAMS` in `test/seal-rule.mjs`; `test/seal.test.mjs` holds the list exact. A PATH a test writes goes
    through `test/seal.mjs` or says why on its line, the same way (`unsealedPaths`).
  - **A proof of the seal** that runs WITHOUT a piece of it names a made-up program (`seal-made-up`, trapped through
    `HOPRIG_SEAL_EXTRA_TRAPS`) and a made-up port (`HOPRIG_SEAL_EXTRA_PORTS`), never a real one: a missing seal then
    ends with "no such file", not with the real program run.
  - The environment is built from a list of names let in (`LET_IN` in `tools/test.mjs`: PATH, the temporary folder,
    the language, the terminal and user, what Windows, Node, npm and CI need, the suite's own opt-in switches);
    anything that looks like a secret is dropped even inside it. A test that needs another inherited variable sets it
    itself, by name. The runner adds `HOME`, the settings and state folders, `TMUX_TMPDIR` (the run's own tmux
    folder), `HOPRIG_TEST_TRAPS`, `HOPRIG_TEST_FILE` and `HOPRIG_NODE_NPM`; the wrap adds those, `HOPRIG_TEST_PID`, `HOPRIG_TEST_MARK` and
    `NODE_OPTIONS` to every child's environment, also one a test builds from nothing. A test that checks an
    environment it built compares only the names it set itself.
  - **Not covered**, each said with what would hold it at the head of `tools/test-seal.mjs`: a program started from
    inside a shell string is found by PATH only, and an `env -i`, `env -u PATH` or `PATH=…` inside such a string
    throws the sealed PATH away (a grep rule over `test/` names that form: `clearedEnvs`, `unsealedPaths`); a
    command built in a variable and handed to a shell; a trapped program reached by a bare name through a link a test
    keeps first on its own PATH; a connection to a default port from a program that is not Node; a program other than
    npm that reaches the network (a git clone of a public address, `curl`), which nothing refuses yet; the coding tool installed on the inherited PATH,
    which a test that asks the product for the installed version finds and reads (hand the version the test plays,
    `{ version: TOOL_VERSION }`, or a stand-in of its own first on PATH); the async listings
    of `/proc` and `lsof`; a macOS login shell, which puts the system's folders first; macOS and Windows runs were not
    proven.
- **Small, plain code.** Small modules, comments that say why, no dead code, no new dependency without a
  strong reason. Plain words in everything a user reads; the same word for the same thing ("provider",
  "computer", "session"; the product is "Hoprig", the command `hoprig`).
- **Nothing private in the repo.** No machine paths, names, tokens or keys. Everything is found from the
  file's own place or from an environment variable.
- **Secrets stay where they are.** Provider files, tokens and passwords are never returned by a route,
  printed, logged or sent to a browser. Tests assert it.
- **The trust rules are code, not hope.** Input from a browser, a terminal, a file name, another computer or
  a downloaded skill is validated and treated as data. Every argument to another program is an array, never
  a shell string built from input. The router never attaches a subscription's token to a request: only
  Claude Code itself uses a subscription sign-in. Every read of a folder's git state that the dashboard makes itself
  goes through `src/gitread.mjs`, so a repository's own settings never start a program for it. (A git command a
  coding tool runs, also one Tia allows for it, is the coding tool's own and runs as git runs it.)
- **Fewer steps.** What is not needed goes. A setting has one plain sentence under it. Defaults are safe:
  anything that costs money, runs commands or opens the dashboard to a network is off until chosen.
- **The version moves with every release.** `version` in `package.json` rises with every push of main that changes
  what a user gets: an install reads the newest version from that file on main, so an unchanged number hides the
  update.
- **Tia's tools** follow the checklist in `src/assistant/tools.mjs` (level, strict schema, server-side
  re-validation, confirm cards, audit) and the real-model eval must not drop below its baseline.

## How to work here

- Model and effort per task: the fast model for running and recording, the strong model for writing and
  reviewing code, the strongest for an unknown cause, a design decision and the last check. Effort low for
  mechanical work, high only where thinking decides the result.
- The narrow case first, then the rest side by side. Estimate before anything long.
- Commit messages say what changed and why in plain words.
