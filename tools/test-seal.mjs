// The seal, in the test file's own process. Its code is tools/test-seal.cjs, which the runner (tools/test.mjs) preloads
// into every test file (`--require`, beside tools/test-flush.mjs); this file keeps its exports for the seal's own test.
// It wraps the seven functions of node:child_process so that a child a test starts is sealed WHETHER OR NOT the test
// wrote any PATH itself:
//  - the environment the child gets always goes through sealed() (the traps first on its PATH, also when the call
//    gives no environment or no PATH at all; the runner's variables carried);
//  - a program named by a FULL PATH that reaches a trapped name (any case, with .exe/.cmd/.bat) outside the test's
//    own area is started from the trap folder instead, so it is refused exactly as a bare trapped name is (the npm
//    trap for npm, so a non-global npm still goes on). The path's whole chain of links is walked, not only its end:
//    a link NAMED as a trapped program (`<tmp>/sudo` -> the real sudo), and a link whose target has another name
//    (`mysnap` -> /usr/bin/snap -> …/snapd), are both caught. A stand-in a test keeps in its temporary folder or
//    under test/ (a real file, or a link that stays inside that area) is its own and runs;
//  - a program named by a FULL PATH into the computer's own folders, outside the test's area, that is NOT on a short
//    allow list (node, a shell, env, git, bwrap) is refused as a missing file (ENOENT) and one line names the test: the
//    computer's own programs started by a full path (/usr/lib/update-notifier/apt-check, /usr/sbin/mariadbd,
//    /usr/libexec/java_home) are as real as a name found on PATH, and no PATH trap can see them. The product then
//    behaves as on a computer without that program; a test gives it facts that say so, or a stand-in in its own
//    area. A test that proves what only that real program shows (a browser's cookies, ssh-keygen's print of a key
//    file the test wrote) names it in HOPRIG_SEAL_REAL on a line `// seal: <why>`, for that start only, and
//    test/seal-rule.mjs lists it (REAL_PROGRAMS); a trapped name is never let through that way. A READ of a file by a full path (fs.readFileSync of /etc/os-release, /var/run/reboot-required) is not a
//    start and is not refused;
//  - every child is given NODE_OPTIONS that preloads the wrap (`--require`), so a Node child (and a Node child of a
//    Node child that builds its own environment) is sealed too. A preload leaves how the child's main file is loaded
//    alone: a Node program whose main file has an ending the ES-module loader does not know (`…/versions/2.1.328`,
//    the coding tool's own install) starts as it would on a person's computer. (Carried as `--import`, it did not
//    start at all: --import sends the main file through that loader, which refuses the ending.);
//  - a TCP connection to a default port of the product (the dashboard's, the router's, a shipped gateway's), on any
//    host, is refused before anything is sent and fails the run by name (tools/seal-net.cjs). That holds by
//    construction for every Node client (net, http, https, fetch) in the test process and its Node children;
//  - df, ps and ss are stand-ins in the trap folder (tools/seal-standins.cjs), so they come first wherever the traps
//    do: df answers one made-up disk with room, ps and ss answer only the test file's own process tree (rooted at
//    the test file's process, HOPRIG_TEST_PID, which every child is told; a process that carries the test file's mark,
//    HOPRIG_TEST_MARK (that pid and a random part, so a server an earlier test file of the same pid left running is
//    not taken for its own), such as a tmux server the test started, is in it too). On Linux a listing of /proc (fs.readdirSync) shows the same tree
//    only. So no test reads this computer's disks, its process table or its ports, and the Operator's look in a test
//    never finds, nor asks, another run's tmux server. tmux itself stays the real one, on a socket of the test's own
//    in the run's own folder (TMUX_TMPDIR, carried too). A test that needs the real df, ps, ss or the whole /proc
//    sets HOPRIG_SEAL_REAL with a line `// seal: <why>`, and test/seal-rule.mjs lists it (REAL_PROGRAMS).
// So the seal holds BY CONSTRUCTION: a test cannot forget it. The grep rules (test/seal-rule.mjs) stay as the second
// line: unsealedPaths for a PATH a test writes, clearedEnvs for `env -i`.
//
// NOT COVERED by the wrap, each with what holds it or what would prove it:
//  - A program started from inside a SHELL STRING (exec, execSync, shell: true, `sh -c '…'`) is found by PATH only.
//    The sealed environment keeps the traps first on PATH, so `exec('sudo -n true')` is still caught. But a PATH set
//    inside the string (`sh -c 'PATH=/usr/bin:/bin sudo …'`) throws the sealed PATH away; the wrap cannot rewrite a
//    shell string, so only the rule holds it (unsealedPaths names a PATH= on a line that starts a child).
//  - A trapped program reached by a BARE NAME through a link a test keeps first on its own PATH (`<tmp>/own/sudo` ->
//    the real sudo, with `<tmp>/own` before the traps) runs the real program: the shell/execvp follows the link, and
//    the wrap sees only the bare name, not which file on PATH it resolves to. A full path to such a link IS caught
//    (above). Covered by nothing else; a contributor would have to name a link after a trapped program on purpose.
//    What would hold it: a rule that names a symlink of a trapped name under test/. Said in AGENTS.md.
//  - `env -i` (also `env -iX`, `env -`, `--ignore-environment`), `env -u PATH` / `--unset=PATH` / `-uPATH`, or a
//    `PATH=` reset, in a COMMAND STRING throws the sealed PATH away (with -i, the whole environment): the program
//    after it is searched on the system's folders, where no trap is. The wrap
//    cannot rewrite a shell string, so only the rule holds that form (clearedEnvs for env -i and -u PATH, unsealedPaths for a
//    PATH=). An `env` ARGV that clears or resets PATH (`['-i', …]`, `['-u', 'PATH', …]`, `['PATH=…', …]`, a full
//    path to env, options before -i) IS held by construction: the wrap forces the sealed PATH and the runner's
//    variables into env's own arguments (sealEnvArgv below), so the program it runs still finds the traps first. The
//    one argv form left to the rule is `-S`/`--split-string`, whose string holds the whole command. A command built in
//    a variable and handed to exec/execSync (`const c = 'env -i sudo…'; execSync(c)`) is caught by neither: a shell
//    string the wrap cannot read and a line the rule cannot see. Said in AGENTS.md.
//  - A connection from a program that is not Node (curl in a shell string, a stand-in written in sh) to a default port
//    is not refused: only Node's sockets are wrapped. Nothing in test/ does it today; a rule would have to name it.
//  - The df/ps/ss stand-ins and the /proc narrowing hold for a call by name and for fs.readdirSync('/proc'). NOT
//    for: the async listings (fs.readdir, fs.promises.readdir, fs.opendir of /proc: nothing in src/ uses them today),
//    a READ of /proc/<pid>/… by a pid the test already knows (left alone on purpose: a test reads its own children
//    that way), a program that is not Node listing /proc (`ls /proc` in a shell string), and `lsof`, which the
//    gateway asks instead of ss where it is installed (not on this suite's Linux computers; it would show only the
//    user's own listeners). What would hold them: the same filter on the async forms, and an lsof stand-in.
//  - On macOS the ps stand-in reads the tree from the computer's ps: pid and parent, and the environment (`ps -axE`) for
//    the test file's mark, so a tmux server the test started (its parent is then launchd) is its own. ss is not there.
//    The macOS forms were proven only by their parsers with made-up answers (test/seal.test.mjs), not on a Mac; that
//    `ps -axE` prints the environment of the user's own processes is from its manual. Proof: the seal's test on a Mac.
//  - The coding tool installed on the inherited PATH (the person's own Claude Code) is FOUND and READ: a test that asks
//    the product for the installed version (claudeVersionQuick, resolveClaude) gets the version of the contributor's
//    own install, or none. Such a test hands the version it plays (`{ version: TOOL_VERSION }`) or a stand-in of its own
//    first on PATH, laid out as …/claude/versions/<version>; test/providers/check.test.mjs does the first.
//  - The preload loads CommonJS only, which every supported Node (22.11 and newer, src/nodefloor.mjs) can require;
//    the whole suite, the seal's test with it, runs on Node 22.11.0 as well as on the newest.
//  - On macOS, a LOGIN SHELL (what tmux starts in a pane) rebuilds PATH with the system's folders first, so inside a
//    pane the traps come after /usr/bin. The wrap seals the environment a test hands over, but a program a pane's
//    shell starts from its own rebuilt PATH is not sealed. Proof: run the suite in a pane on macOS and read the trap
//    log. Not run here (this is a Linux computer).
//  - WINDOWS was not run. A program started without a shell is found by name only as `.exe`, so a `.cmd` trap would
//    be passed by for a bare name; the wrap covers a full path to `sudo.exe`/`winget.exe` by name before the system
//    looks for the file, but the bare-name case on Windows is unproven. Proof: run the suite on Windows.
//  - A WORKER THREAD is sealed: the preload runs in each worker too (src/editor/walk.mjs starts one), so its
//    child_process is wrapped. A worker given its own `env` (without the trap folder, the wrap inside it would do
//    nothing) or its own `execArgv` (`[]` drops the preload) is sealed too: the wrap replaces worker_threads.Worker
//    with one that seals that env like a child's and puts the --require back into that execArgv (test/seal.test.mjs:
//    a worker's child given a fresh PATH meets the trap, in all three forms).
//  - child_process reached NOT through this module's exports: process.binding/internal spawn, or a reference to a
//    child_process function saved by a module loaded before this one. Nothing is loaded before the `--require` of this
//    wrap: Node runs a --require before an --import, so tools/test-flush.mjs comes after it (seen on Node 26; Node 22
//    was not run here), and the last case cannot happen here; nothing in src/ or test/ calls process.binding or
//    internalBinding today, but no rule holds that. What would: a grep rule over src/ and test/ that names them.
import { createRequire } from 'node:module';

export const { trapAlong, systemAlong, logForbidden, allowFullPath } = createRequire(import.meta.url)('./test-seal.cjs');
