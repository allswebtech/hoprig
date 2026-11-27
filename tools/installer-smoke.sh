#!/bin/sh
# The install line from a packed build to a running dashboard, written down step by step, so a red run says why.
#
#   sh tools/installer-smoke.sh <hoprig-X.tgz> serve      the installer, set-up without the service, `hoprig serve`
#   sh tools/installer-smoke.sh <hoprig-X.tgz> service    the same with the computer's own service: sign-in page,
#                                                          restart, sign-in page again, service uninstall
# As root (a container) it first makes a plain user with sudo and runs itself as that user: the installer is for a
# person, not for root. On Windows (Git Bash) the install line is install.ps1. It prints one SMOKE line per step and
# ends with 1 when any step failed. Run by .github/workflows/pack-smoke.yml.
set -u
TGZ=$1
MODE=${2:-serve}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
PORT=17433
FAILED=0

if [ "$(id -u)" = 0 ] && [ -z "${SMOKE_USER:-}" ]; then
  # A made-up plain user with sudo, as a person on a fresh server has one. Only the container's own tools are used.
  if command -v apt-get >/dev/null 2>&1; then apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q sudo >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q sudo shadow-utils >/dev/null
  elif command -v apk >/dev/null 2>&1; then apk add -q sudo shadow >/dev/null
  fi
  useradd -m -s /bin/sh smoke
  mkdir -p /etc/sudoers.d && echo 'smoke ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/smoke && chmod 440 /etc/sudoers.d/smoke
  W=/home/smoke/work
  mkdir -p "$W/repo/tools" && cp "$REPO/install.sh" "$REPO/install.ps1" "$W/repo/" && cp "$HERE/installer-smoke.sh" "$W/repo/tools/" && cp "$TGZ" "$W/pack.tgz" && chown -R smoke "$W"
  exec sudo -u smoke -H env SMOKE_USER=smoke sh "$W/repo/tools/installer-smoke.sh" "$W/pack.tgz" "$MODE"
fi

OUT=${SMOKE_OUT:-${TMPDIR:-/tmp}/installer-smoke.$$}
mkdir -p "$OUT"
say() { printf 'SMOKE %s\n' "$*"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf -- '- %s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; return 0; }
# step <name> <command...>: runs it with its output in a file; ok or FAILED with the last lines of that file.
step() {
  name=$1; shift
  if "$@" >"$OUT/$name.log" 2>&1; then say "$name: ok"; else rc=$?; say "$name: FAILED (exit $rc)"; tail -n 30 "$OUT/$name.log" | sed 's/^/    /'; FAILED=1; fi
}
# The sign-in page answers with 200 within 90 seconds. Node's own fetch: no curl needed on the computer.
login() {
  node -e "
    const url = 'http://127.0.0.1:' + process.argv[1] + '/login';
    const until = Date.now() + 90000;
    (async () => {
      for (;;) {
        try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status === 200) return console.log('/login 200'); } catch {}
        if (Date.now() > until) { console.log('/login did not answer 200'); process.exit(1); }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();" "$1"
}

# Doctor fails on anything broken except the one thing a runner cannot have: a Claude account to sign in to.
doctor() {
  hoprig doctor --offline --json > "$OUT/doctor.json"
  node -e "
    const j = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const bad = j.groups.flatMap((g) => g.checks).filter((c) => c.status === 'fail' && c.action !== 'claude-login');
    for (const c of bad) console.log('✗ ' + c.label + ': ' + c.detail);
    console.log(bad.length ? bad.length + ' check(s) failed' : 'doctor: nothing broken (only the Claude sign-in is left, as on any new computer)');
    process.exit(bad.length ? 1 : 0);" "$OUT/doctor.json"
}

say "system: $(uname -s) $(uname -m), $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
case $(uname -s) in
  MINGW* | MSYS* | CYGWIN*) WIN=1; TGZ=$(cygpath -w "$TGZ") ;; # PowerShell and npm want Windows paths
  *) WIN=0 ;;
esac
export HOPRIG_SOURCE=$TGZ
ARGS="--yes --only base --access local"
[ "$MODE" = serve ] && ARGS="$ARGS --no-service"
if [ "$WIN" = 1 ]; then
  step install powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$REPO/install.ps1")" $ARGS
  PATH="$(cygpath "$APPDATA")/npm:$PATH"
else
  step install sh "$REPO/install.sh" $ARGS
  PATH="$HOME/.local/bin:$PATH"
  # The Node.js the installer put in place (nvm): the one the command it wrote starts.
  NODE_BIN=$(sed -n "s/^exec '\(.*\)' '.*hoprig\.mjs'.*/\1/p" "$HOME/.local/bin/hoprig" 2>/dev/null)
  [ -n "$NODE_BIN" ] && PATH="$(dirname "$NODE_BIN"):$PATH"
fi
tail -n 40 "$OUT/install.log"
export PATH
say "node: $(node --version 2>&1), hoprig: $(hoprig --version 2>&1 | head -1)"
command -v hoprig >/dev/null 2>&1 || { say "hoprig command: not found after the install"; exit 1; }

if [ "$MODE" = serve ]; then
  hoprig serve --host 127.0.0.1 --port "$PORT" >"$OUT/serve.log" 2>&1 &
  SERVER=$!
  step signin-page login "$PORT"
  step doctor doctor
  kill "$SERVER" 2>/dev/null
else
  PORT=7433
  step service-status hoprig service status
  step signin-page login "$PORT"
  step restart hoprig service restart
  step signin-after-restart login "$PORT"
  step doctor doctor
  step service-uninstall hoprig service uninstall
fi
[ "$FAILED" = 0 ] && say "result: ok" || say "result: FAILED"
exit "$FAILED"
