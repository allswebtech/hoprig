#!/bin/sh
# hoprig installer for macOS and Linux.
#
#   curl -fsSL <address of this file> | sh                 one question if something must be installed
#   curl -fsSL <address of this file> | sh -s -- --yes     no questions
#
# It finds what is missing, lists it, asks once, installs it, installs hoprig and runs `hoprig setup`.
#   Node.js 22+   for you only (no administrator rights) with nvm, the version manager nodejs.org lists for macOS
#                 and Linux; on Alpine (musl: nvm has no ready-made Node there) with `apk add nodejs npm`.
#   system bits   only on Linux, with the system package manager: curl when there is no downloader, libatomic
#                 (Node's official Linux builds need it), and the C++ build tools the terminal module (node-pty)
#                 compiles with (it has ready-made builds only for macOS and Windows).
#   hoprig     with npm: from npm, or from $HOPRIG_SOURCE (a .tgz file, a folder or a git URL); into the
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

  MIN_NODE=22 # the same as src/nodeguard.mjs
  NVM_VERSION=v0.40.8 # https://github.com/nvm-sh/nvm/releases (pinned: a release several weeks old)
  # Until the package is on npm the default is the repository's main branch as a tarball, which npm installs directly.
  SOURCE=${HOPRIG_SOURCE:-https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz}
  YES=${HOPRIG_YES:-0}
  for a in "$@"; do
    case $a in --yes | -y) YES=1 ;; esac
  done

  say() { printf '%s\n' "$*"; }
  die() {
    printf 'hoprig installer: %s\n' "$*" >&2
    exit 1
  }

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

  node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

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
  if ! have node || [ "$(node_major)" -lt "$MIN_NODE" ]; then
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

  # ---- one question for all of it ---------------------------------------------------------------------------------
  if [ -n "$PKG_CMD" ] || [ "$NODE_NVM" = 1 ]; then
    say "To install:"
    [ -n "$PKG_CMD" ] && say "  $PKGS   ($PKG_CMD)"
    [ "$NODE_NVM" = 1 ] && say "  Node.js LTS, for you only, with nvm $NVM_VERSION in $NVM_DIR"
    if [ "$YES" != 1 ]; then
      can_ask || die "no terminal to ask in. Run it again with --yes:  curl -fsSL <address> | sh -s -- --yes"
      printf 'Install now? [Y/n] ' >/dev/tty
      read -r answer </dev/tty || answer=n
      case $answer in '' | y | Y | yes | Yes | YES) ;; *) die "nothing was installed." ;; esac
    fi
  fi

  if [ -n "$PKG_CMD" ]; then
    [ -n "$SUDO" ] && say "sudo may ask for your computer password."
    say "Installing $PKGS…"
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
  [ "$(node_major)" -ge "$MIN_NODE" ] || die "Node.js $(node --version) is too old; hoprig needs $MIN_NODE or newer."
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

have() { command -v "$1" >/dev/null 2>&1; }
# Is there a terminal to ask in? (Piped from curl, standard input is this file, so questions go to /dev/tty.)
can_ask() { (: </dev/tty) 2>/dev/null; }

{
  main "$@"
  exit $?
}
