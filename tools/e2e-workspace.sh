#!/bin/sh
# The workspace end to end, in two fresh containers (docs/WORKSPACE.md):
#   computer A: Hoprig installed from a tarball of this tree; a workspace with its AI brain, one project with two code
#               repositories and one plain repository, against bare repositories in a shared folder that stands in
#               for the git server; `workspace map`, then the brain committed and pushed. The command is checked in
#               a login shell and over ssh (a non-interactive shell, where nvm is not loaded).
#   computer B: Hoprig installed the same way, then `hoprig workspace restore <brain address>`: the tree, the
#               repositories and the commits must be there. A then changes something and pushes; `sync` on B gets it.
#
#   tools/e2e-workspace.sh <empty work folder> [image]        needs docker and the network (apt, nvm, npm)
#
# One container works at a time (the other is stopped). Every step has its own time limit; containers are named
# hoprig-e2e-a and hoprig-e2e-b and removed at the end. Addresses look like a real server's
# (https://git.example.test/team/<name>.git); git's insteadOf turns them into the shared folder.
set -eu
WORK=${1:?usage: tools/e2e-workspace.sh <empty work folder> [image]}
IMAGE=${2:-ubuntu:24.04}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
A=hoprig-e2e-a
B=hoprig-e2e-b
mkdir -p "$WORK/srv/team" "$WORK/pkg"
chmod 777 "$WORK/srv" "$WORK/srv/team"
TGZ=$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK/pkg" | tail -n 1)
cp "$ROOT/install.sh" "$WORK/pkg/install.sh"
cleanup() { docker rm -f "$A" "$B" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Run a script in a container (as root, or as alex in a login shell) with a time limit outside it.
step() {
  name=$1 who=$2 limit=$3 title=$4
  shift 4
  printf '\n==== %s: %s\n' "$name" "$title"
  (sleep "$limit"; docker kill "$name" >/dev/null 2>&1) &
  dog=$!
  rc=0
  if [ "$who" = root ]; then docker exec "$name" sh -c "$*" || rc=$?; else docker exec "$name" su - alex -c "$*" || rc=$?; fi
  kill "$dog" 2>/dev/null || true
  wait "$dog" 2>/dev/null || true
  [ "$rc" = 0 ] || { echo "==== $name: $title FAILED (exit $rc)"; exit "$rc"; }
}

PREP='set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
apt-get install -y -q curl git ca-certificates build-essential python3 libatomic1 openssh-server openssh-client >/dev/null
useradd -m -s /bin/bash alex
git --version'
IDENTITY='git config --global user.name "Alex Example"
git config --global user.email alex@example.invalid
git config --global init.defaultBranch main
git config --global url./srv/git/.insteadOf https://git.example.test/'
INSTALL="set -e
$IDENTITY
HOPRIG_SOURCE=/hoprig/$TGZ sh /hoprig/install.sh --yes --only workspace"
HEADS='W=$HOME/Workspace; for d in ai_brain projects/shop projects/shop/code/shop-web projects/shop/code/shop-api git/tool; do printf "%s %s\n" "$d" "$(git -C "$W/$d" rev-parse --short HEAD)"; done'

# ---- computer A ----
docker run -d --name "$A" -v "$WORK/srv:/srv/git" -v "$WORK/pkg:/hoprig:ro" "$IMAGE" sleep infinity >/dev/null
step "$A" root 600 'packages and a user' "$PREP"
step "$A" alex 900 'install Hoprig from the tarball' "$INSTALL"
step "$A" root 120 'the command over ssh (no nvm in that shell)' 'set -e
mkdir -p /run/sshd && ssh-keygen -A >/dev/null && /usr/sbin/sshd
su - alex -c "ssh-keygen -q -t ed25519 -N \"\" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
su - alex -c "ssh -o StrictHostKeyChecking=no -o BatchMode=yes localhost \"command -v node || echo node-not-on-PATH; command -v hoprig; hoprig version; hop version\""'
step "$A" alex 300 'a workspace: brain, a project with two code repositories, a plain repository; map; push' 'set -e
W=$HOME/Workspace
for r in brain shop shop-web shop-api tool; do git init -q --bare -b main /srv/git/team/$r.git; done
git -C $W/ai_brain remote add origin https://git.example.test/team/brain.git
git -C $W/ai_brain push -q -u origin main
hoprig project new shop --remote https://git.example.test/team/shop.git
hoprig project add shop web --remote https://git.example.test/team/shop-web.git
hoprig project add shop api --remote https://git.example.test/team/shop-api.git
git -C $W/projects/shop push -q
mkdir -p $W/git/tool && cd $W/git/tool && git init -q && echo "# tool" > README.md && git add -A && git commit -qm "Start tool"
git remote add origin https://git.example.test/team/tool.git && git push -q -u origin main
hoprig workspace map
cd $W/ai_brain && git add workspace.json && git commit -qm "Add the workspace map" && git push -q
cat workspace.json
'"$HEADS"
docker stop "$A" >/dev/null

# ---- computer B ----
docker run -d --name "$B" -v "$WORK/srv:/srv/git" -v "$WORK/pkg:/hoprig:ro" "$IMAGE" sleep infinity >/dev/null
step "$B" root 600 'packages and a user' "$PREP"
step "$B" alex 900 'install Hoprig from the tarball' "$INSTALL"
step "$B" alex 300 'restore from the brain address alone' 'set -e
hoprig workspace restore https://git.example.test/team/brain.git --yes
'"$HEADS"'
hoprig workspace restore https://git.example.test/team/brain.git --yes | tail -n 8
hoprig workspace status
ls -la $HOME/.claude/projects/*/ | grep -- "memory ->" || true'
docker stop "$B" >/dev/null

# ---- A changes something, B gets it ----
docker start "$A" >/dev/null
step "$A" alex 120 'a change on A, pushed' 'set -e
cd $HOME/Workspace/projects/shop/code/shop-web && echo "changed on A" >> README.md && git commit -qam "Change on A" && git push -q && git rev-parse --short HEAD'
docker stop "$A" >/dev/null
docker start "$B" >/dev/null
step "$B" alex 120 'sync on B' 'hoprig workspace sync; git -C $HOME/Workspace/projects/shop/code/shop-web log --oneline -1'
echo
echo '==== done'
