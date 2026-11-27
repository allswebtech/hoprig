#!/bin/sh
# hoprig installer for macOS and Linux.
#
#   curl -fsSL <address of this file> | sh                 says what it installs, then does it
#   curl -fsSL <address of this file> | sh -s -- --yes     no questions
#
# It finds what is missing, lists it, installs it, installs hoprig and runs `hoprig setup`.
#   Node.js 24.13.1+ for you only (no administrator rights) with nvm, the version manager nodejs.org lists for macOS
#                 and Linux; on Alpine (musl: nvm has no ready-made Node there) with `apk add nodejs npm`.
#   system bits   only on Linux, with the system package manager: curl when there is no downloader, libatomic
#                 (Node's official Linux builds need it), and the C++ build tools the terminal module (node-pty)
#                 compiles with (it has ready-made builds only for macOS and Windows).
#   hoprig     with npm: from the repository's main branch, or from $HOPRIG_SOURCE (a .tgz file, a folder or a git URL); into the
#                 global npm folder, or ~/.local when that folder is not yours to write.
# Arguments go on to `hoprig setup` (for example --yes, --access network, --no-service).
#
# Safe to run again: what is in place is left alone. Every download is https from the vendor's own address.
# Nothing is piped into a root shell: only the package manager runs with sudo, and the command is shown first.
set -eu

# Everything is inside main, called on the last line: the shell has then read the whole file before any of it runs.
# Piped from curl the shell reads this file from its standard input as it goes, so a command that reads its own
# input took the rest of the file away (a package's question did, and the shell ended in "Syntax error: end of file
# unexpected" with nothing installed), and a download that breaks off must not run half of it.
main() {
  # From here on no command gets this file as its input: input is the terminal when there is one, else nothing.
  if can_ask; then exec </dev/tty; else exec </dev/null; fi

  MIN_NODE=24.13.1 # the same as src/nodefloor.mjs (major.minor.patch)
  NVM_VERSION=v0.40.8 # https://github.com/nvm-sh/nvm/releases (pinned: a release several weeks old)
  # Until the package is on npm the default is the repository's main branch as a tarball, which npm installs directly.
  # The same address as hoprigSource() in src/paths.mjs, which the update and its version lookup read.
  SOURCE=${HOPRIG_SOURCE:-https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz}
  YES=${HOPRIG_YES:-0}
  STAY_ROOT=0
  # As root (work_find below): --yes is his yes to make the work user, given on the command line only (never by the
  # variable); --user NAME names it; --no-admin gives it no administrator rights; --dry-run lists and makes nothing.
  # --user and --no-admin are the installer's own: they are taken out of what goes on to `hoprig setup`.
  ROOT_YES=0
  # The command a person runs again, in the words below: `hoprig setup` when set-up started this file (rootwork.mjs).
  # Piped (curl | sh, or the hub over ssh) there is no install.sh to run again: the advice names the piped form.
  if [ -f "$0" ] && head -n 2 "$0" 2>/dev/null | grep -q 'hoprig installer'; then CMD='sh install.sh'; else CMD='curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh -s --'; fi
  case ${HOPRIG_INSTALL_COMMAND:-} in 'hoprig setup' | 'hoprig service install' | 'hoprig move-to-user') CMD=$HOPRIG_INSTALL_COMMAND ;; esac
  WORK_USER=
  NO_ADMIN=0
  DRY_RUN=0
  # --user-only (the move, src/setup/moverun.mjs): the user is made as below and nothing is installed for it; the move
  # copies root's installation first and installs the same build for the user itself.
  USER_ONLY=0
  # --no-work-user (the hub's install that was not asked to make a user): as root, nothing is made.
  NO_WORK=0
  n=$#
  next=
  for a in "$@"; do
    if [ "$next" = user ]; then
      WORK_USER=$a
      next=
      continue
    fi
    case $a in
      --yes | -y) YES=1; ROOT_YES=1; set -- "$@" "$a" ;;
      --stay-root) STAY_ROOT=1; set -- "$@" "$a" ;;
      --dry-run) DRY_RUN=1; set -- "$@" "$a" ;;
      --user) next=user ;;
      --user=*) WORK_USER=${a#--user=} ;;
      --no-admin) NO_ADMIN=1 ;;
      --user-only) USER_ONLY=1 ;;
      --no-work-user) NO_WORK=1 ;;
      *) set -- "$@" "$a" ;;
    esac
  done
  shift "$n"

  say() { printf '%s\n' "$*"; }
  WORK=0
  WORK_MADE=
  die() {
    printf 'hoprig installer: %s\n' "$*" >&2
    # As root, once something was made for the work user: what, and how to go on or take it away.
    [ -z "$WORK_MADE" ] || work_left >&2
    exit 1
  }
  [ "$next" != user ] || die "--user needs a name, for example: --user hoprig"
  if [ -n "$WORK_USER" ]; then
    # The rule of useradd's default NAME_REGEX, the same as USER_NAME_RE in src/setup/rootfacts.mjs.
    case $WORK_USER in '' | *[!a-z0-9_-]* | [!a-z_]*) die "\"$WORK_USER\" is not a user name (small letters, digits, - and _, starting with a letter or _)." ;; esac
    [ "${#WORK_USER}" -le 32 ] || die "\"$WORK_USER\" is longer than 32 characters, too long for a user name."
  fi

  # A locale the terminal sent that this computer lacks (an ssh client's LANG on a fresh cloud server): said once, and
  # this script and set-up after it run with C.UTF-8 (C where that is missing too). The same rule as src/setup/locale.mjs.
  lkey() { printf '%s\n' "$1" | sed 's/\.[uU][tT][fF]-\{0,1\}8$/.utf8/'; }
  if have locale; then
    LNAME=
    for v in LC_ALL LC_CTYPE LANG; do
      eval "LVAL=\${$v:-}"
      if [ -n "$LVAL" ]; then
        LNAME=$v
        break
      fi
    done
    if [ -n "$LNAME" ] && ! printf '%s\n' C POSIX | grep -qixF "$(lkey "$LVAL")" && ! locale -a 2>/dev/null | sed 's/\.[uU][tT][fF]-\{0,1\}8$/.utf8/' | grep -qixF "$(lkey "$LVAL")"; then
      LUSE=C
      if locale -a 2>/dev/null | grep -qix 'c\.utf-\{0,1\}8'; then LUSE=C.UTF-8; fi
      # The same fix as set-up's (src/setup/locale.mjs localeFix): locale-gen takes a name on Ubuntu only, and a value
      # with no language part (macOS sends LC_CTYPE=UTF-8) is changed on the person's side.
      # Read only when it is there: in dash and in bash --posix (macOS's sh) `.` of a missing file ends the shell it
      # runs in, and with set -e this whole script, without a word (macOS and some minimal images have no such file).
      LREL=${HOPRIG_OS_RELEASE:-/etc/os-release}
      # A readable file that does not parse (a hand-edited or broken os-release) aborts the subshell with a syntax
      # error before `|| :` can run, so the `|| LOS=` catches the whole substitution: the locale line still prints.
      LOS=$( if [ -r "$LREL" ]; then . "$LREL" 2>/dev/null || :; fi; printf ' %s %s ' "${ID:-}" "${ID_LIKE:-}") || LOS=' '
      LFIX="export LANG=C.UTF-8 in your shell's start file"
      case $LOS in *' debian '*) LFIX="sudo dpkg-reconfigure locales (choose $LVAL)" ;; esac
      have apt-get && LFIX="sudo dpkg-reconfigure locales (choose $LVAL)"
      case $LOS in *' ubuntu '*) LFIX="sudo locale-gen $LVAL" ;; esac
      if ! printf '%s\n' "$LVAL" | grep -Eq '^[A-Za-z]{2,3}_[A-Za-z]{2}([.@]|$)'; then
        LFIX="export $LNAME=C.UTF-8 in your shell's start file on this computer, or stop your ssh client sending it (SendEnv LC_* in its ssh config)"
      fi
      say "! The locale $LVAL ($LNAME, sent by your terminal) is not on this computer: the installer and set-up run with $LUSE. Fix: $LFIX"
      unset LC_ALL LC_CTYPE
      LANG=$LUSE
      export LANG
    fi
  fi

  OS=$(uname -s)
  case $OS in
    Darwin | Linux) ;;
    MINGW* | MSYS* | CYGWIN*) die "this is Windows: use install.ps1 in PowerShell (see docs/INSTALL.md)." ;;
    *) die "$OS is not supported (macOS and Linux are; Windows has install.ps1)." ;;
  esac

  PM=
  if [ "$OS" = Linux ]; then
    for m in apt-get dnf yum pacman zypper apk; do
      if have "$m"; then
        PM=$m
        break
      fi
    done
  fi
  SUDO=
  if [ "$(id -u)" != 0 ]; then
    if have sudo; then SUDO=sudo; else SUDO=none; fi
  fi

  # ---- root -------------------------------------------------------------------------------------------------------
  # Said before anything is installed. Hoprig is not set up to work as root: Claude Code refuses its mode that asks
  # nothing for root, and the daily work belongs in an ordinary user's account. Root on purpose is inside a container
  # (the same named facts as src/setup/rootfacts.mjs, looked at as files only) or by --stay-root, which set-up keeps
  # in its settings. Otherwise nothing is installed and one line says what to do.
  if [ "$(id -u)" = 0 ]; then
    CFACT=
    for f in /.dockerenv /run/.containerenv /run/systemd/container; do
      if [ -e "$f" ]; then
        CFACT=$f
        break
      fi
    done
    if [ -z "$CFACT" ] && [ -n "${container:-}" ]; then
      CFACT="container=$(printf '%s' "$container" | sed 's/[^A-Za-z0-9._-]//g; s/^\(.\{40\}\).*/\1/')"
    fi
    ROOT_WORDS="Claude Code refuses bypass permissions mode for root; the modes that ask still start"
    # Root's own Hoprig, read as files only (the same facts as set-up's: rootfacts.mjs STAY_ROOT_KEY, rootwork.mjs
    # freshRoot): his kept choice to stay root, and an installation that runs as root already (its service or its
    # dashboard password). The move's --user-only runs while root's installation is there, on purpose.
    RCFG=${HOPRIG_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/hoprig}/config.json
    RSVC=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/hoprig.service
    KEPT=0
    RHAS=
    if [ -f "$RCFG" ] && grep -Eq '"stayRoot"[[:space:]]*:[[:space:]]*true' "$RCFG" 2>/dev/null; then KEPT=1; fi
    if [ -f "$RSVC" ]; then
      RHAS="its service $RSVC"
    elif [ -f "$RCFG" ] && grep -Eq '"passwordHash"[[:space:]]*:[[:space:]]*"[^"]' "$RCFG" 2>/dev/null; then
      RHAS="its dashboard password in $RCFG"
    fi
    if [ "$STAY_ROOT" != 1 ] && [ "$KEPT" = 1 ] && [ -z "$WORK_USER" ] && [ "$USER_ONLY" != 1 ]; then
      STAY_ROOT=1
      KEPT=2 # said here
      set -- "$@" --stay-root
      say "· This is root, kept on root by your choice (in $RCFG). $ROOT_WORDS."
    elif [ "$STAY_ROOT" != 1 ] && [ -z "$CFACT" ] && [ -n "$RHAS" ] && [ "$USER_ONLY" != 1 ]; then
      die "this is root, and Hoprig is set up for root here already ($RHAS), so no user was made and nothing was installed. To move it to an ordinary user: hoprig move-to-user   To keep it on root and install this version there: $CMD --stay-root"
    fi
    if [ "$STAY_ROOT" = 1 ] && [ -n "$WORK_USER" ]; then
      die "--stay-root keeps Hoprig on root and --user sets it up for a user: choose one. Nothing was made."
    elif [ -n "$CFACT" ] && [ -z "$WORK_USER" ] && [ "$USER_ONLY" != 1 ]; then
      say "· This is root, inside a container ($CFACT): Hoprig stays on root here. $ROOT_WORDS."
    elif [ "$STAY_ROOT" = 1 ]; then
      [ "$KEPT" = 2 ] || say "· This is root, kept on root by your choice (--stay-root). $ROOT_WORDS."
    else
      # The work user (work_find below): which user, read only. The steps are said and asked at the question.
      WORK=1
      work_find
    fi
  fi

  # Whether the node on PATH is MIN_NODE or newer, major, minor and patch all (24.13.0 is too old, 24.13.1 and 25.0.0
  # are not).
  node_ok() {
    node -e 'const v = process.versions.node.split(".").map(Number); const m = process.argv[1].split(".").map(Number); const d = v.map((n, i) => n - (m[i] || 0)).find((n) => n !== 0); process.exit(d === undefined || d > 0 ? 0 : 1)' "$MIN_NODE" 2>/dev/null
  }

  # A Node.js installed earlier with nvm is only on PATH in interactive shells: load it, so a second run finds it.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if ! have node && [ -s "$NVM_DIR/nvm.sh" ]; then
    set +eu # nvm is a shell function library written without `set -eu` in mind
    . "$NVM_DIR/nvm.sh"
    nvm use default >/dev/null 2>&1
    set -eu
  fi
  has_cxx() { have make && { have g++ || have c++; } && have python3; }

  # ---- what is missing --------------------------------------------------------------------------------------------
  PKGS=        # system packages
  NODE_NVM=0   # install Node.js with nvm
  if ! have curl && ! have wget; then
    case $PM in apt-get | dnf | yum | zypper) PKGS="$PKGS curl ca-certificates" ;; *) PKGS="$PKGS curl" ;; esac
  fi
  if have node && ! node_ok; then
    if [ "$PM" = apk ]; then with="Alpine's own Node.js package goes in its place"; else with="the newest long-term release of Node.js goes in its place, for you only, with nvm"; fi
    say "Found Node.js $(node -p process.versions.node 2>/dev/null || echo '(it does not start)'), older than $MIN_NODE, the lowest Hoprig runs on: $with."
  fi
  if ! have node || ! node_ok; then
    if [ "$PM" = apk ]; then
      PKGS="$PKGS nodejs npm"
    else
      NODE_NVM=1
      if [ "$OS" = Linux ] && have ldconfig && ! ldconfig -p 2>/dev/null | grep -q 'libatomic\.so\.1'; then
        case $PM in apt-get | zypper) PKGS="$PKGS libatomic1" ;; dnf | yum) PKGS="$PKGS libatomic" ;; esac
      fi
    fi
  fi
  if [ "$OS" = Linux ] && ! has_cxx; then
    case $PM in
      apt-get) PKGS="$PKGS build-essential python3" ;;
      dnf | yum | zypper) PKGS="$PKGS gcc-c++ make python3" ;;
      pacman) PKGS="$PKGS base-devel python" ;;
      apk) PKGS="$PKGS build-base python3 linux-headers" ;;
    esac
  fi
  PKGS=${PKGS# }

  PKG_CMD=
  if [ -n "$PKGS" ]; then
    [ -n "$PM" ] || die "please install these first, then run this installer again: $PKGS"
    case $PM in
      # No questions: a package may ask one (tzdata asks for the "Geographic area" on a minimal system), and its
      # output goes to a log, so nobody would see it and the install would wait for ever.
      apt-get) PKG_CMD="env DEBIAN_FRONTEND=noninteractive apt-get update -q && SUDOenv DEBIAN_FRONTEND=noninteractive apt-get install -y -q $PKGS" ;;
      dnf | yum) PKG_CMD="$PM install -y -q $PKGS" ;;
      pacman) PKG_CMD="pacman -S --needed --noconfirm $PKGS" ;;
      zypper) PKG_CMD="zypper --non-interactive install $PKGS" ;;
      apk) PKG_CMD="apk add $PKGS" ;;
    esac
    if [ "$SUDO" = none ]; then
      die "installing $PKGS needs administrator rights and sudo is not here. As root, run: $(printf '%s' "$PKG_CMD" | sed 's/SUDO//g')"
    fi
    # SUDO marks the second command of the apt line; the first gets it in front.
    PKG_CMD="${SUDO:+$SUDO }$(printf '%s' "$PKG_CMD" | sed "s/SUDO/${SUDO:+$SUDO }/g")"
  fi

  # ---- what will be installed: said, then done (sudo asks for its own password; Ctrl-C stops it) ----------------------
  if [ "$WORK" = 1 ]; then
    work_plan
    if [ "$DRY_RUN" = 1 ]; then
      say "A dry run: nothing was made or installed."
      exit 0
    fi
    work_ask
  elif [ -n "$PKG_CMD" ] || [ "$NODE_NVM" = 1 ]; then
    say "To install:"
    [ -n "$PKG_CMD" ] && say "  $PKGS   ($PKG_CMD)"
    [ "$NODE_NVM" = 1 ] && say "  Node.js LTS, for you only, with nvm $NVM_VERSION in $NVM_DIR"
  fi

  if [ -n "$PKG_CMD" ]; then
    [ -n "$SUDO" ] && say "sudo may ask for your computer password."
    say "Installing ${PKGS}…"
    # Our own fixed text and package names. The package manager's long output goes to a log, shown only when it
    # fails. It gets no input at all (every command above is told not to ask, and a question in a log could not be
    # answered); sudo asks for its password on the terminal itself, so that still works.
    log=$(mktemp)
    sh -c "$PKG_CMD" </dev/null >"$log" 2>&1 || pm_rc=$?
    if [ "${pm_rc:-0}" != 0 ]; then
      tail -n 25 "$log" >&2
      rm -f "$log"
      die "installing $PKGS did not succeed (see above)."
    fi
    rm -f "$log"
  fi

  # As root: the user is made, then the rest of the set-up runs as that user. Neither comes back.
  if [ "$WORK" = 1 ]; then
    work_make
    if [ "$USER_ONLY" = 1 ]; then
      say "✓ The user $WU is ready for Hoprig (home $WU_HOME, user id $WU_UID)."
      exit 0
    fi
    work_handoff "$@"
  fi

  download() {
    if have curl; then curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"; else wget -q -O "$2" "$1"; fi
  }

  if [ "$NODE_NVM" = 1 ]; then
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      tmp=$(mktemp -d)
      download "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" "$tmp/nvm-install.sh"
      # nvm adds two lines to your shell's startup file, so new terminals find node.
      if have bash; then nvm_sh="bash"; else nvm_sh="sh"; fi
      "$nvm_sh" "$tmp/nvm-install.sh" >/dev/null 2>&1 || die "nvm did not install (https://github.com/nvm-sh/nvm#troubleshooting)."
      rm -rf "$tmp"
    fi
    set +eu # nvm is a shell function library written without `set -eu` in mind
    . "$NVM_DIR/nvm.sh"
    say "Installing Node.js…"
    log=$(mktemp)
    nvm install --lts --no-progress >"$log" 2>&1
    rc=$?
    nvm use --lts >/dev/null 2>&1
    set -eu
    if [ "$rc" != 0 ]; then
      tail -n 25 "$log" >&2
      rm -f "$log"
      die "nvm could not install Node.js (see above)."
    fi
    rm -f "$log"
  fi
  have node || die "node is not found."
  node --version >/dev/null 2>&1 || die "node is installed but does not start (see the error above)."
  node_ok || die "Node.js $(node --version) is too old; hoprig needs $MIN_NODE or newer."
  have npm || die "npm is missing (it comes with Node.js)."
  say "✓ Node.js $(node --version)"

  # ---- hoprig --------------------------------------------------------------------------------------------------
  if [ -e "$SOURCE" ]; then
    case $SOURCE in /*) ;; *) SOURCE="$(pwd)/$SOURCE" ;; esac
  fi
  # npm 12 and newer refuse a package named by an address (a tarball URL, a git address) unless this one command
  # allows it; "root" allows only what is named here, never what a dependency points to. An older npm needs nothing,
  # and npm 12 refuses a flag it does not know, so the flag is passed only where it is needed.
  NPM_ALLOW=
  NPM_MAJOR=$(npm --version 2>/dev/null | sed 's/\..*//')
  case $NPM_MAJOR in '' | *[!0-9]*) NPM_MAJOR=0 ;; esac
  if [ "$NPM_MAJOR" -ge 12 ] && [ ! -e "$SOURCE" ]; then
    case $SOURCE in
      git+* | git://* | github:* | *.git) NPM_ALLOW=--allow-git=root ;;
      http://* | https://*) NPM_ALLOW=--allow-remote=root ;;
    esac
  fi
  # The terminal module (node-pty) is built by its install script, which npm 12 does not run in a global install:
  # `hoprig setup` below builds it in hoprig's own folder, where package.json allows exactly that module.
  PREFIX=$(npm prefix -g)
  if [ -w "$PREFIX" ] && { [ ! -e "$PREFIX/lib" ] || [ -w "$PREFIX/lib" ]; }; then
    # shellcheck disable=SC2086 # NPM_ALLOW is one flag or nothing
    npm install -g $NPM_ALLOW --no-audit --no-fund --no-update-notifier --loglevel=error "$SOURCE" >/dev/null
    BIN="$PREFIX/bin/hoprig"
  else
    # The global folder belongs to the system: install for this user instead of with sudo (npm advises against it).
    # shellcheck disable=SC2086
    npm install -g $NPM_ALLOW --prefix "$HOME/.local" --no-audit --no-fund --no-update-notifier --loglevel=error "$SOURCE" >/dev/null
    BIN="$HOME/.local/bin/hoprig"
  fi
  [ -x "$BIN" ] || BIN=$(command -v hoprig || true)
  [ -n "$BIN" ] && [ -x "$BIN" ] || die "hoprig was installed but its command is not found."
  say "✓ hoprig $("$BIN" version)"

  # ---- setup ------------------------------------------------------------------------------------------------------
  # Its first step makes the command work in every shell, not only an interactive one: ~/.local/bin/hoprig and hop
  # start Hoprig with this Node.js (nvm's lines in ~/.bashrc are not read by `ssh <computer> hoprig …`), and
  # ~/.local/bin goes on PATH in ~/.profile, the top of ~/.bashrc and ~/.zshenv, once (src/setup/localbin.mjs).
  exec "$BIN" setup "$@"
}

# ---- root: the work user ------------------------------------------------------------------------------------------
# As root (not in a container, not kept on root by --stay-root) the installer makes an ordinary user for the work and
# sets Hoprig up there: Claude Code refuses its mode that asks nothing for root, and the daily work does not belong in
# root's account. Every fact is read through a program (id, getent, stat, visudo -c, loginctl) and every change is a
# program (useradd, install, visudo, loginctl, runuser), so a test stands in for each; nothing under /etc is written
# with a shell redirect. Root's own login, password and SSH settings are never changed. One implementation: set-up,
# `service install`, the move and the hub run this file for it.

# Reads one `getent passwd` line into WE_NAME, WE_UID, WE_GID, WE_COMMENT, WE_HOME.
work_entry() {
  IFS=: read -r WE_NAME _ WE_UID WE_GID WE_COMMENT WE_HOME _ <<EOF
$1
EOF
}

# Is the user of the entry read last one Hoprig made? Its mark: the file WORK_MARK_FILE in its home, owned by ROOT, with
# one name, holding the one line "$WORK_MARK <name>" (markText in rootfacts.mjs). The user owns his home, so a file of
# his own there, or a file of root's he renamed into that name, must not count: only this installer writes that line
# into a file of root's. The comment field is written too but never trusted: chfn may let users change it.
work_marked() {
  case $WE_HOME in /*) ;; *) return 1 ;; esac
  wm=$WE_HOME/$WORK_MARK_FILE
  [ -f "$wm" ] && [ ! -L "$wm" ] && [ "$(stat -c '%u %h' "$wm" 2>/dev/null)" = '0 1' ] && [ "$(head -c 200 "$wm" 2>/dev/null)" = "$WORK_MARK $WE_NAME" ]
}

# Which user: the one named by --user, else the first of WORK_NAMES that Hoprig made or that is free. Read only.
work_find() {
  # Set here, not at the top of the file: nothing outside main and its functions runs before the last line is read.
  WORK_MARK='Hoprig work user'        # the comment field of the user (WORK_USER_MARK in src/setup/rootfacts.mjs)
  WORK_MARK_FILE=.hoprig-made-by-move # the mark, a file of root's in its home (MOVE_MARK_FILE in rootfacts.mjs)
  WORK_NAMES='hoprig hoprig2 hoprig3 hoprig4 hoprig5 hoprig6 hoprig7 hoprig8 hoprig9' # WORK_USER_NAMES in rootfacts.mjs
  # This file's address, for a run piped from curl that has no file to hand on (INSTALL_SCRIPT_URL in src/paths.mjs).
  INSTALL_URL=https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh
  for p in getent useradd runuser install; do
    have "$p" || die "this is root, and $p is not on this computer, so the user for Hoprig cannot be made here. Nothing was made. To keep Hoprig on root instead: $CMD --stay-root"
  done
  if [ "$NO_ADMIN" != 1 ] && ! have visudo; then
    die "this is root, and visudo (it comes with sudo) is not on this computer, so administrator rights cannot be given to the user for Hoprig. Nothing was made. Run it again without them: $CMD --yes --no-admin"
  fi
  work_entry "$(getent passwd root 2>/dev/null || echo 'root:x:0:0::/root:')"
  ROOT_HOME=${WE_HOME:-/root}
  WU=
  WU_NEW=0
  FREE=
  TAKEN=
  for nm in $WORK_NAMES; do
    getent passwd "$nm" >/dev/null 2>&1 || { FREE=$nm; break; }
  done
  for nm in ${WORK_USER:-$WORK_NAMES}; do
    line=$(getent passwd "$nm" 2>/dev/null) || line=
    if [ -z "$line" ]; then
      WU=$nm
      WU_NEW=1
      WU_HOME=/home/$nm
      WU_UID='<its user id>'
      break
    fi
    work_entry "$line"
    if [ "$WE_UID" != 0 ] && work_marked; then
      WU=$nm
      WU_UID=$WE_UID
      WU_GID=$WE_GID
      WU_HOME=$WE_HOME
      break
    fi
    TAKEN="${TAKEN:+$TAKEN, }$nm"
    # A free name after a taken one is offered, never used without his word: he chose the default, not hoprig2.
    [ -n "$WORK_USER" ] || break
  done
  if [ -z "$WU" ]; then
    die "a user named $TAKEN is already on this computer and Hoprig did not make it, so it is not used. Nothing was made. Choose another name: $CMD --yes --user ${FREE:-<a free name>}"
  fi
  SUDOERS=/etc/sudoers.d/90-hoprig-$WU
  # A new user gets bash where it is there: useradd's default on Ubuntu is /bin/sh, a shell with no history and no
  # arrow keys, for his login and for Hoprig's terminals alike. Where it is not, the system's default stays. A user that
  # exists is never changed. HOPRIG_BIN_BASH is where to look (a test hands in a file of its own); the shell given is
  # always /bin/bash (hasBash in src/setup/moveplan.mjs reads the same fact for the move's list of steps).
  WU_SHELL=
  WU_BASH=${HOPRIG_BIN_BASH:-/bin/bash}
  if [ "$WU_NEW" = 1 ] && [ -f "$WU_BASH" ] && [ -x "$WU_BASH" ]; then WU_SHELL=/bin/bash; fi
}

# The steps, each with its exact command, said before anything is made. Steps already done are said as done.
work_plan() {
  N=0
  step() {
    N=$((N + 1))
    say "  $N. $*"
  }
  say "This is root. Hoprig does not work as root (Claude Code refuses its mode that asks nothing for root), so this"
  say "installer makes an ordinary user for the work and sets Hoprig up there. As root it will:"
  if [ "$WU_NEW" = 1 ]; then
    step "Make the user $WU, with no password${WU_SHELL:+, bash as its shell (the usual command line, with history and arrow keys)} and its home made by the system (normally $WU_HOME):"
    say "       useradd --create-home --comment \"$WORK_MARK\"${WU_SHELL:+ --shell $WU_SHELL} $WU"
  else
    step "The user $WU is here already and Hoprig made it: kept as it is (home $WU_HOME)."
  fi
  if [ -s "$ROOT_HOME/.ssh/authorized_keys" ]; then
    step "Give $WU the keys that let you in as root, so the same key logs you in as $WU (root's own file is not changed):"
    say "       install -d -m 0700 -o $WU -g $WU $WU_HOME/.ssh"
    say "       install -m 0600 -o $WU -g $WU <root's key lines that $WU lacks, added; none with a forced command or no-port-forwarding> $WU_HOME/.ssh/authorized_keys"
  else
    step "Root has no login keys here ($ROOT_HOME/.ssh/authorized_keys), so $WU gets none: from root's login, become $WU with  runuser -u $WU -- sh"
  fi
  if [ "$NO_ADMIN" = 1 ]; then
    step "No administrator rights for $WU (--no-admin): such steps stay yours, as root."
  else
    step "Give $WU administrator rights as cloud servers give their first user (sudo without a password; --no-admin for none), by one file:"
    say "       $SUDOERS  holding  $WU ALL=(ALL) NOPASSWD:ALL   (checked with visudo -cf before it is put in place, then visudo -c)"
  fi
  if have loginctl; then
    step "Keep $WU's services running when nobody is logged in:"
    say "       loginctl enable-linger $WU"
  fi
  [ -z "$PKG_CMD" ] || step "Install $PKGS for everyone:  $PKG_CMD"
  [ "$USER_ONLY" = 1 ] || step "Install Hoprig FOR $WU (its own Node.js, Claude Code, settings and workspace) and start its dashboard as $WU's service:"
  [ "$USER_ONLY" = 1 ] || say "       runuser -u $WU -- env HOME=$WU_HOME USER=$WU LOGNAME=$WU XDG_RUNTIME_DIR=/run/user/$WU_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$WU_UID/bus PATH=$WU_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin sh install.sh --yes"
  say "  Root's own login, password and SSH settings are not changed."
}

# The one question, or the yes of --yes; with no terminal and no --yes nothing is made and the two commands are said.
work_ask() {
  [ "$NO_WORK" != 1 ] || die "this is root, and this install was not asked to make a user, so nothing was made. To make the user $WU and set Hoprig up there: $CMD --yes   To keep Hoprig on root instead: $CMD --stay-root"
  [ "$ROOT_YES" = 1 ] && return 0
  can_ask || die "this is root, and there is no terminal to ask in, so nothing was made. To make the user $WU and set Hoprig up there: $CMD --yes   To keep Hoprig on root instead: $CMD --stay-root"
  printf 'Make the user %s and set Hoprig up there? [Y/n] ' "$WU" >/dev/tty
  read -r answer </dev/tty || answer=n
  case $answer in
    '' | y | Y | yes | Yes | YES) ;;
    *) die "nothing was made. To make the user later: $CMD --yes   To keep Hoprig on root instead: $CMD --stay-root" ;;
  esac
}

# What this run made, and the commands that go on or take it away: said by die once something was made.
work_left() {
  printf 'What this run made (Hoprig does not run there yet):'
  case " $WORK_MADE " in *' user '*) printf ' the user %s;' "$WU" ;; esac
  case " $WORK_MADE " in *' keys '*) printf ' the login keys in %s/.ssh;' "$WU_HOME" ;; esac
  case " $WORK_MADE " in *' sudoers '*) printf ' the file %s;' "$SUDOERS" ;; esac
  case " $WORK_MADE " in *' linger '*) printf ' lingering for %s;' "$WU" ;; esac
  printf '\nTo go on from here, run the same command again: %s --yes%s\n' "$CMD" "${WORK_USER:+ --user $WORK_USER}"
  printf 'To take it away:'
  case " $WORK_MADE " in *' sudoers '*) printf '  rm %s;' "$SUDOERS" ;; esac
  case " $WORK_MADE " in *' linger '*) printf '  loginctl disable-linger %s;' "$WU" ;; esac
  case " $WORK_MADE " in
    *' user '*) printf '  userdel --remove %s' "$WU" ;;
    *' keys '*) printf '  remove from %s/.ssh/authorized_keys the lines root has' "$WU_HOME" ;;
  esac
  printf '\n'
}

# The keys: root's authorized_keys lines that the user's file lacks are added, as written. A line whose options hold a
# forced command, no-port-forwarding or restrict is left out: cloud images put such a line in root's file ("Please
# login as the user ... rather than root"), and with it neither the login as the user nor the dashboard's tunnel works.
# KEYS_OK=1 when the user's file then holds a line that logs in and tunnels (the closing words name ssh only then).
work_keys() {
  KEYS_OK=0
  keys=$ROOT_HOME/.ssh/authorized_keys
  [ -s "$keys" ] || return 0
  if [ -L "$WU_HOME/.ssh" ] || [ -L "$WU_HOME/.ssh/authorized_keys" ]; then
    say "! $WU_HOME/.ssh or its authorized_keys is a link: left alone, so $WU got no keys from root."
    return 0
  fi
  had="$WU_HOME/.ssh/authorized_keys"
  [ -f "$had" ] || had=/dev/null
  t=$(mktemp)
  tn=$(mktemp)
  # Lines compared without a CR at the end; written as they are. A last line without a newline gets one. The options
  # are what comes before the key's type (ssh-…, ecdsa-…, sk-…); a line that starts with its type has none.
  awk -v first="$had" -v counts="$tn" '
    function blocked(k,   o) {
      if (k ~ /^(ssh-|ecdsa-|sk-)/) return 0
      o = k
      sub(/[ \t]+(ssh-|ecdsa-|sk-).*$/, "", o)
      return o ~ /(^|,)[ \t]*(command=|no-port-forwarding|restrict)/
    }
    { k = $0; sub(/\r$/, "", k) }
    FILENAME == first { seen[k] = 1; print; if (k != "" && k !~ /^#/ && !blocked(k)) ok++; next }
    k == "" || k ~ /^#/ || (k in seen) { next }
    blocked(k) { seen[k] = 1; skipped++; next }
    { seen[k] = 1; print; ok++ }
    END { printf "%d %d\n", ok + 0, skipped + 0 > counts }
  ' "$had" "$keys" >"$t"
  read -r kok kskip <"$tn" || { kok=0; kskip=0; }
  rm -f "$tn"
  [ "$kok" -gt 0 ] && KEYS_OK=1
  [ "$kskip" = 0 ] || say "! $kskip of root's key lines were not given to $WU: they hold a forced command, no-port-forwarding or restrict, so they would not log in as $WU or open the dashboard's tunnel."
  if [ "$had" != /dev/null ] && cmp -s "$t" "$had"; then
    rm -f "$t"
    [ "$KEYS_OK" = 0 ] || say "✓ $WU has root's login keys already."
    return 0
  fi
  if [ ! -s "$t" ]; then
    rm -f "$t"
    return 0
  fi
  if ! install -d -m 0700 -o "$WU_UID" -g "$WU_GID" "$WU_HOME/.ssh" || ! install -m 0600 -o "$WU_UID" -g "$WU_GID" "$t" "$WU_HOME/.ssh/authorized_keys"; then
    rm -f "$t"
    die "root's login keys could not be given to $WU (install said why above)."
  fi
  rm -f "$t"
  WORK_MADE="$WORK_MADE keys"
  [ "$KEYS_OK" = 0 ] || say "✓ $WU has root's login keys: the same key logs you in as $WU."
}

# Administrator rights: ONE file, checked by the system's own checker before it counts, taken away on any no.
work_admin() {
  if [ "$NO_ADMIN" = 1 ]; then
    say "· No administrator rights for $WU (--no-admin)."
    return 0
  fi
  if visudo -c -q -f "$SUDOERS" >/dev/null 2>&1; then
    say "✓ Administrator rights for $WU: $SUDOERS is there already."
    return 0
  fi
  t=$(mktemp)
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$WU" >"$t"
  if ! visudo -c -q -f "$t" >/dev/null 2>&1; then
    rm -f "$t"
    die "the administrator rights line for $WU did not pass the system's check (visudo -cf), so nothing was written to /etc/sudoers.d."
  fi
  if ! install -m 0440 -o root -g root "$t" "$SUDOERS"; then
    rm -f "$t"
    die "$SUDOERS could not be put in place (install said why above)."
  fi
  rm -f "$t"
  if ! visudo -c -q >/dev/null 2>&1; then
    rm -f "$SUDOERS"
    die "the system's check of all administrator rights (visudo -c) failed with $SUDOERS, so that file was taken away again."
  fi
  WORK_MADE="$WORK_MADE sudoers"
  say "✓ Administrator rights for $WU: $SUDOERS (checked)."
}

# Lingering, then the wait (bounded) for the user's service manager: its socket /run/user/<uid>/bus.
work_linger() {
  if ! have loginctl; then
    say "! loginctl is not here (no systemd): $WU's dashboard cannot run as a background service."
    return 0
  fi
  if loginctl show-user "$WU" -p Linger 2>/dev/null | grep -q '^Linger=yes'; then
    say "✓ Lingering is on for $WU already."
  else
    loginctl enable-linger "$WU" || die "lingering could not be turned on for $WU (loginctl said why above)."
    WORK_MADE="$WORK_MADE linger"
    say "✓ Lingering is on for $WU."
  fi
  i=0
  until [ "$(stat -L -c %F "/run/user/$WU_UID/bus" 2>/dev/null)" = socket ]; do
    i=$((i + 1))
    [ "$i" -le "${HOPRIG_BUS_WAIT:-30}" ] || die "$WU's service manager did not start (/run/user/$WU_UID/bus did not appear)."
    sleep 1
  done
}

# Makes what the plan said, in its order. Steps already done are said as done, not redone.
work_make() {
  if [ "$WU_NEW" = 1 ]; then
    if [ -n "$WU_SHELL" ]; then set -- --shell "$WU_SHELL"; else set --; fi
    useradd --create-home --comment "$WORK_MARK" "$@" "$WU" || die "the user $WU could not be made (useradd said why above). Nothing was made."
    WORK_MADE="$WORK_MADE user"
    work_entry "$(getent passwd "$WU" 2>/dev/null)"
    case $WE_UID in '' | 0 | *[!0-9]*) die "the user $WU was made but has no ordinary user id." ;; esac
    case $WE_HOME in /*) ;; *) die "the user $WU was made but has no home folder." ;; esac
    WU_UID=$WE_UID
    WU_GID=$WE_GID
    WU_HOME=$WE_HOME
    t=$(mktemp)
    printf '%s %s\n' "$WORK_MARK" "$WU" >"$t"
    install -m 0644 -o root -g root "$t" "$WU_HOME/$WORK_MARK_FILE" || { rm -f "$t"; die "the mark $WU_HOME/$WORK_MARK_FILE could not be written."; }
    rm -f "$t"
    say "✓ Made the user $WU (home $WU_HOME, no password)."
  else
    say "✓ The user $WU is here already (made by Hoprig)."
  fi
  work_keys
  work_admin
  work_linger
}

# The newest Node bin folder of the user's own nvm, or nothing (userNodeBin in src/setup/asuser.mjs).
work_node_bin() {
  v=$(ls "$WU_HOME/.nvm/versions/node" 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  [ -z "$v" ] || printf '%s' "$WU_HOME/.nvm/versions/node/v$v/bin"
}

# The one way to run a step as the user: its service manager's address and a PATH of its own (asUserArgv in
# src/setup/asuser.mjs; keep the two alike). From the user's home: root's folder is not the user's to enter.
as_user() {
  nb=$(work_node_bin)
  # Root's own Hoprig, nvm and Claude Code folders are not the user's: its set-up finds its own from its HOME.
  (unset HOPRIG_CONFIG_DIR HOPRIG_STATE_DIR HOPRIG_WORKSPACE_DIR HOPRIG_PROFILES_DIR CLAUDE_CONFIG_DIR NVM_DIR XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_CACHE_HOME
    cd "$WU_HOME" && runuser -u "$WU" -- env "HOME=$WU_HOME" "USER=$WU" "LOGNAME=$WU" "XDG_RUNTIME_DIR=/run/user/$WU_UID" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$WU_UID/bus" "PATH=$WU_HOME/.local/bin${nb:+:$nb}:/usr/local/bin:/usr/bin:/bin" "$@")
}

# Hands what the user's run needs into its home, owned by it: this installer and a source on this computer.
work_hand() {
  WDIR=$WU_HOME/.cache/hoprig-install
  # Root writes into the user's home here: never through a link the user could have put there.
  if [ -L "$WU_HOME/.cache" ] || [ -L "$WDIR" ]; then die "$WU_HOME/.cache or $WDIR is a link, so nothing is handed to $WU through it. Move it away, then run the same command again."; fi
  install -d -m 0700 -o "$WU_UID" -g "$WU_GID" "$WU_HOME/.cache" "$WDIR" || die "$WDIR could not be made."
  t=$(mktemp)
  if [ -f "$0" ] && head -n 2 "$0" | grep -q 'hoprig installer'; then
    cp "$0" "$t"
  elif [ -d "$SOURCE" ] && [ -f "$SOURCE/install.sh" ]; then
    cp "$SOURCE/install.sh" "$t"
  elif [ -f "$SOURCE" ] && f=$(tar -tzf "$SOURCE" 2>/dev/null | grep -m 1 '^[^/]*/install\.sh$'); then
    tar -xzf "$SOURCE" -O "$f" >"$t"
  elif have curl; then
    curl -fsSL --proto '=https' --tlsv1.2 "$INSTALL_URL" -o "$t" || die "the installer for $WU could not be fetched from $INSTALL_URL."
  else
    wget -q -O "$t" "$INSTALL_URL" || die "the installer for $WU could not be fetched from $INSTALL_URL."
  fi
  install -m 0644 -o "$WU_UID" -g "$WU_GID" "$t" "$WDIR/install.sh" || die "the installer could not be handed to $WU."
  rm -f "$t"
  USRC=
  if [ -n "${HOPRIG_SOURCE:-}" ]; then
    USRC=$HOPRIG_SOURCE
    if [ -f "$SOURCE" ]; then
      USRC=$WDIR/${SOURCE##*/}
      install -m 0644 -o "$WU_UID" -g "$WU_GID" "$SOURCE" "$USRC" || die "the package $SOURCE could not be handed to $WU."
    elif [ -d "$SOURCE" ]; then
      # A folder (set-up and the move hand this Hoprig's own): packed, so npm copies the same build for the user (a
      # folder it would only link). Without its node_modules and git folder: the user's install fetches its own.
      USRC=$WDIR/hoprig.tgz
      t=$(mktemp)
      sd=${SOURCE%/}
      tar -czf "$t" -C "${sd%/*}/" --exclude=node_modules --exclude=.git "${sd##*/}" || die "the folder $SOURCE could not be packed for $WU."
      install -m 0644 -o "$WU_UID" -g "$WU_GID" "$t" "$USRC" || die "the package could not be handed to $WU."
      rm -f "$t"
    fi
  fi
}

# The rest of the set-up, as the user: the same installer started again. Then the closing words. Does not come back.
work_handoff() {
  n=$#
  for a in "$@"; do
    case $a in --yes | -y) ;; *) set -- "$@" "$a" ;; esac
  done
  shift "$n"
  work_hand
  say "Installing Hoprig for $WU: its own Node.js, Claude Code, settings and workspace, in ${WU_HOME}…"
  if [ -n "$USRC" ]; then set -- "HOPRIG_SOURCE=$USRC" sh "$WDIR/install.sh" --yes "$@"; else set -- sh "$WDIR/install.sh" --yes "$@"; fi
  rc=0
  as_user env "NVM_DIR=$WU_HOME/.nvm" "$@" || rc=$?
  [ "$rc" = 0 ] || die "the set-up for $WU did not finish (exit $rc; its own lines above say why), so Hoprig does not run for $WU."
  addr=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{ print $3 }')
  addr=${addr:-<the address you use for ssh>}
  say ""
  say "Hoprig is set up for the user $WU, and works as $WU from now on."
  if [ "${KEYS_OK:-0}" = 1 ]; then
    say "  Log in as $WU with the key you use for root:  ssh $WU@$addr"
    say "  Open the dashboard from your own computer:   ssh -N -L 17433:127.0.0.1:7433 $WU@$addr   then http://localhost:17433"
  else
    say "  $WU has no key that logs in by ssh. Become $WU from root's login:  runuser -u $WU -- sh"
    say "  Open the dashboard from your own computer through root's login, or give $WU a key of yours in $WU_HOME/.ssh/authorized_keys first."
  fi
  say "  Root's login still works and was not changed."
  exit 0
}

have() { command -v "$1" >/dev/null 2>&1; }

# Is there a terminal to ask in? (Piped from curl, standard input is this file, so questions go to /dev/tty.)
can_ask() { (: </dev/tty) 2>/dev/null; }

{
  main "$@"
  exit $?
}
